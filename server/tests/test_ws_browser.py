"""Browser websocket auth, history, display control, and daemon forwarding."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Callable
from typing import Any

from spawn_server import auth
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import Agent, Host
from spawn_server.redis import get_backend
from spawn_server.ws.broker import DaemonConn, get_broker
from spawn_server.ws.browser import browser_ws
from spawn_server.ws.daemon import _pump_host_rtc_signals
from spawn_server.ws.host_signal import (
    HOST_DAEMON_PRESENCE_TTL_SECONDS,
    HostPresenceOwner,
    encode_host_presence_owner,
    host_presence_key,
    wait_for_signal_pump,
)


class FakeBrowserWebSocket:
    def __init__(
        self,
        *,
        authorization: str | None = None,
        cookies: dict[str, str] | None = None,
        subprotocols: list[str] | None = None,
    ):
        self.headers: dict[str, str] = {}
        if authorization is not None:
            self.headers["authorization"] = authorization
        self.cookies = cookies or {}
        self.scope: dict[str, Any] = {"subprotocols": subprotocols or ["spawn.v2"]}
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

    async def send_json(self, value: dict[str, Any]) -> None:
        self.sent_text.append(json.dumps(value))

    async def send_bytes(self, value: bytes) -> None:
        self.sent_bytes.append(value)

    def queue_text(self, payload: dict[str, Any]) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "text": json.dumps(payload)})

    def queue_bytes(self, payload: bytes) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "bytes": payload})

    def queue_disconnect(self) -> None:
        self._incoming.put_nowait({"type": "websocket.disconnect"})


class FakeDaemonWebSocket:
    def __init__(self) -> None:
        self.sent_text: list[str] = []
        self.sent_bytes: list[bytes] = []
        self.closed: tuple[int, str] | None = None

    async def send_text(self, value: str) -> None:
        self.sent_text.append(value)

    async def send_bytes(self, value: bytes) -> None:
        self.sent_bytes.append(value)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)


async def _signup(client, email: str) -> tuple[str, str]:
    response = await client.post(
        "/api/auth/signup", json={"email": email, "password": "passpasspass"}
    )
    assert response.status_code == 200, response.text
    return response.json()["user"]["id"], response.json()["access_token"]


async def _create_host_and_agent(user_id: str, *, status: str = "running") -> tuple[str, str]:
    sm = get_sessionmaker()
    async with sm() as session:
        host = Host(owner_user_id=user_id, name="browser-host", status="online")
        session.add(host)
        await session.flush()
        agent = Agent(
            owner_user_id=user_id,
            host_id=host.id,
            name="browser-agent",
            cwd="/repo",
            argv=["sh"],
            status=status,
        )
        session.add(agent)
        await session.commit()
        return host.id, agent.id


async def _create_host_with_agents(user_id: str, count: int) -> tuple[str, list[str]]:
    sm = get_sessionmaker()
    async with sm() as session:
        host = Host(owner_user_id=user_id, name="browser-host", status="online")
        session.add(host)
        await session.flush()
        agents = [
            Agent(
                owner_user_id=user_id,
                host_id=host.id,
                name=f"browser-agent-{index}",
                cwd=f"/repo/{index}",
                argv=["sh"],
                status="running",
            )
            for index in range(count)
        ]
        session.add_all(agents)
        await session.commit()
        return host.id, [agent.id for agent in agents]


async def _wait_until(predicate: Callable[[], bool], *, timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting for condition")


async def _accept_daemon(daemon: DaemonConn, *, generation: int = 1) -> None:
    daemon.host_generation = generation
    async with get_sessionmaker()() as session:
        host = await session.get(Host, daemon.host_id)
        assert host is not None
        host.daemon_connection_id = daemon.id
        host.daemon_generation = generation
        host.daemon_generation_counter = generation
        host.daemon_pending_connection_id = None
        host.daemon_pending_generation = None
        await session.commit()
    await get_backend().set_ephemeral(
        host_presence_key(daemon.host_id),
        encode_host_presence_owner(HostPresenceOwner(daemon.id, generation)),
        ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
    )
    assert await get_broker().accept_daemon_owner(daemon, generation)


def _sent_json(ws: FakeBrowserWebSocket) -> list[dict[str, Any]]:
    return [json.loads(item) for item in ws.sent_text]


def _messages_of_type(ws: FakeBrowserWebSocket, frame_type: str) -> list[dict[str, Any]]:
    return [item for item in _sent_json(ws) if item.get("type") == frame_type]


def _daemon_messages_of_type(
    ws: FakeDaemonWebSocket, frame_type: str
) -> list[dict[str, Any]]:
    return [
        item
        for item in (json.loads(payload) for payload in ws.sent_text)
        if item.get("type") == frame_type
    ]


async def test_browser_ws_rejects_missing_wrong_kind_and_cross_user_agents(client):
    user_a, token_a = await _signup(client, "ws-browser-a@example.com")
    _user_b, token_b = await _signup(client, "ws-browser-b@example.com")
    _host_id, agent_id = await _create_host_and_agent(user_a)

    missing = FakeBrowserWebSocket()
    await browser_ws(missing, agent_id=agent_id, token=None)  # type: ignore[arg-type]
    assert missing.accepted_subprotocol == "spawn.v2"
    assert missing.closed == (1008, "not authenticated")

    daemon_token = auth.issue_daemon_token("00000000-0000-4000-8000-000000000001", user_a)
    wrong_kind = FakeBrowserWebSocket(authorization=f"Bearer {daemon_token}")
    await browser_ws(wrong_kind, agent_id=agent_id, token=None)  # type: ignore[arg-type]
    assert wrong_kind.closed == (1008, "wrong token kind")

    cross_user = FakeBrowserWebSocket(authorization=f"Bearer {token_b}")
    await browser_ws(cross_user, agent_id=agent_id, token=None)  # type: ignore[arg-type]
    assert cross_user.closed == (1008, "agent not found")

    via_query = FakeBrowserWebSocket()
    via_query.queue_disconnect()
    await browser_ws(via_query, agent_id=agent_id, token=token_a)  # type: ignore[arg-type]
    assert via_query.closed is None

    old = FakeBrowserWebSocket(
        authorization=f"Bearer {token_a}", subprotocols=["spawn.v1"]
    )
    await browser_ws(old, agent_id=agent_id, token=None)  # type: ignore[arg-type]
    assert old.accepted_subprotocol is None
    assert _messages_of_type(old, "protocol.required") == [
        {"type": "protocol.required", "protocol": "spawn.v2", "version": 2}
    ]
    assert old.closed == (4003, "protocol upgrade required")



async def test_browser_upload_reports_exact_daemon_error_and_timeout(client, monkeypatch):
    monkeypatch.setattr("spawn_server.ws.browser.BROWSER_UPLOAD_TIMEOUT_SECONDS", 0.03)
    user_id, token = await _signup(client, "ws-browser-upload-results@example.com")
    host_id, agent_id = await _create_host_and_agent(user_id)
    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(
        browser_ws(ws, agent_id=agent_id, token=None)  # type: ignore[arg-type]
    )
    await _wait_until(lambda: bool(_messages_of_type(ws, "agent.status")))

    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)
    await broker.attach_agent_to_daemon(agent_id, daemon)

    body = base64.b64encode(b"body").decode("ascii")
    ws.queue_text(
        {
            "type": "upload",
            "name": "error.txt",
            "mime_type": "text/plain",
            "bytes_b64": body,
            "destination": "cwd",
            "client_id": "upload-error",
        }
    )
    await _wait_until(
        lambda: any(
            message.get("type") == "agent.upload"
            and message.get("client_id") == "upload-error"
            for message in (json.loads(item) for item in daemon_ws.sent_text)
        )
    )
    request = [
        json.loads(item)
        for item in daemon_ws.sent_text
        if json.loads(item).get("client_id") == "upload-error"
    ][-1]
    error = {
        "type": "error",
        "code": "upload_failed",
        "message": "disk full",
        "request_id": request["request_id"],
        "client_id": "upload-error",
    }
    await broker.resolve_upload(
        agent_id,
        request["request_id"],
        error,
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    await _wait_until(
        lambda: any(
            message.get("client_id") == "upload-error"
            for message in _messages_of_type(ws, "upload.error")
        )
    )
    assert _messages_of_type(ws, "upload.error")[-1] == {
        "type": "upload.error",
        "client_id": "upload-error",
        "message": "disk full",
    }

    ws.queue_text(
        {
            "type": "upload",
            "name": "timeout.txt",
            "mime_type": "text/plain",
            "bytes_b64": body,
            "destination": "cwd",
            "client_id": "upload-timeout",
        }
    )
    await _wait_until(
        lambda: any(
            message.get("client_id") == "upload-timeout"
            and message.get("message") == "Upload timed out."
            for message in _messages_of_type(ws, "upload.error")
        )
    )

    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)



async def test_browser_ws_v2_never_relays_pty_bytes(client):
    """spawn.v2 never exposes a server-side PTY byte path."""

    user_id, token = await _signup(client, "ws-browser-v2@example.com")
    host_id, agent_id = await _create_host_and_agent(user_id)
    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    await broker.register_daemon(daemon)
    await broker.attach_agent_to_daemon(agent_id, daemon)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}", subprotocols=["spawn.v2"])
    task = asyncio.create_task(browser_ws(ws, agent_id=agent_id, token=None))  # type: ignore[arg-type]

    try:
        await _wait_until(lambda: len(_messages_of_type(ws, "agent.status")) >= 1)
        assert ws.accepted_subprotocol == "spawn.v2"
        # Control frames still flow: signaling config reaches the browser.
        assert len(_messages_of_type(ws, "rtc.config")) == 1
        # History, snapshots, geometry and display ownership are now carried
        # only by the endpoint-to-endpoint spawn.ctl DataChannel.
        assert _messages_of_type(ws, "history") == []
        assert _messages_of_type(ws, "snapshot") == []
        assert _messages_of_type(ws, "display.control") == []
        daemon_frames = [json.loads(item) for item in daemon_ws.sent_text]
        assert not any(
            frame.get("type")
            in {"agent.snapshot", "agent.resize", "agent.scroll", "agent.redraw"}
            for frame in daemon_frames
        )

        # There is no terminal-content pubsub channel or binary send path.
        backend = get_backend()
        assert backend.inproc is not None
        assert f"spawn:agent:{agent_id}" not in backend.inproc._subs
        assert ws.sent_bytes == []
    finally:
        ws.queue_disconnect()
        await asyncio.wait_for(task, timeout=1)
        await broker.unregister_daemon(daemon)


async def test_browser_ws_v2_reused_session_rejects_stale_binding_frames(client, monkeypatch):
    monkeypatch.setenv("SPAWN_WEBRTC_ENABLED", "1")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    user_id, token = await _signup(client, "ws-browser-v2-binding@example.com")
    host_id, agent_id = await _create_host_and_agent(user_id)

    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task: asyncio.Task[None] | None = None

    ws = FakeBrowserWebSocket(
        authorization=f"Bearer {token}", subprotocols=["spawn.v2"]
    )
    task = asyncio.create_task(
        browser_ws(ws, agent_id=agent_id, token=None)  # type: ignore[arg-type]
    )
    session_id = "reused-v2-session"
    nonce_a = "a" * 32
    nonce_b = "b" * 32

    try:
        await _wait_until(lambda: bool(_messages_of_type(ws, "rtc.config")))
        assert _messages_of_type(ws, "rtc.config")[-1]["binding_nonce_required"] is True

        await broker.register_daemon(daemon)
        await _accept_daemon(daemon)
        await broker.attach_agent_to_daemon(agent_id, daemon)
        signal_ready = asyncio.Event()
        signal_task = asyncio.create_task(
            _pump_host_rtc_signals(daemon, signal_ready, expiry_tasks)
        )
        await wait_for_signal_pump(signal_task, signal_ready)

        # v2 offers without a browser-generated binding identity fail closed.
        ws.queue_text({"type": "rtc.offer", "session_id": session_id, "sdp": "v=0\r\n"})
        await asyncio.sleep(0.02)
        assert not _daemon_messages_of_type(daemon_ws, "rtc.offer")

        ws.queue_text(
            {
                "type": "rtc.offer",
                "session_id": session_id,
                "binding_nonce": nonce_a,
                "sdp": "v=0\r\nA",
            }
        )
        await _wait_until(
            lambda: len(_daemon_messages_of_type(daemon_ws, "rtc.offer")) == 1
        )
        first_offer = _daemon_messages_of_type(daemon_ws, "rtc.offer")[-1]
        assert first_offer["binding_nonce"] == nonce_a
        assert first_offer["binding_generation"] == daemon.host_generation
        assert first_offer["scope_type"] == "agent"
        assert first_offer["scope_id"] == agent_id
        assert first_offer["protocol"] == "spawn.pty"
        assert first_offer["protocol_version"] == 2

        ws.queue_text(
            {"type": "rtc.close", "session_id": session_id, "binding_nonce": nonce_a}
        )
        await _wait_until(
            lambda: bool(_daemon_messages_of_type(daemon_ws, "rtc.close"))
        )

        negotiating_before = len(
            [
                message
                for message in _messages_of_type(ws, "rtc.status")
                if message.get("status") == "negotiating"
            ]
        )
        ws.queue_text(
            {
                "type": "rtc.offer",
                "session_id": session_id,
                "binding_nonce": nonce_a,
                "sdp": "v=0\r\nretired-A",
            }
        )
        await _wait_until(
            lambda: any(
                message.get("status") == "failed"
                and message.get("binding_nonce") == nonce_a
                for message in _messages_of_type(ws, "rtc.status")
            )
        )
        assert len(_daemon_messages_of_type(daemon_ws, "rtc.offer")) == 1
        assert (
            len(
                [
                    message
                    for message in _messages_of_type(ws, "rtc.status")
                    if message.get("status") == "negotiating"
                ]
            )
            == negotiating_before
        )
        assert await broker.rtc_session_for(session_id) is None

        ws.queue_text(
            {
                "type": "rtc.offer",
                "session_id": session_id,
                "binding_nonce": nonce_b,
                "sdp": "v=0\r\nB",
            }
        )
        await _wait_until(
            lambda: len(_daemon_messages_of_type(daemon_ws, "rtc.offer")) == 2
        )

        before_candidate_count = len(
            _daemon_messages_of_type(daemon_ws, "rtc.candidate")
        )
        before_close_count = len(_daemon_messages_of_type(daemon_ws, "rtc.close"))
        candidate = {"candidate": "candidate:1 1 udp 1 127.0.0.1 9 typ host"}
        ws.queue_text(
            {
                "type": "rtc.candidate",
                "session_id": session_id,
                "binding_nonce": nonce_a,
                "candidate": candidate,
            }
        )
        ws.queue_text(
            {"type": "rtc.close", "session_id": session_id, "binding_nonce": nonce_a}
        )
        await asyncio.sleep(0.02)
        assert (
            len(_daemon_messages_of_type(daemon_ws, "rtc.candidate"))
            == before_candidate_count
        )
        assert len(_daemon_messages_of_type(daemon_ws, "rtc.close")) == before_close_count
        current = await broker.rtc_session_for(session_id)
        assert current is not None
        assert current.nonce == nonce_b

        ws.queue_text(
            {
                "type": "rtc.candidate",
                "session_id": session_id,
                "binding_nonce": nonce_b,
                "candidate": candidate,
            }
        )
        await _wait_until(
            lambda: len(_daemon_messages_of_type(daemon_ws, "rtc.candidate"))
            == before_candidate_count + 1
        )
    finally:
        ws.queue_disconnect()
        await asyncio.wait_for(task, timeout=1)
        if signal_task is not None:
            signal_task.cancel()
            await asyncio.gather(signal_task, return_exceptions=True)
        for expiry_task in expiry_tasks:
            expiry_task.cancel()
        await asyncio.gather(*expiry_tasks, return_exceptions=True)
        await broker.unregister_daemon(daemon)
        get_settings.cache_clear()  # type: ignore[attr-defined]


async def test_browser_ws_v2_rejects_binary_input_as_protocol_error(client):
    user_id, token = await _signup(client, "ws-browser-v2-input@example.com")
    _host_id, agent_id = await _create_host_and_agent(user_id)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}", subprotocols=["spawn.v2"])
    task = asyncio.create_task(browser_ws(ws, agent_id=agent_id, token=None))  # type: ignore[arg-type]

    await _wait_until(lambda: len(_messages_of_type(ws, "agent.status")) >= 1)
    ws.queue_bytes(b"stdin over the relay")
    await asyncio.wait_for(task, timeout=1)

    assert ws.closed is not None
    assert ws.closed[0] == 4002


async def test_browser_ws_v2_rejects_server_visible_viewport_control(client):
    user_id, token = await _signup(client, "ws-browser-v2-control@example.com")
    _host_id, agent_id = await _create_host_and_agent(user_id)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}", subprotocols=["spawn.v2"])
    task = asyncio.create_task(
        browser_ws(ws, agent_id=agent_id, token=None)  # type: ignore[arg-type]
    )

    await _wait_until(lambda: len(_messages_of_type(ws, "agent.status")) >= 1)
    ws.queue_text({"type": "resize", "cols": 132, "rows": 40})
    await asyncio.wait_for(task, timeout=1)

    assert ws.closed == (4002, "terminal control belongs on spawn.ctl")
