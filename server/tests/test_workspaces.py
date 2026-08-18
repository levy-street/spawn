"""Workspace CRUD, grid-v2 layout validation, ordering, and deletion."""

from __future__ import annotations

import json


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


async def _create_host(email: str, *, name: str = "box") -> str:
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


async def _create_session_row(email: str, host_id: str) -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Session, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        row = Session(owner_user_id=user.id, host_id=host_id, cwd="/repo", status="running")
        session.add(row)
        await session.commit()
        return row.id


def _tile(session_id: str, x: int, y: int, w: int, h: int) -> dict:
    return {"session_id": session_id, "x": x, "y": y, "w": w, "h": h}


async def test_workspace_crud_and_cross_user_scoping(client):
    a_token = await _signup(client, "ws-a@example.com")
    b_token = await _signup(client, "ws-b@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    b_auth = {"Authorization": f"Bearer {b_token}"}
    host_id = await _create_host("ws-a@example.com")
    one = await _create_session_row("ws-a@example.com", host_id)
    two = await _create_session_row("ws-a@example.com", host_id)

    created = await client.post("/api/workspaces", json={"name": "  daily drive  "}, headers=a_auth)
    assert created.status_code == 201, created.text
    workspace = created.json()["workspace"]
    assert workspace["name"] == "daily drive"
    assert workspace["layout"] == {"version": 2, "tiles": []}
    assert workspace["position"] == 0
    assert created.json()["session"] is None
    workspace_id = workspace["id"]

    layout = {
        "version": 2,
        "tiles": [_tile(one, 0, 0, 6, 12), _tile(two, 6, 0, 6, 12)],
    }
    patched = await client.patch(
        f"/api/workspaces/{workspace_id}", json={"layout": layout}, headers=a_auth
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["layout"] == layout

    listed = await client.get("/api/workspaces", headers=a_auth)
    assert [row["id"] for row in listed.json()] == [workspace_id]

    renamed = await client.patch(
        f"/api/workspaces/{workspace_id}", json={"name": "focus"}, headers=a_auth
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "focus"

    blank = await client.patch(
        f"/api/workspaces/{workspace_id}", json={"name": "   "}, headers=a_auth
    )
    assert blank.status_code == 400

    assert (await client.get("/api/workspaces", headers=b_auth)).json() == []
    assert (await client.get(f"/api/workspaces/{workspace_id}", headers=b_auth)).status_code == 404
    assert (
        await client.patch(f"/api/workspaces/{workspace_id}", json={"name": "x"}, headers=b_auth)
    ).status_code == 404
    assert (
        await client.delete(f"/api/workspaces/{workspace_id}", headers=b_auth)
    ).status_code == 404

    deleted = await client.delete(f"/api/workspaces/{workspace_id}", headers=a_auth)
    assert deleted.status_code == 204
    assert (await client.get("/api/workspaces", headers=a_auth)).json() == []


async def test_workspace_default_names_use_next_free_number(client):
    token = await _signup(client, "ws-names@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    first = await client.post("/api/workspaces", json={}, headers=auth)
    second = await client.post("/api/workspaces", json={}, headers=auth)
    assert first.json()["workspace"]["name"] == "Workspace 1"
    assert second.json()["workspace"]["name"] == "Workspace 2"
    assert second.json()["workspace"]["position"] == 1

    # Freeing "Workspace 1" makes N=1 available again.
    await client.delete(f"/api/workspaces/{first.json()['workspace']['id']}", headers=auth)
    third = await client.post("/api/workspaces", json={}, headers=auth)
    assert third.json()["workspace"]["name"] == "Workspace 1"


async def test_workspace_create_with_first_session(client):
    token = await _signup(client, "ws-first@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("ws-first@example.com", name="dream")

    from spawn_server.ws.broker import DaemonConn, get_broker

    class _FakeWS:
        def __init__(self):
            self.sent_text = []

        async def send_text(self, value):
            self.sent_text.append(value)

        async def close(self, code=1000, reason=""):
            pass

    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await get_broker().register_daemon(daemon)

    r = await client.post(
        "/api/workspaces",
        json={"first_session": {"host_id": host_id, "cwd": "/home/oem"}},
        headers=auth,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    session = body["session"]
    assert session is not None
    assert session["host_name"] == "dream"
    assert body["workspace"]["layout"]["tiles"] == [
        _tile(session["id"], 0, 0, 12, 12)
    ]
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "session.create"
    assert sent["session_id"] == session["id"]

    await get_broker().unregister_daemon(daemon)


async def test_workspace_layout_prunes_foreign_and_duplicate_sessions(client):
    a_token = await _signup(client, "ws-owner@example.com")
    await _signup(client, "ws-intruder@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    own_host = await _create_host("ws-owner@example.com")
    foreign_host = await _create_host("ws-intruder@example.com")
    own_session = await _create_session_row("ws-owner@example.com", own_host)
    foreign_session = await _create_session_row("ws-intruder@example.com", foreign_host)

    created = await client.post("/api/workspaces", json={"name": "mixed"}, headers=a_auth)
    workspace_id = created.json()["workspace"]["id"]

    # A foreign session's tile is pruned, not rejected.
    r = await client.patch(
        f"/api/workspaces/{workspace_id}",
        json={
            "layout": {
                "version": 2,
                "tiles": [_tile(own_session, 0, 0, 6, 12), _tile(foreign_session, 6, 0, 6, 12)],
            }
        },
        headers=a_auth,
    )
    assert r.status_code == 200, r.text
    assert r.json()["layout"]["tiles"] == [_tile(own_session, 0, 0, 6, 12)]

    # Duplicate tiles for one session keep only the first occurrence.
    r = await client.patch(
        f"/api/workspaces/{workspace_id}",
        json={
            "layout": {
                "version": 2,
                "tiles": [_tile(own_session, 0, 0, 6, 12), _tile(own_session, 6, 0, 6, 12)],
            }
        },
        headers=a_auth,
    )
    assert r.status_code == 200
    assert r.json()["layout"]["tiles"] == [_tile(own_session, 0, 0, 6, 12)]


async def test_workspace_layout_rejects_grid_invariant_violations(client):
    token = await _signup(client, "ws-invalid@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("ws-invalid@example.com")
    sessions = [await _create_session_row("ws-invalid@example.com", host_id) for _ in range(9)]

    created = await client.post("/api/workspaces", json={"name": "grid"}, headers=auth)
    workspace_id = created.json()["workspace"]["id"]

    async def patch_layout(tiles):
        return await client.patch(
            f"/api/workspaces/{workspace_id}",
            json={"layout": {"version": 2, "tiles": tiles}},
            headers=auth,
        )

    # Overlap.
    r = await patch_layout([_tile(sessions[0], 0, 0, 6, 6), _tile(sessions[1], 3, 3, 6, 6)])
    assert r.status_code == 400

    # Below the 3x3 minimum.
    r = await patch_layout([_tile(sessions[0], 0, 0, 2, 12)])
    assert r.status_code == 400

    # Out of bounds.
    r = await patch_layout([_tile(sessions[0], 10, 0, 6, 6)])
    assert r.status_code == 400

    # More than 8 tiles.
    nine = [
        _tile(sessions[i], (i % 4) * 3, (i // 4) * 3, 3, 3) for i in range(9)
    ]
    r = await patch_layout(nine)
    assert r.status_code in (400, 422)

    # Wrong version marker fails schema validation.
    r = await client.patch(
        f"/api/workspaces/{workspace_id}",
        json={"layout": {"version": 1, "tiles": []}},
        headers=auth,
    )
    assert r.status_code == 422

    # Emptying the layout is fine — no ephemeral/410 behavior anymore.
    r = await patch_layout([])
    assert r.status_code == 200
    assert r.json()["layout"] == {"version": 2, "tiles": []}
    assert (await client.get(f"/api/workspaces/{workspace_id}", headers=auth)).status_code == 200


async def test_workspace_position_reordering(client):
    token = await _signup(client, "ws-order@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    ids = []
    for name in ("alpha", "beta", "gamma"):
        r = await client.post("/api/workspaces", json={"name": name}, headers=auth)
        ids.append(r.json()["workspace"]["id"])

    # Move gamma to the front; the rest renumber contiguously.
    r = await client.patch(f"/api/workspaces/{ids[2]}", json={"position": 0}, headers=auth)
    assert r.status_code == 200
    assert r.json()["position"] == 0

    listed = (await client.get("/api/workspaces", headers=auth)).json()
    assert [row["name"] for row in listed] == ["gamma", "alpha", "beta"]
    assert [row["position"] for row in listed] == [0, 1, 2]


async def test_workspace_delete_kills_and_deletes_its_sessions(client):
    token = await _signup(client, "ws-delete@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("ws-delete@example.com")
    inside = await _create_session_row("ws-delete@example.com", host_id)
    outside = await _create_session_row("ws-delete@example.com", host_id)

    from spawn_server.ws.broker import DaemonConn, get_broker

    class _FakeWS:
        def __init__(self):
            self.sent_text = []

        async def send_text(self, value):
            self.sent_text.append(value)

        async def close(self, code=1000, reason=""):
            pass

    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await get_broker().register_daemon(daemon)

    created = await client.post("/api/workspaces", json={"name": "doomed"}, headers=auth)
    workspace_id = created.json()["workspace"]["id"]
    r = await client.patch(
        f"/api/workspaces/{workspace_id}",
        json={"layout": {"version": 2, "tiles": [_tile(inside, 0, 0, 12, 12)]}},
        headers=auth,
    )
    assert r.status_code == 200

    deleted = await client.delete(f"/api/workspaces/{workspace_id}", headers=auth)
    assert deleted.status_code == 204

    kills = [json.loads(f) for f in fake_ws.sent_text if json.loads(f)["type"] == "session.kill"]
    assert [k["session_id"] for k in kills] == [inside]

    assert (await client.get(f"/api/sessions/{inside}", headers=auth)).status_code == 404
    assert (await client.get(f"/api/sessions/{outside}", headers=auth)).status_code == 200

    await get_broker().unregister_daemon(daemon)
