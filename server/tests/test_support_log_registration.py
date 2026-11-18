"""Daemon registration and support delivery over an in-process fake websocket."""

import asyncio
import json
from contextlib import AsyncExitStack, asynccontextmanager, contextmanager

import pytest
from sqlalchemy import delete, event, update

from spawn_server import auth
from spawn_server.config import get_settings
from spawn_server.db import get_engine, get_sessionmaker
from spawn_server.models import BrowserDevice, Host, SupportLogConsent
from spawn_server.support_consent import store_statement
from spawn_server.support_delivery import deliver_statement
from spawn_server.support_log_dispatch import SupportLogPump
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


@pytest.fixture(autouse=True)
def temporary_prebuilts(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "prebuilt_dir", tmp_path / "prebuilt")


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
        assert conn.support_delivery_ready and frames.empty()


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
        await deliver_statement(None, owner, None)
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
        for artifact in [newer, off]:
            await store_statement(owner, artifact)
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
        await deliver_statement(None, "", None)


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


@pytest.mark.parametrize("failure", ["sql", "decode", "read_timeout", "order_timeout"])
async def test_support_failure_keeps_ordinary_socket(app, pump, monkeypatch, caplog, failure):
    from sqlalchemy.exc import SQLAlchemyError

    from spawn_server import support_delivery
    from spawn_server.ws import daemon

    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await _create_host(owner, name="")
    stalled = asyncio.Event()

    async def read(*args, **kwargs):
        assert not get_broker().get_daemon_for_host(host).lifecycle_lock.locked()
        if failure == "read_timeout":
            await stalled.wait()
        raise SQLAlchemyError() if failure == "sql" else ValueError()

    monkeypatch.setattr(daemon, "delivery_snapshot", read)
    if failure == "read_timeout":
        monkeypatch.setattr(daemon, "SUPPORT_READ_SECONDS", 0)
    held = AsyncExitStack()
    if failure == "order_timeout":
        await held.enter_async_context(support_delivery.delivery_order(owner).enter())
        monkeypatch.setattr(support_delivery, "ORDER_SECONDS", 0)
    try:
        async with connected(
            app, owner, host, supports_support_log=True, existing_sessions=[host]
        ) as (ws, frames, conn):
            registration = frames.get_nowait()
            assert (
                registration["type"] == "registered" and "support_log_consent" not in registration
            )
            assert not conn.support_delivery_ready
            ws.queue_text({"type": "host.heartbeat"})
            assert await asyncio.wait_for(frames.get(), 30) == {"type": "host.heartbeat"}
            assert caplog.text.count("could not read support log consent") == 1
    finally:
        await held.aclose()


@pytest.mark.parametrize("delta", [0, 1])
async def test_combined_registration_size_in_wire_bytes(app, pump, monkeypatch, delta):
    from unittest.mock import AsyncMock

    from spawn_server.support_delivery import SUPPORT_LIMIT
    from spawn_server.ws.broker import daemon_wire
    from tests.test_support_log_dispatch import request

    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await _create_host(owner, name="")
    roster = ["\u00e9"]
    combined = dict(
        type="registered",
        host_id=host,
        account_id=owner,
        browser_device_ids=roster,
        browser_pins=[],
        revoked_browser_keys=[],
        support_log_consent=value,
    )
    roster[0] += "a" * (SUPPORT_LIMIT + delta - len(daemon_wire(combined).encode()))
    monkeypatch.setattr(
        "spawn_server.ws.daemon._live_browser_device_ids", AsyncMock(return_value=roster)
    )
    async with connected(app, owner, host, supports_support_log=True) as (ws, frames, conn):
        ordinary = frames.get_nowait()
        assert ordinary["browser_device_ids"] == roster
        if delta:
            assert "support_log_consent" not in ordinary
            assert frames.get_nowait() == {"type": "host.support_log_consent", "consent": value}
        else:
            assert len(ws.sent_text[0].encode()) == SUPPORT_LIMIT
            assert ordinary["support_log_consent"] == value
        assert conn.support_delivery_ready
        queued = await request(owner, host)
        await pump.run_once()
        assert frames.get_nowait()["request_id"] == queued and frames.empty()


@pytest.mark.parametrize("ordinary_too_big", [False, True])
async def test_registration_with_unusable_wire_size_keeps_trust(
    app, pump, monkeypatch, caplog, ordinary_too_big
):
    from unittest.mock import AsyncMock

    from spawn_server.support_delivery import DAEMON_LIMIT, SUPPORT_LIMIT
    from spawn_server.ws.broker import daemon_wire

    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await _create_host(owner, name="")
    roster = ["a" * DAEMON_LIMIT] if ordinary_too_big else ["a"]
    monkeypatch.setattr(
        "spawn_server.ws.daemon._live_browser_device_ids", AsyncMock(return_value=roster)
    )
    if not ordinary_too_big:
        separate = {"type": "host.support_log_consent", "consent": value}
        value["carried_endorsements"] = [""]
        value["carried_endorsements"][0] = "a" * (
            SUPPORT_LIMIT + 1 - len(daemon_wire(separate).encode())
        )
        monkeypatch.setattr(
            "spawn_server.ws.daemon.delivery_snapshot", AsyncMock(return_value=(value, True))
        )
    async with connected(app, owner, host, supports_support_log=True) as (_, frames, conn):
        ordinary = frames.get_nowait()
        assert ordinary["browser_device_ids"] == roster and "support_log_consent" not in ordinary
        assert not conn.support_delivery_ready and frames.empty()
        assert not pump.wake.is_set()
        assert sum("support log" in r.getMessage() for r in caplog.records) == 1
