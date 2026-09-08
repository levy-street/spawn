"""Multi-tenant scoping: user A cannot see user B's hosts."""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

from spawn_server.host_status import derived_host_status, stamp_stale_disconnect
from spawn_server.routes import hosts as hosts_routes


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


@dataclass
class _FakeWS:
    sent_text: list[str] = field(default_factory=list)
    sent_bytes: list[bytes] = field(default_factory=list)

    async def send_text(self, value: str) -> None:
        self.sent_text.append(value)

    async def send_bytes(self, value: bytes) -> None:
        self.sent_bytes.append(value)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        pass


class _RevocationObserverWS(_FakeWS):
    def __init__(self, host_id: str) -> None:
        super().__init__()
        self.host_id = host_id
        self.closed_after_host_delete: bool | None = None
        self.close_code: int | None = None
        self.close_reason: str | None = None

    async def close(self, code: int = 1000, reason: str = "") -> None:
        from spawn_server.db import get_sessionmaker
        from spawn_server.models import Host

        async with get_sessionmaker()() as session:
            self.closed_after_host_delete = await session.get(Host, self.host_id) is None
        self.close_code = code
        self.close_reason = reason


async def _wait_for_text_frame(
    fake_ws: _FakeWS,
    frame_type: str,
    *,
    start: int = 0,
) -> dict:
    for _ in range(100):
        for raw in fake_ws.sent_text[start:]:
            frame = json.loads(raw)
            if frame.get("type") == frame_type:
                return frame
        await asyncio.sleep(0.01)
    raise AssertionError(f"did not receive {frame_type}; got {fake_ws.sent_text[start:]!r}")


async def _accept_daemon(daemon, *, generation: int = 1) -> None:
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host
    from spawn_server.redis import get_backend
    from spawn_server.ws.broker import get_broker
    from spawn_server.ws.host_signal import (
        HOST_DAEMON_PRESENCE_TTL_SECONDS,
        HostPresenceOwner,
        encode_host_presence_owner,
        host_presence_key,
    )

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


async def test_host_scoping(client):
    a_token = await _signup(client, "a@example.com")
    b_token = await _signup(client, "b@example.com")

    # Create a host for user A directly via the ORM (skip device flow for this test).
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        a = (await session.execute(select(User).where(User.email == "a@example.com"))).scalar_one()
        host = Host(owner_user_id=a.id, name="a-box", status="offline")
        session.add(host)
        await session.commit()
        host_id = host.id

    # User A sees their host.
    r = await client.get("/api/hosts", headers={"Authorization": f"Bearer {a_token}"})
    assert r.status_code == 200
    assert any(h["id"] == host_id for h in r.json())

    # User B does NOT see A's host.
    r = await client.get("/api/hosts", headers={"Authorization": f"Bearer {b_token}"})
    assert r.status_code == 200
    assert not any(h["id"] == host_id for h in r.json())

    # User B can't fetch A's host directly.
    r = await client.get(f"/api/hosts/{host_id}", headers={"Authorization": f"Bearer {b_token}"})
    assert r.status_code == 404

    # User B can't delete it either.
    r = await client.delete(f"/api/hosts/{host_id}", headers={"Authorization": f"Bearer {b_token}"})
    assert r.status_code == 404


def test_derived_host_status_requires_a_fresh_online_heartbeat():
    now = datetime(2026, 8, 25, tzinfo=UTC)
    fresh = type("Presence", (), {})()
    fresh.status = "online"
    fresh.last_seen_at = now - timedelta(seconds=90)
    fresh.last_disconnect_at = None
    fresh.last_disconnect_reason = None
    assert derived_host_status(fresh, now) == "online"
    fresh.last_seen_at = now - timedelta(seconds=91)
    assert derived_host_status(fresh, now) == "offline"
    assert stamp_stale_disconnect(fresh, now)
    assert fresh.status == "online"
    assert fresh.last_disconnect_at == now
    assert fresh.last_disconnect_reason == "stale"
    assert not stamp_stale_disconnect(fresh, now + timedelta(seconds=1))


async def test_stale_host_status_and_disconnect_shape_on_all_host_routes(client):
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    token = await _signup(client, "stale-host-surfaces@example.com")
    async with get_sessionmaker()() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "stale-host-surfaces@example.com")
            )
        ).scalar_one()
        host = Host(
            owner_user_id=user.id,
            name="stale-box",
            status="online",
            last_seen_at=datetime.now(UTC) - timedelta(minutes=5),
        )
        session.add(host)
        await session.commit()
        host_id = host.id

    headers = {"Authorization": f"Bearer {token}"}
    listed = await client.get("/api/hosts", headers=headers)
    got = await client.get(f"/api/hosts/{host_id}", headers=headers)
    patched = await client.patch(
        f"/api/hosts/{host_id}", headers=headers, json={"name": "stale-renamed"}
    )
    profile = await client.get("/api/profile", headers=headers)
    assert listed.status_code == got.status_code == patched.status_code == 200
    list_host = next(item for item in listed.json() if item["id"] == host_id)
    for payload in (list_host, got.json(), patched.json()):
        assert payload["status"] == "offline"
        assert payload["last_disconnect"]["reason"] == "stale"
        assert payload["last_disconnect"]["at"] is not None
    profile_host = next(item for item in profile.json()["hosts"] if item["id"] == host_id)
    assert profile_host["status"] == "offline"

    async with get_sessionmaker()() as session:
        persisted = await session.get(Host, host_id)
        assert persisted is not None
        assert persisted.status == "online"
        assert persisted.last_disconnect_reason == "stale"


def _stage_daemon_manifest(tmp_path: Path) -> None:
    from spawn_server import release

    prebuilt = tmp_path / "daemon" / "target" / "prebuilt"
    target = prebuilt / "linux-x86_64"
    target.mkdir(parents=True)
    spawnd = b"manual-spawnd"
    worker = b"manual-worker"
    (target / "spawnd").write_bytes(spawnd)
    (target / "spawn-worker").write_bytes(worker)
    (prebuilt / "manifest.json").write_text(
        json.dumps(
            {
                "commit": "c" * 40,
                "tree": "b" * 40,
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
    release.refresh()


async def test_host_update_endpoint_sends_and_persists_update(client, tmp_path, monkeypatch):
    from sqlalchemy import select

    from spawn_server import release
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    _stage_daemon_manifest(tmp_path)
    token = await _signup(client, "manual-daemon-update@example.com")
    async with get_sessionmaker()() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "manual-daemon-update@example.com")
            )
        ).scalar_one()
        host = Host(
            owner_user_id=user.id,
            name="update-box",
            os="linux",
            arch="x86_64",
            version="0.1.0+gaaaaaaaaaaaa",
            daemon_tree="a" * 40,
            self_update=True,
            status="online",
        )
        session.add(host)
        await session.commit()
        host_id = host.id
        user_id = user.id

    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=fake_ws)  # type: ignore[arg-type]
    await get_broker().register_daemon(daemon)
    await _accept_daemon(daemon)

    invalid = await client.post(
        f"/api/hosts/{host_id}/update",
        headers={"Authorization": f"Bearer {token}"},
        json={"allow_downgrade": "true"},
    )
    assert invalid.status_code == 422

    response = await client.post(
        f"/api/hosts/{host_id}/update",
        headers={"Authorization": f"Bearer {token}"},
        json={"allow_downgrade": True},
    )

    assert response.status_code == 202, response.text
    assert response.json()["update"]["state"] == "updating"
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "daemon.update"
    assert sent["tree"] == "b" * 40
    assert sent["allow_downgrade"] is True
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        assert host.update_state == "updating"
        assert host.update_tree == "b" * 40
        assert host.update_requested_at is not None

    limited = await client.post(
        f"/api/hosts/{host_id}/update",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert limited.status_code == 429


async def test_host_update_repairs_same_tree_worker_mismatch(client, tmp_path, monkeypatch):
    from sqlalchemy import select

    from spawn_server import release
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    _stage_daemon_manifest(tmp_path)
    token = await _signup(client, "manual-worker-repair@example.com")
    async with get_sessionmaker()() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "manual-worker-repair@example.com")
            )
        ).scalar_one()
        host = Host(
            owner_user_id=user.id,
            name="mismatched-box",
            os="linux",
            arch="x86_64",
            version="0.2.0+gcccccccccccc",
            daemon_tree="b" * 40,
            self_update=True,
            worker_mismatch=True,
            status="online",
        )
        session.add(host)
        await session.commit()
        host_id = host.id
        user_id = user.id

    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=fake_ws)  # type: ignore[arg-type]
    await get_broker().register_daemon(daemon)
    await _accept_daemon(daemon)

    before = await client.get(f"/api/hosts/{host_id}", headers={"Authorization": f"Bearer {token}"})
    response = await client.post(
        f"/api/hosts/{host_id}/update",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert before.status_code == 200
    assert before.json()["update"] == {
        "state": "current",
        "latest_version": "0.2.0+gcccccccccccc",
        "error": "worker_mismatch",
        "requested_at": None,
    }
    assert response.status_code == 202, response.text
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "daemon.update"
    assert sent["tree"] == "b" * 40
    assert "allow_downgrade" not in sent


async def test_host_update_endpoint_current_is_noop_and_offline_conflicts(
    client, tmp_path, monkeypatch
):
    from sqlalchemy import select

    from spawn_server import release
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    monkeypatch.setattr(release, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    _stage_daemon_manifest(tmp_path)
    token = await _signup(client, "daemon-update-codes@example.com")
    async with get_sessionmaker()() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "daemon-update-codes@example.com")
            )
        ).scalar_one()
        current = Host(
            owner_user_id=user.id,
            name="current-box",
            os="linux",
            arch="x86_64",
            daemon_tree="b" * 40,
            self_update=True,
            status="offline",
        )
        old = Host(
            owner_user_id=user.id,
            name="offline-box",
            os="linux",
            arch="x86_64",
            daemon_tree="a" * 40,
            self_update=True,
            status="offline",
        )
        session.add_all([current, old])
        await session.commit()
        current_id = current.id
        old_id = old.id
    headers = {"Authorization": f"Bearer {token}"}

    current_response = await client.post(f"/api/hosts/{current_id}/update", headers=headers)
    offline_response = await client.post(f"/api/hosts/{old_id}/update", headers=headers)

    assert current_response.status_code == 200
    assert current_response.json()["update"]["state"] == "current"
    assert offline_response.status_code == 409
    assert offline_response.json() == {"detail": "host daemon is offline"}


async def test_host_revocation_closes_daemon_only_after_database_commit(client):
    token = await _signup(client, "post-commit-revocation@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, HostKeyClaim, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    public_key = "A" * 43
    async with get_sessionmaker()() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "post-commit-revocation@example.com")
            )
        ).scalar_one()
        host = Host(
            owner_user_id=user.id,
            name="post-commit-host",
            host_key_algorithm="ed25519",
            host_public_key=public_key,
            status="online",
        )
        session.add(host)
        session.add(
            HostKeyClaim(
                host_key_algorithm="ed25519",
                host_public_key=public_key,
                owner_user_id=user.id,
            )
        )
        await session.commit()
        host_id = host.id
        user_id = user.id

    observer = _RevocationObserverWS(host_id)
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=observer)  # type: ignore[arg-type]
    await get_broker().register_daemon(daemon)
    await _accept_daemon(daemon)

    removed = await client.delete(f"/api/hosts/{host_id}", headers=auth)
    assert removed.status_code == 204, removed.text
    assert observer.closed_after_host_delete is True
    assert observer.close_code == 4001
    assert observer.close_reason == "host revoked"


async def test_host_agent_check_roundtrip(client):
    token = await _signup(client, "host-tools@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-tools@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="tool-box", status="online")
        session.add(host)
        agent = (await session.execute(select(Agent).where(Agent.name == "codex"))).scalar_one()
        await session.commit()
        host_id = host.id
        agent_id = agent.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)

    task = asyncio.create_task(client.get(f"/api/hosts/{host_id}/agents", headers=auth))
    for _ in range(100):
        if fake_ws.sent_text:
            break
        if task.done():
            break
        await asyncio.sleep(0.01)
    assert fake_ws.sent_text, (await task).text
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "host.agents.check"
    assert any(t["agent_id"] == agent_id and t["command"] == "codex" for t in sent["targets"])
    async with sm() as session:
        from spawn_server.models import HostAgentPolicy

        policy_count = (
            (
                await session.execute(
                    select(HostAgentPolicy).where(HostAgentPolicy.host_id == host_id)
                )
            )
            .scalars()
            .all()
        )
    assert policy_count

    await broker.resolve_agent_check(
        sent["request_id"],
        {
            "type": "host.agents.check_result",
            "request_id": sent["request_id"],
            "agents": [
                {
                    "agent_id": agent_id,
                    "agent_name": "codex",
                    "agent_kind": "codex",
                    "command": "codex",
                    "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                    "installed": True,
                    "path": "/usr/local/bin/codex",
                    "version": "codex 1.2.3",
                    "error": None,
                }
            ],
        },
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    r = await task
    assert r.status_code == 200, r.text
    assert r.json()["agents"][0]["version"] == "codex 1.2.3"

    # Old clients receive an immediate refusal, even with an accepted daemon.
    sent_count = len(fake_ws.sent_text)
    r = await client.post(f"/api/hosts/{host_id}/agents/{agent_id}/install", headers=auth)
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == hosts_routes.AGENT_INSTALL_UNAVAILABLE
    assert len(fake_ws.sent_text) == sent_count

    other_token = await _signup(client, "host-tools-other@example.com")
    other_auth = {"Authorization": f"Bearer {other_token}"}
    r = await client.post(f"/api/hosts/{host_id}/agents/{agent_id}/install", headers=other_auth)
    assert r.status_code == 404
    r = await client.patch(
        f"/api/hosts/{host_id}/agents/{agent_id}/policy",
        json={"auto_update": True},
        headers=other_auth,
    )
    assert r.status_code == 404
    assert len(fake_ws.sent_text) == sent_count

    await broker.unregister_daemon(daemon)


async def test_host_tools_require_online_daemon(client):
    token = await _signup(client, "host-tools-offline@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "host-tools-offline@example.com")
            )
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="offline-box", status="offline")
        session.add(host)
        await session.commit()
        host_id = host.id

    r = await client.get(f"/api/hosts/{host_id}/agents", headers=auth)
    assert r.status_code == 409


async def test_host_control_ping_is_owner_authorized_content_free_and_current(client):
    owner_token = await _signup(client, "host-ping-owner@example.com")
    other_token = await _signup(client, "host-ping-other@example.com")
    owner_auth = {"Authorization": f"Bearer {owner_token}"}
    other_auth = {"Authorization": f"Bearer {other_token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        owner = (
            await session.execute(select(User).where(User.email == "host-ping-owner@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=owner.id, name="ping-box", status="online")
        session.add(host)
        await session.commit()
        host_id = host.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id=owner.id, websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)

    unauthorized = await client.post(f"/api/hosts/{host_id}/control/ping", headers=other_auth)
    assert unauthorized.status_code == 404
    assert not fake_ws.sent_text

    task = asyncio.create_task(
        client.post(f"/api/hosts/{host_id}/control/ping", headers=owner_auth)
    )
    sent = await _wait_for_text_frame(fake_ws, "host.ping")
    assert set(sent) == {"type", "request_id"}
    assert await broker.resolve_host_pong(
        sent["request_id"],
        {"type": "host.pong", "request_id": sent["request_id"]},
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    response = await task
    assert response.status_code == 204
    assert response.content == b""

    await broker.unregister_daemon(daemon)


async def test_host_control_ping_rejects_stale_online_status(client):
    token = await _signup(client, "host-ping-stale-status@example.com")

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        owner = (
            await session.execute(
                select(User).where(User.email == "host-ping-stale-status@example.com")
            )
        ).scalar_one()
        host = Host(owner_user_id=owner.id, name="stale-ping-box", status="online")
        session.add(host)
        await session.commit()
        host_id = host.id

    response = await client.post(
        f"/api/hosts/{host_id}/control/ping",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 409


async def test_host_file_rest_surfaces_are_retired_without_content_forwarding(client):
    a_token = await _signup(client, "host-dirs-a@example.com")
    auth = {"Authorization": f"Bearer {a_token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-dirs-a@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="dir-box", status="online")
        session.add(host)
        await session.commit()
        host_id = host.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)

    secret = "private-path-canary"
    paths = [
        f"/api/hosts/{host_id}/dirs?path=/{secret}",
        f"/api/hosts/{host_id}/files?path=/{secret}",
        f"/api/hosts/{host_id}/files/download?path=/{secret}",
        f"/api/hosts/{host_id}/files/upload",
        f"/api/hosts/{host_id}/files/mkdir",
        f"/api/hosts/{host_id}/files/rename",
        f"/api/hosts/{host_id}/files/delete",
        f"/api/hosts/{host_id}/files/transfer",
    ]
    for path in paths:
        response = await client.request(
            "POST"
            if path.rsplit("/", 1)[-1] in {"upload", "mkdir", "rename", "delete", "transfer"}
            else "GET",
            path,
            headers=auth,
            json={"path": secret},
        )
        assert response.status_code == 404
    assert fake_ws.sent_text == []
    openapi = (await client.get("/openapi.json")).text
    assert "/files" not in openapi
    assert '"home_dir"' not in openapi
    assert "host.fs" not in openapi

    await broker.unregister_daemon(daemon)


async def test_legacy_auto_update_policy_never_schedules_install(client):
    token = await _signup(client, "host-tools-auto@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-tools-auto@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="auto-box", status="online")
        session.add(host)
        agent = (await session.execute(select(Agent).where(Agent.name == "codex"))).scalar_one()
        await session.commit()
        host_id = host.id
        agent_id = agent.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)

    r = await client.patch(
        f"/api/hosts/{host_id}/agents/{agent_id}/policy",
        json={"auto_update": True}, headers=auth,
    )
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == hosts_routes.AGENT_INSTALL_UNAVAILABLE
    assert fake_ws.sent_text == []

    # Existing true policies must not reactivate when a client refreshes status.
    from spawn_server.models import HostAgentPolicy
    async with sm() as session:
        session.add(HostAgentPolicy(owner_user_id=user.id, host_id=host_id,
                                   agent_id=agent_id, auto_update=True))
        await session.commit()

    check_task = asyncio.create_task(client.get(f"/api/hosts/{host_id}/agents", headers=auth))
    for _ in range(100):
        if fake_ws.sent_text:
            break
        await asyncio.sleep(0.01)
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "host.agents.check"
    await broker.resolve_agent_check(
        sent["request_id"],
        {
            "type": "host.agents.check_result",
            "request_id": sent["request_id"],
            "agents": [
                {
                    "agent_id": agent_id,
                    "agent_name": "codex",
                    "agent_kind": "codex",
                    "command": "codex",
                    "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                    "installed": True,
                    "path": "/usr/local/bin/codex",
                    "version": "codex 1.2.3",
                    "latest_version": "1.2.4",
                    "update_available": True,
                    "error": None,
                }
            ],
        },
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    r = await check_task
    assert r.status_code == 200, r.text
    tool = r.json()["agents"][0]
    assert tool["auto_update"] is False
    assert tool["update_available"] is True

    assert [json.loads(text)["type"] for text in fake_ws.sent_text] == ["host.agents.check"]
    r = await client.patch(
        f"/api/hosts/{host_id}/agents/{agent_id}/policy",
        json={"auto_update": False}, headers=auth,
    )
    assert r.status_code == 200, r.text
    assert r.json()["auto_update"] is False
    assert len(fake_ws.sent_text) == 1
    await broker.unregister_daemon(daemon)


async def test_daemon_deregisters_its_own_host(client):
    # `spawnd exorcise` / the possess dedup revoke via DELETE /api/hosts/self,
    # authenticated by the daemon token — a host can only remove itself.
    from sqlalchemy import select

    from spawn_server import auth
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    await _signup(client, "deregister-self@example.com")
    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "deregister-self@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="self-box", status="offline")
        session.add(host)
        await session.commit()
        host_id, user_id = host.id, user.id

    daemon_token = auth.issue_daemon_token(host_id, user_id)
    headers = {"Authorization": f"Bearer {daemon_token}"}

    r = await client.delete("/api/hosts/self", headers=headers)
    assert r.status_code == 204, r.text

    async with sm() as session:
        gone = (await session.execute(select(Host).where(Host.id == host_id))).scalar_one_or_none()
    assert gone is None

    # The token now resolves to no host — a second call is unauthorized.
    r2 = await client.delete("/api/hosts/self", headers=headers)
    assert r2.status_code == 401


async def test_host_deletion_cascades_over_its_sessions(client):
    # The 2026-08-24 production 500: deleting a host that still has session
    # rows died in the ORM flush (host_id nulled against NOT NULL) before the
    # FK cascade could fire. Both delete routes share _revoke_host, so cover
    # the daemon self-delete with a session attached and assert the session
    # rows die with the host.
    from sqlalchemy import select

    from spawn_server import auth
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, Session, User

    await _signup(client, "deregister-cascade@example.com")
    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "deregister-cascade@example.com")
            )
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="session-box", status="offline")
        session.add(host)
        await session.flush()
        session.add(
            Session(owner_user_id=user.id, host_id=host.id, cwd="/home/user", status="running")
        )
        await session.commit()
        host_id, user_id = host.id, user.id

    daemon_token = auth.issue_daemon_token(host_id, user_id)
    r = await client.delete("/api/hosts/self", headers={"Authorization": f"Bearer {daemon_token}"})
    assert r.status_code == 204, r.text

    async with sm() as session:
        gone_host = (
            await session.execute(select(Host).where(Host.id == host_id))
        ).scalar_one_or_none()
        orphan_sessions = (
            (await session.execute(select(Session).where(Session.host_id == host_id)))
            .scalars()
            .all()
        )
    assert gone_host is None
    assert orphan_sessions == []
