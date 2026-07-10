"""Managed skill API behavior."""

from __future__ import annotations

import json


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


async def _create_host_for_user(email: str, name: str = "box") -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        host = Host(owner_user_id=user.id, name=name, status="online")
        session.add(host)
        await session.commit()
        return host.id


async def test_skill_crud_validation_and_scoping(client):
    a_token = await _signup(client, "cap-a@example.com")
    b_token = await _signup(client, "cap-b@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    b_auth = {"Authorization": f"Bearer {b_token}"}

    skill = await client.post(
        "/api/skills",
        json={
            "name": "  reviewer  ",
            "description": "  code review  ",
            "content": "# Reviewer\nCheck the diff.",
            "enabled_by_default": True,
        },
        headers=a_auth,
    )
    assert skill.status_code == 201, skill.text
    skill_id = skill.json()["id"]
    assert skill.json()["name"] == "reviewer"
    assert skill.json()["description"] == "code review"

    duplicate = await client.post(
        "/api/skills",
        json={"name": "reviewer", "content": "# Other"},
        headers=a_auth,
    )
    assert duplicate.status_code == 409

    blank = await client.post(
        "/api/skills",
        json={"name": "   ", "content": "# Blank"},
        headers=a_auth,
    )
    assert blank.status_code == 400

    patched = await client.patch(
        f"/api/skills/{skill_id}",
        json={"description": "updated", "enabled_by_default": False},
        headers=a_auth,
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["description"] == "updated"
    assert patched.json()["enabled_by_default"] is False

    assert (await client.get("/api/skills", headers=b_auth)).json() == []
    assert (await client.patch(f"/api/skills/{skill_id}", json={}, headers=b_auth)).status_code == 404
    assert (await client.delete(f"/api/skills/{skill_id}", headers=b_auth)).status_code == 404


async def test_mcp_surface_is_gone(client):
    """MCP was cut entirely (docs/TRUST.md): no /mcp mount, no registry, no OAuth AS."""
    token = await _signup(client, "cap-no-mcp@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    assert (await client.get("/api/mcp-servers", headers=auth)).status_code == 404
    assert (await client.post("/api/mcp-servers/spawn", json={}, headers=auth)).status_code == 404
    assert (await client.post("/mcp", json={})).status_code == 404
    assert (await client.get("/.well-known/oauth-protected-resource")).status_code == 404
    assert (await client.get("/.well-known/oauth-authorization-server")).status_code == 404
    assert (await client.post("/api/oauth/register", json={})).status_code == 404


async def test_default_skills_launch_with_agent_and_cross_user_grants_do_not_leak(
    client,
):
    a_token = await _signup(client, "cap-launch-a@example.com")
    b_token = await _signup(client, "cap-launch-b@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    b_auth = {"Authorization": f"Bearer {b_token}"}

    a_skill = await client.post(
        "/api/skills",
        json={
            "name": "spawn-skill",
            "content": "# Spawn\nHouse style for agents.",
            "enabled_by_default": True,
        },
        headers=a_auth,
    )
    assert a_skill.status_code == 201, a_skill.text
    b_skill = await client.post(
        "/api/skills",
        json={"name": "other", "content": "# Other"},
        headers=b_auth,
    )
    assert b_skill.status_code == 201, b_skill.text

    host_id = await _create_host_for_user("cap-launch-a@example.com")

    from spawn_server.ws.broker import DaemonConn, get_broker

    class FakeWS:
        def __init__(self) -> None:
            self.sent_text: list[str] = []
            self.sent_bytes: list[bytes] = []

        async def send_text(self, value: str) -> None:
            self.sent_text.append(value)

        async def send_bytes(self, value: bytes) -> None:
            self.sent_bytes.append(value)

        async def close(self, code: int = 1000, reason: str = "") -> None:
            return None

    fake_ws = FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    broker = get_broker()
    await broker.register_daemon(daemon)

    created = await client.post(
        "/api/agents",
        json={"host_id": host_id, "cwd": "/repo", "argv": ["codex"]},
        headers=a_auth,
    )
    assert created.status_code == 201, created.text
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "agent.create"
    assert "mcp_servers" not in sent
    assert [skill["id"] for skill in sent["skills"]] == [a_skill.json()["id"]]

    denied = await client.post(
        "/api/agents",
        json={
            "host_id": host_id,
            "cwd": "/repo",
            "argv": ["codex"],
            "skill_ids": [b_skill.json()["id"]],
        },
        headers=a_auth,
    )
    assert denied.status_code == 404
    assert "skill not found" in denied.text

    access = await client.get(f"/api/agents/{created.json()['id']}/access", headers=b_auth)
    assert access.status_code == 404

    await broker.unregister_daemon(daemon)

    from sqlalchemy import func, select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent

    sm = get_sessionmaker()
    async with sm() as session:
        count = (
            await session.execute(select(func.count()).select_from(Agent))
        ).scalar_one()
    assert count == 1


async def test_agent_access_patch_replaces_skills(client):
    token = await _signup(client, "cap-access-patch@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host_for_user("cap-access-patch@example.com")

    skill_a = await client.post(
        "/api/skills",
        json={"name": "one", "content": "# One"},
        headers=auth,
    )
    skill_b = await client.post(
        "/api/skills",
        json={"name": "two", "content": "# Two"},
        headers=auth,
    )
    assert skill_a.status_code == 201, skill_a.text
    assert skill_b.status_code == 201, skill_b.text

    created = await client.post(
        "/api/agents",
        json={
            "host_id": host_id,
            "cwd": "/repo",
            "argv": ["codex"],
            "skill_ids": [skill_a.json()["id"]],
        },
        headers=auth,
    )
    assert created.status_code == 201, created.text
    agent_id = created.json()["id"]

    updated = await client.patch(
        f"/api/agents/{agent_id}/access",
        json={"skill_ids": [skill_b.json()["id"]]},
        headers=auth,
    )
    assert updated.status_code == 200, updated.text
    assert [skill["id"] for skill in updated.json()["skills"]] == [skill_b.json()["id"]]

    unchanged = await client.patch(f"/api/agents/{agent_id}/access", json={}, headers=auth)
    assert unchanged.status_code == 200, unchanged.text
    assert [skill["id"] for skill in unchanged.json()["skills"]] == [skill_b.json()["id"]]
