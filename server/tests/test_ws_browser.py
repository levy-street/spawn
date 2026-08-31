"""Browser websocket auth, history, display control, and daemon forwarding."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from spawn_server import auth
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import Host, Session, User
from spawn_server.redis import get_backend
from spawn_server.ws.broker import BrowserConn, DaemonConn, get_broker
from spawn_server.ws.browser import (
    _schedule_browser_orphan_expiry,
    _valid_rtc_candidate,
    browser_ws,
)
from spawn_server.ws.daemon import _pump_host_rtc_signals
from spawn_server.ws.host_signal import (
    HOST_DAEMON_PRESENCE_TTL_SECONDS,
    HostPresenceOwner,
    RedisBrowserConn,
    browser_signal_channel,
    encode_host_presence_owner,
    host_presence_key,
    wait_for_signal_pump,
)


def _signed_session_wire(signal_type: str, session_id: str, pty_id: str) -> str:
    vectors = json.loads(
        (Path(__file__).parents[2] / "proto" / "signed-signal-wire-v1-vectors.json").read_text()
    )["vectors"]
    envelope = dict(vectors[0]["envelope"])
    envelope.update(
        {
            "type": signal_type,
            "session_id": session_id,
            "scope_type": "session",
            "scope_id": pty_id,
            "sender_role": "browser" if signal_type == "rtc.offer" else "daemon",
        }
    )
    # Structurally canonical substitutions prove the server is not acting as
    # a trust oracle and does not rewrite security-relevant fields.
    sender = envelope["sender_identity_public_key"]
    peer = envelope["intended_peer_identity_public_key"]
    envelope["sender_identity_public_key"] = peer
    envelope["intended_peer_identity_public_key"] = sender
    signature = str(envelope["signature"])
    envelope["signature"] = ("A" if signature[0] != "A" else "B") + signature[1:]
    return "\n" + json.dumps(envelope, separators=(",", ":")) + " "


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
        self.scope: dict[str, Any] = {"subprotocols": subprotocols or ["spawn.v3"]}
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


async def _create_host_and_session(user_id: str, *, status: str = "running") -> tuple[str, str]:
    sm = get_sessionmaker()
    async with sm() as session:
        host = Host(owner_user_id=user_id, name="browser-host", status="online")
        session.add(host)
        await session.flush()
        row = Session(
            owner_user_id=user_id,
            host_id=host.id,
            name="browser-session",
            cwd="/repo",
            status=status,
        )
        session.add(row)
        await session.commit()
        return host.id, row.id


async def _create_host_with_sessions(user_id: str, count: int) -> tuple[str, list[str]]:
    sm = get_sessionmaker()
    async with sm() as session:
        host = Host(owner_user_id=user_id, name="browser-host", status="online")
        session.add(host)
        await session.flush()
        rows = [
            Session(
                owner_user_id=user_id,
                host_id=host.id,
                name=f"browser-session-{index}",
                cwd=f"/repo/{index}",
                status="running",
            )
            for index in range(count)
        ]
        session.add_all(rows)
        await session.commit()
        return host.id, [row.id for row in rows]


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


def _daemon_messages_of_type(ws: FakeDaemonWebSocket, frame_type: str) -> list[dict[str, Any]]:
    return [
        item
        for item in (json.loads(payload) for payload in ws.sent_text)
        if item.get("type") == frame_type
    ]


def _session_rtc_frame(pty_id: str, **fields: object) -> dict[str, object]:
    return {
        "scope_type": "session",
        "scope_id": pty_id,
        "protocol": "spawn.pty",
        "protocol_version": 2,
        **fields,
    }


def test_rtc_candidate_allowlist_and_bounds():
    assert _valid_rtc_candidate(
        {
            "candidate": "candidate:1",
            "sdpMid": "0",
            "sdpMLineIndex": 0,
            "usernameFragment": "ufrag",
            "secret_extension": "drop-me",
        }
    ) == {
        "candidate": "candidate:1",
        "sdpMid": "0",
        "sdpMLineIndex": 0,
        "usernameFragment": "ufrag",
    }
    assert _valid_rtc_candidate({"candidate": "x" * 1025}) is None
    assert _valid_rtc_candidate({"candidate": "ok", "sdpMLineIndex": 65536}) is None


def test_a_null_optional_field_reads_as_absent_not_as_malformed():
    """The shape every peer actually sends.

    webrtc-rs serializes every member of RTCIceCandidateInit whether or not it
    is set, so each candidate the daemon sends carries
    ``"usernameFragment": null``; browsers send ``"sdpMid": null`` for a
    candidate belonging to no m-line. Refusing those refused every ICE
    candidate the daemon ever sent: the browser received none, sent no
    connectivity checks, and the host-control DataChannel never opened.
    """
    from spawn_server.ws.daemon import _valid_rtc_candidate as daemon_valid

    for validate in (_valid_rtc_candidate, daemon_valid):
        assert validate(
            {
                "candidate": "candidate:1 1 udp 2130706431 192.168.1.165 50123 typ host",
                "sdpMid": "0",
                "sdpMLineIndex": 0,
                "usernameFragment": None,
            }
        ) == {
            "candidate": "candidate:1 1 udp 2130706431 192.168.1.165 50123 typ host",
            "sdpMid": "0",
            "sdpMLineIndex": 0,
        }
        assert validate({"candidate": "candidate:1", "sdpMid": None}) == {
            "candidate": "candidate:1"
        }
        assert validate({"candidate": "candidate:1", "sdpMLineIndex": None}) == {
            "candidate": "candidate:1"
        }
        # Null is the absence of a value, never a licence for the wrong one.
        assert validate({"candidate": "candidate:1", "sdpMid": 7}) is None
        assert validate({"candidate": "candidate:1", "usernameFragment": "x" * 257}) is None
        assert validate({"candidate": "candidate:1", "sdpMLineIndex": True}) is None
        assert validate({"candidate": "candidate:1", "sdpMLineIndex": 65536}) is None
        assert validate({"candidate": None}) is None


def test_query_token_deprecation_warns_once_per_process(monkeypatch, caplog):
    from spawn_server.ws import reliability

    monkeypatch.setattr(reliability, "_query_token_warning_emitted", False)
    logger = logging.getLogger("test.ws.query-token")
    with caplog.at_level(logging.WARNING):
        reliability.warn_query_token_once(logger)
        reliability.warn_query_token_once(logger)
    assert caplog.text.count("deprecated websocket ?token=") == 1


async def test_browser_orphan_grace_expiry_publishes_exact_rtc_close(client):
    user_id, _token = await _signup(client, "ws-browser-orphan-expiry@example.com")
    host_id, pty_id = await _create_host_and_session(user_id)
    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)
    ready = asyncio.Event()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task = asyncio.create_task(_pump_host_rtc_signals(daemon, ready, expiry_tasks))
    await wait_for_signal_pump(signal_task, ready)

    route = RedisBrowserConn(
        user_id=user_id,
        host_id=host_id,
        channel=browser_signal_channel("c" * 32),
        daemon_connection_id=daemon.id,
        daemon_generation=1,
        binding_nonce="c" * 32,
    )
    assert await broker.register_rtc_session(
        "orphan-expiry",
        route,
        daemon=daemon,
        scope_type="session",
        scope_id=pty_id,
        protocol="spawn.pty",
        protocol_version=2,
        binding_nonce="c" * 32,
    )
    orphaned = await broker.orphan_rtc_sessions_for_browser(route, grace_seconds=0.01)
    assert len(orphaned) == 1
    _schedule_browser_orphan_expiry(host_id, orphaned[0])
    await _wait_until(lambda: bool(_daemon_messages_of_type(daemon_ws, "rtc.close")))
    assert _daemon_messages_of_type(daemon_ws, "rtc.close")[-1] == {
        "type": "rtc.close",
        "session_id": "orphan-expiry",
        "binding_nonce": "c" * 32,
        "binding_generation": 1,
        "scope_type": "session",
        "scope_id": pty_id,
        "protocol": "spawn.pty",
        "protocol_version": 2,
    }

    signal_task.cancel()
    await asyncio.gather(signal_task, return_exceptions=True)
    await broker.unregister_daemon(daemon)


async def test_browser_ws_rejects_missing_wrong_kind_and_cross_user_sessions(client):
    user_a, token_a = await _signup(client, "ws-browser-a@example.com")
    _user_b, token_b = await _signup(client, "ws-browser-b@example.com")
    _host_id, pty_id = await _create_host_and_session(user_a)

    missing = FakeBrowserWebSocket()
    await browser_ws(missing, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    assert missing.accepted_subprotocol == "spawn.v3"
    assert missing.closed == (1008, "not authenticated")

    daemon_token = auth.issue_daemon_token("00000000-0000-4000-8000-000000000001", user_a)
    wrong_kind = FakeBrowserWebSocket(authorization=f"Bearer {daemon_token}")
    await browser_ws(wrong_kind, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    assert wrong_kind.closed == (1008, "wrong token kind")

    cross_user = FakeBrowserWebSocket(authorization=f"Bearer {token_b}")
    await browser_ws(cross_user, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    assert cross_user.closed == (1008, "session not found")

    via_query = FakeBrowserWebSocket()
    via_query.queue_disconnect()
    await browser_ws(via_query, pty_session_id=pty_id, token=token_a)  # type: ignore[arg-type]
    assert via_query.closed is None

    old = FakeBrowserWebSocket(authorization=f"Bearer {token_a}", subprotocols=["spawn.v1"])
    await browser_ws(old, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    assert old.accepted_subprotocol is None
    assert _messages_of_type(old, "protocol.required") == [
        {"type": "protocol.required", "protocol": "spawn.v3", "version": 3}
    ]
    assert old.closed == (4003, "protocol upgrade required")


async def test_browser_ws_rejects_revoked_session_epoch(client):
    user_id, token = await _signup(client, "ws-browser-revoked-epoch@example.com")
    _host_id, pty_id = await _create_host_and_session(user_id)
    async with get_sessionmaker()() as session:
        user = await session.get(User, user_id)
        assert user is not None
        user.session_epoch += 1
        await session.commit()

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    await browser_ws(ws, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    assert ws.closed == (1008, "not authenticated")

    fresh = FakeBrowserWebSocket(
        authorization=f"Bearer {auth.issue_access_token(user_id, session_epoch=1)}"
    )
    fresh.queue_disconnect()
    await browser_ws(fresh, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    assert fresh.closed is None


async def test_browser_ws_closes_4010_when_subscription_is_not_ready(client, monkeypatch):
    user_id, token = await _signup(client, "ws-browser-subscription-lost@example.com")
    _host_id, pty_id = await _create_host_and_session(user_id)

    @asynccontextmanager
    async def ended_subscription(_channel):
        async def empty():
            if False:
                yield b""

        yield empty()

    monkeypatch.setattr(get_backend(), "subscribe_channel", ended_subscription)
    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    await browser_ws(ws, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    assert ws.closed == (4010, "subscription lost")


async def test_browser_ws_keepalive_config_refresh_request_and_errors(client, monkeypatch):
    from spawn_server.ws import browser as browser_mod

    user_id, token = await _signup(client, "ws-browser-reliability@example.com")
    _host_id, pty_id = await _create_host_and_session(user_id)
    monkeypatch.setattr(browser_mod, "WS_KEEPALIVE_SECONDS", 0.01)
    monkeypatch.setattr(browser_mod, "rtc_config_refresh_seconds", lambda _settings: 0.01)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(
        browser_ws(ws, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    )
    await _wait_until(
        lambda: (
            bool(_messages_of_type(ws, "ping")) and len(_messages_of_type(ws, "rtc.config")) >= 2
        )
    )
    ws.queue_text({"type": "pong", "ts": 1})
    before = len(_messages_of_type(ws, "rtc.config"))
    ws.queue_text({"type": "rtc.config.request"})
    ws.queue_text({"type": "rtc.config.request"})
    ws.queue_text({"type": "newer.client.frame"})
    await _wait_until(lambda: len(_messages_of_type(ws, "rtc.config")) > before)
    assert len(_messages_of_type(ws, "error")) == 1
    assert _messages_of_type(ws, "error")[0] == {
        "type": "error",
        "code": "unknown_frame",
        "frame_type": "newer.client.frame",
    }
    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)


async def test_browser_upload_frame_fails_closed_without_forwarding_content(client, caplog):
    user_id, token = await _signup(client, "ws-browser-upload-retired@example.com")
    _, pty_id = await _create_host_and_session(user_id)
    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(
        browser_ws(ws, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    )
    await _wait_until(lambda: bool(_messages_of_type(ws, "session.status")))

    secret_name = "browser-secret-name.txt"
    secret_body = "YnJvd3Nlci1zZWNyZXQtY29udGVudA=="
    ws.queue_text(
        {
            "type": "upload",
            "name": secret_name,
            "mime_type": "text/plain",
            "bytes_b64": secret_body,
            "destination": "cwd",
            "client_id": "retired-upload",
        }
    )
    await asyncio.wait_for(task, timeout=1)
    assert ws.closed == (4002, "agent uploads belong on spawn.ctl")
    assert secret_name not in caplog.text
    assert secret_body not in caplog.text


async def test_browser_ws_v3_never_relays_pty_bytes(client):
    """spawn.v3 never exposes a server-side PTY byte path."""

    user_id, token = await _signup(client, "ws-browser-v2@example.com")
    host_id, pty_id = await _create_host_and_session(user_id)
    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    await broker.register_daemon(daemon)
    await broker.attach_session_to_daemon(pty_id, daemon)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}", subprotocols=["spawn.v3"])
    task = asyncio.create_task(browser_ws(ws, pty_session_id=pty_id, token=None))  # type: ignore[arg-type]

    try:
        await _wait_until(lambda: len(_messages_of_type(ws, "session.status")) >= 1)
        assert ws.accepted_subprotocol == "spawn.v3"
        # Control frames still flow: signaling config reaches the browser.
        assert len(_messages_of_type(ws, "rtc.config")) == 1
        # History, snapshots, geometry and display ownership are now carried
        # only by the endpoint-to-endpoint spawn.ctl DataChannel.
        assert _messages_of_type(ws, "history") == []
        assert _messages_of_type(ws, "snapshot") == []
        assert _messages_of_type(ws, "display.control") == []
        daemon_frames = [json.loads(item) for item in daemon_ws.sent_text]
        assert not any(
            frame.get("type") in {"agent.snapshot", "agent.resize", "agent.scroll", "agent.redraw"}
            for frame in daemon_frames
        )

        # There is no terminal-content pubsub channel or binary send path.
        backend = get_backend()
        assert backend.inproc is not None
        assert f"spawn:session:{pty_id}" not in backend.inproc._subs
        assert ws.sent_bytes == []
    finally:
        ws.queue_disconnect()
        await asyncio.wait_for(task, timeout=1)
        await broker.unregister_daemon(daemon)


async def test_browser_ws_v3_reused_session_rejects_stale_binding_frames(client, monkeypatch):
    monkeypatch.setenv("SPAWN_WEBRTC_ENABLED", "1")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    user_id, token = await _signup(client, "ws-browser-v2-binding@example.com")
    host_id, pty_id = await _create_host_and_session(user_id)

    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task: asyncio.Task[None] | None = None

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}", subprotocols=["spawn.v3"])
    task = asyncio.create_task(
        browser_ws(ws, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    )
    session_id = "reused-v2-session"
    nonce_a = "a" * 32
    nonce_b = "b" * 32

    try:
        await _wait_until(lambda: bool(_messages_of_type(ws, "rtc.config")))
        assert _messages_of_type(ws, "rtc.config")[-1]["binding_nonce_required"] is True

        await broker.register_daemon(daemon)
        await _accept_daemon(daemon)
        await broker.attach_session_to_daemon(pty_id, daemon)
        signal_ready = asyncio.Event()
        signal_task = asyncio.create_task(
            _pump_host_rtc_signals(daemon, signal_ready, expiry_tasks)
        )
        await wait_for_signal_pump(signal_task, signal_ready)

        # v2 offers without a browser-generated binding identity fail closed.
        ws.queue_text(
            _session_rtc_frame(pty_id, type="rtc.offer", session_id=session_id, sdp="v=0\r\n")
        )
        await asyncio.sleep(0.02)
        assert not _daemon_messages_of_type(daemon_ws, "rtc.offer")

        valid_tuple = _session_rtc_frame(
            pty_id,
            type="rtc.offer",
            session_id=session_id,
            binding_nonce=nonce_a,
            sdp="v=0\r\ntuple-check",
        )
        invalid_tuples = []
        for field in (
            "scope_type",
            "scope_id",
            "protocol",
            "protocol_version",
        ):
            missing = dict(valid_tuple)
            missing.pop(field)
            invalid_tuples.append(missing)
        for field, value in (
            ("scope_type", "host"),
            ("scope_id", str(uuid.uuid4())),
            ("protocol", "spawn.ctl"),
            ("protocol_version", 1),
        ):
            mismatched = dict(valid_tuple)
            mismatched[field] = value
            invalid_tuples.append(mismatched)
        for invalid in invalid_tuples:
            ws.queue_text(invalid)
        await asyncio.sleep(0.02)
        assert not _daemon_messages_of_type(daemon_ws, "rtc.offer")
        assert await broker.rtc_session_for(session_id) is None

        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.offer",
                session_id=session_id,
                binding_nonce=nonce_a,
                sdp="v=0\r\nA",
            )
        )
        await _wait_until(lambda: len(_daemon_messages_of_type(daemon_ws, "rtc.offer")) == 1)
        first_offer = _daemon_messages_of_type(daemon_ws, "rtc.offer")[-1]
        assert first_offer["binding_nonce"] == nonce_a
        assert first_offer["binding_generation"] == daemon.host_generation
        assert first_offer["scope_type"] == "session"
        assert first_offer["scope_id"] == pty_id
        assert first_offer["protocol"] == "spawn.pty"
        assert first_offer["protocol_version"] == 2

        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.close",
                session_id=session_id,
                binding_nonce=nonce_a,
            )
        )
        await _wait_until(lambda: bool(_daemon_messages_of_type(daemon_ws, "rtc.close")))

        negotiating_before = len(
            [
                message
                for message in _messages_of_type(ws, "rtc.status")
                if message.get("status") == "negotiating"
            ]
        )
        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.offer",
                session_id=session_id,
                binding_nonce=nonce_a,
                sdp="v=0\r\nretired-A",
            )
        )
        await _wait_until(
            lambda: any(
                message.get("status") == "failed" and message.get("binding_nonce") == nonce_a
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
            _session_rtc_frame(
                pty_id,
                type="rtc.offer",
                session_id=session_id,
                binding_nonce=nonce_b,
                sdp="v=0\r\nB",
            )
        )
        await _wait_until(lambda: len(_daemon_messages_of_type(daemon_ws, "rtc.offer")) == 2)

        before_candidate_count = len(_daemon_messages_of_type(daemon_ws, "rtc.candidate"))
        before_close_count = len(_daemon_messages_of_type(daemon_ws, "rtc.close"))
        candidate = {"candidate": "candidate:1 1 udp 1 127.0.0.1 9 typ host"}
        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.candidate",
                session_id=session_id,
                binding_nonce=nonce_a,
                candidate=candidate,
            )
        )
        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.close",
                session_id=session_id,
                binding_nonce=nonce_a,
            )
        )
        await asyncio.sleep(0.02)
        assert len(_daemon_messages_of_type(daemon_ws, "rtc.candidate")) == before_candidate_count
        assert len(_daemon_messages_of_type(daemon_ws, "rtc.close")) == before_close_count
        current = await broker.rtc_session_for(session_id)
        assert current is not None
        assert current.nonce == nonce_b

        missing_candidate_tuple = _session_rtc_frame(
            pty_id,
            type="rtc.candidate",
            session_id=session_id,
            binding_nonce=nonce_b,
            candidate=candidate,
        )
        missing_candidate_tuple.pop("protocol")
        ws.queue_text(missing_candidate_tuple)
        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.candidate",
                session_id=session_id,
                binding_nonce=nonce_b,
                candidate=candidate,
                scope_id=str(uuid.uuid4()),
            )
        )
        missing_close_tuple = _session_rtc_frame(
            pty_id,
            type="rtc.close",
            session_id=session_id,
            binding_nonce=nonce_b,
        )
        missing_close_tuple.pop("scope_type")
        ws.queue_text(missing_close_tuple)
        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.close",
                session_id=session_id,
                binding_nonce=nonce_b,
                protocol_version=1,
            )
        )
        await asyncio.sleep(0.02)
        assert len(_daemon_messages_of_type(daemon_ws, "rtc.candidate")) == before_candidate_count
        assert len(_daemon_messages_of_type(daemon_ws, "rtc.close")) == before_close_count
        current = await broker.rtc_session_for(session_id)
        assert current is not None
        assert current.nonce == nonce_b

        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.candidate",
                session_id=session_id,
                binding_nonce=nonce_b,
                candidate=candidate,
            )
        )
        await _wait_until(
            lambda: (
                len(_daemon_messages_of_type(daemon_ws, "rtc.candidate"))
                == before_candidate_count + 1
            )
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


async def test_session_ice_restart_reuses_live_binding_and_unknown_is_unavailable(
    client, monkeypatch
):
    monkeypatch.setenv("SPAWN_WEBRTC_ENABLED", "1")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    user_id, token = await _signup(client, "ws-browser-ice-restart@example.com")
    host_id, pty_id = await _create_host_and_session(user_id)
    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)
    await broker.attach_session_to_daemon(pty_id, daemon)
    ready = asyncio.Event()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task = asyncio.create_task(_pump_host_rtc_signals(daemon, ready, expiry_tasks))
    await wait_for_signal_pump(signal_task, ready)
    presence = await get_backend().get_ephemeral(host_presence_key(host_id))
    assert presence is not None
    assert await get_backend().delete_ephemeral_if(host_presence_key(host_id), presence)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(
        browser_ws(ws, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    )
    nonce = "d" * 32
    session_id = "restart-live"
    ws.queue_text(
        _session_rtc_frame(
            pty_id,
            type="rtc.offer",
            session_id=session_id,
            binding_nonce=nonce,
            sdp="v=0\r\ninitial",
        )
    )
    await _wait_until(lambda: len(_daemon_messages_of_type(daemon_ws, "rtc.offer")) == 1)
    assert await get_backend().get_ephemeral(host_presence_key(host_id)) is not None
    original = await broker.rtc_session_for(session_id)
    assert original is not None
    ws.queue_text(
        _session_rtc_frame(
            pty_id,
            type="rtc.offer",
            session_id=session_id,
            binding_nonce=nonce,
            binding_generation=original.daemon_generation,
            ice_restart=True,
            sdp="v=0\r\nrestart",
        )
    )
    await _wait_until(lambda: len(_daemon_messages_of_type(daemon_ws, "rtc.offer")) == 2)
    restart = _daemon_messages_of_type(daemon_ws, "rtc.offer")[-1]
    assert restart["ice_restart"] is True
    assert restart["binding_nonce"] == nonce
    assert restart["binding_generation"] == original.daemon_generation
    assert await broker.rtc_session_for(session_id) is original

    ws.queue_text(
        _session_rtc_frame(
            pty_id,
            type="rtc.offer",
            session_id="restart-unknown",
            binding_nonce="e" * 32,
            binding_generation=original.daemon_generation,
            ice_restart=True,
            sdp="v=0\r\nrestart",
        )
    )
    await _wait_until(
        lambda: any(
            frame.get("session_id") == "restart-unknown" and frame.get("status") == "unavailable"
            for frame in _messages_of_type(ws, "rtc.status")
        )
    )
    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)
    signal_task.cancel()
    await asyncio.gather(signal_task, return_exceptions=True)
    for expiry_task in expiry_tasks:
        expiry_task.cancel()
    await asyncio.gather(*expiry_tasks, return_exceptions=True)
    await broker.unregister_daemon(daemon)


async def test_browser_rtc_resume_reassociates_orphan_and_unknown_is_unavailable(
    client, monkeypatch
):
    monkeypatch.setenv("SPAWN_WEBRTC_ENABLED", "1")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    user_id, token = await _signup(client, "ws-browser-resume@example.com")
    host_id, pty_id = await _create_host_and_session(user_id)
    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    daemon.keeps_peers_across_reconnect = True
    broker = get_broker()
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)
    await broker.attach_session_to_daemon(pty_id, daemon)
    ready = asyncio.Event()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task = asyncio.create_task(_pump_host_rtc_signals(daemon, ready, expiry_tasks))
    await wait_for_signal_pump(signal_task, ready)

    first = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    first_task = asyncio.create_task(
        browser_ws(first, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    )
    nonce = "f" * 32
    first.queue_text(
        _session_rtc_frame(
            pty_id,
            type="rtc.offer",
            session_id="resume-live",
            binding_nonce=nonce,
            sdp="v=0\r\n",
        )
    )
    await _wait_until(lambda: bool(_daemon_messages_of_type(daemon_ws, "rtc.offer")))
    binding = await broker.rtc_session_for("resume-live")
    assert binding is not None
    first.queue_disconnect()
    await asyncio.wait_for(first_task, timeout=1)
    orphan = await broker.rtc_session_for("resume-live")
    assert orphan is not None and orphan.browser_orphaned_until is not None

    second = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    second_task = asyncio.create_task(
        browser_ws(second, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    )
    await _wait_until(lambda: bool(_messages_of_type(second, "rtc.config")))
    second.queue_text(
        _session_rtc_frame(
            pty_id,
            type="rtc.resume",
            session_id="resume-unknown",
            binding_nonce="0" * 32,
            binding_generation=binding.daemon_generation,
        )
    )
    second.queue_text(
        _session_rtc_frame(
            pty_id,
            type="rtc.resume",
            session_id="resume-live",
            binding_nonce=nonce,
            binding_generation=binding.daemon_generation,
        )
    )
    await _wait_until(
        lambda: any(
            frame.get("session_id") == "resume-live" and frame.get("status") == "resumed"
            for frame in _messages_of_type(second, "rtc.status")
        )
    )
    assert any(
        frame.get("session_id") == "resume-unknown" and frame.get("status") == "unavailable"
        for frame in _messages_of_type(second, "rtc.status")
    )
    resumed = await broker.rtc_session_for("resume-live")
    assert resumed is not None and resumed.browser_orphaned_until is None
    second.queue_disconnect()
    await asyncio.wait_for(second_task, timeout=1)
    signal_task.cancel()
    await asyncio.gather(signal_task, return_exceptions=True)
    for expiry_task in expiry_tasks:
        expiry_task.cancel()
    await asyncio.gather(*expiry_tasks, return_exceptions=True)
    await broker.unregister_daemon(daemon)


async def test_session_binding_user_cap_returns_failed_status(client, monkeypatch):
    monkeypatch.setenv("SPAWN_WEBRTC_ENABLED", "1")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    user_id, token = await _signup(client, "ws-browser-binding-cap@example.com")
    host_id, pty_id = await _create_host_and_session(user_id)
    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)
    await broker.attach_session_to_daemon(pty_id, daemon)

    for index in range(64):
        route = BrowserConn(user_id, f"seed-pty-{index}", FakeBrowserWebSocket())  # type: ignore[arg-type]
        assert await broker.register_rtc_session(
            f"seed-binding-{index}",
            route,
            daemon=daemon,
            scope_type="session",
            scope_id=route.session_id,
            protocol="spawn.pty",
            protocol_version=2,
            binding_nonce=f"{index:032x}",
        )

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(
        browser_ws(ws, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    )
    ws.queue_text(
        _session_rtc_frame(
            pty_id,
            type="rtc.offer",
            session_id="over-user-cap",
            binding_nonce="f" * 32,
            sdp="v=0\r\n",
        )
    )
    await _wait_until(
        lambda: any(
            frame.get("session_id") == "over-user-cap"
            and frame.get("status") == "failed"
            and frame.get("message") == "RTC session limit reached."
            for frame in _messages_of_type(ws, "rtc.status")
        )
    )
    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)
    await broker.unregister_daemon(daemon)


async def test_session_signed_offer_and_answer_are_opaque_symmetric_and_no_downgrade(
    client, monkeypatch
):
    monkeypatch.setenv("SPAWN_WEBRTC_ENABLED", "1")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    user_id, token = await _signup(client, "ws-browser-signed-relay@example.com")
    host_id, pty_id = await _create_host_and_session(user_id)
    session_id = str(uuid.uuid4())
    nonce = "c" * 32
    offer_wire = _signed_session_wire("rtc.offer", session_id, pty_id)
    answer_wire = _signed_session_wire("rtc.answer", session_id, pty_id)

    daemon_ws = FakeDaemonWebSocket()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    broker = get_broker()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task: asyncio.Task[None] | None = None
    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(browser_ws(ws, pty_session_id=pty_id))  # type: ignore[arg-type]
    try:
        await _wait_until(lambda: bool(_messages_of_type(ws, "rtc.config")))
        await broker.register_daemon(daemon)
        await _accept_daemon(daemon)
        await broker.attach_session_to_daemon(pty_id, daemon)
        ready = asyncio.Event()
        signal_task = asyncio.create_task(_pump_host_rtc_signals(daemon, ready, expiry_tasks))
        await wait_for_signal_pump(signal_task, ready)

        offers_before = len(_daemon_messages_of_type(daemon_ws, "rtc.offer"))
        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.offer",
                session_id=session_id,
                binding_nonce=nonce,
                signed_envelope=None,
            )
        )
        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.offer",
                session_id=session_id,
                binding_nonce=nonce,
                signed_envelope=None,
                sdp="v=0\r\nraw downgrade",
            )
        )
        await asyncio.sleep(0.02)
        assert len(_daemon_messages_of_type(daemon_ws, "rtc.offer")) == offers_before
        assert await broker.rtc_session_for(session_id) is None

        ws.queue_text(
            _session_rtc_frame(
                pty_id,
                type="rtc.offer",
                session_id=session_id,
                binding_nonce=nonce,
                signed_envelope=offer_wire,
            )
        )
        await _wait_until(lambda: bool(_daemon_messages_of_type(daemon_ws, "rtc.offer")))
        forwarded = _daemon_messages_of_type(daemon_ws, "rtc.offer")[-1]
        assert forwarded["signed_envelope"] == offer_wire
        assert "sdp" not in forwarded
        assert (
            json.loads(forwarded["signed_envelope"])["signature"]
            == json.loads(offer_wire)["signature"]
        )
        binding = await broker.rtc_session_for(session_id, daemon=daemon)
        assert binding is not None and binding.signed_signal

        response = {
            "type": "rtc.answer",
            "session_id": session_id,
            "binding_nonce": binding.nonce,
            "binding_generation": binding.daemon_generation,
            "scope_type": "session",
            "scope_id": pty_id,
            "protocol": "spawn.pty",
            "protocol_version": 2,
        }
        before = len(_messages_of_type(ws, "rtc.answer"))
        await binding.browser.send_text(response)
        await binding.browser.send_text({**response, "sdp": "v=0\r\nraw downgrade"})
        await asyncio.sleep(0.02)
        assert len(_messages_of_type(ws, "rtc.answer")) == before

        await binding.browser.send_text({**response, "signed_envelope": answer_wire})
        await _wait_until(lambda: len(_messages_of_type(ws, "rtc.answer")) == before + 1)
        delivered = _messages_of_type(ws, "rtc.answer")[-1]
        assert delivered["signed_envelope"] == answer_wire
        assert "sdp" not in delivered
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


async def test_browser_ws_v3_rejects_binary_input_as_protocol_error(client):
    user_id, token = await _signup(client, "ws-browser-v2-input@example.com")
    _host_id, pty_id = await _create_host_and_session(user_id)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}", subprotocols=["spawn.v3"])
    task = asyncio.create_task(browser_ws(ws, pty_session_id=pty_id, token=None))  # type: ignore[arg-type]

    await _wait_until(lambda: len(_messages_of_type(ws, "session.status")) >= 1)
    ws.queue_bytes(b"stdin over the relay")
    await asyncio.wait_for(task, timeout=1)

    assert ws.closed is not None
    assert ws.closed[0] == 4002


async def test_browser_ws_v3_rejects_server_visible_viewport_control(client):
    user_id, token = await _signup(client, "ws-browser-v2-control@example.com")
    _host_id, pty_id = await _create_host_and_session(user_id)

    ws = FakeBrowserWebSocket(authorization=f"Bearer {token}", subprotocols=["spawn.v3"])
    task = asyncio.create_task(
        browser_ws(ws, pty_session_id=pty_id, token=None)  # type: ignore[arg-type]
    )

    await _wait_until(lambda: len(_messages_of_type(ws, "session.status")) >= 1)
    ws.queue_text({"type": "resize", "cols": 132, "rows": 40})
    await asyncio.wait_for(task, timeout=1)

    assert ws.closed == (4002, "terminal control belongs on spawn.ctl")


def test_session_rtc_config_carries_the_transport_policy(monkeypatch):
    """The terminal is told how to reach the host, not just where.

    Before this, `ice_transport_policy` existed only on the host-control
    channel, so an operator who configured a relay-only deployment had the
    terminal quietly keep trying direct paths that do not exist.
    """
    from spawn_server.config import get_settings
    from spawn_server.ws.browser import _rtc_config_payload

    get_settings.cache_clear()  # type: ignore[attr-defined]
    assert _rtc_config_payload("user-1")["ice_transport_policy"] == "all"

    monkeypatch.setenv("SPAWN_WEBRTC_ICE_SERVERS", "[]")
    monkeypatch.setenv("SPAWN_TURN_URLS", "turn:relay.example:3478?transport=udp")
    monkeypatch.setenv("SPAWN_TURN_SECRET", "s3cret")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    payload = _rtc_config_payload("user-1")
    assert payload["ice_transport_policy"] == "relay"
    assert payload["ice_servers"][-1]["username"].endswith(":user-1")
    get_settings.cache_clear()  # type: ignore[attr-defined]


def test_old_daemon_session_offers_never_carry_ice_transport_policy():
    """A guard, not a preference.

    `daemon/src/run.rs` dispatches a session offer only when
    `ice_transport_policy` is absent — the field's presence is how it
    recognises a *host* offer. Putting it on a session offer would make every
    daemon already in the field drop every terminal offer on the floor, which
    no server-side version check can save. The client is told the policy on
    its own `rtc.config` instead.
    """
    from spawn_server.ws.browser import _offer_ice

    daemon = DaemonConn("host", "user", FakeDaemonWebSocket())  # type: ignore[arg-type]
    daemon.session_ice_policy = False
    offer_ice = _offer_ice("user-1", daemon)
    assert set(offer_ice) == {"ice_servers"}
    assert "ice_transport_policy" not in offer_ice


def test_session_ice_policy_capability_adds_policy_to_session_offer():
    from spawn_server.ws.browser import _offer_ice

    daemon = DaemonConn("host", "user", FakeDaemonWebSocket())  # type: ignore[arg-type]
    daemon.session_ice_policy = True
    assert set(_offer_ice("user-1", daemon)) == {
        "ice_servers",
        "ice_transport_policy",
    }
