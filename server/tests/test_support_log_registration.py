"""Daemon registration and support delivery over an in-process fake websocket."""

import asyncio
import hashlib
import json
from contextlib import AsyncExitStack, asynccontextmanager, contextmanager

import pytest
from sqlalchemy import delete, event, update

from spawn_server import auth
from spawn_server.db import get_engine, get_sessionmaker
from spawn_server.models import BrowserDevice, Host, SupportLogConsent
from spawn_server.support_consent import store_statement
from spawn_server.support_log_dispatch import SupportLogPump, support_log_consent_changed
from spawn_server.ws.broker import get_broker
from spawn_server.ws.daemon import daemon_ws
from tests.test_support_consent import VECTORS, seed_statement, sign
from tests.test_ws_daemon import FakeDaemonWebSocket, _create_host


async def registration_trace(app, *, flag=True):
    statement, _ = await seed_statement()
    owner = statement["account_id"]
    host = await _create_host(owner, name="")
    ws = FakeDaemonWebSocket()
    ws.scope["app"] = app
    ws.queue_text({"type": "register", "supports_support_log": flag})
    ws.queue_disconnect()
    statements = []

    def capture(_conn, _cursor, sql, _params, _context, _many):
        if not ws.sent_text:
            statements.append(sql)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", capture)
    try:
        await daemon_ws(ws, token=auth.issue_daemon_token(host, owner))
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    return host, owner, ws.sent_text, statements


async def test_storage_off_frames_match_master(app):
    host, owner, frames, _ = await registration_trace(app)
    assert frames == [
        json.dumps(
            {
                "type": "registered",
                "host_id": host,
                "account_id": owner,
                "browser_device_ids": [],
                "browser_pins": [],
                "revoked_browser_keys": [],
            }
        )
    ]


async def test_storage_off_registration_sql_matches_master(app):
    _, _, _, statements = await registration_trace(app)
    if get_engine().dialect.name != "sqlite":
        pytest.skip("The production registration trace uses SQLite.")
    # All statements from authentication through the first registered frame,
    # including the exact activation UPDATE. Bind values vary with each socket.
    digest = hashlib.sha256("\n".join(statements).encode()).hexdigest()
    assert len(statements) == 11
    assert digest == "6db729eb81b9ee2f2addc1ec84d24c629fe3dd2b77c7c805a9691f2f394af17d"


@pytest.fixture
def pump(app, monkeypatch):
    instance = SupportLogPump()
    monkeypatch.setattr(app.state, "support_log_pump", instance, raising=False)
    return instance


@asynccontextmanager
async def connected(app, owner, host, **registration):
    ws = FakeDaemonWebSocket()
    ws.scope["app"] = app
    ready = asyncio.Event()
    frames = asyncio.Queue()
    read = ws.receive
    send = ws.send_text

    async def receive():
        if ws.receive_count:
            ready.set()
        return await read()

    async def capture(value):
        await send(value)
        frames.put_nowait(json.loads(value))

    ws.receive, ws.send_text = receive, capture
    ws.queue_text({"type": "register", **registration})
    task = asyncio.create_task(daemon_ws(ws, token=auth.issue_daemon_token(host, owner)))
    try:
        await asyncio.wait_for(ready.wait(), 30)
        yield ws, frames, get_broker().get_daemon_for_host(host)
    finally:
        ws.queue_disconnect()
        await asyncio.wait_for(task, 30)


@pytest.mark.parametrize("flag", [True, False, None, 1, "true", [], {}])
async def test_capability_is_literal_and_replaces_last_registration(app, pump, flag):
    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await _create_host(owner, name="")
    async with get_sessionmaker()() as db:
        await db.execute(update(Host).values(support_log_capable=True))
        await db.commit()
    registration = {} if flag is None else {"supports_support_log": flag}
    async with connected(app, owner, host, **registration) as (_, frames, conn):
        frame = frames.get_nowait()
        assert conn.supports_support_log is (flag is True)
        if flag is True:
            assert frame["support_log_consent"] == value
        else:
            assert "support_log_consent" not in frame
        async with get_sessionmaker()() as db:
            assert (await db.get(Host, host)).support_log_capable is (flag is True)
        assert not pump.wake.is_set()
        assert frames.empty()


@pytest.mark.parametrize("case", ["absent", "carried", "off", "removed_on", "removed_off"])
async def test_registered_contains_effective_stored_statement(app, pump, case):
    value, key = await seed_statement(enabled=case not in {"off", "removed_off"})
    owner = value["account_id"]
    host = await _create_host(owner, name="")
    expected = value
    if case == "carried":
        carried = VECTORS["negative"][1]["consent"]["carried_endorsements"]
        expected = sign({**value, "issued_at_ms": 1001, "carried_endorsements": carried}, key)
        await store_statement(owner, expected)
    if case in {"absent", "removed_on", "removed_off"}:
        async with get_sessionmaker()() as db:
            await db.execute(delete(SupportLogConsent if case == "absent" else BrowserDevice))
            await db.commit()
        if case != "removed_off":
            expected = None
    async with connected(app, owner, host, supports_support_log=True) as (_, frames, conn):
        assert frames.get_nowait()["support_log_consent"] == expected
        assert conn.support_registered_sent and frames.empty()


async def test_enabled_sql_adds_one_read_only_for_capable(app, pump):
    _, _, _, capable = await registration_trace(app)
    assert len(capable) == 12
    consent = [sql for sql in capable if "support_log_consents" in sql]
    assert len(consent) == 1 and "support_log_collections" in consent[0]
    assert sum("support_log_capable=" in sql for sql in capable) == 1
    _, _, _, incapable = await registration_trace(app, flag=False)
    assert len(incapable) == 11
    assert not any("support_log_consents" in sql for sql in incapable)


async def test_change_push_is_account_scoped_and_includes_removed_and_off(app, pump):
    owner_statement, key = await seed_statement()
    other_statement, _ = await seed_statement()
    owner = owner_statement["account_id"]
    other = other_statement["account_id"]
    # A changed account without sockets performs no DB read.
    with no_statements():
        await support_log_consent_changed(app, owner)
    async with AsyncExitStack() as stack:
        queues = []
        for account, capable in [(owner, True), (owner, True), (owner, False), (other, True)]:
            host = await _create_host(account, name="")
            _, frames, _ = await stack.enter_async_context(
                connected(app, account, host, supports_support_log=capable)
            )
            assert frames.get_nowait()["type"] == "registered"
            queues.append(frames)
        newer = sign({**owner_statement, "issued_at_ms": 1001}, key)
        off = sign({**newer, "enabled": False}, key)
        for artifact in [newer, off, None]:
            if artifact is not None:
                await store_statement(owner, artifact)
            else:
                # Simulate an enabled signer removed before a push.
                await store_statement(owner, sign({**newer, "issued_at_ms": 1002}, key))
                async with get_sessionmaker()() as db:
                    await db.execute(
                        delete(BrowserDevice).where(BrowserDevice.id == newer["signer_device_id"])
                    )
                    await db.commit()
            await support_log_consent_changed(app, owner)
            for frames in queues[:2]:
                assert frames.get_nowait() == {
                    "type": "host.support_log_consent",
                    "consent": artifact,
                }
            assert all(frames.empty() for frames in queues)


@contextmanager
def no_statements():
    def unexpected(*args):
        pytest.fail("Unexpected database statement")

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", unexpected)
    try:
        yield
    finally:
        event.remove(engine, "before_cursor_execute", unexpected)


async def test_storage_off_change_is_inert(app):
    with no_statements():
        await support_log_consent_changed(app, "")


async def test_storage_off_ignores_last_capability_and_literal_null_clears_it(app, monkeypatch):
    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await _create_host(owner, name="")
    async with get_sessionmaker()() as db:
        await db.execute(update(Host).where(Host.id == host).values(support_log_capable=True))
        await db.commit()
    async with connected(app, owner, host, supports_support_log=False) as (_, frames, conn):
        assert not conn.supports_support_log
        assert "support_log_consent" not in frames.get_nowait()
    async with get_sessionmaker()() as db:
        assert (await db.get(Host, host)).support_log_capable
    monkeypatch.setattr(app.state, "support_log_pump", SupportLogPump(), raising=False)
    async with connected(app, owner, host, supports_support_log=None) as (_, frames, conn):
        assert not conn.supports_support_log
        assert "support_log_consent" not in frames.get_nowait()
    async with get_sessionmaker()() as db:
        assert not (await db.get(Host, host)).support_log_capable
