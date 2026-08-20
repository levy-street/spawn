"""Workspace CRUD, layout-v3 tab envelopes, grid validation, ordering, deletion."""

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


def _envelope(tiles: list[dict], *, extra_tabs: list[dict] | None = None) -> dict:
    """A v3 layout: `tiles` in the default tab, plus optional extra tabs.

    Every tab is filled out with the folder keys the server always echoes, so
    callers keep writing the short form and still compare equal to a response.
    """
    tabs = [{"id": "tab-1", "name": "Tab 1", "layout": {"version": 3, "tiles": tiles}}]
    tabs.extend(extra_tabs or [])
    return {
        "version": 3,
        "active_tab": "tab-1",
        "tabs": [{"host_id": None, "cwd": None, **tab} for tab in tabs],
    }


def _tab_tiles(workspace: dict, tab_id: str = "tab-1") -> list[dict]:
    tab = next(t for t in workspace["layout"]["tabs"] if t["id"] == tab_id)
    return tab["layout"]["tiles"]


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
    assert workspace["layout"] == _envelope([])
    assert workspace["position"] == 0
    assert created.json()["session"] is None
    workspace_id = workspace["id"]

    layout = _envelope([_tile(one, 0, 0, 12, 24), _tile(two, 12, 0, 12, 24)])
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

    # A workspace created without a first session has no home until patched.
    assert renamed.json()["host_id"] is None
    assert renamed.json()["cwd"] is None
    rehomed = await client.patch(
        f"/api/workspaces/{workspace_id}",
        json={"host_id": host_id, "cwd": "/repo/app"},
        headers=a_auth,
    )
    assert rehomed.status_code == 200
    assert rehomed.json()["host_id"] == host_id
    assert rehomed.json()["cwd"] == "/repo/app"
    assert (
        await client.patch(
            f"/api/workspaces/{workspace_id}", json={"cwd": "   "}, headers=a_auth
        )
    ).status_code == 400
    foreign_host = await _create_host("ws-b@example.com")
    assert (
        await client.patch(
            f"/api/workspaces/{workspace_id}", json={"host_id": foreign_host}, headers=a_auth
        )
    ).status_code == 404

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


def test_workspace_names_come_from_the_folder_they_open_in():
    from spawn_server.routes.workspaces import _unique_name, name_from_cwd

    assert name_from_cwd("/Users/charlie/dev/singingcoach") == "singingcoach"
    assert name_from_cwd("~/dev/singingcoach/") == "singingcoach"
    assert name_from_cwd("~") == "Home"
    assert name_from_cwd("/") is None
    assert name_from_cwd("   ") is None

    # A second workspace in the same folder takes the next free suffix.
    assert _unique_name("singingcoach", set()) == "singingcoach"
    assert _unique_name("singingcoach", {"singingcoach"}) == "singingcoach 2"
    assert _unique_name("singingcoach", {"singingcoach", "singingcoach 2"}) == "singingcoach 3"


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
    # The workspace is named after the folder it was opened in, and that
    # host/folder becomes its home for every later session.
    assert body["workspace"]["name"] == "oem"
    assert body["workspace"]["host_id"] == host_id
    assert body["workspace"]["cwd"] == "/home/oem"
    assert _tab_tiles(body["workspace"]) == [_tile(session["id"], 0, 0, 24, 24)]
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
            "layout": _envelope(
                [_tile(own_session, 0, 0, 12, 24), _tile(foreign_session, 12, 0, 12, 24)]
            )
        },
        headers=a_auth,
    )
    assert r.status_code == 200, r.text
    assert _tab_tiles(r.json()) == [_tile(own_session, 0, 0, 12, 24)]

    # Duplicate tiles for one session keep only the first occurrence.
    r = await client.patch(
        f"/api/workspaces/{workspace_id}",
        json={
            "layout": _envelope(
                [_tile(own_session, 0, 0, 12, 24), _tile(own_session, 12, 0, 12, 24)]
            )
        },
        headers=a_auth,
    )
    assert r.status_code == 200
    assert _tab_tiles(r.json()) == [_tile(own_session, 0, 0, 12, 24)]

    # A session in two tabs keeps only its first-tab tile: it lives in one tab.
    r = await client.patch(
        f"/api/workspaces/{workspace_id}",
        json={
            "layout": _envelope(
                [_tile(own_session, 0, 0, 12, 24)],
                extra_tabs=[
                    {
                        "id": "tab-2",
                        "name": "Tab 2",
                        "layout": {
                            "version": 3,
                            "tiles": [_tile(own_session, 0, 0, 24, 24)],
                        },
                    }
                ],
            )
        },
        headers=a_auth,
    )
    assert r.status_code == 200
    assert _tab_tiles(r.json()) == [_tile(own_session, 0, 0, 12, 24)]
    assert _tab_tiles(r.json(), "tab-2") == []


async def test_tab_folder_round_trips_and_drops_hosts_that_are_not_yours(client):
    """A tab's own host/folder is where its windows open; null inherits the
    workspace's home. A tab pointed at someone else's host goes back to
    inheriting rather than failing the write — the same treatment a tile whose
    session is not yours gets."""
    a_token = await _signup(client, "ws-tabhome@example.com")
    await _signup(client, "ws-tabhome-other@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    own_host = await _create_host("ws-tabhome@example.com")
    foreign_host = await _create_host("ws-tabhome-other@example.com")

    created = await client.post("/api/workspaces", json={"name": "homes"}, headers=a_auth)
    workspace_id = created.json()["workspace"]["id"]
    # A fresh workspace's tab has no folder of its own.
    assert created.json()["workspace"]["layout"]["tabs"][0]["host_id"] is None

    layout = _envelope(
        [],
        extra_tabs=[
            {
                "id": "tab-2",
                "name": "Tab 2",
                "host_id": foreign_host,
                "cwd": "/somewhere/else",
                "layout": {"version": 3, "tiles": []},
            }
        ],
    )
    layout["tabs"][0]["host_id"] = own_host
    layout["tabs"][0]["cwd"] = "/repo"
    r = await client.patch(f"/api/workspaces/{workspace_id}", json={"layout": layout}, headers=a_auth)
    assert r.status_code == 200, r.text
    tabs = r.json()["layout"]["tabs"]
    assert (tabs[0]["host_id"], tabs[0]["cwd"]) == (own_host, "/repo")
    assert (tabs[1]["host_id"], tabs[1]["cwd"]) == (None, None)

    # And it survives a plain read.
    r = await client.get(f"/api/workspaces/{workspace_id}", headers=a_auth)
    assert r.json()["layout"]["tabs"][0]["cwd"] == "/repo"


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
            json={"layout": _envelope(tiles)},
            headers=auth,
        )

    # Overlap.
    r = await patch_layout([_tile(sessions[0], 0, 0, 12, 12), _tile(sessions[1], 6, 6, 12, 12)])
    assert r.status_code == 400

    # Below the 2x2 minimum.
    r = await patch_layout([_tile(sessions[0], 0, 0, 2, 24)])
    assert r.status_code == 400

    # Out of bounds.
    r = await patch_layout([_tile(sessions[0], 20, 0, 12, 12)])
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
        json={"layout": {"version": 3, "tiles": []}},
        headers=auth,
    )
    assert r.status_code == 422

    # A tabless envelope fails schema validation: a workspace always has a tab.
    r = await client.patch(
        f"/api/workspaces/{workspace_id}",
        json={"layout": {"version": 3, "tabs": []}},
        headers=auth,
    )
    assert r.status_code == 422

    # Duplicate tab ids are rejected.
    r = await client.patch(
        f"/api/workspaces/{workspace_id}",
        json={
            "layout": {
                "version": 3,
                "tabs": [
                    {"id": "t", "name": "A", "layout": {"version": 3, "tiles": []}},
                    {"id": "t", "name": "B", "layout": {"version": 3, "tiles": []}},
                ],
            }
        },
        headers=auth,
    )
    assert r.status_code == 400

    # active_tab must name a tab.
    r = await client.patch(
        f"/api/workspaces/{workspace_id}",
        json={
            "layout": {
                "version": 3,
                "active_tab": "ghost",
                "tabs": [
                    {"id": "t", "name": "A", "layout": {"version": 3, "tiles": []}}
                ],
            }
        },
        headers=auth,
    )
    assert r.status_code == 400

    # Emptying the layout is fine — no ephemeral/410 behavior anymore.
    r = await patch_layout([])
    assert r.status_code == 200
    assert r.json()["layout"] == _envelope([])
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
        json={"layout": _envelope([_tile(inside, 0, 0, 24, 24)])},
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


async def test_unmigrated_v2_grid_is_lifted_on_read_not_relabelled(client):
    """A database that has not run migration 0037 still serves usable geometry.

    The stored grid says v2 (12x12); the response must say v3 with coordinates
    scaled to match — relabelling without scaling would render every pane at
    half size, which is the failure mode the version marker exists to prevent.
    """
    token = await _signup(client, "unmigrated@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    r = await client.post("/api/workspaces", json={"name": "legacy"}, headers=auth)
    workspace_id = r.json()["workspace"]["id"]

    # Reach past the API to plant a pre-migration row, the way a real database
    # mid-deploy would look.
    from sqlalchemy import text as _text

    from spawn_server import db as _db

    stored = {
        "version": 3,
        "active_tab": "tab-1",
        "tabs": [
            {
                "id": "tab-1",
                "name": "Tab 1",
                "layout": {"version": 2, "tiles": [{"session_id": "s", "x": 0, "y": 0, "w": 6, "h": 12}]},
            }
        ],
    }
    async with _db.get_sessionmaker()() as session:
        await session.execute(
            _text("UPDATE workspaces SET layout = :layout WHERE id = :id"),
            {"layout": json.dumps(stored), "id": workspace_id},
        )
        await session.commit()

    got = (await client.get(f"/api/workspaces/{workspace_id}", headers=auth)).json()
    tab = got["layout"]["tabs"][0]["layout"]
    assert tab["version"] == 3
    assert [(t["x"], t["y"], t["w"], t["h"]) for t in tab["tiles"]] == [(0, 0, 12, 24)]


# ---------- archive / restore ----------


class _FakeWS:
    """A daemon socket that records what the server sent it."""

    def __init__(self) -> None:
        self.sent_text: list[str] = []

    async def send_text(self, value):
        self.sent_text.append(value)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        pass


async def _register_daemon(host_id: str):
    from spawn_server.ws.broker import DaemonConn, get_broker

    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await get_broker().register_daemon(daemon)
    return fake_ws, daemon


async def _unregister_daemon(daemon) -> None:
    from spawn_server.ws.broker import get_broker

    await get_broker().unregister_daemon(daemon)


def _frames(fake_ws, kind: str) -> list[dict]:
    return [json.loads(f) for f in fake_ws.sent_text if json.loads(f)["type"] == kind]


async def _set_host_status(host_id: str, status: str) -> None:
    from sqlalchemy import text as _text

    from spawn_server import db as _db

    async with _db.get_sessionmaker()() as session:
        await session.execute(
            _text("UPDATE hosts SET status = :status WHERE id = :id"),
            {"status": status, "id": host_id},
        )
        await session.commit()


async def test_archive_stops_its_sessions_and_leaves_them_where_they_are(client):
    """Archive is suspend: the work stops, the arrangement is untouched."""
    token = await _signup(client, "ws-archive@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("ws-archive@example.com")
    inside = await _create_session_row("ws-archive@example.com", host_id)
    outside = await _create_session_row("ws-archive@example.com", host_id)
    fake_ws, daemon = await _register_daemon(host_id)

    created = await client.post("/api/workspaces", json={"name": "put away"}, headers=auth)
    workspace_id = created.json()["workspace"]["id"]
    layout = _envelope([_tile(inside, 0, 0, 24, 24)])
    r = await client.patch(f"/api/workspaces/{workspace_id}", json={"layout": layout}, headers=auth)
    assert r.status_code == 200

    archived = await client.post(f"/api/workspaces/{workspace_id}/archive", headers=auth)
    assert archived.status_code == 200
    assert archived.json()["archived_at"] is not None

    # The process is asked to go; the row it was addressed by stays, and so
    # does the tile pointing at it.
    assert [k["session_id"] for k in _frames(fake_ws, "session.kill")] == [inside]
    stopped = await client.get(f"/api/sessions/{inside}", headers=auth)
    assert stopped.status_code == 200
    assert stopped.json()["status"] == "killed"
    assert (await client.get(f"/api/sessions/{outside}", headers=auth)).status_code == 200
    held = (await client.get(f"/api/workspaces/{workspace_id}", headers=auth)).json()
    assert held["layout"]["tabs"][0]["layout"]["tiles"] == layout["tabs"][0]["layout"]["tiles"]

    listed = (await client.get("/api/workspaces", headers=auth)).json()
    assert [w["id"] for w in listed] == []
    put_away = (await client.get("/api/workspaces?archived=true", headers=auth)).json()
    assert [w["id"] for w in put_away] == [workspace_id]

    await _unregister_daemon(daemon)


async def test_archive_reindexes_the_rest_and_restore_reclaims_the_slot(client):
    """Positions are contiguous from 0, and a restored row comes back to its
    own place rather than to the end of the list."""
    token = await _signup(client, "ws-reindex@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    ids = []
    for name in ("first", "second", "third"):
        r = await client.post("/api/workspaces", json={"name": name}, headers=auth)
        ids.append(r.json()["workspace"]["id"])
    assert [w["position"] for w in (await client.get("/api/workspaces", headers=auth)).json()] == [
        0,
        1,
        2,
    ]

    assert (
        await client.post(f"/api/workspaces/{ids[1]}/archive", headers=auth)
    ).status_code == 200
    listed = (await client.get("/api/workspaces", headers=auth)).json()
    assert [(w["id"], w["position"]) for w in listed] == [(ids[0], 0), (ids[2], 1)]

    restored = await client.post(f"/api/workspaces/{ids[1]}/unarchive", headers=auth)
    assert restored.status_code == 200
    assert restored.json()["archived_at"] is None
    listed = (await client.get("/api/workspaces", headers=auth)).json()
    assert [(w["id"], w["position"]) for w in listed] == [
        (ids[0], 0),
        (ids[1], 1),
        (ids[2], 2),
    ]


async def test_restore_restarts_the_same_sessions_in_place(client):
    """Nothing is rebuilt: the same session ids start again where they stopped."""
    token = await _signup(client, "ws-restore@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("ws-restore@example.com")
    left = await _create_session_row("ws-restore@example.com", host_id)
    right = await _create_session_row("ws-restore@example.com", host_id)
    fake_ws, daemon = await _register_daemon(host_id)

    created = await client.post(
        "/api/workspaces",
        json={"name": "shaped", "host_id": host_id, "cwd": "/home"},
        headers=auth,
    )
    workspace_id = created.json()["workspace"]["id"]
    layout = _envelope([_tile(left, 0, 0, 12, 24), _tile(right, 12, 0, 12, 24)])
    assert (
        await client.patch(
            f"/api/workspaces/{workspace_id}", json={"layout": layout}, headers=auth
        )
    ).status_code == 200
    assert (
        await client.post(f"/api/workspaces/{workspace_id}/archive", headers=auth)
    ).status_code == 200

    restored = await client.post(f"/api/workspaces/{workspace_id}/unarchive", headers=auth)
    assert restored.status_code == 200
    assert restored.json()["archived_at"] is None
    # Same tiles, same session ids — the layout was never taken apart.
    assert restored.json()["layout"]["tabs"][0]["layout"]["tiles"] == (
        layout["tabs"][0]["layout"]["tiles"]
    )
    assert sorted(f["session_id"] for f in _frames(fake_ws, "session.restart")) == sorted(
        [left, right]
    )
    for session_id in (left, right):
        row = (await client.get(f"/api/sessions/{session_id}", headers=auth)).json()
        assert row["status"] == "starting"
        assert row["cwd"] == "/repo"

    await _unregister_daemon(daemon)


async def test_restore_leaves_windows_on_an_offline_host_stopped(client):
    """One unreachable host does not hold the whole workspace hostage."""
    token = await _signup(client, "ws-offline@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("ws-offline@example.com")
    session_id = await _create_session_row("ws-offline@example.com", host_id)
    fake_ws, daemon = await _register_daemon(host_id)

    created = await client.post("/api/workspaces", json={"name": "stranded"}, headers=auth)
    workspace_id = created.json()["workspace"]["id"]
    assert (
        await client.patch(
            f"/api/workspaces/{workspace_id}",
            json={"layout": _envelope([_tile(session_id, 0, 0, 24, 24)])},
            headers=auth,
        )
    ).status_code == 200
    assert (
        await client.post(f"/api/workspaces/{workspace_id}/archive", headers=auth)
    ).status_code == 200

    await _set_host_status(host_id, "offline")
    restored = await client.post(f"/api/workspaces/{workspace_id}/unarchive", headers=auth)
    assert restored.status_code == 200
    assert restored.json()["archived_at"] is None
    # The window is back in the sidebar; the one session in it is still stopped
    # and nothing was asked of the offline daemon.
    assert _frames(fake_ws, "session.restart") == []
    assert (await client.get(f"/api/sessions/{session_id}", headers=auth)).json()[
        "status"
    ] == "killed"

    await _unregister_daemon(daemon)


async def test_empty_workspace_restores_without_a_host(client):
    """Nothing to start, nothing to ask for."""
    token = await _signup(client, "ws-empty@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    created = await client.post("/api/workspaces", json={"name": "blank"}, headers=auth)
    workspace_id = created.json()["workspace"]["id"]

    assert (
        await client.post(f"/api/workspaces/{workspace_id}/archive", headers=auth)
    ).status_code == 200
    restored = await client.post(f"/api/workspaces/{workspace_id}/unarchive", headers=auth)
    assert restored.status_code == 200
    assert restored.json()["archived_at"] is None


async def test_an_archived_workspace_is_editable_but_takes_no_new_sessions(client):
    """It is the same workspace, put away: rearrange it freely, but starting
    work in it is what restoring is for."""
    token = await _signup(client, "ws-frozen@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("ws-frozen@example.com")
    created = await client.post("/api/workspaces", json={"name": "frozen"}, headers=auth)
    workspace_id = created.json()["workspace"]["id"]
    assert (
        await client.post(f"/api/workspaces/{workspace_id}/archive", headers=auth)
    ).status_code == 200

    for body in ({"layout": _envelope([])}, {"position": 0}, {"name": "renamed"}):
        r = await client.patch(f"/api/workspaces/{workspace_id}", json=body, headers=auth)
        assert r.status_code == 200, body

    stranded = await client.post(
        "/api/sessions",
        json={"host_id": host_id, "cwd": "/repo", "workspace_id": workspace_id},
        headers=auth,
    )
    assert stranded.status_code == 409
    assert stranded.json()["detail"] == "workspace_archived"


async def test_archive_and_unarchive_are_not_repeatable(client):
    token = await _signup(client, "ws-idempotent@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    created = await client.post("/api/workspaces", json={"name": "once"}, headers=auth)
    workspace_id = created.json()["workspace"]["id"]

    assert (await client.post(f"/api/workspaces/{workspace_id}/unarchive", headers=auth)).status_code == 409
    assert (await client.post(f"/api/workspaces/{workspace_id}/archive", headers=auth)).status_code == 200
    assert (await client.post(f"/api/workspaces/{workspace_id}/archive", headers=auth)).status_code == 409


async def test_archived_names_still_block_the_default_name(client):
    """A restored workspace must not find its name taken while it was away."""
    token = await _signup(client, "ws-names@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    first = (await client.post("/api/workspaces", json={}, headers=auth)).json()["workspace"]
    assert first["name"] == "Workspace 1"
    assert (await client.post(f"/api/workspaces/{first['id']}/archive", headers=auth)).status_code == 200

    second = (await client.post("/api/workspaces", json={}, headers=auth)).json()["workspace"]
    assert second["name"] == "Workspace 2"


async def test_archive_is_scoped_to_its_owner(client):
    owner = await _signup(client, "ws-owner@example.com")
    other = await _signup(client, "ws-other@example.com")
    created = await client.post(
        "/api/workspaces", json={"name": "mine"}, headers={"Authorization": f"Bearer {owner}"}
    )
    workspace_id = created.json()["workspace"]["id"]

    intruder = {"Authorization": f"Bearer {other}"}
    assert (await client.post(f"/api/workspaces/{workspace_id}/archive", headers=intruder)).status_code == 404
    assert (await client.post(f"/api/workspaces/{workspace_id}/unarchive", headers=intruder)).status_code == 404
