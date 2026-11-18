"""Daemon registration and support delivery over an in-process fake websocket."""

import asyncio
import json
from contextlib import asynccontextmanager, contextmanager
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import delete, event, update

from spawn_server import auth
from spawn_server.config import get_settings
from spawn_server.db import get_engine, get_sessionmaker
from spawn_server.models import BrowserDevice, Host, SupportLogConsent
from spawn_server.support_consent import store_statement
from spawn_server.support_log_dispatch import SUPPORT_LIMIT, SupportLogPump
from spawn_server.ws.broker import SUPPORT_UNSENT, daemon_wire, get_broker
from spawn_server.ws.daemon import daemon_ws
from tests.test_support_consent import VECTORS, seed_statement, sign
from tests.test_ws_daemon import FakeDaemonWebSocket, _create_host

pytestmark = pytest.mark.usefixtures("inprocess_pubsub")


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
        assert "support_log_consent" not in frame
        async with get_sessionmaker()() as db:
            assert (await db.get(Host, host)).support_log_capable is (flag is True)
        assert pump.wake.is_set() == (flag is True)
        assert frames.empty()


@pytest.mark.parametrize("case", ["absent", "carried", "off", "removed_on", "removed_off"])
async def test_pump_sends_effective_stored_statement(app, pump, case):
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
        assert frames.get_nowait()["type"] == "registered" and frames.empty()
        await pump.run_once()
        assert frames.get_nowait() == {"type": "host.support_log_consent", "consent": expected}
        assert conn.support_statement_sent == expected
        await pump.run_once()
        assert frames.empty()


@pytest.mark.parametrize("flag", [True, False])
async def test_registration_only_extends_existing_write(app, pump, flag):
    _, _, _, sql = await registration_trace(app, flag=flag)
    assert len(sql) == 11
    assert sum("support_log_capable=" in stmt for stmt in sql) == 1
    assert not any(
        "support_log_consents" in stmt or "support_log_collections" in stmt for stmt in sql
    )


@pytest.mark.parametrize("flag", [True, False, None])
async def test_enabled_registration_matches_disabled_bytes(app, monkeypatch, flag):
    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await _create_host(owner, name="")
    register = {} if flag is None else {"supports_support_log": flag}
    async with connected(app, owner, host, **register) as (ws, _, _):
        disabled = ws.sent_text.copy()
    monkeypatch.setattr(app.state, "support_log_pump", SupportLogPump(), raising=False)
    async with connected(app, owner, host, **register) as (ws, _, _):
        assert ws.sent_text == disabled


@contextmanager
def no_statements():
    sql = []

    def capture(_conn, _cursor, statement, *_):
        sql.append(statement)

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", capture)
    try:
        yield
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert not sql


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


@pytest.mark.parametrize("delta", [-1, 0, 1])
async def test_registered_wire_size_gates_only_support(app, pump, monkeypatch, caplog, delta):
    from tests.test_support_log_dispatch import request

    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await _create_host(owner, name="")
    roster = ["\u00e9"]
    ordinary = dict(
        type="registered",
        host_id=host,
        account_id=owner,
        browser_device_ids=roster,
        browser_pins=[],
        revoked_browser_keys=[],
    )
    roster[0] += "a" * (SUPPORT_LIMIT + delta - len(daemon_wire(ordinary).encode()))
    monkeypatch.setattr(
        "spawn_server.ws.daemon._live_browser_device_ids", AsyncMock(return_value=roster)
    )
    async with connected(app, owner, host, supports_support_log=True) as (ws, frames, conn):
        assert frames.get_nowait() == ordinary
        assert (
            conn.support_registered_bytes == len(ws.sent_text[0].encode()) == SUPPORT_LIMIT + delta
        )
        queued = await request(owner, host)
        await pump.run_once()
        await pump.run_once()
        if delta > 0:
            assert frames.empty()
            assert caplog.text.count("size prevents support sharing") == 1
        else:
            assert frames.get_nowait() == {"type": "host.support_log_consent", "consent": value}
            assert frames.get_nowait()["request_id"] == queued
            assert frames.empty()


async def test_oversized_statement_withheld_until_it_fits(app, pump, monkeypatch):
    from tests.test_support_log_dispatch import request

    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await _create_host(owner, name="")
    async with connected(app, owner, host, supports_support_log=True) as (_, frames, conn):
        frames.get_nowait()
        queued = await request(owner, host)
        with monkeypatch.context() as m:
            oversized = {**value, "carried_endorsements": ["a" * SUPPORT_LIMIT]}
            m.setattr(
                "spawn_server.support_log_dispatch.effective_statement",
                AsyncMock(return_value=oversized),
            )
            await pump.run_once()
            assert conn.support_statement_sent is SUPPORT_UNSENT and frames.empty()
        await pump.run_once()
        assert frames.get_nowait()["consent"] == value
        assert frames.get_nowait()["request_id"] == queued


async def test_size_bookkeeping_failure_does_not_interrupt_registration(app, pump, monkeypatch):
    from spawn_server.ws.broker import DaemonConn

    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await _create_host(owner, name="")
    assign = DaemonConn.__setattr__

    def fail_size(self, name, value):
        if name == "support_registered_bytes" and value is not None:
            raise RuntimeError
        assign(self, name, value)

    monkeypatch.setattr(DaemonConn, "__setattr__", fail_size)
    async with connected(app, owner, host, supports_support_log=True) as (ws, frames, conn):
        assert frames.get_nowait()["type"] == "registered" and conn.support_registered_bytes is None
        await pump.run_once()
        ws.queue_text({"type": "host.heartbeat"})
        assert await asyncio.wait_for(frames.get(), 30) == {"type": "host.heartbeat"}
        assert frames.empty()
