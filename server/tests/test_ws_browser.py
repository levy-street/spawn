"""Browser websocket auth, history, display control, and daemon forwarding."""

from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Callable
from typing import Any

from spawn_server import auth, transcript
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import Agent, Host
from spawn_server.redis import get_backend
from spawn_server.ws.broker import DaemonConn, get_broker
from spawn_server.ws.browser import INITIAL_SNAPSHOT_LINES, browser_ws
from spawn_server.ws.daemon import _pump_host_rtc_signals
from spawn_server.ws.frames import KIND_INPUT, decode_binary_frame
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
        self.scope: dict[str, Any] = {"subprotocols": subprotocols or ["spawn.v1"]}
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


async def test_browser_ws_rejects_missing_wrong_kind_and_cross_user_agents(client):
    user_a, token_a = await _signup(client, "ws-browser-a@example.com")
    _user_b, token_b = await _signup(client, "ws-browser-b@example.com")
    _host_id, agent_id = await _create_host_and_agent(user_a)

    missing = FakeBrowserWebSocket()
    await browser_ws(missing, agent_id=agent_id, token=None)  # type: ignore[arg-type]
    assert missing.accepted_subprotocol == "spawn.v1"
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
    await browser_ws(via_query, agent_id=agent_id, token=token_a, cols=None, rows=None)  # type: ignore[arg-type]
    assert via_query.closed is None


async def test_browser_ws_replays_transcript_history_and_status(client, tmp_path, monkeypatch):
    monkeypatch.setenv("SPAWN_TRANSCRIPT_DIR", str(tmp_path / "transcripts"))
    get_settings.cache_clear()  # type: ignore[attr-defined]
    user_id, token = await _signup(client, "ws-browser-history@example.com")
    _host_id, agent_id = await _create_host_and_agent(user_id, status="quiet")
    await transcript.append(agent_id, b"historical output\n")

    ws = FakeBrowserWebSocket(cookies={"spawn_session": token})
    ws.queue_disconnect()

    await browser_ws(ws, agent_id=agent_id, cols=120, rows=32)  # type: ignore[arg-type]

    display = _messages_of_type(ws, "display.control")
    assert display[0] == {
        "type": "display.control",
        "owner": True,
        "cols": 120,
        "rows": 32,
        "viewers": 1,
    }
    history = _messages_of_type(ws, "history")
    assert base64.b64decode(history[0]["bytes_b64"]) == b"historical output\n"
    assert _messages_of_type(ws, "agent.status")[-1] == {
        "type": "agent.status",
        "status": "quiet",
    }


async def test_browser_ws_seeds_history_from_small_connect_time_snapshot(client):
    user_id, token = await _signup(client, "ws-browser-daemon-history@example.com")
    host_id, agent_id = await _create_host_and_agent(user_id)

    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)
    await broker.attach_agent_to_daemon(agent_id, daemon)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(
        browser_ws(ws, agent_id=agent_id, token=None, cols=120, rows=32)  # type: ignore[arg-type]
    )
    await _wait_until(
        lambda: any(json.loads(item).get("type") == "agent.snapshot" for item in daemon_ws.sent_text)
    )

    snapshot_request = [
        json.loads(item)
        for item in daemon_ws.sent_text
        if json.loads(item).get("type") == "agent.snapshot"
    ][-1]
    assert snapshot_request == {
        "type": "agent.snapshot",
        "agent_id": agent_id,
        "lines": INITIAL_SNAPSHOT_LINES,
        "request_id": snapshot_request["request_id"],
    }

    assert await broker.resolve_snapshot(
        agent_id,
        {
            "request_id": snapshot_request["request_id"],
            "bytes_b64": base64.b64encode(b"daemon history\n").decode("ascii"),
        },
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    await _wait_until(lambda: len(_messages_of_type(ws, "history")) >= 1)
    history = _messages_of_type(ws, "history")[-1]
    assert base64.b64decode(history["bytes_b64"]) == b"daemon history\n"

    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)
    await broker.unregister_daemon(daemon)


async def test_browser_ws_display_control_tracks_owner_and_viewer_takeover(client):
    user_id, token = await _signup(client, "ws-browser-display@example.com")
    _host_id, agent_id = await _create_host_and_agent(user_id)

    first = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    second = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    first_task = asyncio.create_task(
        browser_ws(first, agent_id=agent_id, token=None, cols=100, rows=30)  # type: ignore[arg-type]
    )
    second_task = asyncio.create_task(
        browser_ws(second, agent_id=agent_id, token=None, cols=80, rows=24)  # type: ignore[arg-type]
    )

    await _wait_until(lambda: len(_messages_of_type(second, "display.control")) >= 1)
    assert _messages_of_type(first, "display.control")[-1]["owner"] is True
    assert _messages_of_type(first, "display.control")[-1]["viewers"] == 2
    assert _messages_of_type(second, "display.control")[-1] == {
        "type": "display.control",
        "owner": False,
        "cols": 100,
        "rows": 30,
        "viewers": 2,
    }

    second.queue_text({"type": "take_control", "cols": 132, "rows": 40})
    await _wait_until(lambda: _messages_of_type(second, "display.control")[-1]["owner"] is True)
    assert _messages_of_type(second, "display.control")[-1]["cols"] == 132
    assert _messages_of_type(second, "display.control")[-1]["rows"] == 40
    assert _messages_of_type(first, "display.control")[-1]["owner"] is False

    first.queue_disconnect()
    second.queue_disconnect()
    await asyncio.wait_for(first_task, timeout=1)
    await asyncio.wait_for(second_task, timeout=1)


async def test_browser_ws_forwards_input_resize_scroll_snapshot_and_upload_to_daemon(
    client, monkeypatch
):
    monkeypatch.setenv("SPAWN_WEBRTC_ENABLED", "1")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    user_id, token = await _signup(client, "ws-browser-forward@example.com")
    host_id, agent_id = await _create_host_and_agent(user_id)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(
        browser_ws(ws, agent_id=agent_id, token=None, cols=100, rows=30)  # type: ignore[arg-type]
    )
    await _wait_until(lambda: len(_messages_of_type(ws, "agent.status")) >= 1)

    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)
    await broker.attach_agent_to_daemon(agent_id, daemon)
    signal_ready = asyncio.Event()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task = asyncio.create_task(
        _pump_host_rtc_signals(daemon, signal_ready, expiry_tasks)
    )
    await wait_for_signal_pump(signal_task, signal_ready)

    ws.queue_bytes(b"hello")
    await _wait_until(lambda: len(daemon_ws.sent_bytes) >= 1)
    frame = decode_binary_frame(daemon_ws.sent_bytes[-1])
    assert frame.kind == KIND_INPUT
    assert frame.agent_id == agent_id
    assert frame.payload == b"hello"

    ws.queue_text({"type": "resize", "cols": 111, "rows": 33})
    await _wait_until(
        lambda: any(json.loads(item).get("type") == "agent.resize" for item in daemon_ws.sent_text)
    )
    resize = [json.loads(item) for item in daemon_ws.sent_text if json.loads(item).get("type") == "agent.resize"][-1]
    assert resize == {"type": "agent.resize", "agent_id": agent_id, "cols": 111, "rows": 33}

    # Legacy spawn.v1 input still stamps activity on the server because its
    # bytes traverse this websocket path.
    sm = get_sessionmaker()
    async with sm() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        assert agent.last_input_at is not None

    ws.queue_text({"type": "scroll", "lines": 999})
    await _wait_until(
        lambda: any(json.loads(item).get("type") == "agent.scroll" for item in daemon_ws.sent_text)
    )
    scroll = [json.loads(item) for item in daemon_ws.sent_text if json.loads(item).get("type") == "agent.scroll"][-1]
    assert scroll == {"type": "agent.scroll", "agent_id": agent_id, "lines": 200}

    upload_body = base64.b64encode(b"file body").decode("ascii")
    ws.queue_text(
        {
            "type": "upload",
            "name": "note.txt",
            "mime_type": "text/plain",
            "bytes_b64": upload_body,
            "destination": "cwd",
            "paste": False,
            "client_id": "client-1",
        }
    )
    await _wait_until(
        lambda: any(json.loads(item).get("type") == "agent.upload" for item in daemon_ws.sent_text)
    )
    upload = [json.loads(item) for item in daemon_ws.sent_text if json.loads(item).get("type") == "agent.upload"][-1]
    request_id = upload.pop("request_id")
    assert isinstance(request_id, str)
    assert request_id != "client-1"
    assert upload == {
        "type": "agent.upload",
        "agent_id": agent_id,
        "cwd": "/repo",
        "name": "note.txt",
        "mime_type": "text/plain",
        "bytes_b64": upload_body,
        "paste_prefix": "",
        "paste": False,
        "destination": "cwd",
        "client_id": "client-1",
    }
    result = {
        "type": "agent.uploaded",
        "agent_id": agent_id,
        "request_id": request_id,
        "client_id": "client-1",
        "path": "/repo/note.txt",
    }
    assert await broker.resolve_upload(
        agent_id,
        request_id,
        result,
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    await _wait_until(lambda: bool(_messages_of_type(ws, "upload.saved")))
    assert _messages_of_type(ws, "upload.saved")[-1] == {
        "type": "upload.saved",
        "client_id": "client-1",
        "path": "/repo/note.txt",
    }

    ws.queue_text({"type": "redraw"})
    await _wait_until(
        lambda: any(json.loads(item).get("type") == "agent.redraw" for item in daemon_ws.sent_text)
    )
    redraw = [
        json.loads(item)
        for item in daemon_ws.sent_text
        if json.loads(item).get("type") == "agent.redraw"
    ][-1]
    assert redraw == {"type": "agent.redraw", "agent_id": agent_id}

    ws.queue_text({"type": "rtc.offer", "session_id": "rtc-browser-1", "sdp": "v=0\r\n"})
    await _wait_until(
        lambda: any(json.loads(item).get("type") == "rtc.offer" for item in daemon_ws.sent_text)
    )
    offer = [json.loads(item) for item in daemon_ws.sent_text if json.loads(item).get("type") == "rtc.offer"][-1]
    assert offer == {
        "type": "rtc.offer",
        "session_id": "rtc-browser-1",
        "agent_id": agent_id,
        "binding_nonce": offer["binding_nonce"],
        "sdp": "v=0\r\n",
        "ice_servers": [{"urls": ["stun:stun.l.google.com:19302"]}],
    }

    candidate = {"candidate": "candidate:1 1 udp 1 127.0.0.1 9 typ host"}
    ws.queue_text({"type": "rtc.candidate", "session_id": "rtc-browser-1", "candidate": candidate})
    await _wait_until(
        lambda: any(json.loads(item).get("type") == "rtc.candidate" for item in daemon_ws.sent_text)
    )
    rtc_candidate = [
        json.loads(item)
        for item in daemon_ws.sent_text
        if json.loads(item).get("type") == "rtc.candidate"
    ][-1]
    assert rtc_candidate == {
        "type": "rtc.candidate",
        "session_id": "rtc-browser-1",
        "agent_id": agent_id,
        "binding_nonce": offer["binding_nonce"],
        "candidate": candidate,
    }

    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)
    signal_task.cancel()
    await asyncio.gather(signal_task, return_exceptions=True)
    for expiry_task in expiry_tasks:
        expiry_task.cancel()
    await asyncio.gather(*expiry_tasks, return_exceptions=True)
    await broker.unregister_daemon(daemon)


async def test_browser_upload_reports_exact_daemon_error_and_timeout(client, monkeypatch):
    monkeypatch.setattr("spawn_server.ws.browser.BROWSER_UPLOAD_TIMEOUT_SECONDS", 0.03)
    user_id, token = await _signup(client, "ws-browser-upload-results@example.com")
    host_id, agent_id = await _create_host_and_agent(user_id)
    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(
        browser_ws(ws, agent_id=agent_id, token=None, cols=80, rows=24)  # type: ignore[arg-type]
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


async def test_browser_ws_fans_out_live_bytes_and_isolates_agents(client):
    from spawn_server.redis import get_backend

    user_id, token = await _signup(client, "ws-browser-fanout@example.com")
    _host_id, agent_ids = await _create_host_with_agents(user_id, 2)
    first_agent, second_agent = agent_ids

    first_agent_sockets = [
        FakeBrowserWebSocket(authorization=f"Bearer {token}"),
        FakeBrowserWebSocket(authorization=f"Bearer {token}"),
        FakeBrowserWebSocket(authorization=f"Bearer {token}"),
    ]
    second_agent_sockets = [
        FakeBrowserWebSocket(authorization=f"Bearer {token}"),
        FakeBrowserWebSocket(authorization=f"Bearer {token}"),
    ]
    tasks = [
        asyncio.create_task(browser_ws(ws, agent_id=first_agent, token=None, cols=100, rows=30))  # type: ignore[arg-type]
        for ws in first_agent_sockets
    ] + [
        asyncio.create_task(browser_ws(ws, agent_id=second_agent, token=None, cols=90, rows=25))  # type: ignore[arg-type]
        for ws in second_agent_sockets
    ]

    try:
        all_sockets = first_agent_sockets + second_agent_sockets
        await _wait_until(
            lambda: all(len(_messages_of_type(ws, "agent.status")) >= 1 for ws in all_sockets)
        )
        backend = get_backend()
        assert backend.inproc is not None
        await _wait_until(
            lambda: len(backend.inproc._subs.get(f"spawn:agent:{first_agent}", ())) == 3
            and len(backend.inproc._subs.get(f"spawn:agent:{second_agent}", ())) == 2
        )

        await backend.publish(first_agent, b"first-agent-output\n")
        await backend.publish(second_agent, b"second-agent-output\n")

        await _wait_until(
            lambda: all(b"first-agent-output" in b"".join(ws.sent_bytes) for ws in first_agent_sockets)
            and all(
                b"second-agent-output" in b"".join(ws.sent_bytes) for ws in second_agent_sockets
            )
        )
        assert all(b"second-agent-output" not in b"".join(ws.sent_bytes) for ws in first_agent_sockets)
        assert all(b"first-agent-output" not in b"".join(ws.sent_bytes) for ws in second_agent_sockets)

        first_agent_display = [
            _messages_of_type(ws, "display.control")[-1] for ws in first_agent_sockets
        ]
        second_agent_display = [
            _messages_of_type(ws, "display.control")[-1] for ws in second_agent_sockets
        ]
        assert {message["viewers"] for message in first_agent_display} == {3}
        assert {message["viewers"] for message in second_agent_display} == {2}
        assert sum(1 for message in first_agent_display if message["owner"]) == 1
        assert sum(1 for message in second_agent_display if message["owner"]) == 1
    finally:
        for ws in first_agent_sockets + second_agent_sockets:
            ws.queue_disconnect()
        await asyncio.gather(*(asyncio.wait_for(task, timeout=1) for task in tasks))


async def test_browser_ws_v2_never_relays_pty_bytes(client):
    """spawn.v2 (docs/TRUST.md Phase 1): no binary in either direction."""
    from spawn_server.redis import get_backend

    user_id, token = await _signup(client, "ws-browser-v2@example.com")
    _host_id, agent_id = await _create_host_and_agent(user_id)

    ws = FakeBrowserWebSocket(
        authorization=f"Bearer {token}", subprotocols=["spawn.v2", "spawn.v1"]
    )
    task = asyncio.create_task(browser_ws(ws, agent_id=agent_id, token=None, cols=100, rows=30))  # type: ignore[arg-type]

    try:
        await _wait_until(lambda: len(_messages_of_type(ws, "agent.status")) >= 1)
        assert ws.accepted_subprotocol == "spawn.v2"
        # Control frames still flow: signaling config reaches the browser.
        assert len(_messages_of_type(ws, "rtc.config")) == 1

        # v2 browsers are never subscribed to the PTY pubsub feed.
        backend = get_backend()
        assert backend.inproc is not None
        assert len(backend.inproc._subs.get(f"spawn:agent:{agent_id}", ())) == 0
        await backend.publish(agent_id, b"live-output\n")
        await asyncio.sleep(0.05)
        assert ws.sent_bytes == []
    finally:
        ws.queue_disconnect()
        await asyncio.wait_for(task, timeout=1)


async def test_browser_ws_v2_rejects_binary_input_as_protocol_error(client):
    user_id, token = await _signup(client, "ws-browser-v2-input@example.com")
    _host_id, agent_id = await _create_host_and_agent(user_id)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}", subprotocols=["spawn.v2"])
    task = asyncio.create_task(browser_ws(ws, agent_id=agent_id, token=None, cols=100, rows=30))  # type: ignore[arg-type]

    await _wait_until(lambda: len(_messages_of_type(ws, "agent.status")) >= 1)
    ws.queue_bytes(b"stdin over the relay")
    await asyncio.wait_for(task, timeout=1)

    assert ws.closed is not None
    assert ws.closed[0] == 4002


async def test_browser_ws_v2_falls_back_to_v1_when_webrtc_disabled(client, monkeypatch):
    monkeypatch.setenv("SPAWN_WEBRTC_ENABLED", "false")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    try:
        user_id, token = await _signup(client, "ws-browser-v2-nortc@example.com")
        _host_id, agent_id = await _create_host_and_agent(user_id)

        ws = FakeBrowserWebSocket(
            authorization=f"Bearer {token}", subprotocols=["spawn.v2", "spawn.v1"]
        )
        ws.queue_disconnect()
        await browser_ws(ws, agent_id=agent_id, token=None, cols=100, rows=30)  # type: ignore[arg-type]

        # A v2 accept with WebRTC off would leave the client with no live
        # path at all; the server keeps such clients on the v1 relay.
        assert ws.accepted_subprotocol == "spawn.v1"
    finally:
        monkeypatch.delenv("SPAWN_WEBRTC_ENABLED", raising=False)
        get_settings.cache_clear()  # type: ignore[attr-defined]
