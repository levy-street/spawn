"""Daemon websocket auth, compatibility, and reconnect behavior."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

from sqlalchemy import select

from spawn_server import auth
from spawn_server.db import get_sessionmaker
from spawn_server.models import Agent, Host, User
from spawn_server.ws.broker import BrowserConn, DaemonConn, get_broker
from spawn_server.ws.daemon import daemon_ws
from spawn_server.ws.frames import KIND_OUTPUT, encode_binary_frame


class FakeDaemonWebSocket:
    def __init__(self, *, authorization: str | None = None) -> None:
        self.headers: dict[str, str] = {}
        if authorization is not None:
            self.headers["authorization"] = authorization
        self.accepted_subprotocol: str | None = None
        self.sent_text: list[str] = []
        self.sent_bytes: list[bytes] = []
        self.closed: tuple[int, str] | None = None
        self._incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def accept(self, subprotocol: str | None = None) -> None:
        self.accepted_subprotocol = subprotocol

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)

    async def receive(self) -> dict[str, Any]:
        return await self._incoming.get()

    async def send_text(self, value: str) -> None:
        self.sent_text.append(value)

    async def send_bytes(self, value: bytes) -> None:
        self.sent_bytes.append(value)

    def queue_text(self, payload: dict[str, Any]) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "text": json.dumps(payload)})

    def queue_bytes(self, payload: bytes) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "bytes": payload})

    def queue_disconnect(self) -> None:
        self._incoming.put_nowait({"type": "websocket.disconnect"})


async def _signup(client, email: str) -> tuple[str, str]:
    response = await client.post(
        "/api/auth/signup", json={"email": email, "password": "passpasspass"}
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]["id"], response.json()["access_token"]


async def _create_host(user_id: str, *, name: str = "daemon-box") -> str:
    sm = get_sessionmaker()
    async with sm() as session:
        host = Host(owner_user_id=user_id, name=name, status="offline")
        session.add(host)
        await session.commit()
        return host.id


async def _create_agent(
    user_id: str,
    host_id: str,
    *,
    name: str = "agent",
) -> str:
    sm = get_sessionmaker()
    async with sm() as session:
        agent = Agent(
            owner_user_id=user_id,
            host_id=host_id,
            name=name,
            cwd="/repo",
            argv=["sh"],
            status="running",
        )
        session.add(agent)
        await session.commit()
        return agent.id


async def _wait_until(predicate: Callable[[], bool], *, timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting for condition")


def _sent_json(ws: FakeDaemonWebSocket) -> list[dict[str, Any]]:
    return [json.loads(item) for item in ws.sent_text]


async def test_daemon_ws_rejects_missing_and_non_daemon_tokens(client):
    user_id, access_token = await _signup(client, "ws-daemon-auth@example.com")
    host_id = await _create_host(user_id)
    daemon_token = auth.issue_daemon_token(host_id, user_id)

    missing = FakeDaemonWebSocket()
    await daemon_ws(missing, token=None)  # type: ignore[arg-type]
    assert missing.accepted_subprotocol == "spawn.v1"
    assert missing.closed == (1008, "missing token")

    wrong_kind = FakeDaemonWebSocket(authorization=f"Bearer {access_token}")
    await daemon_ws(wrong_kind, token=None)  # type: ignore[arg-type]
    assert wrong_kind.closed == (1008, "not a daemon token")

    wrong_host = FakeDaemonWebSocket(authorization=f"Bearer {auth.issue_daemon_token(host_id, 'other-user')}")
    await daemon_ws(wrong_host, token=None)  # type: ignore[arg-type]
    assert wrong_host.closed == (1008, "host gone")

    accepted = FakeDaemonWebSocket(authorization=f"Bearer {daemon_token}")
    accepted.queue_disconnect()
    await daemon_ws(accepted, token=None)  # type: ignore[arg-type]
    assert accepted.closed is None


async def test_daemon_ws_register_accepts_old_shape_and_heartbeat_query_token(client):
    user_id, _ = await _signup(client, "ws-daemon-register@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    ws = FakeDaemonWebSocket()
    ws.queue_text(
        {
            "type": "register",
            "host_name": "old-spawnd",
            "os": "linux",
            "arch": "x86_64",
            "version": "0.1.0",
        }
    )
    ws.queue_text({"type": "host.heartbeat"})
    ws.queue_disconnect()

    await daemon_ws(ws, token=token)  # type: ignore[arg-type]

    sent = _sent_json(ws)
    assert {"type": "registered", "host_id": host_id} in sent
    assert {"type": "host.heartbeat"} in sent
    assert get_broker().get_daemon_for_host(host_id) is None

    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.os == "linux"
        assert host.arch == "x86_64"
        assert host.version == "0.1.0"
        assert host.status == "offline"
        assert host.last_seen_at is not None


async def test_daemon_ws_register_resyncs_only_owned_existing_agents_while_connected(client):
    user_id, _ = await _signup(client, "ws-daemon-resync@example.com")
    host_id = await _create_host(user_id, name="primary")
    other_host_id = await _create_host(user_id, name="other")
    agent_id = await _create_agent(user_id, host_id, name="kept")
    other_agent_id = await _create_agent(user_id, other_host_id, name="ignored")
    token = auth.issue_daemon_token(host_id, user_id)

    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(daemon_ws(ws, token=None))  # type: ignore[arg-type]
    ws.queue_text(
        {
            "type": "register",
            "host_name": "current",
            "os": "linux",
            "arch": "x86_64",
            "version": "0.2.0",
            "home_dir": "/home/tester",
            "existing_agents": [agent_id, other_agent_id, "00000000-0000-4000-8000-999999999999"],
        }
    )

    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(ws)))
    daemon = get_broker().get_daemon_for_host(host_id)
    assert daemon is not None
    assert daemon.home_dir == "/home/tester"
    assert get_broker().get_daemon_for_agent(agent_id) is daemon
    assert get_broker().get_daemon_for_agent(other_agent_id) is None

    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "online"
        assert host.version == "0.2.0"
        user = (await session.execute(select(User).where(User.id == user_id))).scalar_one()
        assert user.email == "ws-daemon-resync@example.com"

    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)
    assert get_broker().get_daemon_for_host(host_id) is None
    assert get_broker().get_daemon_for_agent(agent_id) is None


async def test_distributed_daemon_supersession_cannot_reclaim_presence_or_mark_host_offline(client):
    user_id, _ = await _signup(client, "ws-daemon-superseded@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]
    old.queue_text({"type": "register", "version": "old"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(old)))

    new = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    new_task = asyncio.create_task(daemon_ws(new, token=None))  # type: ignore[arg-type]
    new.queue_text({"type": "register", "version": "new"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(new)))

    # A late heartbeat from the old worker compare-refreshes its lease, fails,
    # and disconnects without overwriting the new worker's online state.
    old.queue_text({"type": "host.heartbeat"})
    await asyncio.wait_for(old_task, timeout=1)
    assert old.closed == (4000, "superseded")
    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "online"
        assert host.version == "new"

    new.queue_disconnect()
    await asyncio.wait_for(new_task, timeout=1)
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "offline"


async def test_daemon_ws_routes_rtc_signaling_back_to_browser(client):
    user_id, _ = await _signup(client, "ws-daemon-rtc@example.com")
    host_id = await _create_host(user_id)
    agent_id = await _create_agent(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    browser_ws = FakeDaemonWebSocket()
    browser_conn = BrowserConn(user_id=user_id, agent_id=agent_id, websocket=browser_ws)  # type: ignore[arg-type]
    signal_daemon = DaemonConn(
        host_id=host_id, user_id=user_id, websocket=FakeDaemonWebSocket()
    )  # type: ignore[arg-type]
    broker = get_broker()
    assert await broker.register_rtc_session(
        "rtc-daemon-1",
        browser_conn,
        daemon=signal_daemon,
        scope_type="agent",
        scope_id=agent_id,
        protocol="spawn.pty",
        protocol_version=1,
    )

    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(daemon_ws(ws, token=None))  # type: ignore[arg-type]
    await _wait_until(lambda: get_broker().get_daemon_for_host(host_id) is not None)
    live_daemon = get_broker().get_daemon_for_host(host_id)
    assert live_daemon is not None
    await broker.unregister_rtc_session("rtc-daemon-1", browser_conn)
    assert await broker.register_rtc_session(
        "rtc-daemon-1",
        browser_conn,
        daemon=live_daemon,
        scope_type="agent",
        scope_id=agent_id,
        protocol="spawn.pty",
        protocol_version=1,
    )

    ws.queue_text(
        {
            "type": "rtc.answer",
            "session_id": "rtc-daemon-1",
            "agent_id": agent_id,
            "sdp": "v=0\r\n",
        }
    )
    await _wait_until(lambda: any(item.get("type") == "rtc.answer" for item in _sent_json(browser_ws)))
    assert _sent_json(browser_ws)[-1] == {
        "type": "rtc.answer",
        "session_id": "rtc-daemon-1",
        "agent_id": agent_id,
        "sdp": "v=0\r\n",
    }

    candidate = {"candidate": "candidate:1 1 udp 1 127.0.0.1 9 typ host"}
    ws.queue_text(
        {
            "type": "rtc.candidate",
            "session_id": "rtc-daemon-1",
            "agent_id": agent_id,
            "candidate": candidate,
        }
    )
    await _wait_until(
        lambda: any(item.get("type") == "rtc.candidate" for item in _sent_json(browser_ws))
    )
    assert _sent_json(browser_ws)[-1] == {
        "type": "rtc.candidate",
        "session_id": "rtc-daemon-1",
        "agent_id": agent_id,
        "candidate": candidate,
    }

    ws.queue_text(
        {
            "type": "rtc.status",
            "session_id": "rtc-daemon-1",
            "agent_id": agent_id,
            "status": "connected",
        }
    )
    await _wait_until(lambda: any(item.get("type") == "rtc.status" for item in _sent_json(browser_ws)))
    assert _sent_json(browser_ws)[-1] == {
        "type": "rtc.status",
        "session_id": "rtc-daemon-1",
        "agent_id": agent_id,
        "status": "connected",
    }

    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)
    await broker.unregister_rtc_session("rtc-daemon-1", browser_conn)


async def test_daemon_ws_activity_is_content_free_and_host_scoped(
    client, monkeypatch, tmp_path
):
    """Only metadata frames stamp activity, and only for this daemon's host."""
    from spawn_server.config import get_settings

    monkeypatch.setenv("SPAWN_TRANSCRIPT_DIR", str(tmp_path))
    get_settings.cache_clear()  # type: ignore[attr-defined]
    user_id, _ = await _signup(client, "ws-daemon-activity@example.com")
    host_id = await _create_host(user_id)
    other_host_id = await _create_host(user_id, name="other-daemon-box")
    agent_id = await _create_agent(user_id, host_id, name="worker")
    binary_only_agent_id = await _create_agent(user_id, host_id, name="binary-only")
    other_agent_id = await _create_agent(user_id, other_host_id, name="other-host-agent")
    token = auth.issue_daemon_token(host_id, user_id)

    ws = FakeDaemonWebSocket()
    ws.queue_text(
        {
            "type": "register",
            "host_name": "spawnd",
            "os": "linux",
            "arch": "x86_64",
            "version": "0.1.0",
        }
    )
    ws.queue_bytes(encode_binary_frame(KIND_OUTPUT, binary_only_agent_id, b"secret terminal bytes"))
    ws.queue_text({"type": "agent.activity", "agent_id": agent_id})
    ws.queue_text({"type": "agent.input_activity", "agent_id": agent_id})
    ws.queue_text({"type": "agent.activity", "agent_id": other_agent_id})
    ws.queue_text({"type": "agent.input_activity", "agent_id": other_agent_id})
    ws.queue_disconnect()

    await daemon_ws(ws, token=token)  # type: ignore[arg-type]

    sm = get_sessionmaker()
    async with sm() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        assert agent.last_output_at is not None
        assert agent.last_input_at is not None

        binary_only_agent = await session.get(Agent, binary_only_agent_id)
        assert binary_only_agent is not None
        assert binary_only_agent.last_output_at is None
        assert binary_only_agent.last_input_at is None

        other_agent = await session.get(Agent, other_agent_id)
        assert other_agent is not None
        assert other_agent.last_output_at is None
        assert other_agent.last_input_at is None

        host = await session.get(Host, host_id)
        assert host is not None
        assert host.last_seen_at is not None

    get_settings.cache_clear()  # type: ignore[attr-defined]
