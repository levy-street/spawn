"""Bounded retention passes and explicit account cleanup, with no public route."""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timedelta

from sqlalchemy import delete, select, update

from .db import get_sessionmaker
from .models import SupportLogCollection as Collection
from .models import _utcnow
from .support_log import transition
from .support_log_files import finish_job

log = logging.getLogger("spawn.support_log")
BATCH = 100
INTERVAL_SECONDS = 15 * 60
CLEANUP_SECONDS = 2


async def delete_collected(store, record_id: str, *, now: datetime | None = None):
    # Caller holds the directory lock. The record is never changed before unlink succeeds.
    await asyncio.to_thread(store.remove, record_id)
    await transition(record_id, "collected", "deleted", now=now)


async def sweep_once(store, *, now: datetime | None = None, limit: int = BATCH):
    now = now or _utcnow()
    async with store.locked():
        async with get_sessionmaker()() as session:
            expired = (
                await session.scalars(
                    select(Collection.id)
                    .where(
                        Collection.state == "collected",
                        Collection.expires_at <= now,
                    )
                    .order_by(Collection.expires_at, Collection.id)
                    .limit(limit)
                )
            ).all()
        for record_id in expired:
            await delete_collected(store, record_id, now=now)

        for current, target, column, age in (
            ("requested", "expired", Collection.requested_at, timedelta(hours=24)),
            ("dispatched", "failed", Collection.dispatched_at, timedelta(minutes=5)),
        ):
            async with get_sessionmaker()() as session:
                candidates = (
                    select(Collection.id)
                    .where(
                        Collection.state == current,
                        column < now - age,
                    )
                    .order_by(column, Collection.id)
                    .limit(limit)
                )
                await session.execute(
                    update(Collection)
                    .where(
                        Collection.id.in_(candidates),
                        Collection.state == current,
                        column < now - age,
                    )
                    .values(state=target, completed_at=now)
                )
                await session.commit()

        async with get_sessionmaker()() as session:
            old = (
                await session.scalars(
                    select(Collection.id)
                    .where(
                        Collection.requested_at < now - timedelta(days=365),
                    )
                    .order_by(Collection.requested_at, Collection.id)
                    .limit(limit)
                )
            ).all()
        for record_id in old:
            await asyncio.to_thread(store.remove, record_id)
        if old:
            async with get_sessionmaker()() as session:
                await session.execute(
                    delete(Collection).where(
                        Collection.id.in_(old), Collection.requested_at < now - timedelta(days=365)
                    )
                )
                await session.commit()

        names = await asyncio.to_thread(
            store.old_entries, (now - timedelta(minutes=10)).timestamp(), limit
        )
        async with get_sessionmaker()() as session:
            retained = set(
                (
                    await session.scalars(
                        select(Collection.id).where(
                            Collection.state == "collected",
                            Collection.id.in_([name.removesuffix(".ndjson") for name in names]),
                        )
                    )
                ).all()
            )
        for name in names:
            if name.endswith(".ndjson") and name.removesuffix(".ndjson") in retained:
                continue
            await asyncio.to_thread(store.unlink, name)


async def remove_files(store, ids):
    # Try the lock once. A slow filesystem cannot delay the caller past
    # the deadline. The worker owns its locked descriptor until it finishes.
    try:
        deadline = time.monotonic() + CLEANUP_SECONDS
        async with asyncio.timeout(CLEANUP_SECONDS):
            await asyncio.to_thread(store.remove_committed, ids, deadline)
    except Exception:
        log.error("SPAWN D support log file cleanup failed; sweep will retry")


async def account_file_ids(session, user_id: str):
    try:
        ids = await session.scalars(
            select(Collection.id).where(
                Collection.owner_user_id == user_id,
                Collection.state.in_(("collected", "deleted", "dispatched")),
            )
        )
        return ids.all()
    except Exception:
        # A failed SELECT can abort the transaction on PostgreSQL. The route
        # has only read authorization and host IDs so far.
        await session.rollback()
        log.error("SPAWN D support log file lookup failed; sweep will retry")
        return []


async def run_sweeps(store, stop: asyncio.Event):
    try:
        while not stop.is_set():
            try:
                await finish_job(sweep_once(store))
            except Exception:
                log.error("SPAWN D support log retention pass failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=INTERVAL_SECONDS)
            except TimeoutError:
                pass
    finally:
        await asyncio.to_thread(store.close)


def start_sweeps(store):
    if store is None:
        return None
    stop = asyncio.Event()
    task = asyncio.create_task(run_sweeps(store, stop), name="support-log-retention")
    return stop, task


async def stop_sweeps(runner):
    if runner is not None:
        stop, task = runner
        stop.set()
        await task
