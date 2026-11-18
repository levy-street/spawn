"""The server's single database-driven support collection sender."""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select

from .db import get_sessionmaker
from .models import SupportLogCollection as Collection
from .models import _utcnow
from .support_consent import (
    delivery_lock,
    delivery_snapshot,
    enabled_statement_time,
    enabled_timestamp,
    sharing_on,
)
from .support_log import ACCOUNT_INTERVAL, clamp_window, mark_dispatched, pacing_refusal, transition
from .ws.broker import get_broker
from .ws.daemon import _bounded_send_text

log = logging.getLogger("spawn.support_log")
INTERVAL_SECONDS = 10


async def support_log_consent_changed(app, user_id: str):
    """Call after committing a changed statement in the server process."""
    pump = getattr(app.state, "support_log_pump", None)
    if pump is None:
        return
    for conn in get_broker().support_daemons_for_account(user_id):
        try:
            async with delivery_lock(user_id):
                if not conn.support_registered_sent or not pump.is_current(conn):
                    # Registration takes the same lock and reads after acquiring it.
                    continue
                conn.support_enabled_sent_ms = None
                async with get_sessionmaker()() as session:
                    statement, _ = await delivery_snapshot(session, user_id)
                await _bounded_send_text(
                    conn, {"type": "host.support_log_consent", "consent": statement}
                )
                conn.support_enabled_sent_ms = enabled_timestamp(statement)
        except Exception:
            log.warning("SPAWN D could not send the support log statement to a host")


class SupportLogPump:
    def __init__(self):
        self.wake = asyncio.Event()
        self.stopping = False

    @staticmethod
    def is_current(conn):
        return get_broker().get_daemon_for_host(conn.host_id) is conn

    async def run_once(self, *, now=None):
        scan_time = now or _utcnow()
        # ix_support_log_state_requested drives the scan, including offline
        # hosts (withdrawal cancels those too). No session spans a socket send.
        async with get_sessionmaker()() as session:
            candidates = (
                await session.execute(
                    select(
                        Collection.id,
                        Collection.owner_user_id,
                        Collection.host_id,
                        Collection.window_seconds,
                        enabled_statement_time(Collection.owner_user_id)
                        .scalar_subquery()
                        .label("issued"),
                        (Collection.requested_at < scan_time - ACCOUNT_INTERVAL).label("too_old"),
                        pacing_refusal(
                            Collection.owner_user_id,
                            Collection.host_id,
                            scan_time,
                            exclude=Collection.id,
                        ).label("paced"),
                    )
                    .where(Collection.state == "requested")
                    .order_by(Collection.requested_at, Collection.id)
                )
            ).all()
        for row in candidates:
            try:
                if row.issued is None:
                    await transition(
                        row.id,
                        "requested",
                        "cancelled",
                        now=now,
                        conditions=(~sharing_on(Collection.owner_user_id),),
                    )
                    continue
                if row.too_old or row.paced is not None:
                    continue
                conn = get_broker().get_daemon_for_host(row.host_id)
                if (
                    conn is None
                    or not conn.supports_support_log
                    or conn.user_id != row.owner_user_id
                ):
                    continue
                async with delivery_lock(conn.user_id):
                    if (
                        conn.support_enabled_sent_ms != row.issued
                        or conn.support_oversized_frame_sent
                        or not self.is_current(conn)
                    ):
                        continue
                    if not await mark_dispatched(
                        row.id, now=now, connection_id=conn.id, sent_ms=conn.support_enabled_sent_ms
                    ):
                        continue
                    if self.is_current(conn):
                        await _bounded_send_text(
                            conn,
                            {
                                "type": "support_log.collect",
                                "request_id": row.id,
                                "since_seconds": clamp_window(row.window_seconds),
                            },
                        )
            except Exception:
                log.error("SPAWN D support log dispatch failed for one request")

    async def run(self):
        while not self.stopping:
            self.wake.clear()
            try:
                await self.run_once()
            except Exception:
                log.error("SPAWN D support log dispatch pass failed")
            if not self.stopping:
                try:
                    await asyncio.wait_for(self.wake.wait(), timeout=INTERVAL_SECONDS)
                except TimeoutError:
                    pass

    def stop(self):
        self.stopping = True
        self.wake.set()
