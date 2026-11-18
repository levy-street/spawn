"""The server's single database-driven support collection sender."""

from __future__ import annotations

import asyncio
import logging
from itertools import batched

from sqlalchemy import select, tuple_

from .db import get_sessionmaker
from .models import SupportLogCollection as Collection
from .models import _utcnow
from .support_consent import effective_statement, enabled_statement_time, sharing_on
from .support_log import (
    ACCOUNT_INTERVAL,
    DISPATCH_LIMIT,
    OPEN_STATES,
    cancel_open,
    clamp_window,
    get_collection,
    mark_dispatched,
    occupied_dispatch_slots,
    pacing_refusal,
)
from .ws.broker import SUPPORT_UNSENT, daemon_wire, get_broker

log = logging.getLogger("spawn.support_log")
INTERVAL_SECONDS = 10
PAGE_SIZE = 32
SEND_SECONDS = 2
SUPPORT_LIMIT = 65536 - 1024
SYNC_BATCH = 32


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
        self._last_claim: asyncio.Future | None = None
        self.stopping = False

    async def run_once(self, *, now=None):
        scan_time = now or _utcnow()
        await self.sync_statements()
        if self.stopping:
            return
        await self.reduce(scan_time)
        cursor = None
        while not self.stopping:
            page = await requested_page(scan_time, cursor)
            if not page:
                return
            slots = DISPATCH_LIMIT - page[0].occupied
            for row in page:
                await asyncio.sleep(0)
                if self.stopping or slots <= 0:
                    return
                try:
                    if row.issued is not None and row.paced is None and not row.too_old:
                        slots -= await self.dispatch(row, now)
                except Exception:
                    log.error("SPAWN D support log dispatch failed for one request")
            if slots <= 0 or len(page) < PAGE_SIZE:
                return
            cursor = (page[-1].requested_at, page[-1].id)

    async def sync_statements(self):
        broker = get_broker()
        statements = {}
        for hosts in batched(broker.support_daemons(), SYNC_BATCH, strict=False):
            pending = []
            for conn in hosts:
                if self.stopping:
                    return
                size = conn.support_registered_bytes
                if size is None or size > SUPPORT_LIMIT:
                    if not conn.support_size_warned:
                        log.warning(
                            "SPAWN D registration size prevents support sharing on a connection"
                        )
                        conn.support_size_warned = True
                    continue
                try:
                    if conn.user_id not in statements:
                        statements[conn.user_id] = await effective_statement(conn.user_id)
                    statement = statements[conn.user_id]
                    if conn.support_statement_sent != statement:
                        pending.append((conn, statement))
                except Exception:
                    conn.support_statement_sent = SUPPORT_UNSENT
                    log.error("SPAWN D could not read the support log statement for a host")
            # All reads are closed. Slow sockets in this batch share a deadline
            # without delaying ordinary frames or each other's sends.
            await asyncio.gather(*(self.send_statement(conn, value) for conn, value in pending))
            await asyncio.sleep(0)

    async def send_statement(self, conn, statement):
        conn.support_statement_sent = SUPPORT_UNSENT
        if self.stopping or get_broker().get_daemon_for_host(conn.host_id) is not conn:
            return
        try:
            frame = {"type": "host.support_log_consent", "consent": statement}
            wire = daemon_wire(frame)
            if len(wire.encode("utf-8")) > SUPPORT_LIMIT:
                log.warning("SPAWN D support log statement exceeds the wire limit")
                return
            # A single WebSocket text message. A slow support write must
            # never hold the lock used for ordinary control frames.
            async with asyncio.timeout(SEND_SECONDS):
                await conn.websocket.send_text(wire)
            conn.support_statement_sent = statement
        except Exception:
            log.error("SPAWN D could not sync the support log statement to a host")

    async def reduce(self, now):
        row = Collection
        async with get_sessionmaker()() as session:
            owners = (
                await session.scalars(
                    select(row.owner_user_id)
                    .distinct()
                    .where(row.state.in_(OPEN_STATES), ~sharing_on(row.owner_user_id))
                )
            ).all()
        for owner in owners:
            if self.stopping:
                return
            try:
                async with get_sessionmaker()() as session:
                    await cancel_open(session, owner, now)
                    await session.commit()
            except Exception:
                log.error("SPAWN D could not cancel support log requests for one account")

    async def dispatch(self, row, now):
        broker = get_broker()
        conn = broker.get_daemon_for_host(row.host_id)
        if self.stopping or conn is None or conn.user_id != row.owner_user_id:
            return False
        statement = conn.support_statement_sent
        if not isinstance(statement, dict) or not statement["enabled"]:
            return False
        sent_ms = statement["issued_at_ms"]
        if sent_ms != row.issued:
            return False
        claim = self._last_claim = asyncio.get_running_loop().create_future()
        try:
            if not await mark_dispatched(row.id, now=now, connection_id=conn.id, sent_ms=sent_ms):
                return False
        finally:
            claim.set_result(None)
        if not self.stopping and broker.get_daemon_for_host(row.host_id) is conn:
            try:
                frame = {
                    "type": "support_log.collect",
                    "request_id": row.id,
                    "since_seconds": clamp_window(row.window_seconds),
                }
                async with asyncio.timeout(SEND_SECONDS):
                    await conn.websocket.send_text(daemon_wire(frame))
            except Exception:
                log.error("SPAWN D support log collect send failed")
        return True

    async def collection_for_upload(self, record_id):
        # The single pump never waits for an upload. A lookup that crossed a
        # claim must see the record again before occupying a reader slot.
        # The caller reserves that slot without yielding after this returns.
        while True:
            claim = self._last_claim
            if claim is not None and not claim.done():
                await asyncio.shield(claim)
                continue
            record = await get_collection(record_id)
            if self._last_claim is claim:
                return record

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
