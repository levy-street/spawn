"""Bounded sweeps, withdrawal, account deletion and inert default behavior."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import delete, update

from spawn_server import auth
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import AuthIdentity, Host, SupportLogCollection, User
from spawn_server.support_consent import get_statement, store_statement
from spawn_server.support_log import create_request, get_collection, mark_dispatched, transition
from spawn_server.support_log_files import get_store
from spawn_server.support_log_retention import (
    account_deletion_files,
    account_file_ids,
    sharing_turned_off,
    start_sweeps,
    stop_sweeps,
    sweep_once,
)
from tests.test_support_consent import sign
from tests.test_support_log_uploads import BODY, app, post, raw_request, setup_request, storage, url

# Re-export this shared fixture without introducing a global test dependency.
__all__ = ["app", "storage"]


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
    temporary = storage.root / ".upload-incomplete"
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
    old = storage.root / ".old"
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
    link = storage.root / "link"
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
    requested = await create_request(
        owner_user_id=statement["account_id"],
        host_id=host.id,
        reason="Connection diagnosis",
        requested_by="operator",
        window_seconds=60,
    )
    dispatched = await create_request(
        owner_user_id=statement["account_id"],
        host_id=host.id,
        reason="Connection diagnosis",
        requested_by="operator",
        window_seconds=60,
    )
    assert await mark_dispatched(dispatched)
    other, other_token, *_ = await setup_request()
    assert (await post(client, other, other_token)).status_code == 204
    off = sign({**statement, "enabled": False}, key)
    await store_statement(statement["account_id"], off)
    await sharing_turned_off(statement["account_id"])
    assert await get_statement(statement["account_id"]) == off
    assert (await get_collection(record_id)).state == "deleted"
    assert (await get_collection(requested)).state == "cancelled"
    assert (await get_collection(dispatched)).state == "cancelled"
    assert not storage.path(record_id).exists()
    assert storage.path(other).exists()
    assert not await mark_dispatched(requested)


@pytest.mark.parametrize("cleanup_fails", [False, True])
async def test_account_deletion_removes_files_and_cascades(
    client, storage, monkeypatch, caplog, cleanup_fails
):
    record_id, token, statement, _key, host = await setup_request()
    assert (await post(client, record_id, token)).status_code == 204
    other, other_token, *_ = await setup_request()
    assert (await post(client, other, other_token)).status_code == 204
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
    socket = Mock(close=AsyncMock())
    broker = Mock(get_daemon_for_host=Mock(return_value=socket))
    monkeypatch.setattr("spawn_server.routes.auth.get_broker", lambda: broker)
    remove = storage.remove
    if cleanup_fails:

        def fail_remove(_record_id):
            raise OSError("injected")

        monkeypatch.setattr(storage, "remove", fail_remove)
    response = await client.post(
        "/api/account/delete",
        json={"confirm_email": user.email},
        headers={"authorization": f"Bearer {auth.issue_access_token(user.id)}"},
    )
    assert response.status_code == 204 and response.content == b""
    assert 'spawn_session=""' in response.headers["set-cookie"]
    assert "Max-Age=0" in response.headers["set-cookie"]
    broker.get_daemon_for_host.assert_called_once_with(host.id)
    socket.close.assert_awaited_once()
    assert await get_collection(record_id) is None
    assert await get_statement(user.id) is None
    assert storage.path(record_id).exists() == cleanup_fails
    assert storage.path(other).exists()
    async with get_sessionmaker()() as session:
        assert await session.get(Host, host.id) is None
        assert await session.get(User, user.id) is None
    if cleanup_fails:
        assert caplog.text.count("account file cleanup failed") == 1
        monkeypatch.setattr(storage, "remove", remove)
        await sweep_once(storage, now=datetime.now(UTC) + timedelta(minutes=11))
        assert not storage.path(record_id).exists()
        assert storage.path(other).exists()


async def test_disabled_routes_match_unknown_paths(tmp_path, monkeypatch):
    from spawn_server.main import create_app

    monkeypatch.setattr(get_settings(), "support_log_dir", None)
    app = create_app()
    status, body, _ = await raw_request(app, "", method="GET", path="/openapi.json")
    assert status == 200
    assert not any("support-log" in path for path in json.loads(body)["paths"])
    for method, suffix in (("POST", ""), ("GET", ""), ("HEAD", ""), ("POST", "/")):
        result = await raw_request(app, "", method=method, path=url(uuid.uuid4()) + suffix)
        unknown = await raw_request(app, "", method=method, path=f"/unknown/{uuid.uuid4()}{suffix}")
        assert result == unknown
        assert result[0] == 404 and result[2] == 0


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
assert support_log_files.get_store() is None
app = main.create_app()
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
    assert start_sweeps() is None
    for record_id, token in (("malformed", None), (str(uuid.uuid4()), "invalid")):
        status, _, reads = await raw_request(app, record_id, token=token)
        assert status == 404 and reads == 0
    await sharing_turned_off(str(uuid.uuid4()))
    async with get_sessionmaker()() as session:
        assert await account_file_ids(session, str(uuid.uuid4())) == []
        async with account_deletion_files(session, str(uuid.uuid4())):
            assert not session.in_transaction()
    assert not directory.exists()


@pytest.mark.parametrize(
    "kind", ["relative", "checkout", "file", "write_failure", "symlink", "no_fcntl"]
)
async def test_bad_configuration_logs_once_and_stays_off(app, tmp_path, monkeypatch, caplog, kind):
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
    elif kind == "file":
        path = tmp_path / "file"
        path.touch()
        directory = str(path)
    elif kind == "symlink":
        path = tmp_path / "link"
        path.symlink_to(checkout, target_is_directory=True)
        directory = str(path / "support-storage-must-not-exist")
    elif kind == "no_fcntl":
        directory = str(tmp_path / "storage")
        monkeypatch.setattr("spawn_server.support_log_files.fcntl", None)
    else:
        directory = str(tmp_path / "storage")
        monkeypatch.setattr(
            "spawn_server.support_log_files.tempfile.mkstemp",
            lambda **_kw: (_ for _ in ()).throw(PermissionError()),
        )
    monkeypatch.setattr(get_settings(), "support_log_dir", directory)
    runner = start_sweeps()
    assert runner is not None
    # Initialization is scheduled, never awaited by server startup.
    status, _, reads = await raw_request(app, str(uuid.uuid4()))
    assert status == 404 and reads == 0
    await asyncio.wait_for(runner[1], 30)
    assert get_store() is None and start_sweeps() is None
    status, _, reads = await raw_request(app, str(uuid.uuid4()), token="invalid")
    assert status == 404 and reads == 0
    assert caplog.text.count("storage is unusable") == 1
    assert not (checkout / "support-storage-must-not-exist").exists()
    if kind == "no_fcntl":
        assert not Path(directory).exists()


async def test_startup_and_periodic_sweep(app, tmp_path, monkeypatch):
    import spawn_server.support_log_retention as retention

    monkeypatch.setattr(get_settings(), "support_log_dir", str(tmp_path / "storage"))
    first, second = asyncio.Event(), asyncio.Event()
    calls = []

    async def sweep(store):
        calls.append(store)
        (first if len(calls) == 1 else second).set()

    monkeypatch.setattr(retention, "sweep_once", sweep)
    assert retention.INTERVAL_SECONDS == 900
    monkeypatch.setattr(retention, "INTERVAL_SECONDS", 0.01)
    runner = start_sweeps()
    await asyncio.wait_for(first.wait(), 30)
    await asyncio.wait_for(second.wait(), 30)
    await stop_sweeps(runner)
    assert runner[1].done()


async def test_collection_functions_validate_and_compare_state(app):
    record_id, _token, statement, key, host = await setup_request(state="requested")
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


async def test_deletion_fences_a_late_upload(file_sqlite_client, storage, monkeypatch):
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
    original = retention.account_file_ids

    async def held_ids(session, user_id):
        ids = await original(session, user_id)
        captured.set()
        await asyncio.wait_for(proceed.wait(), 30)
        return ids

    monkeypatch.setattr(retention, "account_file_ids", held_ids)
    deletion = asyncio.create_task(
        file_sqlite_client.post(
            "/api/account/delete",
            json={"confirm_email": user.email},
            headers={"authorization": f"Bearer {auth.issue_access_token(user.id)}"},
        )
    )
    await asyncio.wait_for(captured.wait(), 30)
    late = asyncio.create_task(post(file_sqlite_client, record_id, token))
    proceed.set()
    result, upload = await asyncio.wait_for(asyncio.gather(deletion, late), 30)
    assert result.status_code == 204
    assert upload.status_code in {401, 404, 409}
    assert not list(storage.root.iterdir())
    assert await get_collection(record_id) is None
