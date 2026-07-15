"""Daemon websocket auth, compatibility, and reconnect behavior."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any

from sqlalchemy import select

from spawn_server import auth
from spawn_server.db import get_sessionmaker
from spawn_server.limits import MAX_SAFE_FENCING_GENERATION
from spawn_server.models import Agent, Host, User
from spawn_server.redis import get_backend
from spawn_server.ws.broker import BrowserConn, DaemonConn, get_broker
from spawn_server.ws.daemon import _allocate_host_generation, daemon_ws
from spawn_server.ws.frames import KIND_OUTPUT, encode_binary_frame
from spawn_server.ws.host_signal import (
    HOST_DAEMON_PRESENCE_TTL_SECONDS,
    HostPresenceOwner,
    decode_host_presence_owner,
    encode_host_presence_owner,
    host_presence_key,
)


class FakeDaemonWebSocket:
    def __init__(self, *, authorization: str | None = None) -> None:
        self.headers: dict[str, str] = {}
        if authorization is not None:
            self.headers["authorization"] = authorization
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
        return message

    async def send_text(self, value: str) -> None:
        self.sent_text.append(value)

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

    wrong_host = FakeDaemonWebSocket(
        authorization=f"Bearer {auth.issue_daemon_token(host_id, 'other-user')}"
    )
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


async def test_pending_daemon_cannot_evict_or_reroute_accepted_owner(client):
    user_id, _ = await _signup(client, "ws-daemon-pending-owner@example.com")
    host_id = await _create_host(user_id)
    agent_id = await _create_agent(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    broker = get_broker()
    accepted = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    accepted_task = asyncio.create_task(daemon_ws(accepted, token=None))  # type: ignore[arg-type]
    accepted.queue_text({"type": "register", "version": "accepted", "existing_agents": [agent_id]})
    await _wait_until(
        lambda: any(item.get("type") == "registered" for item in _sent_json(accepted))
    )
    accepted_conn = broker.get_daemon_for_host(host_id)
    assert accepted_conn is not None
    assert broker.get_daemon_for_agent(agent_id) is accepted_conn

    pending = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    pending_task = asyncio.create_task(daemon_ws(pending, token=None))  # type: ignore[arg-type]
    await _wait_until(lambda: pending.accepted_subprotocol == "spawn.v1")

    # Before register, neither binary output nor lifecycle frames may attach
    # this authenticated-but-pending socket or mutate accepted agent routing.
    pending.queue_bytes(encode_binary_frame(KIND_OUTPUT, agent_id, b"pending"))
    pending.queue_text({"type": "agent.exit", "agent_id": agent_id, "exit_code": 9})
    await _wait_until(lambda: pending.receive_count >= 2)
    assert broker.get_daemon_for_host(host_id) is accepted_conn
    assert broker.get_daemon_for_agent(agent_id) is accepted_conn
    assert accepted.close_calls == []

    sm = get_sessionmaker()
    async with sm() as session:
        agent = await session.get(Agent, agent_id)
        assert agent is not None
        assert agent.status == "running"

    pending.queue_disconnect()
    await asyncio.wait_for(pending_task, timeout=1)
    assert broker.get_daemon_for_host(host_id) is accepted_conn
    assert broker.get_daemon_for_agent(agent_id) is accepted_conn
    assert accepted.close_calls == []

    accepted.queue_text({"type": "host.heartbeat"})
    await _wait_until(
        lambda: any(item.get("type") == "host.heartbeat" for item in _sent_json(accepted))
    )
    accepted.queue_disconnect()
    await asyncio.wait_for(accepted_task, timeout=1)


async def test_corrupt_cache_rejects_pending_owner_without_evicting_accepted_routes(client):
    user_id, _ = await _signup(client, "ws-daemon-corrupt-pending@example.com")
    host_id = await _create_host(user_id)
    agent_id = await _create_agent(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    broker = get_broker()
    accepted = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    accepted_task = asyncio.create_task(daemon_ws(accepted, token=None))  # type: ignore[arg-type]
    accepted.queue_text({"type": "register", "version": "accepted", "existing_agents": [agent_id]})
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

    assert pending.close_calls == [(4000, "superseded")]
    assert accepted.close_calls == []
    assert broker.get_daemon_for_host(host_id) is accepted_conn
    assert broker.get_daemon_for_agent(agent_id) is accepted_conn
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


async def test_generation_max_rejects_pending_owner_without_evicting_accepted_routes(client):
    user_id, _ = await _signup(client, "ws-daemon-max-pending@example.com")
    host_id = await _create_host(user_id)
    agent_id = await _create_agent(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    broker = get_broker()
    accepted = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    accepted_task = asyncio.create_task(daemon_ws(accepted, token=None))  # type: ignore[arg-type]
    accepted.queue_text({"type": "register", "version": "accepted", "existing_agents": [agent_id]})
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

    assert pending.close_calls == [(4000, "superseded")]
    assert accepted.close_calls == []
    assert broker.get_daemon_for_host(host_id) is accepted_conn
    assert broker.get_daemon_for_agent(agent_id) is accepted_conn
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
        host.daemon_generation = MAX_SAFE_FENCING_GENERATION - 1
        await session.commit()

    async with sm() as session:
        generation = await _allocate_host_generation(session, host_id, "a" * 32)
    assert generation == MAX_SAFE_FENCING_GENERATION
    async with sm() as session:
        assert await _allocate_host_generation(session, host_id, "b" * 32) is None
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.daemon_connection_id == "a" * 32
        assert host.daemon_generation == MAX_SAFE_FENCING_GENERATION


async def test_distributed_daemon_supersession_cannot_reclaim_presence_or_mark_host_offline(client):
    user_id, _ = await _signup(client, "ws-daemon-superseded@example.com")
    host_id = await _create_host(user_id)
    agent_id = await _create_agent(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]
    old.queue_text({"type": "register", "version": "old", "existing_agents": [agent_id]})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(old)))
    old_conn = get_broker().get_daemon_for_host(host_id)
    assert old_conn is not None
    assert get_broker().get_daemon_for_agent(agent_id) is old_conn

    new = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    new_task = asyncio.create_task(daemon_ws(new, token=None))  # type: ignore[arg-type]
    new.queue_text({"type": "register", "version": "new", "existing_agents": [agent_id]})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(new)))

    # The atomic claim publishes an active revocation; no heartbeat grace
    # interval is needed to fence the old worker.
    await asyncio.wait_for(old_task, timeout=1)
    assert old.closed == (4000, "superseded")
    assert old.close_calls == [(4000, "superseded")]
    new_conn = get_broker().get_daemon_for_host(host_id)
    assert new_conn is not None
    assert new_conn is not old_conn
    assert get_broker().get_daemon_for_agent(agent_id) is new_conn
    sm = get_sessionmaker()
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
    agent_id = await _create_agent(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    broker = get_broker()
    old = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    old_task = asyncio.create_task(daemon_ws(old, token=None))  # type: ignore[arg-type]

    original_attach = broker.attach_agent_to_daemon
    old_waiting_to_attach = asyncio.Event()
    release_old_resync = asyncio.Event()
    old_conn: DaemonConn | None = None

    async def attach_with_resync_barrier(
        claimed_agent_id: str,
        conn: DaemonConn,
        *,
        expected_host_generation: int | None = None,
    ) -> bool:
        nonlocal old_conn
        if old_conn is None and claimed_agent_id == agent_id:
            old_conn = conn
            old_waiting_to_attach.set()
            await release_old_resync.wait()
        return await original_attach(
            claimed_agent_id,
            conn,
            expected_host_generation=expected_host_generation,
        )

    monkeypatch.setattr(broker, "attach_agent_to_daemon", attach_with_resync_barrier)
    old.queue_text({"type": "register", "version": "old", "existing_agents": [agent_id]})
    await asyncio.wait_for(old_waiting_to_attach.wait(), timeout=1)
    assert old_conn is not None

    new = FakeDaemonWebSocket(authorization=f"Bearer {token}")
    new_task = asyncio.create_task(daemon_ws(new, token=None))  # type: ignore[arg-type]
    new.queue_text({"type": "register", "version": "new", "existing_agents": [agent_id]})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(new)))
    new_conn = broker.get_daemon_for_host(host_id)
    assert new_conn is not None
    assert new_conn is not old_conn
    assert broker.get_daemon_for_agent(agent_id) is new_conn

    release_old_resync.set()
    await asyncio.wait_for(old_task, timeout=1)
    assert old.closed == (4000, "superseded")
    assert broker.get_daemon_for_host(host_id) is new_conn
    assert broker.get_daemon_for_agent(agent_id) is new_conn

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

    release_old_cleanup.set()
    await asyncio.wait_for(old_task, timeout=1)

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


async def test_daemon_ws_routes_rtc_signaling_back_to_browser(client):
    user_id, _ = await _signup(client, "ws-daemon-rtc@example.com")
    host_id = await _create_host(user_id)
    agent_id = await _create_agent(user_id, host_id)
    token = auth.issue_daemon_token(host_id, user_id)

    browser_ws = FakeDaemonWebSocket()
    browser_conn = BrowserConn(user_id=user_id, agent_id=agent_id, websocket=browser_ws)  # type: ignore[arg-type]
    signal_daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=FakeDaemonWebSocket())  # type: ignore[arg-type]
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
    ws.queue_text({"type": "register", "version": "rtc-test"})
    await _wait_until(lambda: any(item.get("type") == "registered" for item in _sent_json(ws)))
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
    await _wait_until(
        lambda: any(item.get("type") == "rtc.answer" for item in _sent_json(browser_ws))
    )
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
    await _wait_until(
        lambda: any(item.get("type") == "rtc.status" for item in _sent_json(browser_ws))
    )
    assert _sent_json(browser_ws)[-1] == {
        "type": "rtc.status",
        "session_id": "rtc-daemon-1",
        "agent_id": agent_id,
        "status": "connected",
    }

    ws.queue_disconnect()
    await asyncio.wait_for(task, timeout=1)
    await broker.unregister_rtc_session("rtc-daemon-1", browser_conn)


async def test_daemon_ws_activity_is_content_free_and_host_scoped(client, monkeypatch, tmp_path):
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
