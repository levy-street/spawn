"""Bounded sweeps, withdrawal, account deletion and inert default behavior."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import threading
import uuid
from datetime import UTC, datetime, timedelta
from functools import partial
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
import pytest_asyncio
from sqlalchemy import delete, update

from spawn_server import auth, main, support_log_cli, support_log_files, support_log_retention
from spawn_server.config import get_settings
from spawn_server.db import Base, dispose_engine, get_sessionmaker, init_engine
from spawn_server.models import AuthIdentity, Host, SupportLogCollection, User
from spawn_server.support_consent import get_statement, store_statement
from spawn_server.support_log import create_request, get_collection, mark_dispatched, transition
from spawn_server.support_log_files import get_store
from spawn_server.support_log_retention import (
    remove_files,
    start_sweeps,
    sweep_once,
)
from spawn_server.ws.broker import Broker, DaemonConn
from tests.test_support_consent import seed_statement, sign
from tests.test_support_log_uploads import (
    BODY,
    app,
    bundle_entries,
    post,
    raw_request,
    seed_request,
    setup_request,
    storage,
    url,
)

# Re-export this shared fixture without introducing a global test dependency.
__all__ = ["app", "storage"]

pytestmark = pytest.mark.usefixtures("inprocess_pubsub")


async def age_record(record_id, **changes):
    async with get_sessionmaker()() as session:
        await session.execute(
            update(SupportLogCollection)
            .where(SupportLogCollection.id == record_id)
            .values(**changes)
        )
        await session.commit()


async def test_every_sweep_rule_and_grace(client, storage):
    now = datetime.now(UTC)
    collected, token, *_ = await setup_request()
    assert (await post(client, collected, token)).status_code == 204
    await age_record(collected, expires_at=now - timedelta(seconds=1))
    requested, *_ = await setup_request(state="requested")
    await age_record(requested, requested_at=now - timedelta(hours=24, seconds=1))
    dispatched, *_ = await setup_request()
    await age_record(dispatched, dispatched_at=now - timedelta(minutes=5, seconds=1))
    ancient, token, *_ = await setup_request()
    assert (await post(client, ancient, token)).status_code == 204
    await age_record(ancient, requested_at=now - timedelta(days=365, seconds=1))
    fresh_requested, *_ = await setup_request(state="requested")
    fresh_dispatched, *_ = await setup_request()
    retained, token, *_ = await setup_request()
    assert (await post(client, retained, token)).status_code == 204
    old_time = (now - timedelta(minutes=10, seconds=1)).timestamp()
    os.utime(storage.path(retained), (old_time, old_time))
    orphan = storage.path(str(uuid.uuid4()))
    orphan.write_bytes(BODY)
    os.utime(orphan, (old_time, old_time))
    fresh_orphan = storage.path(str(uuid.uuid4()))
    fresh_orphan.write_bytes(BODY)
    temporary = storage.root / f".upload-{uuid.uuid4()}.tmp"
    temporary.write_bytes(b"partial")
    os.utime(temporary, (old_time, old_time))
    await sweep_once(storage, now=now)
    assert (await get_collection(collected)).state == "deleted"
    assert not storage.path(collected).exists()
    assert (await get_collection(requested)).state == "expired"
    assert (await get_collection(dispatched)).state == "failed"
    assert await get_collection(ancient) is None
    assert not storage.path(ancient).exists()
    assert (await get_collection(fresh_requested)).state == "requested"
    assert (await get_collection(fresh_dispatched)).state == "dispatched"
    assert (await get_collection(retained)).state == "collected"
    assert storage.path(retained).read_bytes() == BODY
    assert not orphan.exists() and not temporary.exists()
    assert fresh_orphan.exists()


async def test_sweep_bounds_and_cursor_make_progress(client, storage):
    now = datetime.now(UTC)
    records = []
    for _ in range(3):
        record_id, *_ = await setup_request(state="requested")
        await age_record(record_id, requested_at=now - timedelta(days=2))
        records.append(record_id)
    fresh = storage.root / ".fresh"
    fresh.touch()
    old = storage.path(str(uuid.uuid4()))
    old.touch()
    stamp = (now - timedelta(hours=1)).timestamp()
    os.utime(old, (stamp, stamp))
    await sweep_once(storage, now=now, limit=1)
    states = [(await get_collection(record_id)).state for record_id in records]
    assert states.count("expired") == 1
    await sweep_once(storage, now=now, limit=1)
    await sweep_once(storage, now=now, limit=1)
    assert all([(await get_collection(record_id)).state == "expired" for record_id in records])
    assert not old.exists() and fresh.exists()


async def test_orphans_do_not_follow_symlinks_or_remove_subdirectories(client, storage, tmp_path):
    outside = tmp_path / "outside"
    outside.write_bytes(b"preserved")
    link = storage.path(str(uuid.uuid4()))
    link.symlink_to(outside)
    stamp = (datetime.now(UTC) - timedelta(hours=1)).timestamp()
    os.utime(link, (stamp, stamp), follow_symlinks=False)
    subdirectory = storage.root / "nested"
    subdirectory.mkdir()
    os.utime(subdirectory, (stamp, stamp))
    await sweep_once(storage)
    assert not link.exists() and outside.read_bytes() == b"preserved"
    assert subdirectory.exists()


async def test_deletion_failure_keeps_record_retryable(client, storage, monkeypatch):
    record_id, token, *_ = await setup_request()
    assert (await post(client, record_id, token)).status_code == 204
    await age_record(record_id, expires_at=datetime.now(UTC) - timedelta(days=1))
    original = storage.remove
    monkeypatch.setattr(storage, "remove", lambda _id: (_ for _ in ()).throw(OSError("injected")))
    with pytest.raises(OSError):
        await sweep_once(storage)
    assert (await get_collection(record_id)).state == "collected"
    assert storage.path(record_id).exists()
    monkeypatch.setattr(storage, "remove", original)
    await sweep_once(storage)
    assert (await get_collection(record_id)).state == "deleted"


async def test_turning_off_cancels_open_and_deletes_collected(client, storage):
    record_id, token, statement, key, host = await setup_request()
    assert (await post(client, record_id, token)).status_code == 204
    requested = await seed_request(host)
    dispatched = await seed_request(host)
    assert await mark_dispatched(dispatched)
    other, other_token, *_ = await setup_request()
    assert (await post(client, other, other_token)).status_code == 204
    off = sign({**statement, "enabled": False}, key)
    await store_statement(statement["account_id"], off, store=storage)
    assert await get_statement(statement["account_id"]) == off
    assert (await get_collection(record_id)).state == "deleted"
    assert (await get_collection(requested)).state == "cancelled"
    assert (await get_collection(dispatched)).state == "cancelled"
    assert not storage.path(record_id).exists()
    assert storage.path(other).exists()
    assert not await mark_dispatched(requested)


async def linked_user(owner):
    async with get_sessionmaker()() as session:
        user = await session.get(User, owner)
        session.add(
            AuthIdentity(
                user_id=user.id,
                provider="test",
                provider_user_id=uuid.uuid4().hex,
                email=user.email,
            )
        )
        await session.commit()
    return user


@pytest.fixture
def broker(monkeypatch):
    broker = Broker()
    monkeypatch.setattr("spawn_server.routes.auth.get_broker", lambda: broker)
    return broker


@pytest.mark.parametrize("failure", [None, "unlink", "marker", "lock", "mode", "lookup", "timeout"])
async def test_account_deletion_removes_files_and_cascades(
    client, storage, broker, monkeypatch, caplog, failure
):
    record_id, token, statement, _key, host = await setup_request()
    assert (await post(client, record_id, token)).status_code == 204
    other, other_token, *_ = await setup_request()
    assert (await post(client, other, other_token)).status_code == 204
    user = await linked_user(statement["account_id"])
    socket = Mock(close=AsyncMock())
    await broker.register_daemon(DaemonConn(host.id, user.id, socket))
    with monkeypatch.context() as m:
        if failure == "unlink":
            m.setattr(support_log_files, "_unlink", Mock(side_effect=OSError))
        elif failure == "marker":
            os.removexattr(storage.fd, support_log_files.STORE_ATTRIBUTE)
        elif failure == "mode":
            os.fchmod(storage.fd, 0o750)
        elif failure == "lock":
            support_log_files.fcntl.flock(storage.fd, support_log_files.fcntl.LOCK_EX)
        elif failure == "lookup":
            from sqlalchemy.ext.asyncio import AsyncSession

            m.setattr(AsyncSession, "scalars", AsyncMock(side_effect=RuntimeError))
        elif failure == "timeout":
            loop = asyncio.get_running_loop()
            entered, finished = asyncio.Event(), asyncio.Event()
            release = threading.Event()
            deadline = asyncio.timeout(None)
            timeout = asyncio.timeout

            def held_worker(parent, ids, cutoff, stopping):
                try:
                    loop.call_soon_threadsafe(entered.set)
                    release.wait(30)
                finally:
                    os.close(parent)
                    loop.call_soon_threadsafe(finished.set)

            m.setattr(support_log_files, "_remove_committed", held_worker)
            m.setattr(asyncio, "timeout", lambda delay: deadline if delay == 2 else timeout(delay))
        try:
            response = await asyncio.wait_for(
                client.post(
                    "/api/account/delete",
                    json={"confirm_email": user.email},
                    headers={"authorization": f"Bearer {auth.issue_access_token(user.id)}"},
                ),
                30,
            )
            assert response.status_code == 204 and response.content == b""
            assert 'spawn_session=""' in response.headers["set-cookie"]
            assert "Max-Age=0" in response.headers["set-cookie"]
            if failure == "timeout":
                await asyncio.wait_for(entered.wait(), 30)
                assert not finished.is_set() and storage.path(record_id).exists()
                deadline.reschedule(loop.time())
            waiters = [task for task in storage.cleanup_tasks if isinstance(task, asyncio.Task)]
            await asyncio.wait_for(asyncio.gather(*waiters), 30)
            if failure == "timeout":
                assert len(storage.cleanup_tasks) == 1 and not finished.is_set()
        finally:
            if failure == "timeout":
                release.set()
                await asyncio.wait_for(finished.wait(), 30)
                await asyncio.wait_for(asyncio.gather(*storage.cleanup_tasks), 30)
            elif failure == "marker":
                os.setxattr(storage.fd, support_log_files.STORE_ATTRIBUTE, support_log_files.STORE_VERSION)
            elif failure == "mode":
                os.fchmod(storage.fd, 0o700)
            elif failure == "lock":
                support_log_files.fcntl.flock(storage.fd, support_log_files.fcntl.LOCK_UN)
    socket.close.assert_awaited_once_with(code=4001, reason="host revoked")
    assert await get_collection(record_id) is None
    assert await get_statement(user.id) is None
    assert storage.path(record_id).exists() == bool(failure)
    assert storage.path(other).exists()
    async with get_sessionmaker()() as session:
        assert await session.get(Host, host.id) is None
        assert await session.get(User, user.id) is None
    if failure:
        assert caplog.text.count("sweep will retry") == 1
        await sweep_once(storage, now=datetime.now(UTC) + timedelta(minutes=11))
        assert not storage.path(record_id).exists()
        assert storage.path(other).exists()


@pytest.mark.parametrize("first_close", ["succeeds", "raises", "hangs"])
async def test_account_deletion_closes_both_daemons_after_response(app, broker, first_close):
    statement, _ = await seed_statement()
    user = await linked_user(statement["account_id"])
    hosts = [Host(owner_user_id=user.id, name="") for _ in range(2)]
    async with get_sessionmaker()() as session:
        session.add_all(hosts)
        await session.commit()

    close_started, release_close = asyncio.Event(), asyncio.Event()

    async def close(**kwargs):
        if close_started.is_set():
            return
        close_started.set()
        await release_close.wait()
        if first_close == "raises":
            raise RuntimeError

    sockets = [Mock(close=AsyncMock(side_effect=close)) for _ in hosts]
    for host, socket in zip(hosts, sockets, strict=True):
        await broker.register_daemon(DaemonConn(host.id, user.id, socket))

    # The in-process HTTP client waits for background tasks as well. Observe
    # what the app actually sent while the first close is still blocked.
    sent = []

    async def observe_response(scope, receive, send):
        async def observe_send(message):
            await send(message)
            sent.append(message)

        await app(scope, receive, observe_send)

    request = asyncio.create_task(
        raw_request(
            observe_response,
            "",
            path="/api/account/delete",
            token=auth.issue_access_token(user.id),
            body=json.dumps({"confirm_email": user.email}).encode(),
            extra={"content-type": "application/json"},
        )
    )
    try:
        await asyncio.wait_for(close_started.wait(), 30)
        assert not request.done()
        start, body = sent
        assert start["type"] == "http.response.start" and start["status"] == 204
        cookie = dict(start["headers"])[b"set-cookie"]
        assert b'spawn_session=""' in cookie and b"Max-Age=0" in cookie
        assert body["type"] == "http.response.body" and body["body"] == b""
        assert not body.get("more_body", False)
    finally:
        if first_close != "hangs":
            release_close.set()
        await asyncio.wait_for(request, 30)
    for socket in sockets:
        socket.close.assert_awaited_once_with(code=4001, reason="host revoked")


async def test_stalled_cleanup_leaves_later_deletions_to_the_orphan_sweep(client, storage, monkeypatch):
    requests = []
    bundles = []
    for _ in range(10):
        record, token, statement, *_ = await setup_request()
        assert (await post(client, record, token)).status_code == 204
        user = await linked_user(statement["account_id"])
        requests.append(dict(
            json={"confirm_email": user.email},
            headers={"authorization": f"Bearer {auth.issue_access_token(user.id)}"},
        ))
        bundles.append(storage.path(record))

    loop = asyncio.get_running_loop()
    entered, release = asyncio.Event(), threading.Event()
    remove = support_log_files._remove_committed

    def stall(*args):
        loop.call_soon_threadsafe(entered.set)
        release.wait(30)
        remove(*args)

    timeout = asyncio.timeout
    deadline = timeout(None)
    monkeypatch.setattr(asyncio, "timeout", lambda delay: deadline if delay == 2 else timeout(delay))
    monkeypatch.setattr(support_log_files, "monotonic", lambda: 0)
    monkeypatch.setattr(support_log_files, "_remove_committed", stall)
    dup = Mock(wraps=os.dup)
    submit = Mock(wraps=storage.submit_cleanup)
    monkeypatch.setattr(os, "dup", dup)
    monkeypatch.setattr(storage, "submit_cleanup", submit)
    try:
        for i, credentials in enumerate(requests):
            result = await client.post("/api/account/delete", **credentials)
            assert result.status_code == 204 and result.content == b""
            assert 'spawn_session=""' in result.headers["set-cookie"]
            assert "Max-Age=0" in result.headers["set-cookie"]
            if i == 0:
                await asyncio.wait_for(entered.wait(), 30)
                (waiter,) = (job for job in storage.cleanup_tasks if isinstance(job, asyncio.Task))
                deadline.reschedule(loop.time())
                await asyncio.wait_for(waiter, 30)
        dup.assert_called_once_with(storage.fd)
        submit.assert_called_once()
        (worker,) = storage.cleanup_tasks
        assert not worker.done() and all(bundle.exists() for bundle in bundles)
    finally:
        release.set()
        await asyncio.wait_for(asyncio.gather(*storage.cleanup_tasks), 30)
    assert not bundles[0].exists() and all(bundle.exists() for bundle in bundles[1:])
    await sweep_once(storage, now=datetime.now(UTC) + timedelta(minutes=11))
    assert not bundle_entries(storage)


@pytest_asyncio.fixture
async def lifespan_db(tmp_path, monkeypatch, sansio_launch):
    monkeypatch.setattr(get_settings(), "database_url", f"sqlite+aiosqlite:///{tmp_path / 'app.db'}")
    engine = init_engine()
    try:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
    finally:
        await dispose_engine()


@pytest.fixture
def no_sweeps(monkeypatch):
    monkeypatch.setattr(main, "start_sweeps", lambda _: pytest.fail("unexpected support log sweeps"))


async def assert_unknown_paths(app):
    status, body, _ = await raw_request(app, "", method="GET", path="/openapi.json")
    assert status == 200
    assert not any("support-log" in path for path in json.loads(body)["paths"])
    for method, suffix in (("POST", ""), ("GET", ""), ("HEAD", ""), ("POST", "/")):
        result = await raw_request(app, "", method=method, path=url(uuid.uuid4()) + suffix)
        unknown = await raw_request(app, "", method=method, path=f"/unknown/{uuid.uuid4()}{suffix}")
        assert result == unknown
        assert result[0] == 404 and result[2] == 0


async def test_disabled_routes_match_unknown_paths(lifespan_db, no_sweeps, monkeypatch, caplog):
    monkeypatch.setattr(get_settings(), "support_log_dir", None)
    monkeypatch.setattr(support_log_files, "_uses_sansio", Mock(side_effect=AssertionError))
    monkeypatch.setattr(support_log_files, "_store", lambda _: pytest.fail("unexpected store"))
    caplog.set_level(logging.INFO, logger="spawn.support_log")
    app = main.create_app()
    async with app.router.lifespan_context(app):
        assert get_store(app) is None and not hasattr(app.state, "support_log_pump")
        await assert_unknown_paths(app)
    assert not any(r.name == "spawn.support_log" for r in caplog.records)


def test_application_starts_without_unix_support(tmp_path):
    env = {
        **os.environ,
        "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
        "SPAWN_DATABASE_URL": f"sqlite+aiosqlite:///{tmp_path / 'startup.db'}",
        "SPAWN_SUPPORT_LOG_DIR": "",
        "SPAWN_USE_INPROCESS_PUBSUB": "1",
    }
    code = """
import asyncio
import os
import sys

sys.modules["fcntl"] = None
for name in ("fchmod", "O_DIRECTORY", "O_NOFOLLOW", "getuid"):
    if hasattr(os, name):
        delattr(os, name)

from spawn_server import main, support_log_files
from spawn_server.db import Base, get_engine, init_engine

assert support_log_files.fcntl is None
app = main.create_app()
assert support_log_files.get_store(app) is None
assert not any("support-log" in path for path in app.openapi()["paths"])

async def start():
    init_engine()
    async with get_engine().begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with main.lifespan(app):
        pass

asyncio.run(start())
"""
    subprocess.run(
        [sys.executable, "-c", code],
        cwd=tmp_path,
        env=env,
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )


async def test_feature_off_no_io_body_or_sweep(app, tmp_path, monkeypatch):
    directory = tmp_path / "never-created"
    monkeypatch.setattr(get_settings(), "support_log_dir", None)
    from spawn_server import support_log_files as files
    from spawn_server.main import create_app

    monkeypatch.setattr(files, "_store", lambda _path: pytest.fail("off must not touch the store"))
    app = create_app()
    store = get_store(app)
    assert start_sweeps(store) is None
    for record_id, token in (("malformed", None), (str(uuid.uuid4()), "invalid")):
        status, _, reads = await raw_request(app, record_id, token=token)
        assert status == 404 and reads == 0
    assert not directory.exists()


@pytest.mark.parametrize(
    "kind",
    ["relative", "checkout", "file", "uncreatable", "write_failure", "symlink", "no_fcntl", "lock"],
)
async def test_bad_configuration_logs_once_and_stays_off(
    lifespan_db, no_sweeps, tmp_path, monkeypatch, caplog, kind
):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    working = tmp_path / "working"
    working.mkdir()
    monkeypatch.chdir(working)
    monkeypatch.setattr("spawn_server.support_log_files.checkout_root", lambda: checkout)
    if kind == "relative":
        directory = "relative-support-storage"
    elif kind == "checkout":
        directory = str(checkout / "support-storage-must-not-exist")
    elif kind in {"file", "uncreatable"}:
        path = tmp_path / "file"
        path.touch()
        original_mode = path.stat().st_mode
        directory = str(path if kind == "file" else path / "storage")
    elif kind == "symlink":
        path = tmp_path / "link"
        path.symlink_to(checkout, target_is_directory=True)
        directory = str(path / "support-storage-must-not-exist")
    elif kind == "no_fcntl":
        directory = str(tmp_path / "storage")
        monkeypatch.setattr("spawn_server.support_log_files.fcntl", None)
    elif kind == "lock":
        directory = tmp_path / "storage"
        directory.mkdir()
        monkeypatch.setattr(support_log_files.fcntl, "flock", Mock(side_effect=OSError))
    else:
        directory = str(tmp_path / "storage")
        original_open = os.open

        def fail_probe(path, flags, *args, **kwargs):
            if flags & os.O_CREAT and str(path).startswith(".upload-"):
                raise PermissionError
            return original_open(path, flags, *args, **kwargs)

        monkeypatch.setattr(os, "open", fail_probe)
    monkeypatch.setattr(get_settings(), "support_log_dir", str(directory))
    caplog.set_level(logging.INFO, logger="spawn.support_log")
    app = main.create_app()
    async with app.router.lifespan_context(app):
        await assert_unknown_paths(app)
        assert get_store(app) is None
    async with app.router.lifespan_context(app):
        assert get_store(app) is None
    assert [r.levelno for r in caplog.records if r.name == "spawn.support_log"] == [
        logging.INFO, logging.ERROR,
    ] * 2
    assert Path(directory).is_dir() == (kind == "lock")
    if kind in {"file", "uncreatable"}:
        assert path.stat().st_mode == original_mode
    assert not list(tmp_path.glob(".support-*"))


@pytest.mark.parametrize("argv", [
    [], ["--ws", "websockets"], ["--ws=auto"], ["--ws=websockets-sansio", "--ws", "auto"],
    ["--root-path", "--ws=websockets-sansio"], ["--", "--ws=websockets-sansio"],
])
async def test_backend_refusal_disables_the_whole_feature(
    lifespan_db, no_sweeps, tmp_path, monkeypatch, caplog, argv
):
    directory = tmp_path / "storage"
    monkeypatch.setattr(get_settings(), "support_log_dir", str(directory))
    # Leave the marked directory from a previous, successful launch in place.
    store = await support_log_files.prepare_store()
    store.close()
    monkeypatch.setenv("UVICORN_WS", "websockets-sansio")
    monkeypatch.setattr(sys, "argv", [sys.argv[0], *argv])
    monkeypatch.setattr(support_log_files, "_store", Mock(side_effect=AssertionError))
    caplog.clear()
    caplog.set_level(logging.INFO, logger="spawn.support_log")
    app = main.create_app()
    async with app.router.lifespan_context(app):
        assert get_store(app) is None and not hasattr(app.state, "support_log_pump")
        await assert_unknown_paths(app)
        assert await support_log_cli.run(["accounts"]) == 8
    assert [(r.levelno, r.message) for r in caplog.records if r.name == "spawn.support_log"] == [
        (logging.ERROR, "SPAWN D support logs require --ws websockets-sansio")
    ]


@pytest.mark.parametrize(("first_usable", "argv"), [
    (True, ["--ws", "websockets-sansio"]), (False, ["--ws=websockets-sansio"]),
])
async def test_each_lifespan_checks_storage(lifespan_db, tmp_path, monkeypatch, first_usable, argv):
    directory = tmp_path / "storage"
    monkeypatch.setattr(get_settings(), "support_log_dir", str(directory))
    monkeypatch.setattr(sys, "argv", [sys.argv[0], *argv])
    app = main.create_app()
    for usable in (first_usable, not first_usable):
        if usable:
            directory.mkdir()
        else:
            directory.touch()
        async with app.router.lifespan_context(app):
            if usable:
                assert get_store(app).root == directory
                assert hasattr(app.state, "support_log_pump")
                assert await support_log_cli.run(["accounts"]) == 0
                assert "post" in app.openapi()["paths"][url("{request_id}")]
            else:
                assert get_store(app) is None
                await assert_unknown_paths(app)
        assert get_store(app) is None
        if usable:
            (directory / support_log_files.READY_PIPE).unlink()
            directory.rmdir()
        else:
            directory.unlink()


async def test_shutdown_bounds_cleanup_with_worker_still_holding_lock(
    lifespan_db, tmp_path, monkeypatch
):
    monkeypatch.setattr(get_settings(), "support_log_dir", str(tmp_path / "storage"))
    app = main.create_app()
    ready, shutdown = asyncio.Event(), asyncio.Event()
    start_sweep, contended = asyncio.Event(), asyncio.Event()
    locked = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(support_log_files, "monotonic", lambda: 0)
    cleanup_threads = []

    async def sweep(store, **kwargs):
        await start_sweep.wait()
        await sweep_once(store, **kwargs)

    async def serve():
        async with app.router.lifespan_context(app):
            ready.set()
            await shutdown.wait()

    monkeypatch.setattr(support_log_retention, "sweep_once", sweep)
    server = asyncio.create_task(serve())
    try:
        await asyncio.wait_for(ready.wait(), 30)
        store = get_store(app)
        bundle = store.path(str(uuid.uuid4()))
        bundle.touch()
        try_lock = support_log_files._try_store_lock

        def hold_cleanup_lock(parent):
            fd = try_lock(parent)
            if parent == store.fd:
                assert fd is None
                loop.call_soon_threadsafe(contended.set)
            else:
                assert fd is not None
                cleanup_threads.append(threading.current_thread())
                loop.call_soon_threadsafe(locked.set)
                release.wait(30)
            return fd

        monkeypatch.setattr(support_log_files, "_try_store_lock", hold_cleanup_lock)
        timeout = asyncio.timeout
        cleanup_deadline = timeout(None)
        monkeypatch.setattr(
            asyncio, "timeout", lambda delay: cleanup_deadline if delay == 2 else timeout(delay)
        )
        await support_log_retention.start_file_cleanup(store, [bundle.stem])
        await asyncio.wait_for(locked.wait(), 30)
        cleanup_deadline.reschedule(loop.time())
        (waiter,) = (job for job in store.cleanup_tasks if isinstance(job, asyncio.Task))
        await asyncio.wait_for(waiter, 30)
        (worker,) = store.cleanup_tasks
        start_sweep.set()
        await asyncio.wait_for(contended.wait(), 30)

        # Hold the real asyncio.wait timer until the test delivers its deadline.
        call_later = loop.call_later
        deadline = loop.create_future()

        def hold_shutdown_deadline(delay, callback, *args, **kwargs):
            if delay == 2:
                deadline.set_result(partial(callback, *args))
                delay = 30
            return call_later(delay, callback, *args, **kwargs)

        monkeypatch.setattr(loop, "call_later", hold_shutdown_deadline)
        shutdown.set()
        expire = await asyncio.wait_for(deadline, 30)
        assert not server.done() and not worker.done() and store.fd is not None
        expire()
        await asyncio.wait_for(server, 30)
        (thread,) = cleanup_threads
        assert thread.daemon and thread.is_alive() and not release.is_set()
        assert store.fd is None and store.cleanup_tasks == {worker}
        await support_log_retention.start_file_cleanup(store, [bundle.stem])
        assert store.cleanup_tasks == {worker}
        release.set()
        await asyncio.wait_for(worker, 30)
        assert not store.cleanup_tasks and bundle.exists()
    finally:
        release.set()
        start_sweep.set()
        shutdown.set()
        await asyncio.wait_for(server, 30)


async def test_startup_and_periodic_sweep(lifespan_db, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "support_log_dir", str(tmp_path / "storage"))
    first, second = asyncio.Event(), asyncio.Event()
    calls = []

    async def sweep(store, **kwargs):
        await sweep_once(store, **kwargs)
        calls.append(store)
        (first if len(calls) == 1 else second).set()

    monkeypatch.setattr(support_log_retention, "sweep_once", sweep)
    assert support_log_retention.INTERVAL_SECONDS == 900
    monkeypatch.setattr(support_log_retention, "INTERVAL_SECONDS", 0)
    app = main.create_app()
    upload_path = url("{request_id}")
    assert upload_path not in app.openapi()["paths"]
    async with app.router.lifespan_context(app):
        assert "post" in app.openapi()["paths"][upload_path]
        await asyncio.wait_for(first.wait(), 30)
        await asyncio.wait_for(second.wait(), 30)
        record_id, token, *_ = await setup_request()
        assert (await raw_request(app, record_id, token=token))[0] == 204
        assert get_store(app).path(record_id).read_bytes() == BODY
    async with app.router.lifespan_context(app):
        assert sum(route.path == upload_path for route in app.routes) == 1
    monkeypatch.setattr(get_settings(), "support_log_dir", None)
    async with app.router.lifespan_context(app):
        await assert_unknown_paths(app)


async def test_collection_functions_validate_and_compare_state(app):
    statement, _ = await seed_statement()
    async with get_sessionmaker()() as session:
        host = Host(owner_user_id=statement["account_id"], name="", support_log_capable=True)
        session.add(host)
        await session.commit()
    record_id = await create_request(
        owner_user_id=host.owner_user_id, host_id=host.id, reason="Connection diagnosis",
        requested_by="operator", window_seconds=60,
    )
    record = await get_collection(record_id)
    assert record.reason and record.requested_by and record.host_name == host.name
    assert await mark_dispatched(record_id)
    assert not await mark_dispatched(record_id)
    assert await transition(record_id, "dispatched", "failed")
    assert not await transition(record_id, "dispatched", "declined", decline_code="failed")
    with pytest.raises(ValueError):
        await transition(record_id, "failed", "dispatched")
    with pytest.raises(ValueError):
        await transition(record_id, "dispatched", "declined", decline_code="invalid")
    for changes in (
        {"reason": ""},
        {"reason": "x" * 201},
        {"requested_by": ""},
        {"window_seconds": 59},
        {"window_seconds": 259201},
        {"window_seconds": True},
        {"host_id": str(uuid.uuid4())},
        {"owner_user_id": str(uuid.uuid4())},
    ):
        with pytest.raises(ValueError):
            await create_request(
                **dict(
                    owner_user_id=statement["account_id"],
                    host_id=host.id,
                    reason="Connection diagnosis",
                    requested_by="operator",
                    window_seconds=60,
                )
                | changes
            )
    async with get_sessionmaker()() as session:
        await session.execute(delete(Host).where(Host.id == host.id))
        await session.commit()
    assert (await get_collection(record_id)).host_id is None


@pytest.mark.parametrize("before_commit", [False, True])
async def test_upload_during_account_deletion(file_sqlite_client, storage, monkeypatch, before_commit):
    from spawn_server import support_log_retention as retention
    from spawn_server.db import configure_sqlite_connections, get_engine

    # The shared file fixture omits connection pragmas. Use production's foreign
    # keys on every new connection, including the concurrently opened one.
    configure_sqlite_connections(get_engine())
    await get_engine().dispose()

    record_id, token, statement, _key, _host = await setup_request()
    async with get_sessionmaker()() as session:
        user = await session.get(User, statement["account_id"])
        session.add(
            AuthIdentity(
                user_id=user.id,
                provider="test",
                provider_user_id=uuid.uuid4().hex,
                email=user.email,
            )
        )
        await session.commit()
    captured, proceed = asyncio.Event(), asyncio.Event()
    if before_commit:
        get_ids = retention.account_file_ids

        async def hold_snapshot(session, owner):
            ids = await get_ids(session, owner)
            captured.set()
            await proceed.wait()
            return ids

        monkeypatch.setattr(retention, "account_file_ids", hold_snapshot)
    else:
        async def hold_cleanup(store, ids):
            captured.set()
            await proceed.wait()
            await remove_files(store, ids)

        monkeypatch.setattr(retention, "remove_files", hold_cleanup)
    deletion = asyncio.create_task(
        file_sqlite_client.post(
            "/api/account/delete",
            json={"confirm_email": user.email},
            headers={"authorization": f"Bearer {auth.issue_access_token(user.id)}"},
        )
    )
    await asyncio.wait_for(captured.wait(), 30)
    try:
        upload = await post(file_sqlite_client, record_id, token)
        if before_commit:
            assert upload.status_code == 204 and storage.path(record_id).read_bytes() == BODY
        else:
            assert upload.status_code == 401
    finally:
        proceed.set()
    result = await asyncio.wait_for(deletion, 30)
    assert result.status_code == 204
    await asyncio.wait_for(asyncio.gather(*storage.cleanup_tasks), 30)
    assert not bundle_entries(storage)
    assert await get_collection(record_id) is None


async def test_sweep_only_unlinks_store_names_and_rechecks_identity(client, storage):
    old = storage.path(str(uuid.uuid4()))
    temporary = storage.root / f".upload-{uuid.uuid4()}.tmp"
    unrelated = storage.root / "unrelated.ndjson"
    unrelated_temp = storage.root / ".upload-unrelated"
    for path in (old, temporary, unrelated, unrelated_temp):
        path.write_bytes(BODY)
        os.utime(path, (1, 1))
    await sweep_once(storage)
    assert bundle_entries(storage) == {unrelated, unrelated_temp}
    old.write_bytes(BODY)
    os.utime(old, (1, 1))
    os.removexattr(storage.root, support_log_files.STORE_ATTRIBUTE)
    with pytest.raises(OSError):
        await sweep_once(storage)
    assert bundle_entries(storage) == {unrelated, unrelated_temp, old}


async def test_delayed_off_cleanup_only_removes_its_committed_files(client, storage, monkeypatch):
    collected, token, value, key, host = await setup_request()
    assert (await post(client, collected, token)).status_code == 204
    queued = await seed_request(host)
    owner = value["account_id"]
    off = sign({**value, "enabled": False}, key)
    entered, release = asyncio.Event(), asyncio.Event()
    removed = []

    async def hold_cleanup(store, ids):
        removed.extend(ids)
        entered.set()
        await release.wait()
        await remove_files(store, ids)

    monkeypatch.setattr(support_log_retention, "remove_files", hold_cleanup)
    task = asyncio.create_task(store_statement(owner, off, store=storage))
    try:
        await asyncio.wait_for(entered.wait(), 30)
        assert await get_statement(owner) == off
        assert (await get_collection(queued)).state == "cancelled"
        assert (await get_collection(collected)).state == "deleted"
        assert storage.path(collected).exists()
        await store_statement(owner, sign({**value, "issued_at_ms": 1001}, key))
        new = await seed_request(host)
        assert await mark_dispatched(new)
        assert (await post(client, new, token)).status_code == 204
        pending = await seed_request(host)
    finally:
        release.set()
        await asyncio.wait_for(task, 30)
    assert removed == [collected] and not storage.path(collected).exists()
    assert storage.path(new).read_bytes() == BODY and (await get_collection(new)).state == "collected"
    assert (await get_collection(pending)).state == "requested"


async def test_off_and_record_changes_roll_back_together(client, storage):
    from sqlalchemy import event

    from spawn_server.db import get_engine

    collected, token, value, key, host = await setup_request()
    assert (await post(client, collected, token)).status_code == 204
    pending = await seed_request(host)
    off = sign({**value, "enabled": False}, key)

    def reject_delete(_conn, _cursor, sql, *_):
        if sql.startswith("UPDATE support_log_collections") and "deleted_at=" in sql:
            raise RuntimeError("injected")

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", reject_delete)
    try:
        with pytest.raises(RuntimeError, match="injected"):
            await store_statement(value["account_id"], off, store=storage)
    finally:
        event.remove(engine, "before_cursor_execute", reject_delete)
    assert await get_statement(value["account_id"]) == value
    assert (await get_collection(pending)).state == "requested"
    assert (await get_collection(collected)).state == "collected" and storage.path(collected).exists()
