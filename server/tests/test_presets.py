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
            "install": "npm install -g @openai/codex",
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


async def test_builtin_presets_are_resynchronized(client):
    token = await _signup(client, "preset-resync@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Preset
    from spawn_server.presets import BUILTIN_PRESETS, seed_builtin_presets

    sm = get_sessionmaker()
    async with sm() as session:
        preset = (
            await session.execute(
                select(Preset).where(Preset.owner_user_id.is_(None), Preset.name == "codex")
            )
        ).scalar_one()
        preset.agent_kind = "stale"
        preset.default_argv = ["old-codex"]
        preset.env_template = {"OLD": "1"}
        preset.install = None
        await session.commit()

    async with sm() as session:
        await seed_builtin_presets(session)

    r = await client.get("/api/presets", headers=auth)
    assert r.status_code == 200
    codex = next(p for p in r.json() if p["name"] == "codex")
    expected = next(p for p in BUILTIN_PRESETS if p["name"] == "codex")
    assert codex["agent_kind"] == expected["agent_kind"]
    assert codex["default_argv"] == expected["default_argv"]
    assert codex["env_template"] == expected["env_template"]
    assert codex["install"] == expected["install"]


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


async def test_preset_default_argv_is_required(client):
    token = await _signup(client, "preset-empty-argv@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.post(
        "/api/presets",
        json={"name": "empty", "agent_kind": "shell", "default_argv": []},
        headers=auth,
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "default argv is required"

    r = await client.post(
        "/api/presets",
        json={"name": "blank", "agent_kind": "shell", "default_argv": ["  "]},
        headers=auth,
    )
    assert r.status_code == 400

    r = await client.post(
        "/api/presets",
        json={"name": "ok", "agent_kind": "shell", "default_argv": ["bash", "-l"]},
        headers=auth,
    )
    assert r.status_code == 201, r.text
    preset_id = r.json()["id"]

    r = await client.patch(
        f"/api/presets/{preset_id}",
        json={"default_argv": []},
        headers=auth,
    )
    assert r.status_code == 400
