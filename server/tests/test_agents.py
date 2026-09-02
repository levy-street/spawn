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
    assert set(builtins) == {"claude-code", "codex", "opencode", "aider-sonnet", "hermes"}
    assert builtins["claude-code"]["command"] == "claude"
    assert builtins["aider-sonnet"]["command"] == "aider --model claude-sonnet-4-6"
    assert builtins["codex"]["install"].startswith("curl -fsSL")
    assert builtins["hermes"]["command"] == "hermes"
    assert builtins["hermes"]["install"].startswith("curl -fsSL")
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


async def test_builtins_carry_a_yolo_spelling(client):
    token = await _signup(client, "agent-defs-yolo-builtins@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.get("/api/agents", headers=auth)
    builtins = {a["name"]: a for a in r.json() if a["owner_user_id"] is None}

    assert builtins["claude-code"]["yolo_args"] == "--dangerously-skip-permissions"
    assert builtins["codex"]["yolo_args"] == "--dangerously-bypass-approvals-and-sandbox"
    assert builtins["aider-sonnet"]["yolo_args"] == "--yes-always"
    assert builtins["hermes"]["yolo_args"] == "--yolo"
    # opencode has no flag; it is told through the environment instead.
    assert builtins["opencode"]["yolo_args"] is None
    assert "OPENCODE_PERMISSION" in builtins["opencode"]["yolo_env"]
    # Off until somebody asks for it.
    assert all(agent["yolo"] is False for agent in builtins.values())


async def test_yolo_preference_on_a_builtin_is_per_user(client):
    first = await _signup(client, "agent-defs-yolo-first@example.com")
    second = await _signup(client, "agent-defs-yolo-second@example.com")
    auth = {"Authorization": f"Bearer {first}"}
    other = {"Authorization": f"Bearer {second}"}

    listing = (await client.get("/api/agents", headers=auth)).json()
    claude = next(a for a in listing if a["name"] == "claude-code")

    r = await client.patch(
        f"/api/agents/{claude['id']}/preferences", json={"yolo": True}, headers=auth
    )
    assert r.status_code == 200, r.text
    assert r.json()["yolo"] is True
    # The definition itself is untouched — it is shared with everyone.
    assert r.json()["owner_user_id"] is None

    again = (await client.get("/api/agents", headers=auth)).json()
    assert next(a for a in again if a["id"] == claude["id"])["yolo"] is True

    theirs = (await client.get("/api/agents", headers=other)).json()
    assert next(a for a in theirs if a["id"] == claude["id"])["yolo"] is False

    r = await client.patch(
        f"/api/agents/{claude['id']}/preferences", json={"yolo": False}, headers=auth
    )
    assert r.json()["yolo"] is False


async def test_yolo_cannot_be_turned_on_without_a_spelling(client):
    token = await _signup(client, "agent-defs-yolo-empty@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.post(
        "/api/agents",
        json={"name": "plain", "kind": "custom", "command": "plain-agent"},
        headers=auth,
    )
    agent_id = r.json()["id"]
    assert r.json()["yolo_args"] is None

    r = await client.patch(f"/api/agents/{agent_id}/preferences", json={"yolo": True}, headers=auth)
    assert r.status_code == 400

    # Give it one, and the toggle takes.
    r = await client.patch(f"/api/agents/{agent_id}", json={"yolo_args": " --go "}, headers=auth)
    assert r.json()["yolo_args"] == "--go"
    r = await client.patch(f"/api/agents/{agent_id}/preferences", json={"yolo": True}, headers=auth)
    assert r.status_code == 200
    assert r.json()["yolo"] is True


async def test_yolo_preference_on_another_users_agent_is_not_found(client):
    owner_token = await _signup(client, "agent-defs-yolo-owner@example.com")
    other_token = await _signup(client, "agent-defs-yolo-stranger@example.com")

    r = await client.post(
        "/api/agents",
        json={"name": "mine", "kind": "custom", "command": "mine", "yolo_args": "--go"},
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    agent_id = r.json()["id"]

    r = await client.patch(
        f"/api/agents/{agent_id}/preferences",
        json={"yolo": True},
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert r.status_code == 404
