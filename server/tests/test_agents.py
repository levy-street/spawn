"""Agent definition API behavior (`/api/agents` — shortcuts, not processes)."""

from __future__ import annotations


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


async def test_builtins_are_seeded_without_shell(client):
    token = await _signup(client, "agent-defs-builtin-list@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.get("/api/agents", headers=auth)
    assert r.status_code == 200
    builtins = {a["name"]: a for a in r.json() if a["owner_user_id"] is None}
    assert set(builtins) == {"claude-code", "codex", "opencode", "aider-sonnet"}
    assert builtins["claude-code"]["command"] == "claude"
    assert builtins["aider-sonnet"]["command"] == "aider --model claude-sonnet-4-6"
    assert builtins["codex"]["install"].startswith("curl -fsSL")
    for agent in builtins.values():
        assert isinstance(agent["command"], str)
        assert "default_argv" not in agent
        assert "env_template" not in agent


async def test_user_agent_can_be_created_and_updated(client):
    token = await _signup(client, "agent-defs-owner@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.post(
        "/api/agents",
        json={
            "name": "custom-codex",
            "kind": "codex",
            "command": "codex --yolo",
            "env": {"FOO": "bar"},
            "install": "npm install -g codex",
        },
        headers=auth,
    )
    assert r.status_code == 201, r.text
    agent_id = r.json()["id"]
    assert r.json()["command"] == "codex --yolo"
    assert r.json()["env"] == {"FOO": "bar"}

    r = await client.patch(
        f"/api/agents/{agent_id}",
        json={
            "name": "custom-claude",
            "kind": "claude-code",
            "command": "claude --continue",
            "env": {"BAZ": "qux"},
            "install": None,
        },
        headers=auth,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "custom-claude"
    assert body["kind"] == "claude-code"
    assert body["command"] == "claude --continue"
    assert body["env"] == {"BAZ": "qux"}
    assert body["install"] is None


async def test_agent_requires_nonempty_command(client):
    token = await _signup(client, "agent-defs-command@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.post(
        "/api/agents",
        json={"name": "empty", "kind": "custom", "command": "   "},
        headers=auth,
    )
    assert r.status_code == 400


async def test_builtin_agents_cannot_be_updated_or_deleted(client):
    token = await _signup(client, "agent-defs-builtins@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.get("/api/agents", headers=auth)
    assert r.status_code == 200
    builtin = next(a for a in r.json() if a["owner_user_id"] is None)

    r = await client.patch(f"/api/agents/{builtin['id']}", json={"name": "renamed"}, headers=auth)
    assert r.status_code == 404
    r = await client.delete(f"/api/agents/{builtin['id']}", headers=auth)
    assert r.status_code == 404


async def test_other_users_agent_cannot_be_updated(client):
    owner_token = await _signup(client, "agent-defs-owner-2@example.com")
    other_token = await _signup(client, "agent-defs-other@example.com")

    r = await client.post(
        "/api/agents",
        json={"name": "private", "kind": "codex", "command": "codex"},
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert r.status_code == 201, r.text
    agent_id = r.json()["id"]

    r = await client.patch(
        f"/api/agents/{agent_id}",
        json={"name": "stolen"},
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert r.status_code == 404


async def test_duplicate_user_agent_name_returns_conflict(client):
    token = await _signup(client, "agent-defs-dupe@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    second_id = ""

    for name in ("first", "second"):
        r = await client.post(
            "/api/agents",
            json={"name": name, "kind": "codex", "command": "codex"},
            headers=auth,
        )
        assert r.status_code == 201, r.text
        if name == "second":
            second_id = r.json()["id"]

    r = await client.patch(f"/api/agents/{second_id}", json={"name": "first"}, headers=auth)
    assert r.status_code == 409
