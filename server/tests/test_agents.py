"""Agent metadata and lifecycle API behavior."""

from __future__ import annotations


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


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
