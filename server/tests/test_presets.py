"""Preset API behavior."""

from __future__ import annotations


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


async def test_user_preset_can_be_updated(client):
    token = await _signup(client, "preset-owner@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.post(
        "/api/presets",
        json={
            "name": "custom-codex",
            "agent_kind": "codex",
            "default_argv": ["codex"],
            "env_template": {"FOO": "bar"},
            "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
        },
        headers=auth,
    )
    assert r.status_code == 201, r.text
    preset_id = r.json()["id"]

    r = await client.patch(
        f"/api/presets/{preset_id}",
        json={
            "name": "custom-shell",
            "agent_kind": "shell",
            "default_argv": ["bash", "-l"],
            "env_template": {"BAZ": "qux"},
            "install": None,
        },
        headers=auth,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "custom-shell"
    assert body["agent_kind"] == "shell"
    assert body["default_argv"] == ["bash", "-l"]
    assert body["env_template"] == {"BAZ": "qux"}
    assert body["install"] is None


async def test_builtin_presets_cannot_be_updated(client):
    token = await _signup(client, "preset-builtins@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.get("/api/presets", headers=auth)
    assert r.status_code == 200
    builtin = next(p for p in r.json() if p["owner_user_id"] is None)

    r = await client.patch(
        f"/api/presets/{builtin['id']}",
        json={"name": "renamed"},
        headers=auth,
    )
    assert r.status_code == 404


async def test_other_users_preset_cannot_be_updated(client):
    owner_token = await _signup(client, "preset-owner-2@example.com")
    other_token = await _signup(client, "preset-other@example.com")

    r = await client.post(
        "/api/presets",
        json={"name": "private", "agent_kind": "codex", "default_argv": ["codex"]},
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert r.status_code == 201, r.text
    preset_id = r.json()["id"]

    r = await client.patch(
        f"/api/presets/{preset_id}",
        json={"name": "stolen"},
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert r.status_code == 404


async def test_duplicate_user_preset_name_returns_conflict(client):
    token = await _signup(client, "preset-dupe@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    second_id = ""

    for name in ("first", "second"):
        r = await client.post(
            "/api/presets",
            json={"name": name, "agent_kind": "codex", "default_argv": ["codex"]},
            headers=auth,
        )
        assert r.status_code == 201, r.text
        if name == "second":
            second_id = r.json()["id"]

    r = await client.patch(f"/api/presets/{second_id}", json={"name": "first"}, headers=auth)
    assert r.status_code == 409
