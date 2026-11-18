"""The server's single database-driven support collection sender."""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import select, tuple_

from .db import get_sessionmaker
from .models import SupportLogCollection as Collection
from .models import _utcnow
from .support_consent import enabled_statement_time, sharing_on
from .support_delivery import delivery_order
from .support_log import (
    ACCOUNT_INTERVAL,
    DISPATCH_LIMIT,
    clamp_window,
    mark_dispatched,
    occupied_dispatch_slots,
    pacing_refusal,
    transition,
)
from .ws.broker import get_broker

log = logging.getLogger("spawn.support_log")
INTERVAL_SECONDS = 10
PAGE_SIZE = 32


async def requested_page(now, cursor):
    row = Collection
    query = select(
        row.id,
        row.requested_at,
        row.owner_user_id,
        row.host_id,
        row.window_seconds,
        enabled_statement_time(row.owner_user_id).scalar_subquery().label("issued"),
        pacing_refusal(row.owner_user_id, row.host_id, now, exclude=row.id).label("paced"),
        occupied_dispatch_slots().label("occupied"),
        (row.requested_at < now - ACCOUNT_INTERVAL).label("too_old"),
    ).where(row.state == "requested")
    if cursor is not None:
        query = query.where(tuple_(row.requested_at, row.id) > cursor)
    async with get_sessionmaker()() as session:
        return (
            await session.execute(query.order_by(row.requested_at, row.id).limit(PAGE_SIZE))
        ).all()


class SupportLogPump:
    def __init__(self):
        self.wake = asyncio.Event()
        self.upload_admission = asyncio.Lock()
        self.stopping = False

    async def run_once(self, *, now=None):
        scan_time = now or _utcnow()
        cursor = None
        while not self.stopping:
            page = await requested_page(scan_time, cursor)
            if not page:
                return
            slots = DISPATCH_LIMIT - page[0].occupied
            for row in page:
                await asyncio.sleep(0)
                if self.stopping:
                    return
                try:
                    if row.issued is None:
                        await transition(
                            row.id,
                            "requested",
                            "cancelled",
                            now=now,
                            conditions=(~sharing_on(Collection.owner_user_id),),
                        )
                    elif slots > 0 and row.paced is None and not row.too_old:
                        slots -= await self.dispatch(row, now)
                except Exception:
                    log.error("SPAWN D support log dispatch failed for one request")
            if len(page) < PAGE_SIZE:
                return
            cursor = (page[-1].requested_at, page[-1].id)

    async def dispatch(self, row, now):
        broker = get_broker()
        conn = broker.get_daemon_for_host(row.host_id)
        if conn is None or conn.user_id != row.owner_user_id or not conn.support_delivery_ready:
            return False
        async with delivery_order(conn.user_id).enter() as turn:
            if (
                turn is None
                or not conn.support_delivery_ready
                or conn.support_enabled_sent_ms != row.issued
            ):
                return False
            async with self.upload_admission:
                if (
                    self.stopping
                    or not turn.valid
                    or broker.get_daemon_for_host(row.host_id) is not conn
                ):
                    return False
                if not await mark_dispatched(
                    row.id, now=now, connection_id=conn.id, sent_ms=conn.support_enabled_sent_ms
                ):
                    return False
            if broker.get_daemon_for_host(row.host_id) is conn:
                try:
                    await turn.send(
                        conn,
                        {
                            "type": "support_log.collect",
                            "request_id": row.id,
                            "since_seconds": clamp_window(row.window_seconds),
                        },
                    )
                except Exception:
                    log.error("SPAWN D support log collect send failed")
            return True

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
