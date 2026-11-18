"""The server's single database-driven support collection sender."""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from itertools import batched

from sqlalchemy import select, tuple_, type_coerce, update
from sqlalchemy.types import NullType

from .db import get_sessionmaker
from .models import SupportLogCollection as Collection
from .models import _utcnow
from .support_consent import (
    effective_statement,
    sharing_on,
    statement_commit_in_progress,
    statement_generation,
)
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
    transition,
)
from .ws.broker import SUPPORT_UNSENT, daemon_wire, get_broker

log = logging.getLogger("spawn.support_log")
INTERVAL_SECONDS = 10
PAGE_SIZE = 32
SEND_SECONDS = 0.250
SUPPORT_LIMIT = 65536 - 1024
SYNC_BATCH = 32


async def requested_page(now, cursor):
    row = Collection
    # Keep the driver's cursor value, including malformed SQLite date text.
    requested_at = type_coerce(row.requested_at, NullType)
    query = select(
        row.id,
        requested_at.label("requested_at"),
        row.owner_user_id,
        row.host_id,
        row.window_seconds,
        pacing_refusal(row.owner_user_id, row.host_id, now, exclude=row.id).label("paced"),
        occupied_dispatch_slots().label("occupied"),
        (row.requested_at < now - ACCOUNT_INTERVAL).label("too_old"),
    ).where(row.state == "requested")
    if cursor is not None:
        query = query.where(tuple_(requested_at, row.id) > cursor)
    async with get_sessionmaker()() as session:
        return (
            await session.execute(query.order_by(row.requested_at, row.id).limit(PAGE_SIZE))
        ).all()


def send_busy(conn):
    # asyncio.Lock is unlocked briefly while passing ownership to its first waiter.
    # In that interval acquire() would still queue behind ordinary traffic.
    return conn.send_lock.locked() or bool(conn.send_lock._waiters)


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
                    if row.paced is None and not row.too_old:
                        if isinstance(row.requested_at, str):
                            datetime.fromisoformat(row.requested_at)
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
            # All reads are closed before the sockets in this batch send concurrently.
            await asyncio.gather(*(self.send_statement(conn, value) for conn, value in pending))
            await asyncio.sleep(0)

    async def send_statement(self, conn, statement):
        conn.support_statement_sent = SUPPORT_UNSENT
        if (
            self.stopping
            or send_busy(conn)
            or get_broker().get_daemon_for_host(conn.host_id) is not conn
        ):
            return
        try:
            frame = {"type": "host.support_log_consent", "consent": statement}
            wire = daemon_wire(frame)
            if len(wire.encode("utf-8")) > SUPPORT_LIMIT:
                log.warning("SPAWN D support log statement exceeds the wire limit")
                return
            async with asyncio.timeout(SEND_SECONDS):
                await conn.send_text(frame)
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
        if self.stopping or conn is None or conn.user_id != row.owner_user_id or send_busy(conn):
            return False
        statement = conn.support_statement_sent
        if not isinstance(statement, dict) or not statement["enabled"]:
            return False
        sent_ms = statement["issued_at_ms"]
        frame = {
            "type": "support_log.collect",
            "request_id": row.id,
            "since_seconds": clamp_window(row.window_seconds),
        }
        generation = statement_generation(conn.user_id)
        claim = self._last_claim = asyncio.get_running_loop().create_future()
        try:
            if not await mark_dispatched(row.id, now=now, connection_id=conn.id, sent_ms=sent_ms):
                return False
            committing = statement_commit_in_progress(conn.user_id)
            if not committing:
                if generation != statement_generation(conn.user_id):
                    conn.support_statement_sent = SUPPORT_UNSENT
                    await transition(row.id, "dispatched", "cancelled", now=now)
                    return False
                if self.stopping or broker.get_daemon_for_host(row.host_id) is not conn:
                    return True
            if committing or send_busy(conn):
                # The claim committed, but no collect was handed to the socket.
                async with get_sessionmaker()() as session:
                    await session.execute(
                        update(Collection)
                        .where(Collection.id == row.id, Collection.state == "dispatched")
                        .values(state="requested", dispatched_at=None)
                    )
                    await session.commit()
                return False
        finally:
            claim.set_result(None)
        try:
            async with asyncio.timeout(SEND_SECONDS):
                await conn.send_text(frame)
        except Exception as exc:
            if isinstance(exc, TimeoutError):
                conn.support_statement_sent = SUPPORT_UNSENT
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
