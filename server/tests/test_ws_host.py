"""Host-scoped signaling authorization, binding, isolation and cleanup."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

from spawn_server import auth
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import Host
from spawn_server.ws.broker import get_broker
from spawn_server.ws.daemon import daemon_ws
from spawn_server.ws.host import (
    HOST_CONTROL_PROTOCOL,
    HOST_CONTROL_VERSION,
    MAX_SIGNAL_FRAME_BYTES,
    host_ws,
)


class FakeWebSocket:
    def __init__(self, *, authorization: str | None = None) -> None:
        self.headers = {"authorization": authorization} if authorization else {}
        self.cookies: dict[str, str] = {}
        self.scope: dict[str, Any] = {"subprotocols": ["spawn.host.v1"]}
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

    def queue_raw_text(self, payload: str) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "text": payload})

    def queue_disconnect(self) -> None:
        self._incoming.put_nowait({"type": "websocket.disconnect"})


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


def _metadata(host_id: str) -> dict[str, object]:
    return {
        "scope_type": "host",
        "scope_id": host_id,
        "protocol": HOST_CONTROL_PROTOCOL,
        "protocol_version": HOST_CONTROL_VERSION,
    }


async def _start_daemon(user_id: str, host_id: str) -> tuple[FakeWebSocket, asyncio.Task[None]]:
    socket = FakeWebSocket(authorization=f"Bearer {auth.issue_daemon_token(host_id, user_id)}")
    task = asyncio.create_task(daemon_ws(socket))  # type: ignore[arg-type]
    socket.queue_text(
        {
            "type": "register",
            "host_name": "test-daemon",
            "os": "linux",
            "arch": "x86_64",
            "version": "test",
        }
    )
    await _wait_until(
        lambda: any(message.get("type") == "registered" for message in _json_messages(socket))
    )
    return socket, task


async def _stop_daemon(socket: FakeWebSocket, task: asyncio.Task[None]) -> None:
    socket.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)


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
        {"type": "rtc.offer", "session_id": "zero-agent-session", "sdp": "v=0\r\n", **_metadata(host_id)}
    )
    await _wait_until(
        lambda: any(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket))
    )
    offer = _json_messages(daemon_socket)[-1]
    assert offer["type"] == "rtc.offer"
    assert offer["session_id"] == "zero-agent-session"
    assert "agent_id" not in offer
    assert {key: offer[key] for key in _metadata(host_id)} == _metadata(host_id)

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
        **_metadata(host_id),
    }
    assert await broker.rtc_session_for("zero-agent-session") is None
    await _stop_daemon(daemon_socket, daemon_task)


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
        lambda: any(message.get("type") == "rtc.offer" for message in _json_messages(first_daemon_ws))
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
    assert sum(
        message.get("type") == "rtc.offer" for message in _json_messages(second_daemon_ws)
    ) == second_rtc_count

    second_ws.queue_text(
        {
            "type": "rtc.candidate",
            "session_id": "isolated",
            "candidate": {"candidate": "candidate:secret"},
            **_metadata(second_host),
        }
    )
    await asyncio.sleep(0.02)
    assert sum(
        message.get("type") in {"rtc.offer", "rtc.candidate"}
        for message in _json_messages(second_daemon_ws)
    ) == second_rtc_count

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


async def test_daemon_host_answer_is_session_bound_and_status_detail_is_not_forwarded(
    client, caplog
):
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

    daemon_socket.queue_text(
        {
            "type": "rtc.answer",
            "session_id": "wrong-session",
            "sdp": "v=0\r\nwrong",
            **_metadata(host_id),
        }
    )
    await asyncio.sleep(0.02)
    assert not any(message.get("type") == "rtc.answer" for message in _json_messages(browser_socket))

    daemon_socket.queue_text(
        {
            "type": "rtc.answer",
            "session_id": "bound-answer",
            "sdp": "v=0\r\nanswer",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: any(message.get("type") == "rtc.answer" for message in _json_messages(browser_socket))
    )
    answer = [
        message for message in _json_messages(browser_socket) if message.get("type") == "rtc.answer"
    ][-1]
    assert answer == {
        "type": "rtc.answer",
        "session_id": "bound-answer",
        "sdp": "v=0\r\nanswer",
        **_metadata(host_id),
    }

    daemon_socket.queue_text(
        {
            "type": "rtc.status",
            "session_id": "bound-answer",
            "status": "failed",
            "message": "secret endpoint path must not transit",
            **_metadata(host_id),
        }
    )
    await _wait_until(
        lambda: any(message.get("type") == "rtc.status" for message in _json_messages(browser_socket))
    )
    status_message = [
        message for message in _json_messages(browser_socket) if message.get("type") == "rtc.status"
    ][-1]
    assert status_message["status"] == "failed"
    assert "message" not in status_message

    browser_message_count = len(browser_socket.sent_text)
    daemon_socket.queue_text(
        {
            "type": "rtc.status",
            "session_id": "bound-answer",
            "status": "secret-endpoint-status",
            **_metadata(host_id),
        }
    )
    await asyncio.sleep(0.02)
    assert len(browser_socket.sent_text) == browser_message_count
    assert "daemon sent non-allowlisted host rtc status" in caplog.text
    assert "secret endpoint path must not transit" not in caplog.text
    assert "secret-endpoint-status" not in caplog.text

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
        lambda: sum(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket))
        == 1
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
    assert sum(
        message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket)
    ) == 1

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
        lambda: sum(message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket))
        == 8
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
    assert sum(
        message.get("type") == "rtc.offer" for message in _json_messages(daemon_socket)
    ) == 8

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
    old_socket.queue_text(
        {
            "type": "rtc.status",
            "session_id": "established-old-owner",
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
        message.get("type") == "rtc.close"
        and message.get("session_id") == "established-old-owner"
        for message in _json_messages(old_socket)
    )
    assert await get_broker().rtc_session_for("established-old-owner") is None

    browser_socket.queue_disconnect()
    await asyncio.gather(browser_task, _stop_daemon(new_socket, new_task))
