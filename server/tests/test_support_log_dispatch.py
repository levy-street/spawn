"""Durable pacing and ordered, single-attempt delivery."""

import asyncio
import json
import threading
import uuid
from contextlib import AsyncExitStack
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import delete, event

from spawn_server import auth, main, support_consent, support_log_dispatch, support_log_files
from spawn_server.config import get_settings
from spawn_server.db import get_engine, get_sessionmaker
from spawn_server.models import BrowserDevice, Host, SupportLogCollection, _utcnow
from spawn_server.support_consent import store_statement
from spawn_server.support_log import (
    RequestRefusal,
    RequestRefused,
    create_request,
    get_collection,
    transition,
)
from spawn_server.support_log_dispatch import SupportLogPump, support_log_consent_changed
from tests.test_support_consent import seed_statement, sign
from tests.test_support_log_registration import connected, pump
from tests.test_support_log_retention import age_record, lifespan_db
from tests.test_support_log_uploads import BODY, raw_request

__all__ = ["lifespan_db", "pump"]


async def request(owner, host, **kwargs):
    return await create_request(
        owner_user_id=owner,
        host_id=host,
        reason="Connection diagnosis",
        requested_by="operator",
        window_seconds=60,
        **kwargs,
    )


async def capable(owner):
    async with get_sessionmaker()() as db:
        host = Host(owner_user_id=owner, name=uuid.uuid4().hex, support_log_capable=True)
        db.add(host)
        await db.commit()
        return host.id


async def history(owner, host, state, now, **changes):
    async with get_sessionmaker()() as db:
        record = SupportLogCollection(
            owner_user_id=owner,
            host_id=host,
            host_name="",
            state=state,
            requested_at=now,
            reason="Diagnosis",
            requested_by="operator",
            window_seconds=60,
            **changes,
        )
        db.add(record)
        await db.commit()
        return record.id


async def test_concurrent_operator_admission_has_one_winner(file_sqlite_client):
    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    results = await asyncio.gather(
        request(owner, host), request(owner, host), return_exceptions=True
    )
    assert len([r for r in results if isinstance(r, str)]) == 1
    assert [r.reason for r in results if isinstance(r, RequestRefused)] == [RequestRefusal.OPEN]


@pytest.mark.parametrize(
    ("limit", "refusal"),
    [
        ("open_requested", RequestRefusal.OPEN),
        ("open_dispatched", RequestRefusal.OPEN),
        ("host_interval", RequestRefusal.HOST_INTERVAL),
        ("account", RequestRefusal.ACCOUNT_LIMIT),
        ("late_dispatches", RequestRefusal.ACCOUNT_LIMIT),
        ("capacity", RequestRefusal.CAPACITY),
    ],
)
async def test_admission_and_fresh_pump_read_each_limit(app, pump, limit, refusal):
    value, _ = await seed_statement()
    owner = value["account_id"]
    host, other = await capable(owner), await capable(owner)
    now = _utcnow()
    async with connected(app, owner, host, supports_support_log=True) as (_, frames, _):
        assert frames.get_nowait()["type"] == "registered"
        if limit.startswith("open"):
            await history(owner, host, limit.removeprefix("open_"), now)
        elif limit == "host_interval":
            await history(
                owner,
                host,
                "declined",
                now - timedelta(days=1),
                dispatched_at=now - timedelta(minutes=5) + timedelta(microseconds=1),
            )
        elif limit == "capacity":
            other_account, _ = await seed_statement()
            for _ in range(2):
                await history(
                    other_account["account_id"],
                    await capable(other_account["account_id"]),
                    "dispatched",
                    now,
                    dispatched_at=now,
                )
        else:
            for _ in range(10):
                await history(
                    owner,
                    other,
                    "failed",
                    now - timedelta(hours=25 if limit == "late_dispatches" else 23),
                    dispatched_at=now - timedelta(hours=23) if limit == "late_dispatches" else None,
                )
        with pytest.raises(RequestRefused) as caught:
            await request(owner, host, now=now)
        assert caught.value.reason == refusal
        # Inject a pre-existing request as if the limit filled after admission.
        queued = await history(owner, host, "requested", now)
        restarted = SupportLogPump()
        await restarted.run_once(now=now)
        assert frames.empty()
        assert (await get_collection(queued)).state == "requested"


async def test_pacing_boundaries_and_two_slots_across_accounts(app, pump):
    now = _utcnow()
    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    for _ in range(10):
        await history(
            owner,
            host,
            "declined",
            now - timedelta(hours=24),
            dispatched_at=now - timedelta(hours=24),
        )
    await history(
        owner, host, "failed", now - timedelta(hours=25), dispatched_at=now - timedelta(minutes=5)
    )
    queued = await request(owner, host, now=now)
    async with connected(app, owner, host, supports_support_log=True) as (_, frames, _):
        frames.get_nowait()
        await SupportLogPump().run_once(now=now)
        assert frames.get_nowait()["request_id"] == queued
        assert (await get_collection(queued)).state == "dispatched"


async def test_scan_once_empty_uses_state_index(app, pump):
    sql = []

    def capture(_conn, _cursor, statement, params, _context, _many):
        sql.append((statement, params))

    engine = get_engine()
    if engine.dialect.name != "sqlite":
        pytest.skip("SQLite query plan")
    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    try:
        await pump.run_once()
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)
    assert len(sql) == 1
    async with engine.connect() as db:
        plan = await db.exec_driver_sql("EXPLAIN QUERY PLAN " + sql[0][0], sql[0][1])
        assert any("ix_support_log_state_requested" in row[-1] for row in plan)


@pytest.mark.parametrize("off", ["signed", "removed"])
async def test_offline_and_incapable_wait_then_withdrawal_cancels(app, pump, off):
    value, key = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    queued = await request(owner, host)
    await pump.run_once()
    assert (await get_collection(queued)).state == "requested"
    async with connected(app, owner, host) as (_, frames, _):
        assert "support_log_consent" not in frames.get_nowait()
        await pump.run_once()
        assert frames.empty() and (await get_collection(queued)).state == "requested"
        if off == "signed":
            await store_statement(owner, sign({**value, "enabled": False}, key))
        else:
            async with get_sessionmaker()() as db:
                await db.execute(delete(BrowserDevice))
                await db.commit()
        await pump.run_once()
        assert frames.empty() and (await get_collection(queued)).state == "cancelled"


async def test_change_races_collect_and_only_current_statement_can_dispatch(app, pump, monkeypatch):
    value, key = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    record_id = await request(owner, host)
    newer = sign({**value, "issued_at_ms": 1001}, key)
    async with connected(app, owner, host, supports_support_log=True) as (ws, frames, conn):
        assert frames.get_nowait()["support_log_consent"] == value
        await store_statement(owner, newer)
        await pump.run_once()  # The signed on changed, but its push has not started.
        assert frames.empty() and (await get_collection(record_id)).state == "requested"
        started, release, dispatch_waiting = asyncio.Event(), asyncio.Event(), asyncio.Event()
        send = ws.send_text

        async def held_push(wire):
            if json.loads(wire)["type"] == "host.support_log_consent":
                started.set()
                await release.wait()
            await send(wire)

        monkeypatch.setattr(ws, "send_text", held_push)
        monkeypatch.setattr("spawn_server.ws.daemon.HOST_EXTERNAL_EFFECT_TIMEOUT_SECONDS", 30)
        push = asyncio.create_task(support_log_consent_changed(app, owner))
        await asyncio.wait_for(started.wait(), 30)

        def observe_lock(owner):
            dispatch_waiting.set()
            return support_consent.delivery_lock(owner)

        monkeypatch.setattr(support_log_dispatch, "delivery_lock", observe_lock)
        dispatch = asyncio.create_task(pump.run_once())
        try:
            await asyncio.wait_for(dispatch_waiting.wait(), 30)
            assert frames.empty() and not dispatch.done()
        finally:
            release.set()
        await asyncio.wait_for(asyncio.gather(push, dispatch), 30)
        assert conn.support_enabled_sent_ms == newer["issued_at_ms"]
        assert frames.get_nowait() == {"type": "host.support_log_consent", "consent": newer}
        assert frames.get_nowait() == {
            "type": "support_log.collect",
            "request_id": record_id,
            "since_seconds": 60,
        }
        await SupportLogPump().run_once()
        assert frames.empty()


async def test_failed_send_is_never_retried_and_next_record_proceeds(
    app, pump, monkeypatch, tmp_path
):
    value, _ = await seed_statement()
    owner = value["account_id"]
    first, second = await capable(owner), await capable(owner)
    now = _utcnow()
    failed = await request(owner, first, now=now - timedelta(seconds=1))
    sent = await request(owner, second, now=now)
    async with connected(app, owner, first, supports_support_log=True) as (ws, _, _):
        async with connected(app, owner, second, supports_support_log=True) as (_, frames, _):
            frames.get_nowait()
            broken = AsyncMock(side_effect=OSError)
            monkeypatch.setattr(ws, "send_text", broken)
            await pump.run_once(now=now)
            assert frames.get_nowait()["request_id"] == sent
            assert (await get_collection(failed)).state == "dispatched"
            await SupportLogPump().run_once(now=now)
            broken.assert_awaited_once()
            from spawn_server.support_log_retention import sweep_once

            await sweep_once(
                support_log_files.SupportLogFiles(tmp_path),
                now=now + timedelta(minutes=5, seconds=1),
            )
            assert (await get_collection(failed)).state == "failed"


async def test_run_survives_a_failed_iteration_and_wakes_without_delay(pump, monkeypatch, caplog):
    first, second = asyncio.Event(), asyncio.Event()

    async def run_once():
        if not first.is_set():
            first.set()
            raise RuntimeError
        second.set()

    monkeypatch.setattr(pump, "run_once", run_once)
    assert support_log_dispatch.INTERVAL_SECONDS == 10
    task = asyncio.create_task(pump.run())
    try:
        await asyncio.wait_for(first.wait(), 30)
        pump.wake.set()
        await asyncio.wait_for(second.wait(), 30)
        assert "dispatch pass failed" in caplog.text
    finally:
        pump.stop()
        await asyncio.wait_for(task, 30)


@pytest.mark.parametrize("usable", [True, False])
async def test_lifespan_waits_for_worker_and_starts_only_ready_pump(
    lifespan_db,
    tmp_path,
    monkeypatch,
    usable,
):
    app = main.create_app()
    loop = asyncio.get_running_loop()
    entered, started, running = asyncio.Event(), asyncio.Event(), asyncio.Event()
    release, shutdown = threading.Event(), asyncio.Event()
    root = tmp_path / "bundles"
    monkeypatch.setattr(get_settings(), "support_log_dir", str(root))
    original = support_log_files._store

    def probe(path):
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(30)
        if not usable:
            raise OSError
        return original(path)

    monkeypatch.setattr(support_log_files, "_store", probe)

    async def pass_once(self):
        running.set()

    monkeypatch.setattr(SupportLogPump, "run_once", pass_once)

    async def serve():
        async with main.lifespan(app):
            started.set()
            await shutdown.wait()

    task = asyncio.create_task(serve())
    try:
        await asyncio.wait_for(entered.wait(), 30)
        assert not started.is_set() and not running.is_set()
        assert support_log_files.get_store(app) is None
        release.set()
        await asyncio.wait_for(started.wait(), 30)
        if usable:
            await asyncio.wait_for(running.wait(), 30)
        assert hasattr(app.state, "support_log_pump") == usable
        assert running.is_set() == usable
    finally:
        release.set()
        shutdown.set()
        await asyncio.wait_for(task, 30)
    assert not hasattr(app.state, "support_log_pump")
    assert not any(t.get_name() == "support-log-dispatch" for t in asyncio.all_tasks())


@pytest.mark.parametrize("refusal", [False, True])
async def test_registration_wakes_real_pump_and_daemon_posts_outcome(
    lifespan_db,
    tmp_path,
    monkeypatch,
    refusal,
):
    app = main.create_app()
    monkeypatch.setattr(get_settings(), "support_log_dir", str(tmp_path / "bundles"))
    # The only wake after the startup pass must come from this registration.
    monkeypatch.setattr(support_log_dispatch, "INTERVAL_SECONDS", 3600)
    idle = asyncio.Event()
    original = SupportLogPump.run_once

    async def observed(self):
        await original(self)
        idle.set()

    monkeypatch.setattr(SupportLogPump, "run_once", observed)
    async with main.lifespan(app):
        await asyncio.wait_for(idle.wait(), 30)
        value, _ = await seed_statement()
        owner = value["account_id"]
        host = await capable(owner)
        queued = await request(owner, host)
        token = auth.issue_daemon_token(host, owner)
        async with connected(app, owner, host, supports_support_log=True) as (_, frames, _):
            assert frames.get_nowait()["support_log_consent"] == value
            collect = await asyncio.wait_for(frames.get(), 30)
            assert collect == {
                "type": "support_log.collect",
                "request_id": queued,
                "since_seconds": 60,
            }
            assert (await get_collection(queued)).state == "dispatched"
            extra = {"content-type": "application/json"} if refusal else None
            status, _, _ = await raw_request(
                app,
                queued,
                token=token,
                extra=extra,
                body=b'{"declined":"no_log"}' if refusal else BODY,
            )
            assert status == 204
            result = await get_collection(queued)
            if refusal:
                assert result.state == "declined" and result.decline_code == "no_log"
            else:
                assert result.state == "collected"
                assert app.state.support_log_store.path(queued).read_bytes() == BODY


async def test_concurrent_scans_share_two_slots_and_never_send_twice(
    app,
    file_sqlite_client,
    pump,
):
    now = _utcnow()
    deliveries = []
    async with AsyncExitStack() as stack:
        for offset in (3, 2, 1):
            value, _ = await seed_statement()
            owner = value["account_id"]
            host = await capable(owner)
            _, frames, _ = await stack.enter_async_context(
                connected(app, owner, host, supports_support_log=True)
            )
            frames.get_nowait()
            queued = await request(owner, host, now=now - timedelta(seconds=offset))
            deliveries.append((queued, frames))
        await asyncio.gather(pump.run_once(now=now), SupportLogPump().run_once(now=now))
        for queued, frames in deliveries[:2]:
            assert frames.get_nowait()["request_id"] == queued and frames.empty()
            assert (await get_collection(queued)).state == "dispatched"
        queued, frames = deliveries[-1]
        assert frames.empty() and (await get_collection(queued)).state == "requested"
        assert await transition(deliveries[0][0], "dispatched", "declined", decline_code="no_log")
        await SupportLogPump().run_once(now=now)
        assert frames.get_nowait()["request_id"] == queued
        assert all(f.empty() for _, f in deliveries)


async def test_store_racing_a_claimed_send_has_no_write_transaction_to_wait_for(
    app,
    file_sqlite_client,
    pump,
    monkeypatch,
):
    value, key = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    queued = await request(owner, host)
    off = sign({**value, "enabled": False}, key)
    started, release, store_waiting = asyncio.Event(), asyncio.Event(), asyncio.Event()
    monkeypatch.setattr("spawn_server.ws.daemon.HOST_EXTERNAL_EFFECT_TIMEOUT_SECONDS", 30)
    async with connected(app, owner, host, supports_support_log=True) as (ws, frames, _):
        assert frames.get_nowait()["support_log_consent"] == value
        send = ws.send_text

        async def held_send(wire):
            if json.loads(wire)["type"] == "support_log.collect":
                started.set()
                await release.wait()
            await send(wire)

        monkeypatch.setattr(ws, "send_text", held_send)
        dispatch = asyncio.create_task(pump.run_once())
        try:
            await asyncio.wait_for(started.wait(), 30)
            assert (await get_collection(queued)).state == "dispatched"
            lock = support_consent.delivery_lock

            def observe_store(account):
                if account == owner:
                    store_waiting.set()
                return lock(account)

            monkeypatch.setattr(support_consent, "delivery_lock", observe_store)
            withdrawal = asyncio.create_task(store_statement(owner, off))
            await asyncio.wait_for(store_waiting.wait(), 30)
            # An unrelated writer can commit while this socket is held.
            await asyncio.wait_for(capable(owner), 30)
            assert not withdrawal.done()
        finally:
            release.set()
        await asyncio.wait_for(asyncio.gather(withdrawal, dispatch), 30)
        await support_log_consent_changed(app, owner)
        assert frames.get_nowait()["request_id"] == queued
        assert frames.get_nowait() == {"type": "host.support_log_consent", "consent": off}


async def test_expired_request_never_dispatched_and_failed_push_does_not_enable(
    app, pump, monkeypatch
):
    value, key = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    now = _utcnow()
    queued = await request(owner, host, now=now - timedelta(hours=25))
    async with connected(app, owner, host, supports_support_log=True) as (ws, frames, conn):
        frames.get_nowait()
        await pump.run_once(now=now)
        assert frames.empty() and (await get_collection(queued)).state == "requested"
        await age_record(queued, requested_at=now)
        await store_statement(owner, sign({**value, "issued_at_ms": 1001}, key))
        monkeypatch.setattr(ws, "send_text", AsyncMock(side_effect=OSError))
        await support_log_consent_changed(app, owner)
        assert conn.support_enabled_sent_ms is None
        await pump.run_once(now=now)
        assert frames.empty() and (await get_collection(queued)).state == "requested"


async def test_periodic_pass_uses_ten_second_timer(pump, monkeypatch):
    passes, timeouts = [], []

    async def tick(awaitable, *, timeout):
        timeouts.append(timeout)
        awaitable.close()
        raise TimeoutError

    async def scan():
        passes.append(True)
        if len(passes) == 2:
            pump.stop()

    monkeypatch.setattr(pump, "run_once", scan)
    monkeypatch.setattr(asyncio, "wait_for", tick)
    await pump.run()
    assert timeouts == [10] and len(passes) == 2


async def test_full_registration_over_wire_limit_preserves_fields_and_holds_collect(
    app, pump, monkeypatch
):
    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    queued = await request(owner, host)
    roster = [str(uuid.uuid4()) for _ in range(1800)]
    monkeypatch.setattr(
        "spawn_server.ws.daemon._live_browser_device_ids", AsyncMock(return_value=roster)
    )
    async with connected(app, owner, host, supports_support_log=True) as (_, frames, conn):
        registered = frames.get_nowait()
        assert (
            registered["browser_device_ids"] == roster
            and registered["support_log_consent"] == value
        )
        assert conn.support_oversized_frame_sent
        await pump.run_once()
        assert frames.empty() and (await get_collection(queued)).state == "requested"
