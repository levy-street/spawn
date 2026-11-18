"""Durable pacing and ordered, single-attempt delivery."""

import asyncio
import threading
import uuid
from contextlib import AsyncExitStack
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import delete, event

from spawn_server import (
    auth,
    main,
    support_log_dispatch,
    support_log_files,
)
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
from spawn_server.support_log_dispatch import SupportLogPump
from spawn_server.ws.broker import SUPPORT_UNSENT
from tests.test_support_consent import seed_statement, sign
from tests.test_support_log_registration import connected, pump, temporary_prebuilts
from tests.test_support_log_retention import lifespan_db
from tests.test_support_log_uploads import BODY, raw_request

__all__ = ["lifespan_db", "pump", "temporary_prebuilts"]


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


async def test_two_hosts_race_for_last_daily_request(file_sqlite_client):
    value, _ = await seed_statement()
    owner = value["account_id"]
    first, second = await capable(owner), await capable(owner)
    now = _utcnow()
    for _ in range(9):
        await history(owner, first, "failed", now)
    results = await asyncio.gather(
        request(owner, first, now=now), request(owner, second, now=now), return_exceptions=True
    )
    assert sum(isinstance(r, str) for r in results) == 1
    assert [r.reason for r in results if isinstance(r, RequestRefused)] == [
        RequestRefusal.ACCOUNT_LIMIT
    ]


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
        assert frames.get_nowait()["consent"] == value and frames.empty()
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
        assert frames.get_nowait()["consent"] == value
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
    # One reduction lookup and one indexed request page.
    assert len(sql) == 2
    async with engine.connect() as db:
        plan = await db.exec_driver_sql("EXPLAIN QUERY PLAN " + sql[1][0], sql[1][1])
        assert any(
            "SEARCH support_log_collections USING INDEX ix_support_log_state_requested" in row[-1]
            for row in plan
        )


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


async def test_change_after_scan_blocks_claim_until_new_statement_sent(app, pump, monkeypatch):
    value, key = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    queued = await request(owner, host)
    newer = sign({**value, "issued_at_ms": 1001}, key)
    original = support_log_dispatch.mark_dispatched

    async def change_before_claim(*args, **kwargs):
        await store_statement(owner, newer)
        return await original(*args, **kwargs)

    async with connected(app, owner, host, supports_support_log=True) as (_, frames, _):
        frames.get_nowait()
        with monkeypatch.context() as m:
            m.setattr(support_log_dispatch, "mark_dispatched", change_before_claim)
            await pump.run_once()
        assert frames.get_nowait()["consent"] == value and frames.empty()
        assert (await get_collection(queued)).state == "requested"
        await pump.run_once()
        assert frames.get_nowait()["consent"] == newer
        assert frames.get_nowait()["request_id"] == queued and frames.empty()


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
            await pump.sync_statements()
            assert frames.get_nowait()["consent"] == value
            broken = AsyncMock(side_effect=OSError)
            monkeypatch.setattr(ws, "send_text", broken)
            await pump.run_once(now=now)
            assert frames.get_nowait()["request_id"] == sent
            assert (await get_collection(failed)).state == "dispatched"
            await SupportLogPump().run_once(now=now)
            broken.assert_awaited_once()
            from spawn_server.support_log_retention import sweep_once

            store = support_log_files._store(str(tmp_path / "bundles"))
            try:
                await sweep_once(store, now=now + timedelta(minutes=5, seconds=1))
            finally:
                store.close()
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
        if not release.wait(30):
            raise TimeoutError
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
            assert frames.get_nowait()["type"] == "registered"
            assert (await asyncio.wait_for(frames.get(), 30))["consent"] == value
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
        await pump.sync_statements()
        for _, frames in deliveries:
            assert frames.get_nowait()["type"] == "host.support_log_consent"
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


async def test_expired_request_never_dispatched(app, pump):
    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    now = _utcnow()
    queued = await request(owner, host, now=now - timedelta(hours=25))
    async with connected(app, owner, host, supports_support_log=True) as (_, frames, _):
        frames.get_nowait()
        await pump.run_once(now=now)
        assert frames.get_nowait()["consent"] == value and frames.empty()
        assert (await get_collection(queued)).state == "requested"


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


async def test_off_then_on_between_passes_delivers_only_current_on(app, pump):
    value, key = await seed_statement()
    owner = value["account_id"]
    off = sign({**value, "enabled": False}, key)
    on = sign({**value, "issued_at_ms": 1001}, key)
    async with connected(app, owner, await capable(owner), supports_support_log=True) as (
        _,
        frames,
        _,
    ):
        frames.get_nowait()
        await pump.run_once()
        assert frames.get_nowait()["consent"] == value
        await store_statement(owner, off)
        await store_statement(owner, on)
        assert frames.empty()
        await pump.run_once()
        await pump.run_once()
        assert frames.get_nowait()["consent"] == on and frames.empty()


@pytest.mark.parametrize("failure", ["timeout", "error"])
async def test_failed_sync_retries_only_that_connection(app, pump, monkeypatch, failure):
    value, _ = await seed_statement()
    owner = value["account_id"]
    first, second = await capable(owner), await capable(owner)
    first_id, second_id = await request(owner, first), await request(owner, second)
    async with (
        connected(app, owner, first, supports_support_log=True) as (ws, frames, conn),
        connected(app, owner, second, supports_support_log=True) as (_, healthy, _),
    ):
        frames.get_nowait()
        healthy.get_nowait()
        # Expire the actual send context as soon as the stalled socket yields.
        entered = asyncio.Event()
        deadlines = {}
        stalled = []
        timeout = asyncio.timeout

        def capture(seconds):
            deadline = timeout(None)
            deadlines[asyncio.current_task()] = (seconds, deadline)
            return deadline

        async def stall(wire):
            stalled.append(asyncio.current_task())
            entered.set()
            await asyncio.Future()

        with monkeypatch.context() as m:
            if failure == "timeout":
                m.setattr(asyncio, "timeout", capture)
                m.setattr(ws, "send_text", stall)
            else:
                m.setattr(ws, "send_text", AsyncMock(side_effect=OSError))
            task = asyncio.create_task(pump.run_once())
            if failure == "timeout":
                await asyncio.wait_for(entered.wait(), 30)
                assert (await asyncio.wait_for(healthy.get(), 30))["consent"] == value
                seconds, deadline = deadlines[stalled[0]]
                assert seconds == 2
                deadline.reschedule(asyncio.get_running_loop().time())
            await asyncio.wait_for(task, 30)
        assert conn.support_statement_sent is SUPPORT_UNSENT and frames.empty()
        assert (await get_collection(first_id)).state == "requested"
        if failure == "error":
            assert healthy.get_nowait()["consent"] == value
        assert healthy.get_nowait()["request_id"] == second_id
        await pump.run_once()
        assert frames.get_nowait()["consent"] == value
        assert frames.get_nowait()["request_id"] == first_id
        assert healthy.empty() and frames.empty()


@pytest.mark.parametrize("page_size", [1, 4])
async def test_shutdown_during_paged_backlog_stops_claims(app, pump, monkeypatch, page_size):
    value, _ = await seed_statement()
    owner = value["account_id"]
    now = _utcnow()
    for n in (4, 3):
        await request(owner, await capable(owner), now=now - timedelta(seconds=n))
    monkeypatch.setattr(support_log_dispatch, "PAGE_SIZE", page_size)
    async with AsyncExitStack() as stack:
        hosts = []
        for n in (2, 1):
            host = await capable(owner)
            ws, frames, _ = await stack.enter_async_context(
                connected(app, owner, host, supports_support_log=True)
            )
            frames.get_nowait()
            hosts.append((ws, frames, await request(owner, host, now=now - timedelta(seconds=n))))
        await pump.sync_statements()
        for _, frames, _ in hosts:
            assert frames.get_nowait()["consent"] == value
        original = hosts[0][0].send_text

        async def stop(wire):
            await original(wire)
            pump.stop()

        monkeypatch.setattr(hosts[0][0], "send_text", stop)
        await pump.run_once(now=now)
        assert hosts[0][1].get_nowait()["request_id"] == hosts[0][2]
        assert hosts[1][1].empty() and (await get_collection(hosts[1][2])).state == "requested"


@pytest.mark.parametrize("close_by", ["withdrawal", "sweep"])
async def test_closed_uploads_still_reading_occupy_dispatch_capacity(
    app, file_sqlite_client, pump, tmp_path, close_by
):
    from spawn_server.routes import support_log
    from spawn_server.support_log import mark_dispatched
    from spawn_server.support_log_retention import sweep_once

    upload_app = main.create_app()
    upload_app.include_router(support_log.router)
    store = support_log_files._store(str(tmp_path / "bundles"))
    upload_app.state.support_log_store = store
    upload_app.state.support_log_pump = pump
    value, key = await seed_statement()
    owner = value["account_id"]
    other, _ = await seed_statement()
    next_owner = other["account_id"]
    next_host = await capable(next_owner)
    queued = await request(next_owner, next_host)
    readers, release = [], asyncio.Event()
    async with connected(app, next_owner, next_host, supports_support_log=True) as (_, frames, _):
        frames.get_nowait()
        try:
            for _ in range(2):
                host = await capable(owner)
                record = await request(owner, host)
                assert await mark_dispatched(record)
                entered = asyncio.Event()

                async def receive(entered=entered):
                    entered.set()
                    await release.wait()
                    return {"type": "http.request", "body": BODY, "more_body": False}

                readers.append(
                    asyncio.create_task(
                        raw_request(
                            upload_app,
                            record,
                            token=auth.issue_daemon_token(host, owner),
                            receive_body=receive,
                        )
                    )
                )
                await asyncio.wait_for(entered.wait(), 30)
            if close_by == "withdrawal":
                await store_statement(owner, sign({**value, "enabled": False}, key))
            else:
                await sweep_once(store, now=_utcnow() + timedelta(minutes=6))
            await pump.run_once()
            assert frames.get_nowait()["consent"] == other
            assert frames.empty() and (await get_collection(queued)).state == "requested"
        finally:
            release.set()
            results = await asyncio.wait_for(asyncio.gather(*readers), 30)
            store.close()
        assert [r[0] for r in results] == [409, 409]
        await pump.run_once()
        assert frames.get_nowait()["request_id"] == queued


async def test_replacement_during_claim_never_inherits_a_collect(
    app, file_sqlite_client, pump, monkeypatch
):
    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    queued = await request(owner, host)
    claimed, release = asyncio.Event(), asyncio.Event()
    original = support_log_dispatch.mark_dispatched

    async def hold_claim(*args, **kwargs):
        result = await original(*args, **kwargs)
        claimed.set()
        await release.wait()
        return result

    monkeypatch.setattr(support_log_dispatch, "mark_dispatched", hold_claim)
    async with connected(app, owner, host, supports_support_log=True) as (_, before, old_conn):
        before.get_nowait()
        task = asyncio.create_task(pump.run_once())
        await asyncio.wait_for(claimed.wait(), 30)
        assert before.get_nowait()["consent"] == value
        try:
            async with connected(app, owner, host, supports_support_log=True) as (
                _,
                after,
                new_conn,
            ):
                assert new_conn is not old_conn
                assert after.get_nowait()["type"] == "registered"
                release.set()
                await asyncio.wait_for(task, 30)
                await pump.run_once()
                assert after.get_nowait()["consent"] == value and after.empty() and before.empty()
                assert (await get_collection(queued)).state == "dispatched"
        finally:
            release.set()
            await asyncio.wait_for(task, 30)


async def test_removal_sends_same_sql_and_trust_frame_and_pump_reduces_next_pass(
    app, file_sqlite_client, monkeypatch
):
    traces = []
    engine = get_engine().sync_engine
    for enabled in (False, True):
        pump = SupportLogPump()
        value, _ = await seed_statement()
        owner = value["account_id"]
        key = value["signer_public_key"]
        host = await capable(owner)
        if enabled:
            monkeypatch.setattr(app.state, "support_log_pump", pump, raising=False)
            # Exercise the enabled branch of the former removal route as well.
            monkeypatch.setattr(app.state, "support_log_store", object(), raising=False)
        async with connected(app, owner, host, supports_support_log=True) as (ws, frames, _):
            frames.get_nowait()
            if enabled:
                sent = await request(owner, host)
                pending = await request(owner, await capable(owner))
                await pump.run_once()
                assert frames.get_nowait()["consent"] == value
                assert frames.get_nowait()["request_id"] == sent
            sql = []

            def capture(_conn, _cursor, statement, *_, sql=sql):
                sql.append(statement)

            event.listen(engine, "before_cursor_execute", capture)
            wire_start = len(ws.sent_text)
            try:
                response = await file_sqlite_client.post(
                    f"/api/browser-devices/{value['signer_device_id']}/revoke",
                    json={"expected_public_key": key},
                    headers={"authorization": f"Bearer {auth.issue_access_token(owner)}"},
                )
            finally:
                event.remove(engine, "before_cursor_execute", capture)
            assert response.status_code == 200 and response.json()["revoked_at"]
            assert frames.get_nowait()["revoked_browser_keys"] == [key] and frames.empty()
            wire = [
                frame.replace(key, "<key>").replace(owner, "<owner>")
                for frame in ws.sent_text[wire_start:]
            ]
            traces.append((sql, wire))
            if enabled:
                assert (await get_collection(sent)).state == "dispatched"
                assert (await get_collection(pending)).state == "requested"
                await pump.run_once()
                assert frames.get_nowait() == {"type": "host.support_log_consent", "consent": None}
                assert (await get_collection(sent)).state == "cancelled"
                assert (await get_collection(pending)).state == "cancelled"
    assert traces[0] == traces[1]


async def test_reduce_failure_isolated_to_one_account(app, pump, monkeypatch, caplog):
    requests = {}
    for _ in range(2):
        value, _ = await seed_statement()
        owner = value["account_id"]
        requests[owner] = await request(owner, await capable(owner))
    async with get_sessionmaker()() as db:
        await db.execute(delete(BrowserDevice))
        await db.commit()
    broken, healthy = requests
    original = support_log_dispatch.cancel_open

    async def fail_one(session, owner, now):
        if owner == broken:
            raise RuntimeError
        await original(session, owner, now)

    monkeypatch.setattr(support_log_dispatch, "cancel_open", fail_one)
    await pump.run_once()
    assert (await get_collection(requests[broken])).state == "requested"
    assert (await get_collection(requests[healthy])).state == "cancelled"
    assert "one account" in caplog.text


async def test_stalled_support_write_cannot_hold_up_ordinary_removal(
    app, file_sqlite_client, pump, monkeypatch
):
    import json

    value, _ = await seed_statement()
    owner = value["account_id"]
    entered, release = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(support_log_dispatch, "SEND_SECONDS", 30)
    async with connected(app, owner, await capable(owner), supports_support_log=True) as (
        ws,
        frames,
        conn,
    ):
        frames.get_nowait()
        send = ws.send_text

        async def stall_statement(wire):
            if json.loads(wire)["type"] == "host.support_log_consent":
                entered.set()
                await release.wait()
            await send(wire)

        monkeypatch.setattr(ws, "send_text", stall_statement)
        task = asyncio.create_task(pump.run_once())
        try:
            await asyncio.wait_for(entered.wait(), 30)
            assert not conn.send_lock.locked()
            assert get_engine().sync_engine.pool.checkedout() == 0
            response = await file_sqlite_client.post(
                f"/api/browser-devices/{value['signer_device_id']}/revoke",
                json={"expected_public_key": value["signer_public_key"]},
                headers={"authorization": f"Bearer {auth.issue_access_token(owner)}"},
            )
            assert response.status_code == 200
            assert frames.get_nowait()["type"] == "host.browser_pins"
        finally:
            release.set()
            await asyncio.wait_for(task, 30)
        assert frames.get_nowait()["consent"] == value
        await pump.run_once()
        assert frames.get_nowait()["consent"] is None and frames.empty()
