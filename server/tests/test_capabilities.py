"""Managed MCP server and skill API behavior."""

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


async def test_mcp_server_and_skill_crud_validation_and_scoping(client):
    a_token = await _signup(client, "cap-a@example.com")
    b_token = await _signup(client, "cap-b@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    b_auth = {"Authorization": f"Bearer {b_token}"}

    invalid_http = await client.post(
        "/api/mcp-servers",
        json={"name": "bad-http", "transport": "streamable_http"},
        headers=a_auth,
    )
    assert invalid_http.status_code == 400
    invalid_stdio = await client.post(
        "/api/mcp-servers",
        json={"name": "bad-stdio", "transport": "stdio"},
        headers=a_auth,
    )
    assert invalid_stdio.status_code == 400

    server = await client.post(
        "/api/mcp-servers",
        json={
            "name": "  filesystem  ",
            "transport": "stdio",
            "command": " npx ",
            "args": ["-y", "@modelcontextprotocol/server-filesystem"],
            "env": {"ROOT": "/repo"},
            "enabled_by_default": True,
        },
        headers=a_auth,
    )
    assert server.status_code == 201, server.text
    server_id = server.json()["id"]
    assert server.json()["name"] == "filesystem"
    assert server.json()["command"] == "npx"

    duplicate = await client.post(
        "/api/mcp-servers",
        json={"name": "filesystem", "transport": "stdio", "command": "node"},
        headers=a_auth,
    )
    assert duplicate.status_code == 409

    patched = await client.patch(
        f"/api/mcp-servers/{server_id}",
        json={
            "transport": "streamable_http",
            "url": " http://localhost:8000/mcp ",
            "command": "",
            "enabled_by_default": False,
        },
        headers=a_auth,
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["url"] == "http://localhost:8000/mcp"
    assert patched.json()["command"] is None
    assert patched.json()["enabled_by_default"] is False

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

    assert (await client.get("/api/mcp-servers", headers=b_auth)).json() == []
    assert (await client.get("/api/skills", headers=b_auth)).json() == []
    assert (await client.patch(f"/api/mcp-servers/{server_id}", json={}, headers=b_auth)).status_code == 404
    assert (await client.delete(f"/api/skills/{skill_id}", headers=b_auth)).status_code == 404


async def test_spawn_mcp_server_helper_is_idempotent_and_issues_user_scoped_token(client):
    token = await _signup(client, "spawn-mcp-helper@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    first = await client.post(
        "/api/mcp-servers/spawn",
        json={"name": "spawn", "enabled_by_default": True},
        headers=auth,
    )
    assert first.status_code == 201, first.text
    first_body = first.json()
    assert first_body["transport"] == "streamable_http"
    assert first_body["url"] == "http://localhost:8000/mcp"
    assert first_body["headers"]["Authorization"].startswith("Bearer ")
    assert first_body["enabled_by_default"] is True

    second = await client.post(
        "/api/mcp-servers/spawn",
        json={"name": "spawn", "enabled_by_default": False},
        headers=auth,
    )
    assert second.status_code == 201, second.text
    second_body = second.json()
    assert second_body["id"] == first_body["id"]
    assert second_body["enabled_by_default"] is False
    assert second_body["headers"]["Authorization"].startswith("Bearer ")


async def test_default_capabilities_launch_with_agent_and_cross_user_grants_do_not_leak(
    client,
):
    a_token = await _signup(client, "cap-launch-a@example.com")
    b_token = await _signup(client, "cap-launch-b@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    b_auth = {"Authorization": f"Bearer {b_token}"}

    a_mcp = await client.post(
        "/api/mcp-servers",
        json={
            "name": "spawn",
            "transport": "streamable_http",
            "url": "http://spawn.test/mcp",
            "headers": {"Authorization": "Bearer a"},
            "enabled_by_default": True,
        },
        headers=a_auth,
    )
    assert a_mcp.status_code == 201, a_mcp.text
    a_skill = await client.post(
        "/api/skills",
        json={
            "name": "spawn-skill",
            "content": "# Spawn\nUse the spawn MCP.",
            "enabled_by_default": True,
        },
        headers=a_auth,
    )
    assert a_skill.status_code == 201, a_skill.text
    b_mcp = await client.post(
        "/api/mcp-servers",
        json={"name": "other", "transport": "stdio", "command": "node"},
        headers=b_auth,
    )
    assert b_mcp.status_code == 201, b_mcp.text

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
    assert [server["id"] for server in sent["mcp_servers"]] == [a_mcp.json()["id"]]
    assert [skill["id"] for skill in sent["skills"]] == [a_skill.json()["id"]]

    denied = await client.post(
        "/api/agents",
        json={
            "host_id": host_id,
            "cwd": "/repo",
            "argv": ["codex"],
            "mcp_server_ids": [b_mcp.json()["id"]],
        },
        headers=a_auth,
    )
    assert denied.status_code == 404
    assert "mcp server not found" in denied.text

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


async def test_agent_access_patch_preserves_omitted_categories(client):
    token = await _signup(client, "cap-access-patch@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host_for_user("cap-access-patch@example.com")

    mcp = await client.post(
        "/api/mcp-servers",
        json={"name": "spawn", "transport": "streamable_http", "url": "http://spawn.test/mcp"},
        headers=auth,
    )
    assert mcp.status_code == 201, mcp.text
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
            "mcp_server_ids": [mcp.json()["id"]],
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
    assert [server["id"] for server in updated.json()["mcp_servers"]] == [mcp.json()["id"]]
    assert [skill["id"] for skill in updated.json()["skills"]] == [skill_b.json()["id"]]
