"""Daemon websocket auth, compatibility, and reconnect behavior."""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import jwt
import pytest
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from spawn_server import auth
from spawn_server.db import get_sessionmaker
from spawn_server.limits import MAX_SAFE_FENCING_GENERATION
from spawn_server.models import BrowserDevice, Host, HostBrowserPin, Session, User
from spawn_server.redis import get_backend
from spawn_server.ws.broker import DaemonConn, HostBrowserConn, get_broker
from spawn_server.ws.daemon import (
    _allocate_host_generation,
    _fence_superseded_daemon,
    _redis_owner_is_current,
    _route_rtc_payload_if_owner,
    _validate_durable_host_owner,
    _validated_live_bindings,
    daemon_ws,
)
from spawn_server.ws.host_signal import (
    HOST_DAEMON_PRESENCE_TTL_SECONDS,
    HostPresenceOwner,
    RedisBrowserConn,
    browser_signal_channel,
    decode_host_presence_owner,
    decode_rtc_signal_dispatch,
    encode_host_presence_owner,
    host_pending_presence_key,
    host_presence_key,
)


def _signed_session_answer_wire(session_id: str, pty_id: str) -> str:
    vectors = json.loads(
        (Path(__file__).parents[2] / "proto" / "signed-signal-wire-v1-vectors.json").read_text()
    )["vectors"]
    envelope = dict(vectors[0]["envelope"])
    envelope.update(
        {
            "type": "rtc.answer",
            "session_id": session_id,
            "scope_type": "session",
            "scope_id": pty_id,
            "sender_role": "daemon",
        }
    )
    return "\n" + json.dumps(envelope, separators=(",", ":")) + " "


class FakeDaemonWebSocket:
    def __init__(
        self,
        *,
        authorization: str | None = None,
        subprotocols: list[str] | None = None,
    ) -> None:
        self.headers: dict[str, str] = {}
        if authorization is not None:
            self.headers["authorization"] = authorization
        self.scope: dict[str, Any] = {"subprotocols": subprotocols or ["spawn.control.v3"]}
        self.accepted_subprotocol: str | None = None
        self.sent_text: list[str] = []
        self.sent_bytes: list[bytes] = []
        self.closed: tuple[int, str] | None = None
        self.close_calls: list[tuple[int, str]] = []
        self.receive_count = 0
        self._incoming: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def accept(self, subprotocol: str | None = None) -> None:
        self.accepted_subprotocol = subprotocol

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)
        self.close_calls.append((code, reason))

    async def receive(self) -> dict[str, Any]:
        message = await self._incoming.get()
        self.receive_count += 1
        if isinstance(message, WebSocketDisconnect):
            raise message
        return message

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

    def queue_bytes(self, payload: bytes) -> None:
        self._incoming.put_nowait({"type": "websocket.receive", "bytes": payload})

    def queue_disconnect(self) -> None:
        self._incoming.put_nowait({"type": "websocket.disconnect"})

    def queue_disconnect_error(self, code: int, reason: str) -> None:
        self._incoming.put_nowait(WebSocketDisconnect(code=code, reason=reason))


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


async def _create_session_row(
    user_id: str,
    host_id: str,
    *,
    name: str = "session",
) -> str:
    sm = get_sessionmaker()
    async with sm() as session:
        row = Session(
            owner_user_id=user_id,
            host_id=host_id,
            name=name,
            cwd="/repo",
            status="running",
        )
        session.add(row)
        await session.commit()
        return row.id


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
    assert missing.accepted_subprotocol == "spawn.control.v3"
    assert missing.closed == (1008, "token_invalid")

    wrong_kind = FakeDaemonWebSocket(authorization=f"Bearer {access_token}")
    await daemon_ws(wrong_kind, token=None)  # type: ignore[arg-type]
    assert wrong_kind.closed == (1008, "token_invalid")

    wrong_host = FakeDaemonWebSocket(
        authorization=f"Bearer {auth.issue_daemon_token(host_id, 'other-user')}"
    )
    await daemon_ws(wrong_host, token=None)  # type: ignore[arg-type]
    assert wrong_host.closed == (1008, "token_revoked")
    async with get_sessionmaker()() as session:
        rejected_host = await session.get(Host, host_id)
        assert rejected_host is not None
        assert rejected_host.last_disconnect_reason == "auth_rejected"
        assert rejected_host.last_disconnect_at is not None

    accepted = FakeDaemonWebSocket(authorization=f"Bearer {daemon_token}")
    accepted.queue_disconnect()
    await daemon_ws(accepted, token=None)  # type: ignore[arg-type]
    assert accepted.closed is None

    old = FakeDaemonWebSocket(authorization=f"Bearer {daemon_token}", subprotocols=["spawn.v1"])
    await daemon_ws(old, token=None)  # type: ignore[arg-type]
    assert old.accepted_subprotocol is None
    assert _sent_json(old) == [
        {
            "type": "protocol.required",
            "protocol": "spawn.control.v3",
            "version": 3,
        }
    ]
    assert old.closed == (4003, "protocol upgrade required")


async def test_expired_daemon_token_is_identified_and_recorded(client):
    user_id, _ = await _signup(client, "ws-daemon-expired@example.com")
    host_id = await _create_host(user_id)
    settings = auth.get_settings()
    now = datetime.now(UTC)
    expired_token = jwt.encode(
        {
            "sub": f"host:{host_id}",
            "user_id": user_id,
            "kind": auth.KIND_DAEMON,
            "iat": int((now - timedelta(days=366)).timestamp()),
            "exp": int((now - timedelta(seconds=1)).timestamp()),
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )
    ws = FakeDaemonWebSocket(authorization=f"Bearer {expired_token}")

    await daemon_ws(ws, token=None)  # type: ignore[arg-type]

    assert ws.closed == (1008, "token_expired")
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.last_disconnect_reason == "auth_rejected"
        assert host.last_disconnect_at is not None


async def test_registered_rotates_daemon_token_with_under_thirty_days_left(client):
    user_id, _ = await _signup(client, "ws-daemon-rotation@example.com")
    host_id = await _create_host(user_id)
    settings = auth.get_settings()
    now = datetime.now(UTC)
    expiring_token = jwt.encode(
        {
            "sub": f"host:{host_id}",
            "user_id": user_id,
            "kind": auth.KIND_DAEMON,
            "iat": int(now.timestamp()),
            "exp": int((now + timedelta(days=29)).timestamp()),
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )
    ws = FakeDaemonWebSocket(authorization=f"Bearer {expiring_token}")
    ws.queue_text({"type": "register"})
    ws.queue_disconnect()

    await daemon_ws(ws, token=None)  # type: ignore[arg-type]

    registered = next(frame for frame in _sent_json(ws) if frame["type"] == "registered")
    rotated = auth.decode_token(registered["access_token"])
    assert rotated["sub"] == f"host:{host_id}"
    assert rotated["user_id"] == user_id
    assert rotated["kind"] == auth.KIND_DAEMON
    assert datetime.fromtimestamp(rotated["exp"], UTC) > now + timedelta(days=364)


async def test_daemon_pre_register_frame_gets_invalid_frame(client):
    user_id, _ = await _signup(client, "ws-daemon-pre-register@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)
    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    ws.queue_text({"type": "host.heartbeat"})
    ws.queue_disconnect()
    await daemon_ws(ws, token=None)  # type: ignore[arg-type]
    assert _sent_json(ws) == [
        {
            "type": "error",
            "code": "invalid_frame",
            "frame_type": "host.heartbeat",
        }
    ]


async def test_daemon_register_rejects_invalid_capability_shapes(client):
    user_id, _ = await _signup(client, "ws-daemon-invalid-capability@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)
    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    ws.queue_text({"type": "register", "keeps_peers_across_reconnect": "yes"})
    ws.queue_disconnect()
    await daemon_ws(ws, token=None)  # type: ignore[arg-type]
    assert _sent_json(ws) == [
        {
            "type": "error",
            "code": "invalid_frame",
            "frame_type": "register",
        }
    ]

    mismatch = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    mismatch.queue_text({"type": "register", "worker_mismatch": "yes"})
    mismatch.queue_disconnect()
    await daemon_ws(mismatch, token=None)  # type: ignore[arg-type]
    assert _sent_json(mismatch) == [
        {
            "type": "error",
            "code": "invalid_frame",
            "frame_type": "register",
        }
    ]


async def test_daemon_ws_closes_4010_when_subscription_is_not_ready(client, monkeypatch):
    user_id, _ = await _signup(client, "ws-daemon-subscription-lost@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    @asynccontextmanager
    async def ended_subscription(_channel):
        async def empty():
            if False:
                yield b""

        yield empty()

    monkeypatch.setattr(get_backend(), "subscribe_channel", ended_subscription)
    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    await daemon_ws(ws, token=None)  # type: ignore[arg-type]
    assert ws.closed == (4010, "subscription lost")


async def test_daemon_keepalive_timeout_records_disconnect_reason(client):
    user_id, _ = await _signup(client, "ws-daemon-keepalive-timeout@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)
    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(daemon_ws(ws, token=None))  # type: ignore[arg-type]
    ws.queue_text({"type": "register", "version": "test"})
    await _wait_until(lambda: any(frame.get("type") == "registered" for frame in _sent_json(ws)))
    ws.queue_disconnect_error(4008, "keepalive timeout")
    await asyncio.wait_for(task, timeout=1)
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.last_disconnect_reason == "keepalive_timeout"
        assert host.last_disconnect_at is not None


async def test_durable_owner_cache_skips_db_and_transient_timeout_drops_one_frame(
    monkeypatch,
):
    from spawn_server.ws import daemon as daemon_mod
    from spawn_server.ws.broker import RtcSessionBinding

    daemon_socket = FakeDaemonWebSocket()
    daemon = DaemonConn("cache-host", "owner", daemon_socket)  # type: ignore[arg-type]
    daemon.host_generation = 4
    daemon.durable_owner_valid_until = asyncio.get_running_loop().time() + 10

    async def db_must_not_run(*_args, **_kwargs):
        raise AssertionError("cached durable ownership queried the database")

    monkeypatch.setattr(daemon_mod, "_is_durable_host_owner", db_must_not_run)
    assert await _validate_durable_host_owner(daemon)

    async def timeout(*_args, **_kwargs):
        raise TimeoutError

    monkeypatch.setattr(daemon_mod, "_validate_durable_host_owner", timeout)
    browser = RedisBrowserConn(
        "owner",
        "cache-host",
        browser_signal_channel("f" * 32),
        daemon.id,
        4,
        "a" * 32,
    )
    binding = RtcSessionBinding(
        "cache-binding",
        browser,
        daemon,
        "host",
        "cache-host",
        "spawn.host.ctl",
        1,
        daemon.id,
        4,
        "a" * 32,
        float("inf"),
    )
    assert await _route_rtc_payload_if_owner(
        daemon,
        binding,
        {"type": "rtc.status", "session_id": "cache-binding"},
    )
    assert daemon_socket.closed is None

    async def lost_cas(*_args, **_kwargs):
        return False

    daemon.durable_owner_valid_until = asyncio.get_running_loop().time() + 10
    monkeypatch.setattr(get_backend(), "host_owner_is_current", lost_cas)
    assert not await _redis_owner_is_current(daemon)
    assert daemon.durable_owner_valid_until == 0


async def test_stale_host_offer_after_active_takeover_revokes_existing_binding(app, monkeypatch):
    """Lease fencing must not consume the revocation cleanup opportunity."""

    import spawn_server.ws.daemon as daemon_mod
    from spawn_server.ws.host_signal import HostSignalEnvelope

    broker = get_broker()
    backend = get_backend()
    host_id = "stale-offer-takeover-host"
    old_socket = FakeDaemonWebSocket()
    old = DaemonConn(
        host_id=host_id,
        user_id="owner",
        websocket=old_socket,  # type: ignore[arg-type]
        id="a" * 32,
        host_generation=1,
    )
    assert await broker.accept_daemon_owner(old, 1)

    browser_route = browser_signal_channel("c" * 32)
    binding_nonce = "d" * 32
    remote_browser = RedisBrowserConn(
        "owner",
        host_id,
        browser_route,
        old.id,
        1,
        binding_nonce,
    )
    session_id = "established-before-takeover"
    assert await broker.register_rtc_session(
        session_id,
        remote_browser,
        daemon=old,
        scope_type="host",
        scope_id=host_id,
        protocol="spawn.host.ctl",
        protocol_version=1,
        binding_nonce=binding_nonce,
        ttl_seconds=60,
    )

    async def cached_durable_owner(_conn):
        return True

    monkeypatch.setattr(daemon_mod, "_validate_durable_host_owner", cached_durable_owner)
    replacement = HostPresenceOwner("b" * 32, 2)
    await backend.set_ephemeral(
        host_presence_key(host_id),
        encode_host_presence_owner(replacement),
        ttl_seconds=60,
    )
    stale_offer = HostSignalEnvelope(
        old.id,
        1,
        browser_route,
        {
            "type": "rtc.offer",
            "session_id": "stale-after-takeover",
            "binding_nonce": "e" * 32,
            "scope_type": "host",
            "scope_id": host_id,
            "protocol": "spawn.host.ctl",
            "protocol_version": 1,
            "sdp": "v=0\r\n",
        },
    )

    try:
        async with backend.subscribe_channel(browser_route) as responses:
            assert not await daemon_mod._process_host_rtc_signal(old, stale_offer, set())
            raw = await asyncio.wait_for(anext(responses), timeout=1)
        dispatch = decode_rtc_signal_dispatch(raw)
        assert dispatch is not None
        assert dispatch.session_connection_id == old.id
        assert dispatch.session_generation == 1
        assert dispatch.binding_nonce == binding_nonce
        assert dispatch.dispatch_connection_id == replacement.daemon_connection_id
        assert dispatch.dispatch_generation == replacement.generation
        assert dispatch.signal["type"] == "rtc.status"
        assert dispatch.signal["session_id"] == session_id
        assert dispatch.signal["status"] == "unavailable"
        assert old_socket.closed == (4000, "superseded")
        assert any(
            frame.get("type") == "rtc.close" and frame.get("session_id") == session_id
            for frame in _sent_json(old_socket)
        )
        assert await broker.rtc_session_for(session_id) is None
    finally:
        await broker.unregister_daemon(old)


def test_live_bindings_are_validated_field_by_field_and_capped():
    valid = {
        "session_id": "session",
        "binding_nonce": "a" * 32,
        "binding_generation": 3,
        "scope_type": "session",
        "scope_id": "pty",
        "protocol": "spawn.pty",
        "protocol_version": 2,
    }
    assert _validated_live_bindings([valid, {**valid, "unknown": True}, "bad"]) == [valid]
    assert len(_validated_live_bindings([valid] * 300)) == 256


async def test_daemon_ws_register_accepts_old_shape_and_heartbeat_query_token(client):
    user_id, _ = await _signup(client, "ws-daemon-register@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    ws = FakeDaemonWebSocket()
    ws.queue_raw_text("null")
    ws.queue_raw_text("7")
    ws.queue_raw_text('"primitive"')
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
    # The registration frame carries the authoritative live browser-pin set so
    # a daemon reconciles revocations on every connect; this host has none.
    registered = next(frame for frame in sent if frame.get("type") == "registered")
    assert registered["host_id"] == host_id
    # Carries the authoritative live pin set so the daemon reconciles
    # revocations, and full records so it can adopt endorsed devices.
    assert registered["browser_device_ids"] == []
    assert registered["browser_pins"] == []
    assert {"type": "host.heartbeat"} in sent
    assert get_broker().get_daemon_for_host(host_id) is None

    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.os == "linux"
        assert host.arch == "x86_64"
        assert host.version == "0.1.0"
        assert host.daemon_tree is None
        assert host.self_update is False
        assert host.self_update_blocked is None
        assert host.status == "offline"
        assert host.last_seen_at is not None
        assert host.last_disconnect_reason == "socket_closed"
        assert host.last_disconnect_at is not None


async def test_registration_admission_allows_forty_waiting_daemons(client, monkeypatch):
    from spawn_server.ws import daemon as daemon_mod

    # The production default is 32. A single permit makes the waiting behavior
    # deterministic on SQLite, whose test connection cannot commit concurrent
    # write transactions. Keep post-registration reads out of this admission
    # test so only the transaction under test contends for that connection.
    admission = asyncio.Semaphore(1)
    monkeypatch.setattr(daemon_mod, "_registration_semaphore", lambda: admission)

    async def empty_records(*_args, **_kwargs):
        return []

    async def no_update(*_args, **_kwargs):
        return None

    monkeypatch.setattr(daemon_mod, "_live_browser_device_ids", empty_records)
    monkeypatch.setattr(daemon_mod, "_live_browser_pins", empty_records)
    monkeypatch.setattr(daemon_mod, "_revoked_browser_keys", empty_records)
    monkeypatch.setattr(daemon_mod, "_auto_update_after_registration", no_update)
    user_id, _ = await _signup(client, "ws-daemon-admission@example.com")
    host_ids = [await _create_host(user_id, name=f"admission-{index}") for index in range(40)]
    sockets: list[FakeDaemonWebSocket] = []
    tasks: list[asyncio.Task[None]] = []
    for host_id in host_ids:
        token = auth.issue_daemon_token(host_id, user_id)
        socket = FakeDaemonWebSocket(authorization=f"Bearer {token}")
        sockets.append(socket)
        tasks.append(asyncio.create_task(daemon_ws(socket, token=None)))  # type: ignore[arg-type]
        socket.queue_text({"type": "register", "version": "admission"})

    await asyncio.gather(
        *(
            _wait_until(
                lambda socket=socket: any(
                    frame.get("type") == "registered" for frame in _sent_json(socket)
                ),
                timeout=20,
            )
            for socket in sockets
        )
    )
    for socket, task in zip(sockets, tasks, strict=True):
        assert socket.closed is None
        socket.queue_disconnect()
        await asyncio.wait_for(task, timeout=2)


async def test_register_persists_self_update_fields(client):
    user_id, _ = await _signup(client, "ws-daemon-update-register@example.com")
    host_id = await _create_host(user_id)
    tree = "a" * 40
    ws = FakeDaemonWebSocket()
    ws.queue_text(
        {
            "type": "register",
            "os": "linux",
            "arch": "x86_64",
            "version": "0.1.0+gaaaaaaaaaaaa",
            "daemon_tree": tree.upper(),
            "self_update": True,
            "self_update_blocked": None,
        }
    )
    ws.queue_disconnect()

    await daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]

    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_tree == tree
        assert host.self_update is True
        assert host.self_update_blocked is None


async def test_register_invalid_self_update_fields_are_treated_as_absent(client):
    user_id, _ = await _signup(client, "ws-daemon-update-register-invalid@example.com")
    host_id = await _create_host(user_id)
    ws = FakeDaemonWebSocket()
    ws.queue_text(
        {
            "type": "register",
            "daemon_tree": "not-a-tree",
            "self_update": "yes",
            "self_update_blocked": "x" * 65,
        }
    )
    ws.queue_disconnect()

    await daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]

    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_tree is None
        assert host.self_update is False
        assert host.self_update_blocked is None


def _stage_update_manifest(tmp_path: Path, *, tree: str = "b" * 40) -> None:
    root = tmp_path / "daemon" / "target" / "prebuilt"
    target = root / "linux-x86_64"
    target.mkdir(parents=True)
    spawnd = b"new-spawnd"
    worker = b"new-worker"
    (target / "spawnd").write_bytes(spawnd)
    (target / "spawn-worker").write_bytes(worker)
    (root / "manifest.json").write_text(
        json.dumps(
            {
                "commit": "c" * 40,
                "tree": tree,
                "version": "0.2.0+gcccccccccccc",
                "targets": {
                    "linux-x86_64": {
                        "spawnd_sha256": hashlib.sha256(spawnd).hexdigest(),
                        "spawn_worker_sha256": hashlib.sha256(worker).hexdigest(),
                    }
                },
            }
        )
    )


async def test_register_auto_sends_daemon_update_after_registered(client, tmp_path, monkeypatch):
    from spawn_server import release

    _stage_update_manifest(tmp_path)
    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    release.refresh()
    user_id, _ = await _signup(client, "ws-daemon-auto-update@example.com")
    host_id = await _create_host(user_id)
    ws = FakeDaemonWebSocket()
    ws.queue_text(
        {
            "type": "register",
            "os": "linux",
            "arch": "x86_64",
            "version": "0.1.0+gaaaaaaaaaaaa",
            "daemon_tree": "a" * 40,
            "self_update": True,
        }
    )
    ws.queue_disconnect()

    await daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]

    frames = _sent_json(ws)
    registered_index = next(i for i, frame in enumerate(frames) if frame["type"] == "registered")
    update_index = next(i for i, frame in enumerate(frames) if frame["type"] == "daemon.update")
    assert registered_index < update_index
    update_frame = frames[update_index]
    assert update_frame["tree"] == "b" * 40
    assert update_frame["target"] == "linux-x86_64"
    assert update_frame["spawnd"]["path"] == "/api/install/spawnd/linux-x86_64"
    assert update_frame["spawn_worker"]["path"] == ("/api/install/spawn-worker/linux-x86_64")
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.update_state == "updating"
        assert host.update_tree == "b" * 40
        assert host.update_requested_at is not None


async def test_register_respects_disabled_daemon_auto_update(client, tmp_path, monkeypatch):
    from spawn_server import release
    from spawn_server.ws import daemon as daemon_module

    _stage_update_manifest(tmp_path)
    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    settings = daemon_module.get_settings().model_copy(update={"daemon_auto_update": False})
    monkeypatch.setattr(daemon_module, "get_settings", lambda: settings)
    release.refresh()
    user_id, _ = await _signup(client, "ws-daemon-auto-update-disabled@example.com")
    host_id = await _create_host(user_id)
    ws = FakeDaemonWebSocket()
    ws.queue_text(
        {
            "type": "register",
            "os": "linux",
            "arch": "x86_64",
            "daemon_tree": "a" * 40,
            "self_update": True,
        }
    )
    ws.queue_disconnect()

    await daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]

    assert not any(frame["type"] == "daemon.update" for frame in _sent_json(ws))
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.update_state is None


async def test_worker_mismatch_register_repairs_same_tree_and_omission_clears_flag(
    client, tmp_path, monkeypatch
):
    from spawn_server import release
    from spawn_server.ws import daemon as daemon_module

    tree = "b" * 40
    _stage_update_manifest(tmp_path, tree=tree)
    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    settings = daemon_module.get_settings().model_copy(update={"daemon_auto_update": False})
    monkeypatch.setattr(daemon_module, "get_settings", lambda: settings)
    release.refresh()
    user_id, _ = await _signup(client, "ws-daemon-worker-repair@example.com")
    host_id = await _create_host(user_id)

    mismatch = FakeDaemonWebSocket()
    mismatch.queue_text(
        {
            "type": "register",
            "os": "linux",
            "arch": "x86_64",
            "daemon_tree": tree,
            "self_update": False,
            "worker_mismatch": True,
        }
    )
    mismatch.queue_disconnect()
    await daemon_ws(mismatch, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]

    frames = _sent_json(mismatch)
    registered_index = next(i for i, frame in enumerate(frames) if frame["type"] == "registered")
    update_index = next(i for i, frame in enumerate(frames) if frame["type"] == "daemon.update")
    assert registered_index < update_index
    assert frames[update_index]["tree"] == tree
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.worker_mismatch is True

    repaired = FakeDaemonWebSocket()
    repaired.queue_text(
        {
            "type": "register",
            "os": "linux",
            "arch": "x86_64",
            "daemon_tree": tree,
            "self_update": False,
        }
    )
    repaired.queue_disconnect()
    await daemon_ws(repaired, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]

    assert not any(frame["type"] == "daemon.update" for frame in _sent_json(repaired))
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.worker_mismatch is False


async def test_pin_adoption_failure_is_validated_persisted_published_and_cleared(
    client, monkeypatch
):
    from spawn_server.ws import daemon as daemon_module

    user_id, _ = await _signup(client, "ws-daemon-pin-adoption@example.com")
    host_id = await _create_host(user_id)
    async with get_sessionmaker()() as session:
        device = BrowserDevice(
            owner_user_id=user_id,
            key_algorithm="ed25519",
            public_key="P" * 43,
        )
        session.add(device)
        await session.flush()
        pin = HostBrowserPin(
            host_id=host_id,
            browser_device_id=device.id,
            browser_key_algorithm="ed25519",
            browser_public_key=device.public_key,
            browser_key_fingerprint="SHA256:" + "p" * 16,
        )
        session.add(pin)
        await session.commit()
        device_id = device.id

    events: list[tuple[str, dict[str, object]]] = []

    async def capture_event(owner_id: str, payload: dict[str, object]) -> None:
        events.append((owner_id, payload))

    monkeypatch.setattr(daemon_module, "publish_trust_event", capture_event)
    ws = FakeDaemonWebSocket()
    ws.queue_text({"type": "register"})
    task = asyncio.create_task(
        daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]
    )
    await _wait_until(lambda: any(frame.get("type") == "registered" for frame in _sent_json(ws)))

    ws.queue_text(
        {
            "type": "host.pin_adopt_failed",
            "browser_device_id": device_id,
            "reason": "pin_limit",
            "extra": True,
        }
    )
    ws.queue_text(
        {
            "type": "host.pin_adopt_failed",
            "browser_device_id": str(uuid.uuid4()),
            "reason": "other",
        }
    )
    ws.queue_text(
        {
            "type": "host.pin_adopt_failed",
            "browser_device_id": device_id,
            "reason": "pin_limit",
        }
    )
    await _wait_until(lambda: len(events) == 1)

    assert events[0][0] == user_id
    assert events[0][1]["event"] == "host.pin_undelivered"
    assert events[0][1]["host_id"] == host_id
    assert events[0][1]["browser_device_id"] == device_id
    assert events[0][1]["reason"] == "pin_limit"
    assert [frame for frame in _sent_json(ws) if frame.get("code") == "invalid_frame"] == [
        {
            "type": "error",
            "code": "invalid_frame",
            "frame_type": "host.pin_adopt_failed",
        }
    ]
    async with get_sessionmaker()() as session:
        pin = await session.get(HostBrowserPin, (host_id, device_id))
        assert pin is not None
        assert pin.delivered_at is None
        assert pin.undelivered_reason == "pin_limit"

    ws.queue_text({"type": "host.pin_adopted", "browser_device_id": device_id})
    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)

    async with get_sessionmaker()() as session:
        pin = await session.get(HostBrowserPin, (host_id, device_id))
        assert pin is not None
        assert pin.delivered_at is not None
        assert pin.undelivered_reason is None


@pytest.mark.parametrize(
    ("stage", "error", "humanized"),
    [
        ("verify", "checksum_mismatch", "verify: checksum mismatch"),
        ("health", "worker_not_healthy", "health: worker not healthy"),
    ],
)
async def test_update_result_failure_is_humanized_and_keeps_requested_tree(
    client, stage, error, humanized
):
    user_id, _ = await _signup(client, "ws-daemon-update-result@example.com")
    host_id = await _create_host(user_id)
    requested_tree = "b" * 40
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        host.update_state = "failed"
        host.update_tree = requested_tree
        host.update_error = "old error"
        await session.commit()

    ws = FakeDaemonWebSocket()
    ws.queue_text(
        {
            "type": "register",
            "daemon_tree": "a" * 40,
            "self_update": True,
        }
    )
    ws.queue_text(
        {
            "type": "daemon.update_result",
            "request_id": "request-1",
            "ok": False,
            "tree": requested_tree,
            "stage": stage,
            "error": error,
        }
    )
    ws.queue_disconnect()

    await daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]

    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.update_state == "failed"
        assert host.update_tree == requested_tree
        assert host.update_error == humanized


async def test_successful_update_result_stays_updating_until_reregister(client):
    user_id, _ = await _signup(client, "ws-daemon-update-result-ok@example.com")
    host_id = await _create_host(user_id)
    ws = FakeDaemonWebSocket()
    ws.queue_text({"type": "register", "daemon_tree": "a" * 40, "self_update": True})
    task = asyncio.create_task(
        daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]
    )
    await _wait_until(lambda: any(frame.get("type") == "registered" for frame in _sent_json(ws)))
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        host.update_state = "updating"
        host.update_tree = "b" * 40
        host.update_requested_at = datetime.now(UTC)
        await session.commit()

    ws.queue_text(
        {
            "type": "daemon.update_result",
            "request_id": "request-ok",
            "ok": True,
            "tree": "b" * 40,
            "stage": None,
            "error": None,
        }
    )
    ws.queue_disconnect()
    await task

    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.update_state == "updating"
        assert host.update_tree == "b" * 40


async def test_register_reconciles_success_and_previous_binary_failure(client):
    user_id, _ = await _signup(client, "ws-daemon-update-reconcile@example.com")
    host_id = await _create_host(user_id)
    expected_tree = "b" * 40

    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        host.update_state = "updating"
        host.update_tree = expected_tree
        host.update_error = "old"
        host.update_requested_at = datetime.now(UTC)
        await session.commit()
    updated = FakeDaemonWebSocket()
    updated.queue_text({"type": "register", "daemon_tree": expected_tree, "self_update": True})
    updated.queue_disconnect()
    await daemon_ws(updated, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]

    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.update_state is None
        assert host.update_tree is None
        assert host.update_error is None
        assert host.update_requested_at is None
        host.update_state = "updating"
        host.update_tree = expected_tree
        host.update_requested_at = datetime.now(UTC)
        await session.commit()

    previous = FakeDaemonWebSocket()
    previous.queue_text({"type": "register", "daemon_tree": "a" * 40, "self_update": True})
    previous.queue_disconnect()
    await daemon_ws(previous, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]

    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.update_state == "failed"
        assert host.update_tree == expected_tree
        assert host.update_error == "restarted on the previous binary"


async def test_register_ratchets_account_chain_support(client):
    """Mesh R9: chain capability is set by an advertising daemon and never
    lowered by an older build reconnecting — the per-host endorsement path
    stays retired once retired."""

    user_id, _ = await _signup(client, "ws-chain-ratchet@example.com")
    host_id = await _create_host(user_id)

    async def register(payload: dict) -> None:
        ws = FakeDaemonWebSocket()
        ws.queue_text(payload)
        ws.queue_disconnect()
        await daemon_ws(ws, token=auth.issue_daemon_token(host_id, user_id))  # type: ignore[arg-type]

    sm = get_sessionmaker()

    await register({"type": "register", "host_name": "new-spawnd", "version": "0.2.0"})
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None and host.supports_account_chains is False

    await register(
        {
            "type": "register",
            "host_name": "new-spawnd",
            "version": "0.2.0",
            "supports_account_chains": True,
        }
    )
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None and host.supports_account_chains is True

    # An old build (no flag) reconnects: the ratchet holds.
    await register({"type": "register", "host_name": "old-spawnd", "version": "0.1.0"})
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None and host.supports_account_chains is True


async def test_daemon_ws_register_resyncs_only_owned_existing_agents_while_connected(client):
    user_id, _ = await _signup(client, "ws-daemon-resync@example.com")
    host_id = await _create_host(user_id, name="primary")
    other_host_id = await _create_host(user_id, name="other")
    pty_id = await _create_session_row(user_id, host_id, name="kept")
    other_pty_id = await _create_session_row(user_id, other_host_id, name="ignored")
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
            "existing_sessions": [pty_id, other_pty_id, "00000000-0000-4000-8000-999999999999"],
        }
    )

    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(ws)))
    daemon = get_broker().get_daemon_for_host(host_id)
    assert daemon is not None
    assert get_broker().get_daemon_for_session(pty_id) is daemon
    assert get_broker().get_daemon_for_session(other_pty_id) is None

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
    assert get_broker().get_daemon_for_session(pty_id) is None


async def test_pending_daemon_cannot_evict_or_reroute_accepted_owner(client):
    user_id, _ = await _signup(client, "ws-daemon-pending-owner@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    broker = get_broker()
    accepted = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    accepted_task = asyncio.create_task(daemon_ws(accepted, token=None))  # type: ignore[arg-type]
    accepted.queue_text({"type": "register", "version": "accepted", "existing_sessions": [pty_id]})
    await _wait_until(
        lambda: any(item.get("type") == "registered" for item in _sent_json(accepted))
    )
    accepted_conn = broker.get_daemon_for_host(host_id)
    assert accepted_conn is not None
    assert broker.get_daemon_for_session(pty_id) is accepted_conn

    pending = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    pending_task = asyncio.create_task(daemon_ws(pending, token=None))  # type: ignore[arg-type]
    await _wait_until(lambda: pending.accepted_subprotocol == "spawn.control.v3")

    # Before register, neither activity nor lifecycle frames may attach
    # this authenticated-but-pending socket or mutate accepted agent routing.
    pending.queue_text({"type": "session.activity", "session_id": pty_id})
    pending.queue_text({"type": "session.exit", "session_id": pty_id, "exit_code": 9})
    await _wait_until(lambda: pending.receive_count >= 2)
    assert broker.get_daemon_for_host(host_id) is accepted_conn
    assert broker.get_daemon_for_session(pty_id) is accepted_conn
    assert accepted.close_calls == []

    sm = get_sessionmaker()
    async with sm() as session:
        agent = await session.get(Session, pty_id)
        assert agent is not None
        assert agent.status == "running"

    pending.queue_disconnect()
    await asyncio.wait_for(pending_task, timeout=1)
    assert broker.get_daemon_for_host(host_id) is accepted_conn
    assert broker.get_daemon_for_session(pty_id) is accepted_conn
    assert accepted.close_calls == []

    accepted.queue_text({"type": "host.heartbeat"})
    await _wait_until(
        lambda: any(item.get("type") == "host.heartbeat" for item in _sent_json(accepted))
    )
    accepted.queue_disconnect()
    await asyncio.wait_for(accepted_task, timeout=1)


async def test_stalled_generation_reservation_keeps_active_owner_and_routes(client, monkeypatch):
    import spawn_server.ws.daemon as daemon_mod

    user_id, _ = await _signup(client, "ws-daemon-stalled-reservation@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)
    broker = get_broker()

    accepted = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    accepted_task = asyncio.create_task(daemon_ws(accepted, token=None))  # type: ignore[arg-type]
    accepted.queue_text({"type": "register", "version": "accepted", "existing_sessions": [pty_id]})
    await _wait_until(
        lambda: any(item.get("type") == "registered" for item in _sent_json(accepted))
    )
    accepted_conn = broker.get_daemon_for_host(host_id)
    assert accepted_conn is not None
    accepted_value = encode_host_presence_owner(
        HostPresenceOwner(accepted_conn.id, accepted_conn.host_generation)
    )

    original_claim = daemon_mod._claim_host_signal_presence
    reserved = asyncio.Event()
    release = asyncio.Event()

    async def claim_then_stall(conn):
        result = await original_claim(conn)
        reserved.set()
        await release.wait()
        return result

    monkeypatch.setattr(daemon_mod, "_claim_host_signal_presence", claim_then_stall)
    pending = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    pending_task = asyncio.create_task(daemon_ws(pending, token=None))  # type: ignore[arg-type]
    pending.queue_text({"type": "register", "version": "pending"})
    await asyncio.wait_for(reserved.wait(), timeout=1)

    assert broker.get_daemon_for_host(host_id) is accepted_conn
    assert broker.get_daemon_for_session(pty_id) is accepted_conn
    assert await get_backend().get_ephemeral(host_presence_key(host_id)) == accepted_value
    assert await get_backend().get_ephemeral(host_pending_presence_key(host_id)) is not None
    accepted.queue_text({"type": "host.heartbeat"})
    await _wait_until(
        lambda: any(item.get("type") == "host.heartbeat" for item in _sent_json(accepted))
    )

    pending_task.cancel()
    await asyncio.gather(pending_task, return_exceptions=True)
    assert await get_backend().get_ephemeral(host_presence_key(host_id)) == accepted_value
    assert await get_backend().get_ephemeral(host_pending_presence_key(host_id)) is None
    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_connection_id == accepted_conn.id
        assert host.daemon_generation == accepted_conn.host_generation
        assert host.daemon_pending_connection_id is None
        assert host.daemon_pending_generation is None

    release.set()
    accepted.queue_disconnect()
    await asyncio.wait_for(accepted_task, timeout=1)


async def test_corrupt_cache_rejects_pending_owner_without_evicting_accepted_routes(client):
    user_id, _ = await _signup(client, "ws-daemon-corrupt-pending@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    broker = get_broker()
    accepted = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    accepted_task = asyncio.create_task(daemon_ws(accepted, token=None))  # type: ignore[arg-type]
    accepted.queue_text({"type": "register", "version": "accepted", "existing_sessions": [pty_id]})
    await _wait_until(
        lambda: any(item.get("type") == "registered" for item in _sent_json(accepted))
    )
    accepted_conn = broker.get_daemon_for_host(host_id)
    assert accepted_conn is not None
    assert accepted_conn.host_generation is not None

    backend = get_backend()
    await backend.set_ephemeral(
        host_presence_key(host_id),
        b"corrupt",
        ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
    )
    pending = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    pending_task = asyncio.create_task(daemon_ws(pending, token=None))  # type: ignore[arg-type]
    pending.queue_text({"type": "register", "version": "rejected"})
    await asyncio.wait_for(pending_task, timeout=1)

    assert pending.close_calls == [(4004, "fencing consistency failure")]
    assert accepted.close_calls == []
    assert broker.get_daemon_for_host(host_id) is accepted_conn
    assert broker.get_daemon_for_session(pty_id) is accepted_conn
    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "online"
        assert host.version == "accepted"
        assert host.daemon_connection_id == accepted_conn.id
        assert host.daemon_generation == accepted_conn.host_generation

    await backend.set_ephemeral(
        host_presence_key(host_id),
        encode_host_presence_owner(
            HostPresenceOwner(accepted_conn.id, accepted_conn.host_generation)
        ),
        ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
    )
    accepted.queue_text({"type": "host.heartbeat"})
    await _wait_until(
        lambda: any(item.get("type") == "host.heartbeat" for item in _sent_json(accepted))
    )
    accepted.queue_disconnect()
    await asyncio.wait_for(accepted_task, timeout=1)


async def test_activation_commit_failure_cas_restores_accepted_owner(client, monkeypatch):
    from sqlalchemy.ext.asyncio import AsyncSession

    import spawn_server.ws.daemon as daemon_mod

    user_id, _ = await _signup(client, "ws-daemon-activation-rollback@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)
    broker = get_broker()

    accepted = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    accepted_task = asyncio.create_task(daemon_ws(accepted, token=None))  # type: ignore[arg-type]
    accepted.queue_text({"type": "register", "version": "accepted", "existing_sessions": [pty_id]})
    await _wait_until(
        lambda: any(item.get("type") == "registered" for item in _sent_json(accepted))
    )
    accepted_conn = broker.get_daemon_for_host(host_id)
    assert accepted_conn is not None
    assert accepted_conn.host_generation is not None
    accepted_value = encode_host_presence_owner(
        HostPresenceOwner(accepted_conn.id, accepted_conn.host_generation)
    )

    original_prepare = daemon_mod._prepare_host_activation
    original_commit = AsyncSession.commit

    async def prepare_then_fail_commit(session, *args, **kwargs):
        prepared = await original_prepare(session, *args, **kwargs)
        if prepared:
            session.info["fail_activation_commit"] = True
        return prepared

    async def fail_selected_commit(session):
        if session.info.pop("fail_activation_commit", False):
            raise RuntimeError("injected activation commit failure")
        await original_commit(session)

    monkeypatch.setattr(daemon_mod, "_prepare_host_activation", prepare_then_fail_commit)
    monkeypatch.setattr(AsyncSession, "commit", fail_selected_commit)

    pending = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    pending_task = asyncio.create_task(daemon_ws(pending, token=None))  # type: ignore[arg-type]
    pending.queue_text({"type": "register", "version": "must-rollback"})
    await asyncio.wait_for(pending_task, timeout=1)

    assert broker.get_daemon_for_host(host_id) is accepted_conn
    assert broker.get_daemon_for_session(pty_id) is accepted_conn
    assert accepted.close_calls == []
    assert await get_backend().get_ephemeral(host_presence_key(host_id)) == accepted_value
    assert await get_backend().get_ephemeral(host_pending_presence_key(host_id)) is None
    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_connection_id == accepted_conn.id
        assert host.daemon_generation == accepted_conn.host_generation
        assert host.daemon_pending_connection_id is None
        assert host.daemon_pending_generation is None

    accepted.queue_text({"type": "host.heartbeat"})
    await _wait_until(
        lambda: any(item.get("type") == "host.heartbeat" for item in _sent_json(accepted))
    )
    accepted.queue_disconnect()
    await asyncio.wait_for(accepted_task, timeout=1)


async def test_activation_lost_ack_after_commit_reconciles_new_owner(client, monkeypatch):
    import spawn_server.ws.daemon as daemon_mod

    user_id, _ = await _signup(client, "ws-daemon-activation-lost-ack@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]
    old.queue_text({"type": "register", "version": "old"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(old)))

    original_attempt = daemon_mod._attempt_host_activation

    async def commit_then_lose_ack(*args, **kwargs):
        await original_attempt(*args, **kwargs)
        raise RuntimeError("injected lost activation acknowledgement")

    monkeypatch.setattr(daemon_mod, "_attempt_host_activation", commit_then_lose_ack)
    new = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    new_task = asyncio.create_task(daemon_ws(new, token=None))  # type: ignore[arg-type]
    new.queue_text({"type": "register", "version": "new"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(new)))

    new_conn = get_broker().get_daemon_for_host(host_id)
    assert new_conn is not None
    assert new_conn.host_generation == 2
    owner = decode_host_presence_owner(
        await get_backend().get_ephemeral(host_presence_key(host_id))
    )
    assert owner == HostPresenceOwner(new_conn.id, 2)
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_connection_id == new_conn.id
        assert host.daemon_generation == 2

    await asyncio.wait_for(old_task, timeout=1)
    new.queue_disconnect()
    await asyncio.wait_for(new_task, timeout=1)


async def test_registration_repairs_db_b_redis_a_with_successor_c(client):
    user_id, _ = await _signup(client, "ws-daemon-db-b-redis-a@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    owner_a = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    owner_a_task = asyncio.create_task(daemon_ws(owner_a, token=None))  # type: ignore[arg-type]
    owner_a.queue_text({"type": "register", "version": "owner-a"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(owner_a)))
    conn_a = get_broker().get_daemon_for_host(host_id)
    assert conn_a is not None and conn_a.host_generation == 1
    value_a = encode_host_presence_owner(HostPresenceOwner(conn_a.id, 1))

    # Simulate B crashing after its durable commit and before Redis promotion.
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        host.daemon_connection_id = "b" * 32
        host.daemon_generation = 2
        host.daemon_generation_counter = 2
        host.daemon_pending_connection_id = None
        host.daemon_pending_generation = None
        await session.commit()
    assert await get_backend().get_ephemeral(host_presence_key(host_id)) == value_a

    owner_c = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    owner_c_task = asyncio.create_task(daemon_ws(owner_c, token=None))  # type: ignore[arg-type]
    owner_c.queue_text({"type": "register", "version": "owner-c"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(owner_c)))
    conn_c = get_broker().get_daemon_for_host(host_id)
    assert conn_c is not None and conn_c.host_generation == 3
    assert decode_host_presence_owner(
        await get_backend().get_ephemeral(host_presence_key(host_id))
    ) == HostPresenceOwner(conn_c.id, 3)
    assert await get_backend().get_ephemeral(host_pending_presence_key(host_id)) is None
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_connection_id == conn_c.id
        assert host.daemon_generation == 3

    owner_a.queue_disconnect()
    await asyncio.wait_for(owner_a_task, timeout=1)
    owner_c.queue_disconnect()
    await asyncio.wait_for(owner_c_task, timeout=1)


async def test_delayed_c_recovery_cannot_overwrite_successor_d(client, monkeypatch):
    user_id, _ = await _signup(client, "ws-daemon-delayed-c-successor-d@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    owner_a = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    owner_a_task = asyncio.create_task(daemon_ws(owner_a, token=None))  # type: ignore[arg-type]
    owner_a.queue_text({"type": "register", "version": "owner-a"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(owner_a)))
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        host.daemon_connection_id = "b" * 32
        host.daemon_generation = 2
        host.daemon_generation_counter = 2
        host.daemon_pending_connection_id = None
        host.daemon_pending_generation = None
        await session.commit()

    backend = get_backend()
    original_activate = backend.activate_ephemeral_if_newer
    c_committed = asyncio.Event()
    release_c = asyncio.Event()

    async def delay_c_promotion(*args, generation, **kwargs):
        if generation == 3 and not c_committed.is_set():
            c_committed.set()
            await release_c.wait()
        return await original_activate(*args, generation=generation, **kwargs)

    monkeypatch.setattr(backend, "activate_ephemeral_if_newer", delay_c_promotion)
    owner_c = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    owner_c_task = asyncio.create_task(daemon_ws(owner_c, token=None))  # type: ignore[arg-type]
    owner_c.queue_text({"type": "register", "version": "owner-c"})
    await asyncio.wait_for(c_committed.wait(), timeout=1)

    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_generation == 3
        assert host.daemon_connection_id is not None
    pending_c = decode_host_presence_owner(
        await backend.get_ephemeral(host_pending_presence_key(host_id))
    )
    assert pending_c is not None and pending_c.generation == 3

    owner_d = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    owner_d_task = asyncio.create_task(daemon_ws(owner_d, token=None))  # type: ignore[arg-type]
    owner_d.queue_text({"type": "register", "version": "owner-d"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(owner_d)))
    conn_d = get_broker().get_daemon_for_host(host_id)
    assert conn_d is not None and conn_d.host_generation == 4

    release_c.set()
    await asyncio.wait_for(owner_c_task, timeout=1)
    assert owner_c.closed == (4000, "superseded")
    assert decode_host_presence_owner(
        await backend.get_ephemeral(host_presence_key(host_id))
    ) == HostPresenceOwner(conn_d.id, 4)
    assert await backend.get_ephemeral(host_pending_presence_key(host_id)) is None
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_connection_id == conn_d.id
        assert host.daemon_generation == 4

    owner_a.queue_disconnect()
    await asyncio.wait_for(owner_a_task, timeout=1)
    owner_d.queue_disconnect()
    await asyncio.wait_for(owner_d_task, timeout=1)


async def test_activation_cancellation_awaits_cleanup_and_restores_predecessor(client, monkeypatch):
    import spawn_server.ws.daemon as daemon_mod

    user_id, _ = await _signup(client, "ws-daemon-activation-cancel@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]
    old.queue_text({"type": "register", "version": "old"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(old)))
    old_conn = get_broker().get_daemon_for_host(host_id)
    assert old_conn is not None
    old_value = encode_host_presence_owner(HostPresenceOwner(old_conn.id, old_conn.host_generation))

    attempt_started = asyncio.Event()
    attempt_cleaned = asyncio.Event()

    async def hang_activation(*args, **kwargs):
        attempt_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            attempt_cleaned.set()

    monkeypatch.setattr(daemon_mod, "_attempt_host_activation", hang_activation)
    pending = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    pending_task = asyncio.create_task(daemon_ws(pending, token=None))  # type: ignore[arg-type]
    pending.queue_text({"type": "register", "version": "cancelled"})
    await asyncio.wait_for(attempt_started.wait(), timeout=1)

    pending_task.cancel()
    result = await asyncio.gather(pending_task, return_exceptions=True)
    assert isinstance(result[0], asyncio.CancelledError)
    assert attempt_cleaned.is_set()
    assert await get_backend().get_ephemeral(host_presence_key(host_id)) == old_value
    assert await get_backend().get_ephemeral(host_pending_presence_key(host_id)) is None
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_connection_id == old_conn.id
        assert host.daemon_generation == old_conn.host_generation
        assert host.daemon_pending_connection_id is None
        assert host.daemon_pending_generation is None

    old.queue_disconnect()
    await asyncio.wait_for(old_task, timeout=1)


async def test_activation_deadline_cancels_attempt_and_restores_predecessor(client, monkeypatch):
    import spawn_server.ws.daemon as daemon_mod

    user_id, _ = await _signup(client, "ws-daemon-activation-deadline@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]
    old.queue_text({"type": "register", "version": "old"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(old)))
    old_conn = get_broker().get_daemon_for_host(host_id)
    assert old_conn is not None
    old_value = encode_host_presence_owner(HostPresenceOwner(old_conn.id, old_conn.host_generation))

    attempt_cleaned = asyncio.Event()

    async def hang_activation(*args, **kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            attempt_cleaned.set()

    monkeypatch.setattr(daemon_mod, "_attempt_host_activation", hang_activation)
    monkeypatch.setattr(daemon_mod, "HOST_ACTIVATION_DEADLINE_SECONDS", 0.01)
    pending = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    pending_task = asyncio.create_task(daemon_ws(pending, token=None))  # type: ignore[arg-type]
    pending.queue_text({"type": "register", "version": "timed-out"})
    await asyncio.wait_for(pending_task, timeout=1)

    assert attempt_cleaned.is_set()
    assert pending.close_calls == [(4004, "fencing consistency failure")]
    assert await get_backend().get_ephemeral(host_presence_key(host_id)) == old_value
    assert await get_backend().get_ephemeral(host_pending_presence_key(host_id)) is None
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_connection_id == old_conn.id
        assert host.daemon_generation == old_conn.host_generation
        assert host.daemon_pending_connection_id is None
        assert host.daemon_pending_generation is None

    old.queue_disconnect()
    await asyncio.wait_for(old_task, timeout=1)


async def test_generation_max_rejects_pending_owner_without_evicting_accepted_routes(client):
    user_id, _ = await _signup(client, "ws-daemon-max-pending@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    broker = get_broker()
    accepted = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    accepted_task = asyncio.create_task(daemon_ws(accepted, token=None))  # type: ignore[arg-type]
    accepted.queue_text({"type": "register", "version": "accepted", "existing_sessions": [pty_id]})
    await _wait_until(
        lambda: any(item.get("type") == "registered" for item in _sent_json(accepted))
    )
    accepted_conn = broker.get_daemon_for_host(host_id)
    assert accepted_conn is not None

    accepted_conn.host_generation = MAX_SAFE_FENCING_GENERATION
    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        host.daemon_generation = MAX_SAFE_FENCING_GENERATION
        host.daemon_generation_counter = MAX_SAFE_FENCING_GENERATION
        await session.commit()
    await get_backend().set_ephemeral(
        host_presence_key(host_id),
        encode_host_presence_owner(
            HostPresenceOwner(accepted_conn.id, MAX_SAFE_FENCING_GENERATION)
        ),
        ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
    )
    assert await broker.accept_daemon_owner(accepted_conn, MAX_SAFE_FENCING_GENERATION)

    pending = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    pending_task = asyncio.create_task(daemon_ws(pending, token=None))  # type: ignore[arg-type]
    pending.queue_text({"type": "register", "version": "rejected"})
    await asyncio.wait_for(pending_task, timeout=1)

    assert pending.close_calls == [(4004, "fencing consistency failure")]
    assert accepted.close_calls == []
    assert broker.get_daemon_for_host(host_id) is accepted_conn
    assert broker.get_daemon_for_session(pty_id) is accepted_conn
    accepted.queue_text({"type": "host.heartbeat"})
    await _wait_until(
        lambda: any(item.get("type") == "host.heartbeat" for item in _sent_json(accepted))
    )
    accepted.queue_disconnect()
    await asyncio.wait_for(accepted_task, timeout=1)


async def test_durable_generation_allocator_fails_closed_at_redis_safe_maximum(client):
    user_id, _ = await _signup(client, "ws-daemon-generation-maximum@example.com")
    host_id = await _create_host(user_id)
    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        host.daemon_generation_counter = MAX_SAFE_FENCING_GENERATION - 1
        await session.commit()

    async with sm() as session:
        generation = await _allocate_host_generation(session, host_id, "a" * 32)
    assert generation == MAX_SAFE_FENCING_GENERATION
    async with sm() as session:
        assert await _allocate_host_generation(session, host_id, "b" * 32) is None
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_connection_id is None
        assert host.daemon_generation == 0
        assert host.daemon_pending_connection_id == "a" * 32
        assert host.daemon_pending_generation == MAX_SAFE_FENCING_GENERATION
        assert host.daemon_generation_counter == MAX_SAFE_FENCING_GENERATION


async def test_distributed_daemon_supersession_cannot_reclaim_presence_or_mark_host_offline(client):
    user_id, _ = await _signup(client, "ws-daemon-superseded@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]
    old.queue_text({"type": "register", "version": "old", "existing_sessions": [pty_id]})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(old)))
    old_conn = get_broker().get_daemon_for_host(host_id)
    assert old_conn is not None
    assert get_broker().get_daemon_for_session(pty_id) is old_conn

    new = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    new_task = asyncio.create_task(daemon_ws(new, token=None))  # type: ignore[arg-type]
    new.queue_text({"type": "register", "version": "new", "existing_sessions": [pty_id]})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(new)))

    # The atomic claim publishes an active revocation; no heartbeat grace
    # interval is needed to fence the old worker.
    await asyncio.wait_for(old_task, timeout=1)
    assert old.closed == (4000, "superseded")
    assert old.close_calls == [(4000, "superseded")]
    new_conn = get_broker().get_daemon_for_host(host_id)
    assert new_conn is not None
    assert new_conn is not old_conn
    assert get_broker().get_daemon_for_session(pty_id) is new_conn
    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "online"
        assert host.version == "new"
        assert host.daemon_connection_id == new_conn.id
        assert host.last_disconnect_reason == "superseded"
        assert host.last_disconnect_at is not None

    new.queue_disconnect()
    await asyncio.wait_for(new_task, timeout=1)
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "offline"
        assert host.daemon_connection_id is None


async def test_redis_loss_cannot_make_an_older_durable_generation_current(client):
    user_id, _ = await _signup(client, "ws-daemon-inverse-claim-race@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]
    old.queue_text({"type": "register", "version": "old"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(old)))
    old_conn = get_broker().get_daemon_for_host(host_id)
    assert old_conn is not None
    assert old_conn.host_generation == 1

    # Losing the volatile cache cannot reset the database allocator. A new
    # accepted owner must still receive a strictly newer durable generation.
    backend = get_backend()
    await backend.shutdown()
    await backend.startup()
    old.queue_text({"type": "host.heartbeat"})
    await _wait_until(lambda: any(item.get("type") == "host.heartbeat" for item in _sent_json(old)))

    new = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    new_task = asyncio.create_task(daemon_ws(new, token=None))  # type: ignore[arg-type]
    new.queue_text({"type": "register", "version": "new"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(new)))
    new_conn = get_broker().get_daemon_for_host(host_id)
    assert new_conn is not None
    assert new_conn.id != old_conn.id
    assert new_conn.host_generation == 2
    redis_owner = decode_host_presence_owner(
        await backend.get_ephemeral(host_presence_key(host_id))
    )
    assert redis_owner is not None
    assert redis_owner.daemon_connection_id == new_conn.id
    assert redis_owner.generation == new_conn.host_generation

    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "online"
        assert host.version == "new"
        assert host.daemon_connection_id == new_conn.id
        assert host.daemon_generation == new_conn.host_generation

    # Lose Redis again while B is the accepted durable owner. Its heartbeat
    # must reclaim the empty routing cache with generation 2, not fence B.
    await backend.shutdown()
    await backend.startup()
    new.queue_text({"type": "host.heartbeat"})
    await _wait_until(lambda: any(item.get("type") == "host.heartbeat" for item in _sent_json(new)))
    redis_owner = decode_host_presence_owner(
        await backend.get_ephemeral(host_presence_key(host_id))
    )
    assert redis_owner is not None
    assert redis_owner.daemon_connection_id == new_conn.id
    assert redis_owner.generation == new_conn.host_generation

    # The in-process backend restart intentionally strands A's old subscriber;
    # its socket was still closed exactly once by local broker acceptance.
    old.queue_disconnect()
    await asyncio.wait_for(old_task, timeout=1)
    assert old.closed == (4000, "superseded")
    assert old.close_calls == [(4000, "superseded")]
    redis_owner = decode_host_presence_owner(
        await backend.get_ephemeral(host_presence_key(host_id))
    )
    assert redis_owner is not None
    assert redis_owner.daemon_connection_id == new_conn.id
    assert redis_owner.generation == new_conn.host_generation
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "online"
        assert host.version == "new"
        assert host.daemon_connection_id == new_conn.id
        assert host.daemon_generation == new_conn.host_generation

    new.queue_disconnect()
    await asyncio.wait_for(new_task, timeout=1)
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "offline"
        assert host.daemon_connection_id is None
        assert host.daemon_generation == new_conn.host_generation


async def test_delayed_resync_cannot_overwrite_new_broker_owner(client, monkeypatch):
    user_id, _ = await _signup(client, "ws-daemon-delayed-resync@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    broker = get_broker()
    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]

    original_attach = broker.attach_session_to_daemon
    old_waiting_to_attach = asyncio.Event()
    release_old_resync = asyncio.Event()
    old_conn: DaemonConn | None = None

    async def attach_with_resync_barrier(
        claimed_pty_id: str,
        conn: DaemonConn,
        *,
        expected_host_generation: int | None = None,
    ) -> bool:
        nonlocal old_conn
        if old_conn is None and claimed_pty_id == pty_id:
            old_conn = conn
            old_waiting_to_attach.set()
            await release_old_resync.wait()
        return await original_attach(
            claimed_pty_id,
            conn,
            expected_host_generation=expected_host_generation,
        )

    monkeypatch.setattr(broker, "attach_session_to_daemon", attach_with_resync_barrier)
    old.queue_text({"type": "register", "version": "old", "existing_sessions": [pty_id]})
    await asyncio.wait_for(old_waiting_to_attach.wait(), timeout=1)
    assert old_conn is not None

    new = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    new_task = asyncio.create_task(daemon_ws(new, token=None))  # type: ignore[arg-type]
    new.queue_text({"type": "register", "version": "new", "existing_sessions": [pty_id]})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(new)))
    new_conn = broker.get_daemon_for_host(host_id)
    assert new_conn is not None
    assert new_conn is not old_conn
    assert broker.get_daemon_for_session(pty_id) is new_conn

    release_old_resync.set()
    await asyncio.wait_for(old_task, timeout=1)
    assert old.closed == (4000, "superseded")
    assert broker.get_daemon_for_host(host_id) is new_conn
    assert broker.get_daemon_for_session(pty_id) is new_conn

    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "online"
        assert host.version == "new"
        assert host.daemon_connection_id == new_conn.id
        assert host.daemon_generation == new_conn.host_generation

    new.queue_text({"type": "host.heartbeat"})
    await _wait_until(lambda: any(item.get("type") == "host.heartbeat" for item in _sent_json(new)))
    new.queue_disconnect()
    await asyncio.wait_for(new_task, timeout=1)


async def test_dequeued_stale_exit_cannot_mutate_or_detach_replacement(client, monkeypatch):
    from sqlalchemy.ext.asyncio import AsyncSession

    user_id, _ = await _signup(client, "ws-daemon-stale-exit@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)
    broker = get_broker()

    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]
    old.queue_text({"type": "register", "existing_sessions": [pty_id]})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(old)))

    original_get = AsyncSession.get
    old_exit_dequeued = asyncio.Event()
    release_old_exit = asyncio.Event()

    async def get_with_exit_barrier(session, entity, ident, *args, **kwargs):
        value = await original_get(session, entity, ident, *args, **kwargs)
        if entity is Session and ident == pty_id and not old_exit_dequeued.is_set():
            old_exit_dequeued.set()
            await release_old_exit.wait()
        return value

    monkeypatch.setattr(AsyncSession, "get", get_with_exit_barrier)
    old.queue_text({"type": "session.exit", "session_id": pty_id, "exit_code": 17})
    await asyncio.wait_for(old_exit_dequeued.wait(), timeout=1)

    new = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    new_task = asyncio.create_task(daemon_ws(new, token=None))  # type: ignore[arg-type]
    new.queue_text({"type": "register", "existing_sessions": [pty_id]})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(new)))
    new_conn = broker.get_daemon_for_host(host_id)
    assert new_conn is not None
    assert broker.get_daemon_for_session(pty_id) is new_conn

    release_old_exit.set()
    await asyncio.wait_for(old_task, timeout=1)
    async with get_sessionmaker()() as db:
        pty = await db.get(Session, pty_id)
        assert pty is not None
        assert pty.status == "running"
        assert pty.exit_code is None
    assert broker.get_daemon_for_session(pty_id) is new_conn

    new.queue_disconnect()
    await asyncio.wait_for(new_task, timeout=1)


async def test_started_publish_failure_fences_without_broker_deadlock(client, monkeypatch):
    user_id, _ = await _signup(client, "ws-daemon-publish-fence@example.com")
    host_id = await _create_host(user_id, name="publish-failure")
    other_host_id = await _create_host(user_id, name="broker-stays-live")
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)
    other_token = auth.issue_daemon_token(other_host_id, user_id)

    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(daemon_ws(ws, token=None))  # type: ignore[arg-type]
    ws.queue_text({"type": "register"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(ws)))

    other = FakeDaemonWebSocket(authorization=f"Bearer {other_token}")
    other_task = asyncio.create_task(daemon_ws(other, token=None))  # type: ignore[arg-type]
    other.queue_text({"type": "register"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(other)))
    other_conn = get_broker().get_daemon_for_host(other_host_id)
    assert other_conn is not None and other_conn.host_generation is not None

    backend = get_backend()
    original_publish = backend.publish_if_host_owner

    async def fail_agent_event(
        active_key,
        pending_key,
        expected,
        *,
        generation,
        channel,
        payload,
    ):
        if channel == f"spawn:session:{pty_id}:events":
            return False
        return await original_publish(
            active_key,
            pending_key,
            expected,
            generation=generation,
            channel=channel,
            payload=payload,
        )

    monkeypatch.setattr(backend, "publish_if_host_owner", fail_agent_event)
    ws.queue_text({"type": "session.started", "session_id": pty_id})
    await asyncio.wait_for(task, timeout=1)
    assert ws.closed == (4004, "fencing consistency failure")

    assert await asyncio.wait_for(
        get_broker().is_accepted_daemon_owner(other_conn, other_conn.host_generation),
        timeout=0.2,
    )
    other.queue_text({"type": "host.heartbeat"})
    await _wait_until(
        lambda: any(item.get("type") == "host.heartbeat" for item in _sent_json(other))
    )
    other.queue_disconnect()
    await asyncio.wait_for(other_task, timeout=1)


@pytest.mark.parametrize(
    ("frame", "reason", "secret"),
    [
        (
            {"type": "agent.uploaded", "path": "/secret/daemon-upload-path"},
            "agent upload acknowledgements belong on spawn.ctl",
            "/secret/daemon-upload-path",
        ),
        (
            {
                "type": "error",
                "code": "upload_failed",
                "message": "secret daemon upload failure",
            },
            "agent upload errors belong on spawn.ctl",
            "secret daemon upload failure",
        ),
    ],
)
async def test_daemon_upload_frames_fail_closed_without_logging_content(
    client, caplog, frame, reason, secret
):
    slug = frame["type"].replace(".", "-")
    user_id, _ = await _signup(client, f"ws-daemon-retired-{slug}@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    ws.queue_text({"type": "register", "existing_sessions": [pty_id]})
    ws.queue_text({**frame, "session_id": pty_id})
    await daemon_ws(ws, token=None)  # type: ignore[arg-type]
    assert ws.closed == (4002, reason)
    assert secret not in caplog.text


async def test_fence_closes_before_stalled_rtc_revocation_and_keeps_broker_usable(app):
    class StalledBrowserWebSocket(FakeDaemonWebSocket):
        async def send_text(self, value: str) -> None:
            await asyncio.Event().wait()

    broker = get_broker()
    stale_ws = FakeDaemonWebSocket()
    stale = DaemonConn(
        host_id="stale-rtc-host",
        user_id="owner",
        websocket=stale_ws,  # type: ignore[arg-type]
        host_generation=1,
    )
    assert await broker.accept_daemon_owner(stale, 1)
    browser = HostBrowserConn(
        "owner",
        stale.host_id,
        StalledBrowserWebSocket(),  # type: ignore[arg-type]
    )
    assert await broker.register_rtc_session(
        "stalled-revocation",
        browser,
        daemon=stale,
        scope_type="host",
        scope_id=stale.host_id,
        protocol="spawn.host.ctl",
        protocol_version=1,
        ttl_seconds=60,
    )

    fence = asyncio.create_task(_fence_superseded_daemon(stale))
    await _wait_until(lambda: stale_ws.closed == (4000, "superseded"), timeout=0.2)

    other = DaemonConn(
        host_id="healthy-host",
        user_id="owner",
        websocket=FakeDaemonWebSocket(),  # type: ignore[arg-type]
        host_generation=1,
    )
    assert await asyncio.wait_for(broker.accept_daemon_owner(other, 1), timeout=0.1)
    assert await asyncio.wait_for(broker.is_accepted_daemon_owner(other, 1), timeout=0.1)

    fence.cancel()
    await asyncio.gather(fence, return_exceptions=True)
    await broker.unregister_rtc_session("stalled-revocation", browser)
    await broker.unregister_daemon(stale)
    await broker.unregister_daemon(other)


async def test_stalled_post_commit_publish_does_not_block_host_takeover(client, monkeypatch):
    import spawn_server.ws.daemon as daemon_mod

    user_id, _ = await _signup(client, "ws-daemon-stalled-publish@example.com")
    host_id = await _create_host(user_id, name="stalled-publish")
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]
    old.queue_text({"type": "register"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(old)))

    publish_started = asyncio.Event()
    release_publish = asyncio.Event()

    async def stall_publish(conn, aid, payload):
        assert aid == pty_id
        publish_started.set()
        await release_publish.wait()
        return False

    monkeypatch.setattr(daemon_mod, "_publish_session_event_if_owner", stall_publish)
    old.queue_text({"type": "session.started", "session_id": pty_id})
    await asyncio.wait_for(publish_started.wait(), timeout=1)

    # The lifecycle mutation committed before the external publish began. A
    # replacement must still acquire the Host row and register immediately.
    new = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    new_task = asyncio.create_task(daemon_ws(new, token=None))  # type: ignore[arg-type]
    new.queue_text({"type": "register", "existing_sessions": [pty_id]})
    await asyncio.wait_for(
        _wait_until(
            lambda: any(item.get("type") == "registered" for item in _sent_json(new)),
            timeout=1,
        ),
        timeout=1.1,
    )
    new_conn = get_broker().get_daemon_for_host(host_id)
    assert new_conn is not None and new_conn.host_generation == 2

    release_publish.set()
    await asyncio.wait_for(old_task, timeout=1)
    assert old.closed == (4000, "superseded")
    assert get_broker().get_daemon_for_session(pty_id) is new_conn

    new.queue_disconnect()
    await asyncio.wait_for(new_task, timeout=1)


async def test_old_cleanup_cannot_overwrite_replacement_database_ownership(client, monkeypatch):
    user_id, _ = await _signup(client, "ws-daemon-cleanup-race@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]
    old.queue_text({"type": "register", "version": "old"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(old)))
    old_conn = get_broker().get_daemon_for_host(host_id)
    assert old_conn is not None

    backend = get_backend()
    original_delete = backend.delete_ephemeral_if
    old_deleted_lease = asyncio.Event()
    release_old_cleanup = asyncio.Event()

    async def delete_with_old_cleanup_barrier(key: str, value: bytes) -> bool:
        deleted = await original_delete(key, value)
        owner = decode_host_presence_owner(value)
        if owner is not None and owner.daemon_connection_id == old_conn.id:
            old_deleted_lease.set()
            await release_old_cleanup.wait()
        return deleted

    monkeypatch.setattr(backend, "delete_ephemeral_if", delete_with_old_cleanup_barrier)

    old.queue_disconnect()
    await asyncio.wait_for(old_deleted_lease.wait(), timeout=1)

    # The old active lease is removed before its exact database offline mark.
    # Finish that CAS-guarded cleanup before a no-predecessor activation.
    release_old_cleanup.set()
    await asyncio.wait_for(old_task, timeout=1)

    new = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    new_task = asyncio.create_task(daemon_ws(new, token=None))  # type: ignore[arg-type]
    new.queue_text({"type": "register", "version": "new"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(new)))
    new_conn = get_broker().get_daemon_for_host(host_id)
    assert new_conn is not None
    assert new_conn.id != old_conn.id

    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "online"
        assert host.daemon_connection_id == new_conn.id

    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "online"
        assert host.version == "new"
        assert host.daemon_connection_id == new_conn.id

    new.queue_disconnect()
    await asyncio.wait_for(new_task, timeout=1)
    async with sm() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.status == "offline"
        assert host.daemon_connection_id is None


async def test_daemon_terminal_host_status_frees_the_binding(client):
    """A daemon that reaps or supersedes a device connection says `unavailable`;
    the server must forget the host binding on that word, as it already does
    for a session binding through the browser relay. A browser's shared
    connection never sends `rtc.close`, so nothing else would free it before
    its TTL, and the per-host and per-browser caps would fill with peers only
    the daemon knew were gone."""
    user_id, _ = await _signup(client, "ws-daemon-host-status@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)
    broker = get_broker()

    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(daemon_ws(ws, token=None))  # type: ignore[arg-type]
    ws.queue_text({"type": "register", "version": "rtc-test"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(ws)))
    live_daemon = broker.get_daemon_for_host(host_id)
    assert live_daemon is not None and live_daemon.host_generation is not None
    nonce = "b" * 32
    browser_conn = RedisBrowserConn(
        user_id=user_id,
        host_id=host_id,
        channel=browser_signal_channel(nonce),
        daemon_connection_id=live_daemon.id,
        daemon_generation=live_daemon.host_generation,
        binding_nonce=nonce,
    )
    session_id = "host-binding-reaped"
    assert await broker.register_rtc_session(
        session_id,
        browser_conn,
        daemon=live_daemon,
        scope_type="host",
        scope_id=host_id,
        protocol="spawn.host.ctl",
        protocol_version=2,
        binding_nonce=nonce,
    )
    assert await broker.rtc_session_for(session_id) is not None

    async with get_backend().subscribe_channel(browser_conn.channel) as stream:
        ws.queue_text(
            {
                "type": "rtc.status",
                "session_id": session_id,
                "binding_nonce": nonce,
                "scope_type": "host",
                "scope_id": host_id,
                "protocol": "spawn.host.ctl",
                "protocol_version": 2,
                "status": "unavailable",
                "message": "stayed disconnected",
            }
        )
        dispatch = decode_rtc_signal_dispatch(await asyncio.wait_for(anext(stream), timeout=1))
        assert dispatch is not None
        assert dispatch.signal["status"] == "unavailable"
    for _ in range(100):
        if await broker.rtc_session_for(session_id) is None:
            break
        await asyncio.sleep(0.01)
    assert await broker.rtc_session_for(session_id) is None, (
        "the host binding is freed on the daemon's word"
    )

    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)


async def test_daemon_terminal_status_for_a_forgotten_binding_is_a_no_op(client):
    """A daemon says goodbye for every peer it ever admitted. For a binding the
    server no longer holds — dropped at reconcile, freed on the browser's word,
    expired — that goodbye is nothing to act on and nothing the daemon did
    wrong, so it earns no `invalid_frame`."""
    user_id, _ = await _signup(client, "ws-daemon-forgotten-status@example.com")
    host_id = await _create_host(user_id)
    token = auth.issue_daemon_token(host_id, user_id)

    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(daemon_ws(ws, token=None))  # type: ignore[arg-type]
    ws.queue_text({"type": "register", "version": "rtc-test"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(ws)))
    frame = {
        "type": "rtc.status",
        "session_id": "host-binding-forgotten",
        "binding_nonce": "c" * 32,
        "scope_type": "host",
        "scope_id": host_id,
        "protocol": "spawn.host.ctl",
        "protocol_version": 2,
    }
    ws.queue_text({**frame, "status": "unavailable", "message": "stayed disconnected"})
    # Error frames are rate-limited to one a second: had the goodbye earned
    # one, the error for this frame would be swallowed, and the only error
    # seen would name `rtc.status`.
    ws.queue_text({"type": "no.such.frame"})
    await _wait_until(lambda: any(item.get("type") == "error" for item in _sent_json(ws)))
    assert [item for item in _sent_json(ws) if item.get("type") == "error"] == [
        {"type": "error", "code": "unknown_frame", "frame_type": "no.such.frame"}
    ], "no error for the goodbye"

    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)


async def test_daemon_ws_routes_rtc_signaling_back_to_browser(client):
    user_id, _ = await _signup(client, "ws-daemon-rtc@example.com")
    host_id = await _create_host(user_id)
    pty_id = await _create_session_row(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    broker = get_broker()

    ws = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    task = asyncio.create_task(daemon_ws(ws, token=None))  # type: ignore[arg-type]
    ws.queue_text({"type": "register", "version": "rtc-test"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(ws)))
    live_daemon = get_broker().get_daemon_for_host(host_id)
    assert live_daemon is not None and live_daemon.host_generation is not None
    browser_conn = RedisBrowserConn(
        user_id=user_id,
        host_id=host_id,
        channel=browser_signal_channel("a" * 32),
        daemon_connection_id=live_daemon.id,
        daemon_generation=live_daemon.host_generation,
        binding_nonce="a" * 32,
    )
    assert await broker.register_rtc_session(
        "rtc-daemon-1",
        browser_conn,
        daemon=live_daemon,
        scope_type="session",
        scope_id=pty_id,
        protocol="spawn.pty",
        protocol_version=2,
        binding_nonce="a" * 32,
    )

    expected_signals = [
        {
            "type": "rtc.answer",
            "session_id": "rtc-daemon-1",
            "binding_nonce": "a" * 32,
            "scope_type": "session",
            "scope_id": pty_id,
            "protocol": "spawn.pty",
            "protocol_version": 2,
            "sdp": "v=0\r\n",
        },
        {
            "type": "rtc.candidate",
            "session_id": "rtc-daemon-1",
            "binding_nonce": "a" * 32,
            "scope_type": "session",
            "scope_id": pty_id,
            "protocol": "spawn.pty",
            "protocol_version": 2,
            "candidate": {"candidate": "candidate:1 1 udp 1 127.0.0.1 9 typ host"},
        },
        {
            "type": "rtc.status",
            "session_id": "rtc-daemon-1",
            "binding_nonce": "a" * 32,
            "scope_type": "session",
            "scope_id": pty_id,
            "protocol": "spawn.pty",
            "protocol_version": 2,
            "status": "connected",
            "message": "x" * 300,
        },
    ]
    async with get_backend().subscribe_channel(browser_conn.channel) as stream:
        for expected in expected_signals:
            ws.queue_text(expected)
            dispatch = decode_rtc_signal_dispatch(await asyncio.wait_for(anext(stream), timeout=1))
            assert dispatch is not None
            assert dispatch.host_id == host_id
            assert dispatch.session_connection_id == live_daemon.id
            assert dispatch.session_generation == live_daemon.host_generation
            assert dispatch.dispatch_connection_id == live_daemon.id
            assert dispatch.dispatch_generation == live_daemon.host_generation
            forwarded = {
                **expected,
                "binding_generation": live_daemon.host_generation,
            }
            if forwarded.get("type") == "rtc.status":
                forwarded["message"] = "x" * 256
            assert dispatch.signal == forwarded

        signed_session_id = "018f0f77-86d2-7a8e-9b1c-1f3b847ca2a1"
        assert await broker.register_rtc_session(
            signed_session_id,
            browser_conn,
            daemon=live_daemon,
            scope_type="session",
            scope_id=pty_id,
            protocol="spawn.pty",
            protocol_version=2,
            binding_nonce="a" * 32,
            signed_signal=True,
        )
        answer_wire = _signed_session_answer_wire(signed_session_id, pty_id)
        base_answer = {
            "type": "rtc.answer",
            "session_id": signed_session_id,
            "binding_nonce": "a" * 32,
            "scope_type": "session",
            "scope_id": pty_id,
            "protocol": "spawn.pty",
            "protocol_version": 2,
        }
        # Raw/mixed answers cannot downgrade a binding selected by its signed offer.
        ws.queue_text(base_answer)
        ws.queue_text({**base_answer, "signed_envelope": None})
        ws.queue_text(
            {
                **base_answer,
                "signed_envelope": None,
                "sdp": "v=0\r\nraw downgrade",
            }
        )
        ws.queue_text({**base_answer, "sdp": "v=0\r\nraw downgrade"})
        ws.queue_text(
            {
                **base_answer,
                "sdp": "v=0\r\nraw sibling",
                "signed_envelope": answer_wire,
            }
        )
        await asyncio.sleep(0.02)
        ws.queue_text({**base_answer, "signed_envelope": answer_wire})
        signed_dispatch = decode_rtc_signal_dispatch(
            await asyncio.wait_for(anext(stream), timeout=1)
        )
        assert signed_dispatch is not None
        assert signed_dispatch.signal["signed_envelope"] == answer_wire
        assert "sdp" not in signed_dispatch.signal

    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)
    await broker.unregister_rtc_session("rtc-daemon-1", browser_conn)
    await broker.unregister_rtc_session(signed_session_id, browser_conn)


async def test_daemon_ws_activity_is_content_free_and_binary_fails_closed(client, caplog):
    """Only metadata frames stamp activity, and only for this daemon's host."""
    user_id, _ = await _signup(client, "ws-daemon-activity@example.com")
    host_id = await _create_host(user_id)
    other_host_id = await _create_host(user_id, name="other-daemon-box")
    pty_id = await _create_session_row(user_id, host_id, name="worker")
    binary_only_pty_id = await _create_session_row(user_id, host_id, name="binary-only")
    other_pty_id = await _create_session_row(user_id, other_host_id, name="other-host-agent")
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
    ws.queue_text({"type": "session.activity", "session_id": pty_id})
    ws.queue_text({"type": "session.input_activity", "session_id": pty_id})
    ws.queue_text({"type": "session.activity", "session_id": other_pty_id})
    ws.queue_text({"type": "session.input_activity", "session_id": other_pty_id})
    ws.queue_bytes(b"secret terminal bytes")

    await daemon_ws(ws, token=token)  # type: ignore[arg-type]

    sm = get_sessionmaker()
    async with sm() as session:
        agent = await session.get(Session, pty_id)
        assert agent is not None
        assert agent.last_output_at is not None
        assert agent.last_input_at is not None

        binary_only_agent = await session.get(Session, binary_only_pty_id)
        assert binary_only_agent is not None
        assert binary_only_agent.last_output_at is None
        assert binary_only_agent.last_input_at is None

        other_agent = await session.get(Session, other_pty_id)
        assert other_agent is not None
        assert other_agent.last_output_at is None
        assert other_agent.last_input_at is None

        host = await session.get(Host, host_id)
        assert host is not None
        assert host.last_seen_at is not None
    assert ws.closed == (4002, "binary terminal frames are retired")
    assert "secret terminal bytes" not in caplog.text


async def test_daemon_ws_session_foreground_stores_hardened_basename(client):
    """The documented content-free exception: a basename, nothing else."""
    user_id, _ = await _signup(client, "ws-daemon-foreground@example.com")
    host_id = await _create_host(user_id)
    other_host_id = await _create_host(user_id, name="other-foreground-box")
    pty_id = await _create_session_row(user_id, host_id, name="worker")
    other_pty_id = await _create_session_row(user_id, other_host_id, name="foreign")
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
    ws.queue_text({"type": "session.foreground", "session_id": pty_id, "command": "claude"})
    # Another host's session must not be labeled by this daemon.
    ws.queue_text({"type": "session.foreground", "session_id": other_pty_id, "command": "claude"})
    ws.queue_disconnect()
    await daemon_ws(ws, token=token)  # type: ignore[arg-type]

    sm = get_sessionmaker()
    async with sm() as session:
        row = await session.get(Session, pty_id)
        assert row is not None
        assert row.foreground_command == "claude"
        foreign = await session.get(Session, other_pty_id)
        assert foreign is not None
        assert foreign.foreground_command is None

    # Paths are re-basenamed and oversized values truncated server-side; an
    # empty command clears the label.
    for sent, stored in (
        ("/usr/local/bin/claude", "claude"),
        ("x" * 200, "x" * 64),
        ("", None),
        (None, None),
    ):
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
        ws.queue_text({"type": "session.foreground", "session_id": pty_id, "command": sent})
        ws.queue_disconnect()
        await daemon_ws(ws, token=token)  # type: ignore[arg-type]
        async with sm() as session:
            row = await session.get(Session, pty_id)
            assert row is not None
            assert row.foreground_command == stored, (sent, stored)

    # session.exit clears the stale foreground label with the shell.
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
    ws.queue_text({"type": "session.foreground", "session_id": pty_id, "command": "claude"})
    ws.queue_text({"type": "session.exit", "session_id": pty_id, "exit_code": 0})
    ws.queue_disconnect()
    await daemon_ws(ws, token=token)  # type: ignore[arg-type]
    async with sm() as session:
        row = await session.get(Session, pty_id)
        assert row is not None
        assert row.status == "exited"
        assert row.foreground_command is None


async def test_live_browser_device_ids_excludes_revoked_devices(client):
    """Revocation must reach the daemon.

    A daemon learns its browser pins once, at pairing. Registration reports the
    live set so a revoked device stops being trusted on the next connect rather
    than remaining valid indefinitely.
    """

    from datetime import UTC, datetime

    from spawn_server.models import BrowserDevice, HostBrowserPin
    from spawn_server.ws.daemon import _live_browser_device_ids

    async with get_sessionmaker()() as session:
        user = User(email="pinreconcile@example.com", password_hash="x")
        session.add(user)
        await session.flush()
        host = Host(name="reconcile-box", owner_user_id=user.id)
        session.add(host)
        await session.flush()

        live_device = BrowserDevice(
            owner_user_id=user.id, key_algorithm="ed25519", public_key="L" * 43
        )
        revoked_device = BrowserDevice(
            owner_user_id=user.id,
            key_algorithm="ed25519",
            public_key="R" * 43,
            revoked_at=datetime.now(UTC),
        )
        session.add_all([live_device, revoked_device])
        await session.flush()

        for device in (live_device, revoked_device):
            session.add(
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=device.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=device.public_key,
                    browser_key_fingerprint="SHA256:" + "z" * 16,
                )
            )
        await session.commit()
        host_id, live_id = host.id, live_device.id

    assert await _live_browser_device_ids(host_id) == [live_id]


async def test_revoking_endorser_drops_its_endorsed_pins_from_live_set(client):
    """Revoking a device must revoke what it endorsed.

    A pin that exists only on a now-revoked endorser's authority must leave the
    live set the daemon reconciles against. Otherwise revoking a stolen device
    would not remove the access it granted, only the device itself.
    """

    from datetime import UTC, datetime

    from spawn_server.models import BrowserDevice, HostBrowserPin
    from spawn_server.ws.daemon import _live_browser_device_ids, _live_browser_pins

    async with get_sessionmaker()() as session:
        user = User(email="endorser-revoke@example.com", password_hash="x")
        session.add(user)
        await session.flush()
        host = Host(name="endorser-revoke-box", owner_user_id=user.id)
        session.add(host)
        await session.flush()

        endorser = BrowserDevice(
            owner_user_id=user.id, key_algorithm="ed25519", public_key="E" * 43
        )
        endorsed = BrowserDevice(
            owner_user_id=user.id, key_algorithm="ed25519", public_key="D" * 43
        )
        direct = BrowserDevice(owner_user_id=user.id, key_algorithm="ed25519", public_key="A" * 43)
        session.add_all([endorser, endorsed, direct])
        await session.flush()

        session.add_all(
            [
                # Directly approved: the endorser itself and a control device.
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=endorser.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=endorser.public_key,
                    browser_key_fingerprint="SHA256:" + "e" * 16,
                ),
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=direct.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=direct.public_key,
                    browser_key_fingerprint="SHA256:" + "a" * 16,
                ),
                # Live only on the endorser's authority.
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=endorsed.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=endorsed.public_key,
                    browser_key_fingerprint="SHA256:" + "d" * 16,
                    endorser_device_id=endorser.id,
                    endorsement_signature="s" * 86,
                ),
            ]
        )
        await session.commit()
        host_id = host.id
        endorser_id, endorsed_id, direct_id = endorser.id, endorsed.id, direct.id

    # All three pins are live before revocation.
    assert await _live_browser_device_ids(host_id) == sorted([endorser_id, endorsed_id, direct_id])
    assert {row["browser_device_id"] for row in await _live_browser_pins(host_id)} == {
        endorser_id,
        endorsed_id,
        direct_id,
    }

    async with get_sessionmaker()() as session:
        endorser_device = await session.get(BrowserDevice, endorser_id)
        assert endorser_device is not None
        endorser_device.revoked_at = datetime.now(UTC)
        await session.commit()

    # The endorser's own pin is gone (it is revoked) and so is the pin it
    # endorsed; the directly approved control device is untouched.
    assert await _live_browser_device_ids(host_id) == [direct_id]
    assert {row["browser_device_id"] for row in await _live_browser_pins(host_id)} == {direct_id}


async def test_account_root_pin_survives_its_endorsers_revocation(client):
    """The account root's pin is a ratchet (mesh stage 5c).

    A host anchors on pk_R via an endorsement from an already-pinned device.
    Revoking that device must NOT drop the root's pin — surviving the loss of
    every ordinary device is the root's entire purpose (P3'). An ordinary pin
    endorsed by the same device dies with it, and revoking the root itself
    still drops the root's pin.
    """

    from datetime import UTC, datetime

    from spawn_server.models import BrowserDevice, HostBrowserPin
    from spawn_server.ws.daemon import _live_browser_device_ids, _live_browser_pins

    async with get_sessionmaker()() as session:
        user = User(email="root-ratchet@example.com", password_hash="x")
        session.add(user)
        await session.flush()
        host = Host(name="root-ratchet-box", owner_user_id=user.id)
        session.add(host)
        await session.flush()

        endorser = BrowserDevice(
            owner_user_id=user.id, key_algorithm="ed25519", public_key="E" * 43
        )
        account_root = BrowserDevice(
            owner_user_id=user.id, key_algorithm="ed25519", public_key="R" * 43, is_root=True
        )
        ordinary = BrowserDevice(
            owner_user_id=user.id, key_algorithm="ed25519", public_key="D" * 43
        )
        session.add_all([endorser, account_root, ordinary])
        await session.flush()

        session.add_all(
            [
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=endorser.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=endorser.public_key,
                    browser_key_fingerprint="SHA256:" + "e" * 16,
                ),
                # Both endorsed by the same device: the root pin and a control.
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=account_root.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=account_root.public_key,
                    browser_key_fingerprint="SHA256:" + "r" * 16,
                    endorser_device_id=endorser.id,
                    endorsement_signature="s" * 86,
                ),
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=ordinary.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=ordinary.public_key,
                    browser_key_fingerprint="SHA256:" + "d" * 16,
                    endorser_device_id=endorser.id,
                    endorsement_signature="t" * 86,
                ),
            ]
        )
        await session.commit()
        host_id = host.id
        endorser_id, root_id, ordinary_id = endorser.id, account_root.id, ordinary.id

    assert await _live_browser_device_ids(host_id) == sorted([endorser_id, root_id, ordinary_id])

    async with get_sessionmaker()() as session:
        endorser_device = await session.get(BrowserDevice, endorser_id)
        assert endorser_device is not None
        endorser_device.revoked_at = datetime.now(UTC)
        await session.commit()

    # The root's pin survives its endorser; the ordinary pin dies with it.
    assert await _live_browser_device_ids(host_id) == [root_id]
    assert {row["browser_device_id"] for row in await _live_browser_pins(host_id)} == {root_id}

    # Revoking the root itself still drops it — the ratchet is not immortality.
    async with get_sessionmaker()() as session:
        root_device = await session.get(BrowserDevice, root_id)
        assert root_device is not None
        root_device.revoked_at = datetime.now(UTC)
        await session.commit()
    assert await _live_browser_device_ids(host_id) == []


async def test_revoking_root_drops_the_whole_endorsement_subtree(client):
    """Revocation severs a multi-hop endorsement chain, not just the first hop.

    root -> mid -> leaf, all pinned. Revoking root must drop mid AND leaf: leaf's
    only authority traces through mid, whose only authority was root. Checking
    just the immediate endorser's revoked flag would keep leaf (mid still reads
    not-revoked) and leave a stolen device a surviving 2-hop foothold.
    """

    from datetime import UTC, datetime

    from spawn_server.models import BrowserDevice, HostBrowserPin
    from spawn_server.ws.daemon import _live_browser_device_ids, _live_browser_pins

    async with get_sessionmaker()() as session:
        user = User(email="chain-revoke@example.com", password_hash="x")
        session.add(user)
        await session.flush()
        host = Host(name="chain-revoke-box", owner_user_id=user.id)
        session.add(host)
        await session.flush()

        root = BrowserDevice(owner_user_id=user.id, key_algorithm="ed25519", public_key="R" * 43)
        mid = BrowserDevice(owner_user_id=user.id, key_algorithm="ed25519", public_key="M" * 43)
        leaf = BrowserDevice(owner_user_id=user.id, key_algorithm="ed25519", public_key="L" * 43)
        direct = BrowserDevice(owner_user_id=user.id, key_algorithm="ed25519", public_key="A" * 43)
        session.add_all([root, mid, leaf, direct])
        await session.flush()

        session.add_all(
            [
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=root.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=root.public_key,
                    browser_key_fingerprint="SHA256:" + "r" * 16,
                ),
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=direct.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=direct.public_key,
                    browser_key_fingerprint="SHA256:" + "a" * 16,
                ),
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=mid.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=mid.public_key,
                    browser_key_fingerprint="SHA256:" + "m" * 16,
                    endorser_device_id=root.id,
                    endorsement_signature="s" * 86,
                ),
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=leaf.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=leaf.public_key,
                    browser_key_fingerprint="SHA256:" + "l" * 16,
                    endorser_device_id=mid.id,
                    endorsement_signature="t" * 86,
                ),
            ]
        )
        await session.commit()
        host_id = host.id
        root_id, mid_id, leaf_id, direct_id = root.id, mid.id, leaf.id, direct.id

    # All four are live before revocation.
    assert await _live_browser_device_ids(host_id) == sorted([root_id, mid_id, leaf_id, direct_id])

    async with get_sessionmaker()() as session:
        root_device = await session.get(BrowserDevice, root_id)
        assert root_device is not None
        root_device.revoked_at = datetime.now(UTC)
        await session.commit()

    # Revoking root drops the entire subtree beneath it (mid and leaf); only the
    # directly approved control device remains.
    assert await _live_browser_device_ids(host_id) == [direct_id]
    assert {row["browser_device_id"] for row in await _live_browser_pins(host_id)} == {direct_id}


async def test_pruning_a_revoked_endorser_keeps_its_subtree_severed(client):
    """Hard-deleting a revoked endorser must not resurrect what it endorsed.

    Prune removes the tombstone row entirely, leaving the endorsed pin with a
    dangling endorser_device_id. The live-set computation must treat that
    exactly like a revoked endorser — never admitted — or clearing history
    would silently restore access that revocation removed.
    """

    from datetime import UTC, datetime

    from spawn_server import auth
    from spawn_server.models import BrowserDevice, HostBrowserPin
    from spawn_server.ws.daemon import _live_browser_device_ids, _live_browser_pins

    async with get_sessionmaker()() as session:
        user = User(email="endorser-prune@example.com", password_hash="x")
        session.add(user)
        await session.flush()
        host = Host(name="endorser-prune-box", owner_user_id=user.id)
        session.add(host)
        await session.flush()

        endorser = BrowserDevice(
            owner_user_id=user.id, key_algorithm="ed25519", public_key="F" * 43
        )
        endorsed = BrowserDevice(
            owner_user_id=user.id, key_algorithm="ed25519", public_key="G" * 43
        )
        direct = BrowserDevice(owner_user_id=user.id, key_algorithm="ed25519", public_key="H" * 43)
        session.add_all([endorser, endorsed, direct])
        await session.flush()
        session.add_all(
            [
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=endorser.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=endorser.public_key,
                    browser_key_fingerprint="SHA256:" + "f" * 16,
                ),
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=direct.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=direct.public_key,
                    browser_key_fingerprint="SHA256:" + "h" * 16,
                ),
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=endorsed.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=endorsed.public_key,
                    browser_key_fingerprint="SHA256:" + "g" * 16,
                    endorser_device_id=endorser.id,
                    endorsement_signature="s" * 86,
                ),
            ]
        )
        endorser.revoked_at = datetime.now(UTC)
        await session.commit()
        host_id = host.id
        user_id = user.id
        endorser_id, endorsed_id, direct_id = endorser.id, endorsed.id, direct.id

    # Revocation already severed the endorser and its endorsee.
    assert await _live_browser_device_ids(host_id) == [direct_id]

    headers = {"Authorization": f"Bearer {auth.issue_access_token(user_id)}"}
    pruned = await client.post("/api/browser-devices/prune", headers=headers)
    assert pruned.status_code == 200
    assert pruned.json() == {"pruned": 1}

    # The endorser row (and, via cascade, its own pin) is gone; the endorsed
    # pin's dangling endorser id keeps it out of the live set, and the
    # directly approved device is untouched.
    async with get_sessionmaker()() as session:
        assert await session.get(BrowserDevice, endorser_id) is None
        endorsed_pin = (
            await session.execute(
                select(HostBrowserPin).where(HostBrowserPin.browser_device_id == endorsed_id)
            )
        ).scalar_one()
        assert endorsed_pin.endorser_device_id == endorser_id
    assert await _live_browser_device_ids(host_id) == [direct_id]
    assert {row["browser_device_id"] for row in await _live_browser_pins(host_id)} == {direct_id}
