"""Session metadata and lifecycle API behavior."""

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


async def _create_host(email: str, *, name: str = "box", status: str = "online") -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        host = Host(owner_user_id=user.id, name=name, status=status)
        session.add(host)
        await session.commit()
        return host.id


async def _create_session_row(email: str, host_id: str, **kwargs) -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Session, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        row = Session(
            owner_user_id=user.id,
            host_id=host_id,
            cwd=kwargs.pop("cwd", "/repo"),
            status=kwargs.pop("status", "running"),
            **kwargs,
        )
        session.add(row)
        await session.commit()
        return row.id


async def test_session_patch_name_and_delete(client):
    token = await _signup(client, "session-owner@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("session-owner@example.com", status="offline")
    session_id = await _create_session_row("session-owner@example.com", host_id)

    r = await client.patch(
        f"/api/sessions/{session_id}", json={"name": "  ui work  "}, headers=auth
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "ui work"

    # Clearing the name falls back to null; archived/pinned are retired.
    r = await client.patch(f"/api/sessions/{session_id}", json={"name": ""}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["name"] is None
    assert "archived_at" not in r.json()
    assert "pinned_at" not in r.json()

    r = await client.delete(f"/api/sessions/{session_id}", headers=auth)
    assert r.status_code == 204, r.text

    r = await client.get(f"/api/sessions/{session_id}", headers=auth)
    assert r.status_code == 404


async def test_session_create_defaults_name_from_host_and_cwd(client):
    token = await _signup(client, "default-name@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("default-name@example.com", name="dream", status="offline")

    r = await client.post(
        "/api/sessions",
        json={"host_id": host_id, "cwd": "/home/oem/projects/spawn"},
        headers=auth,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "dream - spawn"
    assert body["host_name"] == "dream"
    assert body["foreground_command"] is None
    # The launch surface is gone from the API shape entirely.
    assert "argv" not in body
    assert "env" not in body
    assert "preset_id" not in body


async def test_session_create_rejects_retired_launch_fields(client):
    token = await _signup(client, "no-argv@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("no-argv@example.com")

    r = await client.post(
        "/api/sessions",
        json={"host_id": host_id, "cwd": "/repo", "argv": ["codex"]},
        headers=auth,
    )
    # Sessions are always the login shell; argv/env/preset_id no longer exist.
    assert r.status_code == 201, r.text

    sessions = await client.get("/api/sessions", headers=auth)
    assert sessions.status_code == 200
    assert "include_archived" not in sessions.request.url.query.decode()


async def test_session_create_dispatches_shell_frame_and_skills(client):
    token = await _signup(client, "session-capabilities@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from spawn_server.ws.broker import DaemonConn, get_broker

    skill = await client.post(
        "/api/skills",
        json={
            "name": "spawn-test",
            "description": "test skill",
            "content": "# Spawn Test\nUse Spawn.",
        },
        headers=auth,
    )
    assert skill.status_code == 201, skill.text

    host_id = await _create_host("session-capabilities@example.com")

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    r = await client.post(
        "/api/sessions",
        json={
            "name": "capability session",
            "host_id": host_id,
            "cwd": "/tmp",
            "skill_ids": [skill.json()["id"]],
        },
        headers=auth,
    )
    assert r.status_code == 201, r.text

    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "session.create"
    assert sent["session_id"] == r.json()["id"]
    assert sent["cwd"] == "/tmp"
    assert sent["create_cwd"] is True
    # No launch surface on the wire: the daemon spawns the login shell.
    assert "argv" not in sent
    assert "env" not in sent
    assert "install" not in sent
    assert sent["skills"][0]["name"] == "spawn-test"
    assert sent["skills"][0]["content"] == "# Spawn Test\nUse Spawn."

    access = await client.get(f"/api/sessions/{r.json()['id']}/access", headers=auth)
    assert access.status_code == 200, access.text
    assert access.json()["session_id"] == r.json()["id"]
    assert access.json()["skills"][0]["id"] == skill.json()["id"]

    await broker.unregister_daemon(daemon)


async def test_session_create_upserts_recent_dirs(client):
    token = await _signup(client, "recent-dirs@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("recent-dirs@example.com")

    for index in range(10):
        r = await client.post(
            "/api/sessions",
            json={"host_id": host_id, "cwd": f"/repo/{index}"},
            headers=auth,
        )
        assert r.status_code == 201, r.text

    # Re-use one of the older paths so it jumps back to the top.
    r = await client.post(
        "/api/sessions", json={"host_id": host_id, "cwd": "/repo/5"}, headers=auth
    )
    assert r.status_code == 201

    dirs = await client.get(f"/api/hosts/{host_id}/recent-dirs", headers=auth)
    assert dirs.status_code == 200, dirs.text
    paths = [entry["path"] for entry in dirs.json()["dirs"]]
    assert len(paths) <= 8
    assert paths[0] == "/repo/5"
    # The oldest entries fell off the capped list.
    assert "/repo/0" not in paths
    assert "/repo/1" not in paths


async def test_session_create_appends_workspace_tile(client):
    token = await _signup(client, "tile-append@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("tile-append@example.com")

    ws = await client.post("/api/workspaces", json={"name": "grid"}, headers=auth)
    assert ws.status_code == 201, ws.text
    workspace_id = ws.json()["workspace"]["id"]

    # Auto-place: first session takes the whole canvas.
    first = await client.post(
        "/api/sessions",
        json={"host_id": host_id, "cwd": "/one", "workspace_id": workspace_id},
        headers=auth,
    )
    assert first.status_code == 201, first.text
    layout = (await client.get(f"/api/workspaces/{workspace_id}", headers=auth)).json()["layout"]
    assert layout["tabs"][0]["layout"]["tiles"] == [
        {"session_id": first.json()["id"], "x": 0, "y": 0, "w": 12, "h": 12}
    ]

    # Second session splits the full-canvas tile.
    second = await client.post(
        "/api/sessions",
        json={"host_id": host_id, "cwd": "/two", "workspace_id": workspace_id},
        headers=auth,
    )
    assert second.status_code == 201, second.text
    layout = (await client.get(f"/api/workspaces/{workspace_id}", headers=auth)).json()["layout"]
    by_id = {tile["session_id"]: tile for tile in layout["tabs"][0]["layout"]["tiles"]}
    assert by_id[first.json()["id"]] == {
        "session_id": first.json()["id"], "x": 0, "y": 0, "w": 6, "h": 12
    }
    assert by_id[second.json()["id"]] == {
        "session_id": second.json()["id"], "x": 6, "y": 0, "w": 6, "h": 12
    }


async def test_session_create_explicit_tile_validation(client):
    token = await _signup(client, "tile-explicit@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("tile-explicit@example.com")

    ws = await client.post("/api/workspaces", json={"name": "grid"}, headers=auth)
    workspace_id = ws.json()["workspace"]["id"]

    ok = await client.post(
        "/api/sessions",
        json={
            "host_id": host_id,
            "cwd": "/one",
            "workspace_id": workspace_id,
            "tile": {"x": 0, "y": 0, "w": 6, "h": 12},
        },
        headers=auth,
    )
    assert ok.status_code == 201, ok.text

    # Overlapping explicit tile -> 400, and no session is created.
    bad = await client.post(
        "/api/sessions",
        json={
            "host_id": host_id,
            "cwd": "/two",
            "workspace_id": workspace_id,
            "tile": {"x": 3, "y": 0, "w": 6, "h": 12},
        },
        headers=auth,
    )
    assert bad.status_code == 400, bad.text
    sessions = (await client.get("/api/sessions", headers=auth)).json()
    assert len(sessions) == 1

    # Out-of-bounds explicit tile -> 400.
    bad = await client.post(
        "/api/sessions",
        json={
            "host_id": host_id,
            "cwd": "/three",
            "workspace_id": workspace_id,
            "tile": {"x": 10, "y": 0, "w": 6, "h": 12},
        },
        headers=auth,
    )
    assert bad.status_code == 400

    # A tile without a workspace is meaningless.
    bad = await client.post(
        "/api/sessions",
        json={"host_id": host_id, "cwd": "/four", "tile": {"x": 0, "y": 0, "w": 3, "h": 3}},
        headers=auth,
    )
    assert bad.status_code == 400


async def test_session_activity_fields(client):
    token = await _signup(client, "session-activity@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("session-activity@example.com")
    now = datetime.now(UTC)
    session_id = await _create_session_row(
        "session-activity@example.com",
        host_id,
        last_output_at=now - timedelta(seconds=30),
    )

    r = await client.get(f"/api/sessions/{session_id}", headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["activity_state"] == "waiting"
    assert body["activity_label"] == "Awaiting input"
    assert body["last_output_at"] is not None
    assert body["last_activity_at"] is not None


async def test_session_restart_dispatches_shell_respawn(client):
    token = await _signup(client, "session-restart@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from spawn_server.ws.broker import DaemonConn, get_broker

    host_id = await _create_host("session-restart@example.com")
    session_id = await _create_session_row(
        "session-restart@example.com",
        host_id,
        foreground_command="claude",
    )

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    r = await client.post(f"/api/sessions/{session_id}/restart", headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "starting"
    # A restarted session is a fresh shell; the stale foreground label clears.
    assert r.json()["foreground_command"] is None
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "session.restart"
    assert sent["session_id"] == session_id
    assert sent["cwd"] == "/repo"
    assert "argv" not in sent
    assert "env" not in sent
    assert "install" not in sent

    await broker.unregister_daemon(daemon)


async def test_session_cross_user_scoping(client):
    owner_token = await _signup(client, "session-scope-a@example.com")
    other_token = await _signup(client, "session-scope-b@example.com")
    host_id = await _create_host("session-scope-a@example.com")
    session_id = await _create_session_row("session-scope-a@example.com", host_id)
    other = {"Authorization": f"Bearer {other_token}"}
    owner = {"Authorization": f"Bearer {owner_token}"}

    assert (await client.get("/api/sessions", headers=other)).json() == []
    assert (await client.get(f"/api/sessions/{session_id}", headers=other)).status_code == 404
    assert (
        await client.patch(f"/api/sessions/{session_id}", json={"name": "x"}, headers=other)
    ).status_code == 404
    assert (await client.delete(f"/api/sessions/{session_id}", headers=other)).status_code == 404
    assert (await client.get(f"/api/sessions/{session_id}", headers=owner)).status_code == 200
