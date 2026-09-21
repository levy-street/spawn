"""Host-scoped signaling authorization, binding, isolation and cleanup."""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import pytest

from spawn_server import auth
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import Host, User
from spawn_server.ws.broker import HostBrowserConn, get_broker
from spawn_server.ws.daemon import daemon_ws
from spawn_server.ws.host import (
    HOST_CONTROL_PROTOCOL,
    HOST_CONTROL_VERSION,
    MAX_SIGNAL_FRAME_BYTES,
    BrowserRtcSession,
    _binding_identity,
    _cleanup_retired_bindings,
    _forward_if_exact_binding,
    _prune_sessions,
    _retire_binding,
    _rtc_binding_capacity_available,
    host_ws,
)


def _signed_host_wire(signal_type: str, session_id: str, host_id: str, version: int = 1) -> str:
    vectors = json.loads(
        (Path(__file__).parents[2] / "proto" / "signed-signal-wire-v1-vectors.json").read_text()
    )["vectors"]
    envelope = dict(vectors[1]["envelope"])
    envelope.update(
        {
            "type": signal_type,
            "protocol_version": version,
            "session_id": session_id,
            "scope_id": host_id,
            "sender_role": "browser" if signal_type == "rtc.offer" else "daemon",
        }
    )
    signature = str(envelope["signature"])
    envelope["signature"] = ("A" if signature[0] != "A" else "B") + signature[1:]
    return " \n" + json.dumps(envelope, separators=(",", ":")) + "\t"


class FakeWebSocket:
    def __init__(
        self,
        *,
        authorization: str | None = None,
        subprotocols: list[str] | None = None,
    ) -> None:
        self.headers = {"authorization": authorization} if authorization else {}
        self.cookies: dict[str, str] = {}
        self.scope: dict[str, Any] = {"subprotocols": subprotocols or ["spawn.host.v1"]}
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

    def queue_raw_text(self, payload: str) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "text": payload})

    def queue_disconnect(self) -> None:
        self._incoming.put_nowait({"type": "websocket.disconnect"})


async def test_connected_dispatch_cas_cannot_extend_reused_session_identity():
    socket = FakeWebSocket()
    conn = HostBrowserConn("owner", "host-1", socket)  # type: ignore[arg-type]
    lock = asyncio.Lock()
    retired: dict[tuple[str, str, int, str], float] = {}
    first = BrowserRtcSession("reused", "a" * 32, 1, "1" * 32, 1000)
    sessions = {"reused": first}

    # Model the exact await boundary in the signal pump: A was captured, then
    # close/reconnect installed B before A reacquired the sessions lock.
    async with lock:
        sessions.pop("reused")
        _retire_binding(retired, first, 10)
        second = BrowserRtcSession("reused", "a" * 32, 1, "2" * 32, float("inf"))
        sessions["reused"] = second

    assert not await _forward_if_exact_binding(
        conn,
        {
            "type": "rtc.status",
            "session_id": "reused",
            "binding_nonce": first.nonce,
            "status": "connected",
        },
        first,
        sessions,
        retired,
        lock,
        connected=True,
    )
    assert sessions["reused"] is second
    assert sessions["reused"].expires_at == float("inf")
    assert socket.sent_text == []

    _prune_sessions(sessions, retired, 10 + 5 * 60 + 1)
    assert _binding_identity(first) not in retired


async def test_local_rtc_tombstones_are_bounded_expire_idle_and_cleanup_cancels(
    monkeypatch,
):
    from spawn_server.ws import host as host_mod

    monkeypatch.setattr(host_mod, "MAX_HOST_RTC_BINDING_IDENTITIES", 2)
    monkeypatch.setattr(host_mod, "RTC_BINDING_TOMBSTONE_TTL_SECONDS", 0.02)
    sessions: dict[str, BrowserRtcSession] = {}
    retired: dict[tuple[str, str, int, str], float] = {}
    lock = asyncio.Lock()
    changed = asyncio.Event()
    cleanup = asyncio.create_task(_cleanup_retired_bindings(sessions, retired, lock, changed))
    first = BrowserRtcSession("one", "a" * 32, 1, "1" * 32, float("inf"))
    second = BrowserRtcSession("two", "a" * 32, 1, "2" * 32, float("inf"))
    assert _retire_binding(retired, first, asyncio.get_running_loop().time(), changed)
    assert _retire_binding(retired, second, asyncio.get_running_loop().time(), changed)
    assert not _rtc_binding_capacity_available(sessions, retired)
    assert not _retire_binding(
        retired,
        BrowserRtcSession("three", "a" * 32, 1, "3" * 32, float("inf")),
        asyncio.get_running_loop().time(),
        changed,
    )

    await _wait_until(lambda: not retired, timeout=0.2)
    assert _rtc_binding_capacity_available(sessions, retired)
    cleanup.cancel()
    await asyncio.gather(cleanup, return_exceptions=True)
    assert cleanup.cancelled()


async def _signup(client, email: str) -> tuple[str, str]:
    response = await client.post(
        "/api/auth/signup", json={"email": email, "password": "passpasspass"}
    )
    assert response.status_code == 200
    return response.json()["user"]["id"], response.json()["access_token"]


async def _create_host(user_id: str, name: str) -> str:
    sm = get_sessionmaker()
    async with sm() as session:
        host = Host(owner_user_id=user_id, name=name, status="online")
        session.add(host)
        await session.commit()
        return host.id


async def _wait_until(predicate: Callable[[], bool], timeout: float = 1.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting for condition")


def _json_messages(ws: FakeWebSocket) -> list[dict[str, Any]]:
    return [json.loads(item) for item in ws.sent_text]


def _metadata(host_id: str, version: int = HOST_CONTROL_VERSION) -> dict[str, object]:
    return {
        "scope_type": "host",
        "scope_id": host_id,
        "protocol": HOST_CONTROL_PROTOCOL,
        "protocol_version": version,
    }


async def _start_daemon(
    user_id: str, host_id: str, *, shared: bool = True
) -> tuple[FakeWebSocket, asyncio.Task[None]]:
    socket = FakeWebSocket(
        authorization=f"Bearer {auth.issue_daemon_token(host_id, user_id)}",
        subprotocols=["spawn.control.v3"],
    )
    task = asyncio.create_task(daemon_ws(socket))  # type: ignore[arg-type]
    socket.queue_text(
        {
            "type": "register",
            "host_name": "test-daemon",
            "os": "linux",
            "arch": "x86_64",
            "version": "test",
            "supports_device_connections": shared,
        }
    )
    await _wait_until(
        lambda: any(message.get("type") == "registered" for message in _json_messages(socket))
    )
    return socket, task


async def _stop_daemon(socket: FakeWebSocket, task: asyncio.Task[None]) -> None:
    socket.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)


async def test_host_ws_protocol_epoch_keepalive_and_config_refresh(client, monkeypatch):
    from spawn_server.ws import host as host_mod

    user_id, token = await _signup(client, "host-ws-reliability@example.com")
    host_id = await _create_host(user_id, "reliable-host")

    old = FakeWebSocket(authorization=f"Bearer {token}", subprotocols=["spawn.host.v0"])
    await host_ws(old, host_id=host_id)  # type: ignore[arg-type]
    assert old.closed == (4003, "protocol upgrade required")
    assert _json_messages(old) == [
        {"type": "protocol.required", "protocol": "spawn.host.v1", "version": 1}
    ]

    async with get_sessionmaker()() as session:
        user = await session.get(User, user_id)
        assert user is not None
        user.session_epoch += 1
        await session.commit()
    revoked = FakeWebSocket(authorization=f"Bearer {token}")
    await host_ws(revoked, host_id=host_id)  # type: ignore[arg-type]
    assert revoked.closed == (1008, "not authenticated")

    fresh = auth.issue_access_token(user_id, session_epoch=1)
    monkeypatch.setattr(host_mod, "WS_KEEPALIVE_SECONDS", 0.01)
    monkeypatch.setattr(host_mod, "rtc_config_refresh_seconds", lambda _settings: 0.01)
    ws = FakeWebSocket(authorization=f"Bearer {fresh}")
    task = asyncio.create_task(host_ws(ws, host_id=host_id))  # type: ignore[arg-type]
    await _wait_until(
        lambda: (
            any(frame.get("type") == "ping" for frame in _json_messages(ws))
            and sum(frame.get("type") == "rtc.config" for frame in _json_messages(ws)) >= 2
        )
    )
    before = sum(frame.get("type") == "rtc.config" for frame in _json_messages(ws))
    ws.queue_text({"type": "pong", "ts": 1})
    ws.queue_text({"type": "rtc.config.request"})
    ws.queue_text({"type": "rtc.config.request"})
    ws.queue_text({"type": "future.host.frame", **_metadata(host_id), "session_id": "s"})
    await _wait_until(
        lambda: (
            sum(frame.get("type") == "rtc.config" for frame in _json_messages(ws)) > before
            and any(frame.get("type") == "error" for frame in _json_messages(ws))
        )
    )
    errors = [frame for frame in _json_messages(ws) if frame.get("type") == "error"]
    assert errors[-1] == {
        "type": "error",
        "code": "unknown_frame",
        "frame_type": "future.host.frame",
    }
    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)


async def test_host_ws_closes_4010_when_subscription_is_not_ready(client, monkeypatch):
    user_id, token = await _signup(client, "host-ws-subscription-lost@example.com")
    host_id = await _create_host(user_id, "subscription-host")

    @asynccontextmanager
    async def ended_subscription(_channel):
        async def empty():
            if False:
                yield b""

        yield empty()

    from spawn_server.redis import get_backend

    monkeypatch.setattr(get_backend(), "subscribe_channel", ended_subscription)
    ws = FakeWebSocket(authorization=f"Bearer {token}")
    await host_ws(ws, host_id=host_id)  # type: ignore[arg-type]
    assert ws.closed == (4010, "subscription lost")


async def test_host_ws_lets_a_browser_gone_before_the_greeting_go_quietly(client, caplog):
    """The page tore its socket down while the server was still setting up.

    The greeting is the first write; on uvloop a transport the peer already
    closed refuses it with a RuntimeError rather than a disconnect event. That
    is not a crash, and it must not be logged as one.
    """
    user_id, token = await _signup(client, "host-ws-gone-early@example.com")
    host_id = await _create_host(user_id, "gone-early")

    class GoneWebSocket(FakeWebSocket):
        async def send_text(self, value: str) -> None:
            raise RuntimeError(
                "unable to perform operation on <TCPTransport closed=True reading=False 0x1>; "
                "the handler is closed"
            )

    ws = GoneWebSocket(authorization=f"Bearer {token}")
    with caplog.at_level("ERROR"):
        await asyncio.wait_for(host_ws(ws, host_id=host_id), timeout=5)  # type: ignore[arg-type]
    assert ws.accepted_subprotocol == "spawn.host.v1"
    assert ws.sent_text == []
    assert "crashed" not in caplog.text


async def test_zero_agent_host_signaling_is_bound_and_cleaned_up(client):
    user_id, token = await _signup(client, "host-rtc-zero@example.com")
    host_id = await _create_host(user_id, "zero-agents")
    daemon_socket, daemon_task = await _start_daemon(user_id, host_id)
    broker = get_broker()

    browser_ws = FakeWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(host_ws(browser_ws, host_id=host_id))  # type: ignore[arg-type]
    await _wait_until(lambda: bool(browser_ws.sent_text))
    config = _json_messages(browser_ws)[0]
    assert config["type"] == "rtc.config"
    assert {key: config[key] for key in _metadata(host_id)} == _metadata(host_id)

    for primitive in ("null", "7", '"primitive"'):
        browser_ws.queue_raw_text(primitive)
    browser_ws.queue_text(
        {
            "type": "rtc.offer",
            "session_id": "zero-agent-session",
            "sdp": "v=0\r\n",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: any(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket))
    )
    offer = _json_messages(daemon_socket)[-1]
    assert offer["type"] == "rtc.offer"
    assert offer["session_id"] == "zero-agent-session"
    assert "agent_id" not in offer
    assert {key: offer[key] for key in _metadata(host_id)} == _metadata(host_id)
    assert len(offer["binding_nonce"]) == 32

    # Host-control payload-shaped JSON is not a signaling frame and is never
    # forwarded to the daemon websocket.
    count = len(daemon_socket.sent_text)
    browser_ws.queue_text(
        {
            "type": "request",
            "request_id": "secret-request",
            "payload": "server must not receive control payloads",
            **_metadata(host_id),
        }
    )
    await asyncio.sleep(0.02)
    assert len(daemon_socket.sent_text) == count

    browser_ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)
    await _wait_until(lambda: _json_messages(daemon_socket)[-1].get("type") == "rtc.close")
    assert _json_messages(daemon_socket)[-1] == {
        "type": "rtc.close",
        "session_id": "zero-agent-session",
        "binding_nonce": offer["binding_nonce"],
        **_metadata(host_id),
    }
    assert await broker.rtc_session_for("zero-agent-session") is None
    await _stop_daemon(daemon_socket, daemon_task)


async def test_device_connection_reports_an_old_daemon_without_forwarding_the_offer(client):
    user_id, token = await _signup(client, "shared-rtc-old-daemon@example.com")
    host_id = await _create_host(user_id, "old-daemon")
    daemon_socket, daemon_task = await _start_daemon(user_id, host_id, shared=False)
    browser = FakeWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(host_ws(browser, host_id=host_id, rtc_version=2))
    try:
        await _wait_until(lambda: bool(browser.sent_text))
        session_id = str(uuid.uuid4())
        browser.queue_text(
            {
                "type": "rtc.offer",
                "session_id": session_id,
                "signed_envelope": _signed_host_wire("rtc.offer", session_id, host_id, 2),
                **_metadata(host_id, 2),
            }
        )
        await _wait_until(
            lambda: any(
                frame.get("code") == "daemon_update_required" for frame in _json_messages(browser)
            )
        )
        assert not any(frame.get("type") == "rtc.offer" for frame in _json_messages(daemon_socket))
    finally:
        browser.queue_disconnect()
        await asyncio.wait_for(task, timeout=1)
        await _stop_daemon(daemon_socket, daemon_task)


async def test_pending_host_rtc_binding_expires_with_status(client, monkeypatch):
    from spawn_server.ws import daemon as daemon_mod

    monkeypatch.setattr(daemon_mod, "HOST_RTC_SESSION_TTL_SECONDS", 0.02)
    user_id, token = await _signup(client, "host-rtc-expired@example.com")
    host_id = await _create_host(user_id, "expiry-host")
    daemon_socket, daemon_task = await _start_daemon(user_id, host_id)
    browser_socket = FakeWebSocket(authorization=f"Bearer {token}")
    browser_task = asyncio.create_task(host_ws(browser_socket, host_id=host_id))  # type: ignore[arg-type]
    await _wait_until(lambda: bool(browser_socket.sent_text))
    browser_socket.queue_text(
        {
            "type": "rtc.offer",
            "session_id": "expires",
            "sdp": "v=0\r\n",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: any(
            frame.get("type") == "rtc.status"
            and frame.get("session_id") == "expires"
            and frame.get("status") == "expired"
            for frame in _json_messages(browser_socket)
        )
    )
    browser_socket.queue_disconnect()
    await asyncio.gather(
        browser_task,
        _stop_daemon(daemon_socket, daemon_task),
    )


async def test_host_signaling_rejects_non_owner_and_cross_host_session(client):
    owner_id, owner_token = await _signup(client, "host-rtc-owner@example.com")
    _other_id, other_token = await _signup(client, "host-rtc-other@example.com")
    first_host = await _create_host(owner_id, "first")
    second_host = await _create_host(owner_id, "second")

    rejected = FakeWebSocket(authorization=f"Bearer {other_token}")
    await host_ws(rejected, host_id=first_host)  # type: ignore[arg-type]
    assert rejected.closed == (1008, "host not found")

    first_daemon_ws, first_daemon_task = await _start_daemon(owner_id, first_host)
    second_daemon_ws, second_daemon_task = await _start_daemon(owner_id, second_host)
    first_ws = FakeWebSocket(authorization=f"Bearer {owner_token}")
    second_ws = FakeWebSocket(authorization=f"Bearer {owner_token}")
    first_task = asyncio.create_task(host_ws(first_ws, host_id=first_host))  # type: ignore[arg-type]
    second_task = asyncio.create_task(host_ws(second_ws, host_id=second_host))  # type: ignore[arg-type]
    await _wait_until(lambda: bool(first_ws.sent_text) and bool(second_ws.sent_text))

    first_ws.queue_text(
        {"type": "rtc.offer", "session_id": "isolated", "sdp": "v=0\r\n", **_metadata(first_host)}
    )
    await _wait_until(
        lambda: any(
            message.get("type") == "rtc.offer" for message in _json_messages(first_daemon_ws)
        )
    )
    second_rtc_count = sum(
        message.get("type") == "rtc.offer" for message in _json_messages(second_daemon_ws)
    )
    second_ws.queue_text(
        {
            "type": "rtc.offer",
            "session_id": "isolated",
            "sdp": "v=0\r\n",
            **_metadata(second_host),
        }
    )
    await _wait_until(
        lambda: any(
            message.get("type") == "rtc.status" and message.get("status") == "failed"
            for message in _json_messages(second_ws)
        )
    )
    assert (
        sum(message.get("type") == "rtc.offer" for message in _json_messages(second_daemon_ws))
        == second_rtc_count
    )

    second_ws.queue_text(
        {
            "type": "rtc.candidate",
            "session_id": "isolated",
            "candidate": {"candidate": "candidate:secret"},
            **_metadata(second_host),
        }
    )
    await asyncio.sleep(0.02)
    assert (
        sum(
            message.get("type") in {"rtc.offer", "rtc.candidate"}
            for message in _json_messages(second_daemon_ws)
        )
        == second_rtc_count
    )

    first_ws.queue_disconnect()
    second_ws.queue_disconnect()
    await asyncio.gather(first_task, second_task)
    await asyncio.gather(
        _stop_daemon(first_daemon_ws, first_daemon_task),
        _stop_daemon(second_daemon_ws, second_daemon_task),
    )


async def test_host_signaling_turn_only_and_oversize_limit(client, monkeypatch):
    monkeypatch.setenv("SPAWN_WEBRTC_ICE_SERVERS", "[]")
    monkeypatch.setenv("SPAWN_TURN_URLS", "turn:relay.example:3478?transport=tcp")
    monkeypatch.setenv("SPAWN_TURN_SECRET", "turn-secret")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    user_id, token = await _signup(client, "host-rtc-turn@example.com")
    host_id = await _create_host(user_id, "turn-only")
    browser_socket = FakeWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(host_ws(browser_socket, host_id=host_id))  # type: ignore[arg-type]
    await _wait_until(lambda: bool(browser_socket.sent_text))
    config = _json_messages(browser_socket)[0]
    assert config["ice_transport_policy"] == "relay"
    assert config["ice_servers"][0]["urls"] == ["turn:relay.example:3478?transport=tcp"]

    browser_socket.queue_raw_text("x" * (MAX_SIGNAL_FRAME_BYTES + 1))
    await asyncio.wait_for(task, timeout=1)
    assert browser_socket.closed == (1009, "signaling frame too large")
    get_settings.cache_clear()  # type: ignore[attr-defined]


async def test_daemon_host_answer_is_session_bound_and_status_detail_is_truncated(client, caplog):
    user_id, token = await _signup(client, "host-rtc-answer@example.com")
    host_id = await _create_host(user_id, "answer-host")
    daemon_socket, daemon_task = await _start_daemon(user_id, host_id)

    browser_socket = FakeWebSocket(authorization=f"Bearer {token}")
    browser_task = asyncio.create_task(host_ws(browser_socket, host_id=host_id))  # type: ignore[arg-type]
    await _wait_until(lambda: bool(browser_socket.sent_text))
    browser_socket.queue_text(
        {
            "type": "rtc.offer",
            "session_id": "bound-answer",
            "sdp": "v=0\r\n",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: any(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket))
    )
    offer = [
        message for message in _json_messages(daemon_socket) if message.get("type") == "rtc.offer"
    ][-1]
    binding_nonce = offer["binding_nonce"]

    daemon_socket.queue_text(
        {
            "type": "rtc.answer",
            "session_id": "wrong-session",
            "binding_nonce": binding_nonce,
            "sdp": "v=0\r\nwrong",
            **_metadata(host_id),
        }
    )
    await asyncio.sleep(0.02)
    assert not any(
        message.get("type") == "rtc.answer" for message in _json_messages(browser_socket)
    )

    daemon_socket.queue_text(
        {
            "type": "rtc.answer",
            "session_id": "bound-answer",
            "binding_nonce": binding_nonce,
            "sdp": "v=0\r\nanswer",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: any(
            message.get("type") == "rtc.answer" for message in _json_messages(browser_socket)
        )
    )
    answer = [
        message for message in _json_messages(browser_socket) if message.get("type") == "rtc.answer"
    ][-1]
    assert answer == {
        "type": "rtc.answer",
        "session_id": "bound-answer",
        "binding_nonce": binding_nonce,
        "binding_generation": 1,
        "sdp": "v=0\r\nanswer",
        **_metadata(host_id),
    }

    # The allowlist is checked on a live binding: a terminal status ends the
    # binding, so it comes last.
    browser_message_count = len(browser_socket.sent_text)
    daemon_socket.queue_text(
        {
            "type": "rtc.status",
            "session_id": "bound-answer",
            "binding_nonce": binding_nonce,
            "status": "secret-endpoint-status",
            **_metadata(host_id),
        }
    )
    await asyncio.sleep(0.02)
    assert len(browser_socket.sent_text) == browser_message_count
    assert "daemon sent non-allowlisted host rtc status" in caplog.text
    assert "secret-endpoint-status" not in caplog.text

    daemon_socket.queue_text(
        {
            "type": "rtc.status",
            "session_id": "bound-answer",
            "binding_nonce": binding_nonce,
            "status": "failed",
            "message": "safe detail " + "x" * 300,
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: any(
            message.get("type") == "rtc.status" for message in _json_messages(browser_socket)
        )
    )
    status_message = [
        message for message in _json_messages(browser_socket) if message.get("type") == "rtc.status"
    ][-1]
    assert status_message["status"] == "failed"
    assert status_message["message"] == ("safe detail " + "x" * 300)[:256]
    assert "safe detail" not in caplog.text
    # A terminal status from the daemon ends the host binding.
    for _ in range(100):
        if await get_broker().rtc_session_for("bound-answer") is None:
            break
        await asyncio.sleep(0.01)
    assert await get_broker().rtc_session_for("bound-answer") is None

    browser_socket.queue_disconnect()
    await asyncio.gather(browser_task, _stop_daemon(daemon_socket, daemon_task))


async def test_host_ice_restart_reuses_live_binding_and_unknown_is_unavailable(client):
    from spawn_server.redis import get_backend
    from spawn_server.ws.host_signal import host_presence_key

    user_id, token = await _signup(client, "host-rtc-restart@example.com")
    host_id = await _create_host(user_id, "restart-host")
    daemon_socket, daemon_task = await _start_daemon(user_id, host_id)
    presence = await get_backend().get_ephemeral(host_presence_key(host_id))
    assert presence is not None
    assert await get_backend().delete_ephemeral_if(host_presence_key(host_id), presence)
    browser_socket = FakeWebSocket(authorization=f"Bearer {token}")
    browser_task = asyncio.create_task(host_ws(browser_socket, host_id=host_id))  # type: ignore[arg-type]
    await _wait_until(lambda: bool(browser_socket.sent_text))

    browser_socket.queue_text(
        {
            "type": "rtc.offer",
            "session_id": "host-restart-live",
            "sdp": "v=0\r\ninitial",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: (
            sum(frame.get("type") == "rtc.offer" for frame in _json_messages(daemon_socket)) == 1
        )
    )
    assert await get_backend().get_ephemeral(host_presence_key(host_id)) is not None
    initial = [
        frame for frame in _json_messages(daemon_socket) if frame.get("type") == "rtc.offer"
    ][-1]
    binding = await get_broker().rtc_session_for("host-restart-live")
    assert binding is not None

    browser_socket.queue_text(
        {
            "type": "rtc.offer",
            "session_id": "host-restart-live",
            "binding_nonce": initial["binding_nonce"],
            "binding_generation": initial["binding_generation"],
            "ice_restart": True,
            "sdp": "v=0\r\nrestart",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: (
            sum(frame.get("type") == "rtc.offer" for frame in _json_messages(daemon_socket)) == 2
        )
    )
    restart = [
        frame for frame in _json_messages(daemon_socket) if frame.get("type") == "rtc.offer"
    ][-1]
    assert restart["ice_restart"] is True
    assert restart["binding_nonce"] == initial["binding_nonce"]
    assert restart["binding_generation"] == initial["binding_generation"]
    assert await get_broker().rtc_session_for("host-restart-live") is binding

    browser_socket.queue_text(
        {
            "type": "rtc.offer",
            "session_id": "host-restart-unknown",
            "binding_nonce": "f" * 32,
            "binding_generation": initial["binding_generation"],
            "ice_restart": True,
            "sdp": "v=0\r\nrestart",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: any(
            frame.get("session_id") == "host-restart-unknown"
            and frame.get("status") == "unavailable"
            for frame in _json_messages(browser_socket)
        )
    )

    browser_socket.queue_disconnect()
    await asyncio.gather(browser_task, _stop_daemon(daemon_socket, daemon_task))


@pytest.mark.parametrize("version", [1, 2])
async def test_host_signed_offer_answer_survive_all_relays_and_refuse_raw_downgrade(
    client, version
):
    user_id, token = await _signup(client, "host-rtc-signed-relay@example.com")
    host_id = await _create_host(user_id, "signed-answer-host")
    session_id = str(uuid.uuid4())
    offer_wire = _signed_host_wire("rtc.offer", session_id, host_id, version)
    answer_wire = _signed_host_wire("rtc.answer", session_id, host_id, version)
    daemon_socket, daemon_task = await _start_daemon(user_id, host_id)
    browser_socket = FakeWebSocket(authorization=f"Bearer {token}")
    browser_task = asyncio.create_task(
        host_ws(browser_socket, host_id=host_id, rtc_version=version)
    )  # type: ignore[arg-type]
    try:
        await _wait_until(lambda: bool(browser_socket.sent_text))
        assert _json_messages(browser_socket)[0]["protocol_version"] == version
        offers_before = sum(
            message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket)
        )
        browser_socket.queue_text(
            {
                "type": "rtc.offer",
                "session_id": session_id,
                "signed_envelope": None,
                **_metadata(host_id, version),
            }
        )
        browser_socket.queue_text(
            {
                "type": "rtc.offer",
                "session_id": session_id,
                "signed_envelope": None,
                "sdp": "v=0\r\nraw downgrade",
                **_metadata(host_id, version),
            }
        )
        await asyncio.sleep(0.02)
        assert (
            sum(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket))
            == offers_before
        )

        if version == 2:
            # v2 never accepts a raw offer, including its very first offer.
            browser_socket.queue_text(
                {
                    "type": "rtc.offer",
                    "session_id": session_id,
                    "sdp": "v=0\r\n",
                    **_metadata(host_id, version),
                }
            )
            browser_socket.queue_text(
                {
                    "type": "rtc.offer",
                    "session_id": session_id,
                    "signed_envelope": _signed_host_wire("rtc.offer", session_id, host_id, 1),
                    **_metadata(host_id, version),
                }
            )
            await asyncio.sleep(0.02)
            assert (
                sum(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket))
                == offers_before
            )
        browser_socket.queue_text(
            {
                "type": "rtc.offer",
                "session_id": session_id,
                "signed_envelope": offer_wire,
                **_metadata(host_id, version),
            }
        )
        await _wait_until(
            lambda: any(
                message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket)
            )
        )
        offer = [
            message
            for message in _json_messages(daemon_socket)
            if message.get("type") == "rtc.offer"
        ][-1]
        assert offer["signed_envelope"] == offer_wire
        assert "sdp" not in offer
        binding_nonce = offer["binding_nonce"]

        before = sum(
            message.get("type") == "rtc.answer" for message in _json_messages(browser_socket)
        )
        daemon_socket.queue_text(
            {
                "type": "rtc.answer",
                "session_id": session_id,
                "binding_nonce": binding_nonce,
                **_metadata(host_id, version),
            }
        )
        daemon_socket.queue_text(
            {
                "type": "rtc.answer",
                "session_id": session_id,
                "binding_nonce": binding_nonce,
                "signed_envelope": None,
                **_metadata(host_id, version),
            }
        )
        daemon_socket.queue_text(
            {
                "type": "rtc.answer",
                "session_id": session_id,
                "binding_nonce": binding_nonce,
                "signed_envelope": None,
                "sdp": "v=0\r\nraw downgrade",
                **_metadata(host_id, version),
            }
        )
        daemon_socket.queue_text(
            {
                "type": "rtc.answer",
                "session_id": session_id,
                "binding_nonce": binding_nonce,
                "sdp": "v=0\r\nraw downgrade",
                **_metadata(host_id, version),
            }
        )
        daemon_socket.queue_text(
            {
                "type": "rtc.answer",
                "session_id": session_id,
                "binding_nonce": binding_nonce,
                "signed_envelope": answer_wire,
                **_metadata(host_id, version),
            }
        )
        await _wait_until(
            lambda: (
                sum(
                    message.get("type") == "rtc.answer"
                    for message in _json_messages(browser_socket)
                )
                == before + 1
            )
        )
        answer = [
            message
            for message in _json_messages(browser_socket)
            if message.get("type") == "rtc.answer"
        ][-1]
        assert answer["signed_envelope"] == answer_wire
        assert "sdp" not in answer

        # A signed value plus a raw sibling is never interpreted as legacy.
        browser_socket.queue_text(
            {
                "type": "rtc.offer",
                "session_id": str(uuid.uuid4()),
                "signed_envelope": offer_wire,
                "sdp": "v=0\r\nsubstitute",
                **_metadata(host_id, version),
            }
        )
        await asyncio.sleep(0.02)
        assert (
            sum(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket))
            == 1
        )
    finally:
        browser_socket.queue_disconnect()
        await asyncio.gather(browser_task, _stop_daemon(daemon_socket, daemon_task))


async def test_host_signaling_rejects_repeated_offers_and_caps_pending_sessions(client):
    user_id, token = await _signup(client, "host-rtc-bounds@example.com")
    host_id = await _create_host(user_id, "bounded-host")
    daemon_socket, daemon_task = await _start_daemon(user_id, host_id)
    browser_socket = FakeWebSocket(authorization=f"Bearer {token}")
    browser_task = asyncio.create_task(host_ws(browser_socket, host_id=host_id))  # type: ignore[arg-type]
    await _wait_until(lambda: bool(browser_socket.sent_text))

    first = {"type": "rtc.offer", "session_id": "pending-0", "sdp": "v=0\r\n", **_metadata(host_id)}
    browser_socket.queue_text(first)
    await _wait_until(
        lambda: (
            sum(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket))
            == 1
        )
    )
    browser_socket.queue_text(first)
    await _wait_until(
        lambda: any(
            message.get("type") == "rtc.status"
            and message.get("session_id") == "pending-0"
            and message.get("status") == "failed"
            for message in _json_messages(browser_socket)
        )
    )
    assert sum(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket)) == 1

    for index in range(1, 8):
        browser_socket.queue_text(
            {
                "type": "rtc.offer",
                "session_id": f"pending-{index}",
                "sdp": "v=0\r\n",
                **_metadata(host_id),
            }
        )
    await _wait_until(
        lambda: (
            sum(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket))
            == 8
        )
    )
    browser_socket.queue_text(
        {"type": "rtc.offer", "session_id": "over-cap", "sdp": "v=0\r\n", **_metadata(host_id)}
    )
    await _wait_until(
        lambda: any(
            message.get("type") == "rtc.status"
            and message.get("session_id") == "over-cap"
            and message.get("status") == "failed"
            for message in _json_messages(browser_socket)
        )
    )
    assert sum(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket)) == 8

    browser_socket.queue_disconnect()
    await asyncio.gather(browser_task, _stop_daemon(daemon_socket, daemon_task))


async def test_new_daemon_claim_actively_revokes_established_old_worker_session(client):
    user_id, token = await _signup(client, "host-rtc-revocation@example.com")
    host_id = await _create_host(user_id, "revoked-host")
    old_socket, old_task = await _start_daemon(user_id, host_id)
    browser_socket = FakeWebSocket(authorization=f"Bearer {token}")
    browser_task = asyncio.create_task(host_ws(browser_socket, host_id=host_id))  # type: ignore[arg-type]
    await _wait_until(lambda: bool(browser_socket.sent_text))
    browser_socket.queue_text(
        {
            "type": "rtc.offer",
            "session_id": "established-old-owner",
            "sdp": "v=0\r\n",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: any(message.get("type") == "rtc.offer" for message in _json_messages(old_socket))
    )
    old_offer = [
        message for message in _json_messages(old_socket) if message.get("type") == "rtc.offer"
    ][-1]
    old_socket.queue_text(
        {
            "type": "rtc.status",
            "session_id": "established-old-owner",
            "binding_nonce": old_offer["binding_nonce"],
            "status": "connected",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: any(
            message.get("type") == "rtc.status" and message.get("status") == "connected"
            for message in _json_messages(browser_socket)
        )
    )

    new_socket, new_task = await _start_daemon(user_id, host_id)
    await asyncio.wait_for(old_task, timeout=1)
    await _wait_until(
        lambda: any(
            message.get("type") == "rtc.status" and message.get("status") == "unavailable"
            for message in _json_messages(browser_socket)
        )
    )
    assert old_socket.closed == (4000, "superseded")
    assert any(
        message.get("type") == "rtc.close" and message.get("session_id") == "established-old-owner"
        for message in _json_messages(old_socket)
    )
    assert await get_broker().rtc_session_for("established-old-owner") is None

    browser_socket.queue_disconnect()
    await asyncio.gather(browser_task, _stop_daemon(new_socket, new_task))
