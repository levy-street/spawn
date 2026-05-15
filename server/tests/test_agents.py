"""Agent metadata and lifecycle API behavior."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta


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


async def test_agent_rename_archive_and_delete(client):
    token = await _signup(client, "agent-owner@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "agent-owner@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="offline")
        session.add(host)
        await session.flush()
        agent = Agent(
            owner_user_id=user.id,
            host_id=host.id,
            cwd="/repo",
            argv=["codex"],
            env={},
            status="running",
        )
        session.add(agent)
        await session.commit()
        agent_id = agent.id

    r = await client.patch(f"/api/agents/{agent_id}", json={"name": "  ui work  "}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "ui work"
    assert r.json()["archived_at"] is None
    assert r.json()["pinned_at"] is None

    r = await client.patch(f"/api/agents/{agent_id}", json={"pinned": True}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["pinned_at"] is not None

    r = await client.patch(f"/api/agents/{agent_id}", json={"pinned": False}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["pinned_at"] is None

    r = await client.patch(f"/api/agents/{agent_id}", json={"archived": True}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["archived_at"] is not None

    r = await client.get("/api/agents", headers=auth)
    assert r.status_code == 200
    assert all(a["id"] != agent_id for a in r.json())

    r = await client.get("/api/agents?include_archived=true", headers=auth)
    assert r.status_code == 200
    assert any(a["id"] == agent_id for a in r.json())

    r = await client.delete(f"/api/agents/{agent_id}", headers=auth)
    assert r.status_code == 204, r.text

    r = await client.get(f"/api/agents/{agent_id}", headers=auth)
    assert r.status_code == 404


async def test_agent_create_defaults_name_from_host_and_cwd(client):
    token = await _signup(client, "default-name@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "default-name@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="dream", status="offline")
        session.add(host)
        await session.commit()
        host_id = host.id

    r = await client.post(
        "/api/agents",
        json={"host_id": host_id, "cwd": "/home/oem/projects/spawn", "argv": ["codex"]},
        headers=auth,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "dream - spawn"
    assert body["host_name"] == "dream"


async def test_agent_activity_fields(client):
    token = await _signup(client, "agent-activity@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User

    now = datetime.now(UTC)
    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "agent-activity@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="online")
        session.add(host)
        await session.flush()
        agent = Agent(
            owner_user_id=user.id,
            host_id=host.id,
            cwd="/repo",
            argv=["codex"],
            env={},
            status="running",
            last_output_at=now - timedelta(seconds=30),
        )
        session.add(agent)
        await session.commit()
        agent_id = agent.id

    r = await client.get(f"/api/agents/{agent_id}", headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["activity_state"] == "waiting"
    assert body["activity_label"] == "Awaiting input"
    assert body["last_output_at"] is not None
    assert body["last_activity_at"] is not None


async def test_agent_restart_dispatches_existing_agent(client):
    token = await _signup(client, "agent-restart@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, Preset, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "agent-restart@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="online")
        preset = (
            await session.execute(select(Preset).where(Preset.name == "codex"))
        ).scalar_one()
        session.add(host)
        await session.flush()
        agent = Agent(
            owner_user_id=user.id,
            host_id=host.id,
            preset_id=preset.id,
            cwd="/repo",
            argv=["codex", "--yolo"],
            env={"A": "B"},
            status="running",
        )
        session.add(agent)
        await session.commit()
        host_id = host.id
        agent_id = agent.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    r = await client.post(
        f"/api/agents/{agent_id}/restart",
        json={"cols": 100, "rows": 40},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "starting"
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "agent.restart"
    assert sent["agent_id"] == agent_id
    assert sent["cols"] == 100
    assert sent["rows"] == 40
    assert sent["cwd"] == "/repo"
    assert sent["argv"] == ["codex", "--yolo"]

    await broker.unregister_daemon(daemon)
