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


async def test_session_create_leaves_an_unnamed_window_unnamed(client):
    """Host and folder are shown beside a window already; a default name that
    repeated them read as a duplicate in every header."""
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
    assert body["name"] is None
    assert body["host_name"] == "dream"
    assert body["foreground_command"] is None
    # The launch surface is gone from the API shape entirely.
    assert "argv" not in body
    assert "env" not in body
    assert "preset_id" not in body


async def _builtin_agent_id(client, auth, name: str) -> str:
    r = await client.get("/api/agents", headers=auth)
    assert r.status_code == 200, r.text
    return next(a["id"] for a in r.json() if a["name"] == name)


async def test_session_remembers_the_agent_it_was_opened_as(client):
    """A window's type outlives the process: what the client launched into it
    is recorded, so a duplicate can reproduce it even when the agent has been
    quit, or reports an interpreter's name while it runs."""
    token = await _signup(client, "session-agent@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("session-agent@example.com", status="offline")
    hermes = await _builtin_agent_id(client, auth, "hermes")

    r = await client.post(
        "/api/sessions",
        json={"host_id": host_id, "cwd": "/repo", "agent_id": hermes},
        headers=auth,
    )
    assert r.status_code == 201, r.text
    session_id = r.json()["id"]
    assert r.json()["agent_id"] == hermes

    # Still the window's type when the daemon reports the interpreter that
    # actually holds the foreground.
    r = await client.get(f"/api/sessions/{session_id}", headers=auth)
    assert r.json()["agent_id"] == hermes

    # Launching another agent into the same window retypes it...
    codex = await _builtin_agent_id(client, auth, "codex")
    r = await client.patch(f"/api/sessions/{session_id}", json={"agent_id": codex}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["agent_id"] == codex

    # ...a patch that says nothing about it leaves it be...
    r = await client.patch(f"/api/sessions/{session_id}", json={"name": "work"}, headers=auth)
    assert r.json()["agent_id"] == codex

    # ...and stopping back to a bare prompt says so with an explicit null.
    r = await client.patch(f"/api/sessions/{session_id}", json={"agent_id": None}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["agent_id"] is None


async def test_session_agent_must_be_one_this_user_can_launch(client):
    token = await _signup(client, "session-agent-scope@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("session-agent-scope@example.com", status="offline")

    # Someone else's definition is not a type this user's windows may claim.
    other = await _signup(client, "session-agent-other@example.com")
    r = await client.post(
        "/api/agents",
        json={"name": "theirs", "kind": "codex", "command": "codex"},
        headers={"Authorization": f"Bearer {other}"},
    )
    assert r.status_code == 201, r.text
    theirs = r.json()["id"]

    r = await client.post(
        "/api/sessions",
        json={"host_id": host_id, "cwd": "/repo", "agent_id": theirs},
        headers=auth,
    )
    assert r.status_code == 404, r.text

    r = await client.post(
        "/api/sessions",
        json={
            "host_id": host_id,
            "cwd": "/repo",
            "agent_id": "00000000-0000-4000-8000-000000009999",
        },
        headers=auth,
    )
    assert r.status_code == 404, r.text

    # A window opened as nothing in particular is a shell, and says so.
    r = await client.post("/api/sessions", json={"host_id": host_id, "cwd": "/repo"}, headers=auth)
    assert r.status_code == 201, r.text
    assert r.json()["agent_id"] is None
    session_id = r.json()["id"]

    r = await client.patch(f"/api/sessions/{session_id}", json={"agent_id": theirs}, headers=auth)
    assert r.status_code == 404, r.text


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
        {"session_id": first.json()["id"], "x": 0, "y": 0, "w": 24, "h": 24}
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
        "session_id": first.json()["id"],
        "x": 0,
        "y": 0,
        "w": 12,
        "h": 24,
    }
    assert by_id[second.json()["id"]] == {
        "session_id": second.json()["id"],
        "x": 12,
        "y": 0,
        "w": 12,
        "h": 24,
    }


async def test_a_workspace_holds_windows_from_several_hosts_and_gains_no_home(client):
    """A workspace is a layout of windows, each of which says where it runs.

    Creating a window in it never writes the window's host or folder back onto
    the workspace: that "home" is what made every other window open there.
    """
    token = await _signup(client, "many-hosts@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    first_host = await _create_host("many-hosts@example.com")
    second_host = await _create_host("many-hosts@example.com")
    assert first_host != second_host

    ws = await client.post("/api/workspaces", json={"name": "mixed"}, headers=auth)
    assert ws.status_code == 201, ws.text
    workspace_id = ws.json()["workspace"]["id"]

    created = []
    for host_id, cwd in ((first_host, "/repo/api"), (second_host, "/Users/me/site")):
        r = await client.post(
            "/api/sessions",
            json={"host_id": host_id, "cwd": cwd, "workspace_id": workspace_id},
            headers=auth,
        )
        assert r.status_code == 201, r.text
        created.append((r.json()["id"], host_id, cwd))

    workspace = (await client.get(f"/api/workspaces/{workspace_id}", headers=auth)).json()
    assert workspace["host_id"] is None
    assert workspace["cwd"] is None
    tiles = [tile["session_id"] for tab in workspace["layout"]["tabs"] for tile in tab["layout"]["tiles"]]
    assert sorted(tiles) == sorted(session_id for session_id, _, _ in created)
    for session_id, host_id, cwd in created:
        session = (await client.get(f"/api/sessions/{session_id}", headers=auth)).json()
        assert (session["host_id"], session["cwd"]) == (host_id, cwd)


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
            "tile": {"x": 0, "y": 0, "w": 12, "h": 24},
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
            "tile": {"x": 6, "y": 0, "w": 12, "h": 24},
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
            "tile": {"x": 20, "y": 0, "w": 12, "h": 24},
        },
        headers=auth,
    )
    assert bad.status_code == 400

    # A tile without a workspace is meaningless.
    bad = await client.post(
        "/api/sessions",
        json={"host_id": host_id, "cwd": "/four", "tile": {"x": 0, "y": 0, "w": 6, "h": 6}},
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


async def test_session_kill_addresses_only_the_host_it_names(client):
    """A moved window is already routed to its new host once the launch
    there has gone out. Stopping its worker on the host it left must reach
    that host's daemon, and leave the new host's worker and routing alone."""
    email = "session-kill-host@example.com"
    await _signup(client, email)

    from spawn_server.routes.sessions import send_session_kill
    from spawn_server.ws.broker import DaemonConn, get_broker

    left_host = await _create_host(email, name="left")
    new_host = await _create_host(email, name="new")
    session_id = await _create_session_row(email, new_host)

    broker = get_broker()
    left_ws, new_ws = _FakeWS(), _FakeWS()
    left = DaemonConn(host_id=left_host, user_id="user", websocket=left_ws)  # type: ignore[arg-type]
    new = DaemonConn(host_id=new_host, user_id="user", websocket=new_ws)  # type: ignore[arg-type]
    await broker.register_daemon(left)
    await broker.register_daemon(new)
    try:
        await broker.attach_session_to_daemon(session_id, new)

        await send_session_kill(session_id, left_host)

        assert [json.loads(frame) for frame in left_ws.sent_text] == [
            {"type": "session.kill", "session_id": session_id, "signal": "TERM"}
        ]
        assert new_ws.sent_text == []
        assert broker.get_daemon_for_session(session_id) is new

        # Its own host's kill still detaches it.
        await send_session_kill(session_id, new_host)
        assert [json.loads(frame)["type"] for frame in new_ws.sent_text] == ["session.kill"]
        assert broker.get_daemon_for_session(session_id) is None
    finally:
        await broker.unregister_daemon(left)
        await broker.unregister_daemon(new)


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


async def test_session_remembers_the_conversation_its_agent_started(client):
    """The conversation id the client typed after `--session-id` is kept with
    the window, survives a restart (that is what a restart resumes), travels
    with a retype, and is refused in any spelling a shell would need to quote or
    the agent would read as a flag."""
    token = await _signup(client, "session-conversation@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("session-conversation@example.com")
    claude = await _builtin_agent_id(client, auth, "claude-code")
    codex = await _builtin_agent_id(client, auth, "codex")

    from spawn_server.ws.broker import DaemonConn, get_broker

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    try:
        conversation = "3f1c9b6e-2c7e-4f39-9a55-0d5b7d2f1a10"
        r = await client.post(
            "/api/sessions",
            json={
                "host_id": host_id,
                "cwd": "/repo",
                "agent_id": claude,
                "agent_session_id": conversation,
            },
            headers=auth,
        )
        assert r.status_code == 201, r.text
        session_id = r.json()["id"]
        assert r.json()["agent_session_id"] == conversation

        # A restart is what resumes the conversation, so it must not lose it.
        r = await client.post(f"/api/sessions/{session_id}/restart", headers=auth)
        assert r.status_code == 200, r.text
        assert r.json()["agent_session_id"] == conversation
        r = await client.get(f"/api/sessions/{session_id}", headers=auth)
        assert r.json()["agent_session_id"] == conversation

        # Launching another agent into the window is a new conversation: a
        # retype that names none clears the old one rather than pointing a
        # resume at a thread this window has left...
        r = await client.patch(
            f"/api/sessions/{session_id}", json={"agent_id": codex}, headers=auth
        )
        assert r.status_code == 200, r.text
        assert r.json()["agent_id"] == codex
        assert r.json()["agent_session_id"] is None

        # ...and a retype that names one keeps it.
        r = await client.patch(
            f"/api/sessions/{session_id}",
            json={"agent_id": claude, "agent_session_id": "conv-2"},
            headers=auth,
        )
        assert r.status_code == 200, r.text
        assert r.json()["agent_session_id"] == "conv-2"

        # Stopping back to a bare prompt ends the conversation with the agent.
        r = await client.patch(
            f"/api/sessions/{session_id}",
            json={"agent_id": None, "agent_session_id": "conv-3"},
            headers=auth,
        )
        assert r.status_code == 200, r.text
        assert r.json()["agent_id"] is None
        assert r.json()["agent_session_id"] is None

        # The id is typed into a shell verbatim, so nothing a shell would have
        # to quote is accepted.
        r = await client.patch(
            f"/api/sessions/{session_id}",
            json={"agent_id": claude, "agent_session_id": "rm -rf ~"},
            headers=auth,
        )
        assert r.status_code == 422, r.text

        # Nor anything the agent would read as a flag after `--resume`.
        for flag in ("--dangerously-skip-permissions", "-p", "--settings=x", "-"):
            r = await client.patch(
                f"/api/sessions/{session_id}",
                json={"agent_id": claude, "agent_session_id": flag},
                headers=auth,
            )
            assert r.status_code == 422, (flag, r.text)
            r = await client.post(
                "/api/sessions",
                json={
                    "host_id": host_id,
                    "cwd": "/repo",
                    "agent_id": claude,
                    "agent_session_id": flag,
                },
                headers=auth,
            )
            assert r.status_code == 422, (flag, r.text)
        r = await client.get(f"/api/sessions/{session_id}", headers=auth)
        assert r.json()["agent_id"] is None
        assert r.json()["agent_session_id"] is None

        # A plain shell window has no conversation to remember.
        r = await client.post(
            "/api/sessions",
            json={"host_id": host_id, "cwd": "/repo", "agent_session_id": conversation},
            headers=auth,
        )
        assert r.status_code == 201, r.text
        assert r.json()["agent_id"] is None
        assert r.json()["agent_session_id"] is None
    finally:
        await broker.unregister_daemon(daemon)


@dataclass
class _HostLogWS(_FakeWS):
    """A daemon socket that notes, beside every frame it is sent, where the
    window's row said it ran at that instant — the order of effects is the
    contract `/move` keeps."""

    host: str = ""
    log: list[tuple[str, str, str | None]] = field(default_factory=list)
    watched: str | None = None

    async def send_text(self, value: str) -> None:
        await super().send_text(value)
        row_host: str | None = None
        if self.watched is not None:
            from spawn_server.db import get_sessionmaker
            from spawn_server.models import Session

            async with get_sessionmaker()() as session:
                row = await session.get(Session, self.watched)
                row_host = row.host_id if row is not None else None
        self.log.append((self.host, json.loads(value)["type"], row_host))


async def _move_fixture(client, email: str):
    """An account with two hosts, dream and mac, and an agent window on dream
    that has a name, a skill and a conversation."""
    token = await _signup(client, email)
    auth = {"Authorization": f"Bearer {token}"}
    dream = await _create_host(email, name="dream")
    mac = await _create_host(email, name="mac")
    skill = await client.post(
        "/api/skills",
        json={"name": "move-skill", "description": "d", "content": "# Move\nkept"},
        headers=auth,
    )
    assert skill.status_code == 201, skill.text
    claude = await _builtin_agent_id(client, auth, "claude-code")
    r = await client.post(
        "/api/sessions",
        json={
            "host_id": dream,
            "cwd": "/repo",
            "name": "builder",
            "agent_id": claude,
            "agent_session_id": "conv-dream",
            "skill_ids": [skill.json()["id"]],
        },
        headers=auth,
    )
    assert r.status_code == 201, r.text
    return auth, dream, mac, skill.json()["id"], claude, r.json()["id"]


async def test_session_move_rebinds_the_window_then_kills_there_and_restarts_here(client):
    auth, dream, mac, skill_id, claude, session_id = await _move_fixture(
        client, "session-move@example.com"
    )

    from spawn_server.ws.broker import DaemonConn, get_broker

    broker = get_broker()
    log: list[tuple[str, str, str | None]] = []
    dream_ws = _HostLogWS(host="dream", log=log, watched=session_id)
    mac_ws = _HostLogWS(host="mac", log=log, watched=session_id)
    dream_daemon = DaemonConn(host_id=dream, user_id="user", websocket=dream_ws)  # type: ignore[arg-type]
    mac_daemon = DaemonConn(host_id=mac, user_id="user", websocket=mac_ws)  # type: ignore[arg-type]
    await broker.register_daemon(dream_daemon)
    await broker.register_daemon(mac_daemon)
    await broker.attach_session_to_daemon(session_id, dream_daemon)
    try:
        r = await client.post(
            f"/api/sessions/{session_id}/move",
            json={
                "host_id": mac,
                "cwd": "/work/spawn",
                "expected_host_id": dream,
                "agent_session_id": "conv-mac",
            },
            headers=auth,
        )
        assert r.status_code == 200, r.text
        moved = r.json()

        # The same window: id, name, agent kept; the place and the
        # conversation are new, and the incarnation starts from nothing.
        assert moved["id"] == session_id
        assert moved["name"] == "builder"
        assert moved["agent_id"] == claude
        assert moved["host_id"] == mac
        assert moved["host_name"] == "mac"
        assert moved["cwd"] == "/work/spawn"
        assert moved["status"] == "starting"
        assert moved["agent_session_id"] == "conv-mac"
        for cleared in (
            "exited_at",
            "exit_code",
            "last_output_at",
            "last_input_at",
            "foreground_command",
        ):
            assert moved[cleared] is None, cleared

        # Rebind first, then the kill to the old host, then the restart on the
        # new one: by the time dream hears of it the row already names mac, so
        # dream's exit is fenced out as a stranger's.
        assert log == [("dream", "session.kill", mac), ("mac", "session.restart", mac)]
        kill = json.loads(dream_ws.sent_text[-1])
        assert kill == {"type": "session.kill", "session_id": session_id, "signal": "TERM"}
        restart = json.loads(mac_ws.sent_text[-1])
        assert restart["session_id"] == session_id
        assert restart["cwd"] == "/work/spawn"
        assert restart["create_cwd"] is True
        # The skills the window was granted ride along, as on any restart.
        assert [skill["name"] for skill in restart["skills"]] == ["move-skill"]
        assert "argv" not in restart and "env" not in restart

        # Routing follows the window to its new host.
        assert broker.get_daemon_for_session(session_id) is mac_daemon
        assert session_id not in dream_daemon.session_ids

        # Grants live on the row, so they were never copied and cannot drift.
        access = await client.get(f"/api/sessions/{session_id}/access", headers=auth)
        assert [skill["id"] for skill in access.json()["skills"]] == [skill_id]
        # The new folder is remembered for the new host, as a create would.
        dirs = await client.get(f"/api/hosts/{mac}/recent-dirs", headers=auth)
        assert dirs.json()["dirs"][0]["path"] == "/work/spawn"
        listed = await client.get(f"/api/sessions?host_id={mac}", headers=auth)
        assert [row["id"] for row in listed.json()] == [session_id]
        assert (await client.get(f"/api/sessions?host_id={dream}", headers=auth)).json() == []
    finally:
        await broker.unregister_daemon(dream_daemon)
        await broker.unregister_daemon(mac_daemon)


async def test_session_move_refusals_leave_the_window_where_it_was(client):
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-refusals@example.com"
    )
    other_token = await _signup(client, "session-move-stranger@example.com")
    other = {"Authorization": f"Bearer {other_token}"}
    strangers_host = await _create_host("session-move-stranger@example.com", name="theirs")

    from spawn_server.ws.broker import DaemonConn, get_broker

    broker = get_broker()
    dream_ws, mac_ws, theirs_ws = _FakeWS(), _FakeWS(), _FakeWS()
    daemons = [
        DaemonConn(host_id=dream, user_id="user", websocket=dream_ws),  # type: ignore[arg-type]
        DaemonConn(host_id=strangers_host, user_id="u2", websocket=theirs_ws),  # type: ignore[arg-type]
    ]
    for daemon in daemons:
        await broker.register_daemon(daemon)

    def body(**overrides):
        return {"host_id": mac, "cwd": "/work", "expected_host_id": dream, **overrides}

    async def move(json_body, headers=auth, sid=session_id):
        return await client.post(f"/api/sessions/{sid}/move", json=json_body, headers=headers)

    try:
        # Not yours, either end.
        r = await move(body(), headers=other)
        assert r.status_code == 404 and r.json()["detail"] == "session not found"
        r = await move(body(), sid="00000000-0000-4000-8000-000000000000")
        assert r.status_code == 404 and r.json()["detail"] == "session not found"
        r = await move(body(host_id=strangers_host))
        assert r.status_code == 404 and r.json()["detail"] == "host not found"
        r = await move(body(host_id="no-such-host"))
        assert r.status_code == 404 and r.json()["detail"] == "host not found"
        # A type nothing can launch is refused rather than stored.
        r = await move(body(agent_id="no-such-agent"))
        assert r.status_code == 404 and r.json()["detail"] == "agent not found"
        # Same machine is a cd in the running shell, never a move.
        r = await move(body(host_id=dream))
        assert r.status_code == 400 and r.json()["detail"] == "same_host"
        # A picture of the window that is out of date is a conflict, even when
        # it names the host the window has since gone to.
        r = await move(body(expected_host_id=mac))
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        r = await move(body(host_id=dream, expected_host_id=mac))
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        # Nothing to start it on.
        r = await move(body())
        assert r.status_code == 409 and r.json()["detail"] == "target_offline"
        # Shape: a folder, a known host, and a conversation id a shell can take.
        assert (await move(body(cwd=""))).status_code == 422
        assert (await move({"host_id": mac, "cwd": "/work"})).status_code == 422
        assert (await move(body(agent_session_id="rm -rf ~"))).status_code == 422
        # Nor one the agent would read as a flag after `--session-id`.
        for flag in ("--dangerously-skip-permissions", "-p", "--settings=x", "-"):
            assert (await move(body(agent_session_id=flag))).status_code == 422, flag
        assert (await move(body(tile={"x": 0}))).status_code == 422

        row = (await client.get(f"/api/sessions/{session_id}", headers=auth)).json()
        assert row["host_id"] == dream and row["cwd"] == "/repo"
        assert row["agent_session_id"] == "conv-dream"
        # Every refusal is decided before anything reaches a host.
        assert dream_ws.sent_text == [] and mac_ws.sent_text == [] and theirs_ws.sent_text == []
    finally:
        for daemon in daemons:
            await broker.unregister_daemon(daemon)


async def test_session_move_compare_and_set_loses_to_a_move_that_landed_first(client, monkeypatch):
    """Two devices moving one window: the one whose write lands second finds
    the row no longer where it saw it and is refused, not applied on top."""
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-race@example.com"
    )
    alto = await _create_host("session-move-race@example.com", name="alto")

    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.sql.dml import Update

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Session
    from spawn_server.ws.broker import DaemonConn, get_broker

    broker = get_broker()
    mac_ws = _FakeWS()
    mac_daemon = DaemonConn(host_id=mac, user_id="user", websocket=mac_ws)  # type: ignore[arg-type]
    await broker.register_daemon(mac_daemon)
    real_execute = AsyncSession.execute
    raced = False

    async def execute(self, statement, *args, **kwargs):
        # The other device's move commits after this request has checked the
        # row and before its compare-and-set runs.
        nonlocal raced
        if not raced and isinstance(statement, Update) and statement.table.name == "sessions":
            raced = True
            async with get_sessionmaker()() as other:
                row = await other.get(Session, session_id)
                assert row is not None
                row.host_id = alto
                await other.commit()
        return await real_execute(self, statement, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, "execute", execute)
    try:
        r = await client.post(
            f"/api/sessions/{session_id}/move",
            json={"host_id": mac, "cwd": "/work", "expected_host_id": dream},
            headers=auth,
        )
    finally:
        monkeypatch.setattr(AsyncSession, "execute", real_execute)
        await broker.unregister_daemon(mac_daemon)
    assert raced
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "move_conflict"
    # The move that landed first stands, and nothing was dispatched for ours.
    row = (await client.get(f"/api/sessions/{session_id}", headers=auth)).json()
    assert row["host_id"] == alto
    assert mac_ws.sent_text == []


async def test_session_move_from_an_offline_host_still_rebinds(client):
    """The old host being away does not hold the window hostage: the row
    moves and the new host starts it. The old worker is the orphan reaper's
    to stop when that host returns."""
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-offline-source@example.com"
    )

    from spawn_server.ws.broker import DaemonConn, get_broker

    broker = get_broker()
    mac_ws = _FakeWS()
    mac_daemon = DaemonConn(host_id=mac, user_id="user", websocket=mac_ws)  # type: ignore[arg-type]
    await broker.register_daemon(mac_daemon)
    try:
        r = await client.post(
            f"/api/sessions/{session_id}/move",
            json={"host_id": mac, "cwd": "/work", "expected_host_id": dream},
            headers=auth,
        )
        assert r.status_code == 200, r.text
        assert r.json()["host_id"] == mac
        assert [json.loads(frame)["type"] for frame in mac_ws.sent_text] == ["session.restart"]
    finally:
        await broker.unregister_daemon(mac_daemon)


async def test_session_move_starts_a_new_conversation_or_none(client):
    """M2 carries nothing: the conversation is the one the mover names for the
    new host, or none — never the old host's, which a restart there could not
    resume. A shell window has no conversation to name at all."""
    auth, dream, mac, _skill_id, _claude, agent_window = await _move_fixture(
        client, "session-move-conversation@example.com"
    )
    r = await client.post("/api/sessions", json={"host_id": dream, "cwd": "/repo"}, headers=auth)
    assert r.status_code == 201, r.text
    shell_window = r.json()["id"]

    from spawn_server.ws.broker import DaemonConn, get_broker

    broker = get_broker()
    daemons = [
        DaemonConn(host_id=host, user_id="user", websocket=_FakeWS())  # type: ignore[arg-type]
        for host in (dream, mac)
    ]
    for daemon in daemons:
        await broker.register_daemon(daemon)
    try:
        r = await client.post(
            f"/api/sessions/{agent_window}/move",
            json={"host_id": mac, "cwd": "/work", "expected_host_id": dream},
            headers=auth,
        )
        assert r.status_code == 200, r.text
        assert r.json()["agent_session_id"] is None
        assert r.json()["agent_id"] is not None

        r = await client.post(
            f"/api/sessions/{shell_window}/move",
            json={
                "host_id": mac,
                "cwd": "/work",
                "expected_host_id": dream,
                "agent_session_id": "conv-x",
            },
            headers=auth,
        )
        assert r.status_code == 200, r.text
        assert r.json()["agent_id"] is None
        assert r.json()["agent_session_id"] is None

        # And back again: the same window, the same id, wherever it runs.
        r = await client.post(
            f"/api/sessions/{agent_window}/move",
            json={
                "host_id": dream,
                "cwd": "/repo",
                "expected_host_id": mac,
                "agent_session_id": "conv-home",
            },
            headers=auth,
        )
        assert r.status_code == 200, r.text
        assert (r.json()["id"], r.json()["host_id"]) == (agent_window, dream)
        assert r.json()["agent_session_id"] == "conv-home"
    finally:
        for daemon in daemons:
            await broker.unregister_daemon(daemon)


async def test_session_move_types_a_shell_whose_agent_was_started_by_hand(client):
    """A shell window someone typed `claude` into names no agent; the mover
    knows it from the foreground and starts that agent over there. The move
    records it as the window's type, as a create would, so the conversation it
    starts there is remembered and a restart can resume it."""
    auth, dream, mac, _skill_id, claude, _agent_window = await _move_fixture(
        client, "session-move-hand-typed@example.com"
    )
    r = await client.post("/api/sessions", json={"host_id": dream, "cwd": "/repo"}, headers=auth)
    assert r.status_code == 201, r.text
    shell_window = r.json()["id"]
    assert r.json()["agent_id"] is None

    from spawn_server.ws.broker import DaemonConn, get_broker

    broker = get_broker()
    daemons = [
        DaemonConn(host_id=host, user_id="user", websocket=_FakeWS())  # type: ignore[arg-type]
        for host in (dream, mac)
    ]
    for daemon in daemons:
        await broker.register_daemon(daemon)
    try:
        r = await client.post(
            f"/api/sessions/{shell_window}/move",
            json={
                "host_id": mac,
                "cwd": "/work",
                "expected_host_id": dream,
                "agent_id": claude,
                "agent_session_id": "conv-by-hand",
            },
            headers=auth,
        )
        assert r.status_code == 200, r.text
        assert r.json()["agent_id"] == claude
        assert r.json()["agent_session_id"] == "conv-by-hand"

        # Saying nothing about the type leaves it as it is now.
        r = await client.post(
            f"/api/sessions/{shell_window}/move",
            json={
                "host_id": dream,
                "cwd": "/repo",
                "expected_host_id": mac,
                "agent_session_id": "conv-home",
            },
            headers=auth,
        )
        assert r.status_code == 200, r.text
        assert r.json()["agent_id"] == claude
        assert r.json()["agent_session_id"] == "conv-home"
    finally:
        for daemon in daemons:
            await broker.unregister_daemon(daemon)


async def test_session_move_fans_out_once_and_the_old_hosts_exit_is_a_strangers(client):
    """Every other client hears of the move by the ordinary data frame, which
    carries the mover's echo id; and when the old host reports the exit the
    kill caused, nothing changes — no "Shell exited", no session.died — because
    the row no longer names that host."""
    email = "session-move-fence@example.com"
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(client, email)

    from sqlalchemy import select

    from spawn_server import auth as auth_mod
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Session, User
    from spawn_server.redis import user_alert_channel
    from spawn_server.ws.broker import DaemonConn, get_broker
    from spawn_server.ws.daemon import daemon_ws
    from tests.test_data_events import _ChannelTap
    from tests.test_ws_daemon import FakeDaemonWebSocket

    async with get_sessionmaker()() as session:
        user_id = (await session.execute(select(User).where(User.email == email))).scalar_one().id

    broker = get_broker()
    mac_daemon = DaemonConn(host_id=mac, user_id=user_id, websocket=_FakeWS())  # type: ignore[arg-type]
    await broker.register_daemon(mac_daemon)
    try:
        async with _ChannelTap(user_alert_channel(user_id)) as tap:
            r = await client.post(
                f"/api/sessions/{session_id}/move",
                json={"host_id": mac, "cwd": "/work", "expected_host_id": dream},
                headers={**auth, "X-Spawn-Client": "mover-tab"},
            )
            assert r.status_code == 200, r.text
            frames = await tap.settled()
        data = [frame for frame in frames if frame.get("type") == "data"]
        assert [(f["resource"], f["id"], f["origin"]) for f in data] == [
            ("sessions", session_id, "mover-tab")
        ]
    finally:
        await broker.unregister_daemon(mac_daemon)

    # dream comes back and reports the exit of the worker the move killed.
    old = FakeDaemonWebSocket()
    old.queue_text(
        {
            "type": "register",
            "host_name": "dream",
            "os": "linux",
            "arch": "x86_64",
            "version": "0.1.0",
        }
    )
    old.queue_text(
        {"type": "session.exit", "session_id": session_id, "exit_code": 0, "signal": "TERM"}
    )
    old.queue_disconnect()
    async with _ChannelTap(user_alert_channel(user_id)) as tap:
        await daemon_ws(old, token=auth_mod.issue_daemon_token(dream, user_id))  # type: ignore[arg-type]
        frames = await tap.settled()

    # dream was accepted, so its exit frame was read and judged, not dropped.
    assert "registered" in [json.loads(frame)["type"] for frame in old.sent_text]
    assert not [frame for frame in frames if frame.get("type") == "alert"]
    assert not [
        frame
        for frame in frames
        if frame.get("type") == "data" and frame.get("resource") == "sessions"
    ]
    async with get_sessionmaker()() as session:
        row = await session.get(Session, session_id)
        assert row is not None
        assert (row.host_id, row.status, row.exited_at) == (mac, "starting", None)
    # A stranger's exit is not a consistency failure: the old daemon was not
    # thrown off for reporting it.
    assert old.closed is None or old.closed[0] == 1000


# ---------- carried moves: begin, commit, abort ----------


class _Daemons:
    """Fake daemon connections for some of an account's hosts, each socket
    logging (host, frame type, the row's host at that instant) into one list
    so a test can read the order of effects across hosts."""

    def __init__(self, hosts: dict[str, str], *, watched: str | None = None) -> None:
        self.hosts = hosts
        self.log: list[tuple[str, str, str | None]] = []
        self.watched = watched
        self.sockets: dict[str, _HostLogWS] = {}
        self.conns: dict[str, object] = {}

    async def __aenter__(self) -> _Daemons:
        from spawn_server.ws.broker import DaemonConn, get_broker

        for name, host_id in self.hosts.items():
            ws = _HostLogWS(host=name, log=self.log, watched=self.watched)
            conn = DaemonConn(host_id=host_id, user_id="user", websocket=ws)  # type: ignore[arg-type]
            await get_broker().register_daemon(conn)
            self.sockets[name] = ws
            self.conns[name] = conn
        return self

    async def __aexit__(self, *_: object) -> None:
        from spawn_server.ws.broker import get_broker

        for conn in self.conns.values():
            await get_broker().unregister_daemon(conn)  # type: ignore[arg-type]

    def frames(self, name: str) -> list[str]:
        return [json.loads(frame)["type"] for frame in self.sockets[name].sent_text]


async def _write_row(session_id: str, **values) -> None:
    """Another device's committed write, made on its own session: what lands
    between a request's read and its own write in the race tests."""
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Session

    async with get_sessionmaker()() as other:
        row = await other.get(Session, session_id)
        assert row is not None
        for key, value in values.items():
            setattr(row, key, value)
        await other.commit()


async def _row(session_id: str):
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Session

    async with get_sessionmaker()() as session:
        return await session.get(Session, session_id)


async def _user_id(email: str) -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import User

    async with get_sessionmaker()() as session:
        return (await session.execute(select(User).where(User.email == email))).scalar_one().id


async def test_move_begin_marks_the_window_moving_and_reaches_no_host(client):
    """Begin is lifecycle metadata: the row says "moving" and keeps where it
    runs, its folder and its conversation; no kill or launch goes anywhere,
    because the source's own retire is what stops the window. Every other
    device hears of it by the ordinary data frame."""
    email = "session-move-begin@example.com"
    auth, dream, mac, _skill_id, claude, session_id = await _move_fixture(client, email)
    user_id = await _user_id(email)

    from spawn_server.redis import user_alert_channel
    from tests.test_data_events import _ChannelTap

    async with _Daemons({"dream": dream, "mac": mac}) as daemons:
        async with _ChannelTap(user_alert_channel(user_id)) as tap:
            r = await client.post(
                f"/api/sessions/{session_id}/move/begin",
                json={"expected_host_id": dream},
                headers={**auth, "X-Spawn-Client": "mover-tab"},
            )
            frames = await tap.settled()
        assert r.status_code == 200, r.text
        moving = r.json()
        assert moving["status"] == "moving"
        assert (moving["activity_state"], moving["activity_label"]) == ("moving", "Moving")
        assert (moving["id"], moving["name"], moving["agent_id"]) == (session_id, "builder", claude)
        assert (moving["host_id"], moving["host_name"], moving["cwd"]) == (dream, "dream", "/repo")
        assert moving["agent_session_id"] == "conv-dream"
        assert moving["exited_at"] is None
        assert daemons.log == []

        data = [frame for frame in frames if frame.get("type") == "data"]
        assert [(f["resource"], f["id"], f["origin"]) for f in data] == [
            ("sessions", session_id, "mover-tab")
        ]
        assert not [frame for frame in frames if frame.get("type") == "alert"]
        listed = await client.get(f"/api/sessions?host_id={dream}", headers=auth)
        assert [(row["id"], row["status"]) for row in listed.json()] == [(session_id, "moving")]

        # A stopped window moves too: its conversation is on the host however
        # its shell went.
        for stopped_status in ("exited", "killed"):
            r = await client.post(
                "/api/sessions", json={"host_id": dream, "cwd": "/repo"}, headers=auth
            )
            assert r.status_code == 201, r.text
            stopped = r.json()["id"]
            await _write_row(stopped, status=stopped_status, exit_code=0)
            r = await client.post(
                f"/api/sessions/{stopped}/move/begin",
                json={"expected_host_id": dream},
                headers=auth,
            )
            assert r.status_code == 200, r.text
            assert r.json()["status"] == "moving"
            # The exit it recorded stays on the row.
            assert r.json()["exit_code"] == 0
        assert daemons.frames("mac") == []
        assert daemons.frames("dream") == ["session.create", "session.create"]


async def test_move_begin_refusals_leave_the_window_as_it_was(client):
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-begin-refusals@example.com"
    )
    other_token = await _signup(client, "session-move-begin-stranger@example.com")
    other = {"Authorization": f"Bearer {other_token}"}

    async def begin(json_body, headers=auth, sid=session_id):
        return await client.post(f"/api/sessions/{sid}/move/begin", json=json_body, headers=headers)

    # The host it would leave is not connected: the conversation cannot come
    # along, and a fresh move is the way to start the window elsewhere.
    r = await begin({"expected_host_id": dream})
    assert r.status_code == 409 and r.json()["detail"] == "source_offline"

    async with _Daemons({"dream": dream}) as daemons:
        r = await begin({"expected_host_id": dream}, headers=other)
        assert r.status_code == 404 and r.json()["detail"] == "session not found"
        r = await begin({"expected_host_id": dream}, sid="00000000-0000-4000-8000-000000000000")
        assert r.status_code == 404
        # A picture of the window that is out of date.
        r = await begin({"expected_host_id": mac})
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        # Shape: the expected host and nothing else — no target, no folder.
        assert (await begin({})).status_code == 422
        assert (await begin({"expected_host_id": dream, "host_id": mac})).status_code == 422
        assert (await _row(session_id)).status == "starting"

        # A window whose launch has not reported back yet moves as well.
        r = await begin({"expected_host_id": dream})
        assert r.status_code == 200, r.text
        # One move at a time.
        r = await begin({"expected_host_id": dream})
        assert r.status_code == 409 and r.json()["detail"] == "move_in_progress"
        assert daemons.log == []


async def test_carried_commit_rebinds_a_moving_window_and_only_a_moving_one(client):
    """The commit is `/move` with `carried`: a compare-and-set on the host the
    device saw and on "moving". It rebinds with the conversation the device
    carried, kills on the host it left (usually nothing there by now) and
    restarts on the target, in that order."""
    auth, dream, mac, skill_id, claude, session_id = await _move_fixture(
        client, "session-move-commit@example.com"
    )

    def commit(**overrides):
        return client.post(
            f"/api/sessions/{session_id}/move",
            json={
                "host_id": mac,
                "cwd": "/work/spawn",
                "expected_host_id": dream,
                "agent_session_id": "conv-dream",
                "carried": True,
                **overrides,
            },
            headers=auth,
        )

    async with _Daemons({"dream": dream}, watched=session_id) as daemons:
        # Nothing to commit before a begin.
        r = await commit()
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        r = await client.post(
            f"/api/sessions/{session_id}/move/begin",
            json={"expected_host_id": dream},
            headers=auth,
        )
        assert r.status_code == 200, r.text

        # A fresh move while a carry is under way is refused, not applied over it.
        r = await commit(carried=False)
        assert r.status_code == 409 and r.json()["detail"] == "move_in_progress"
        r = await commit(expected_host_id=mac)
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        r = await commit(host_id=dream)
        assert r.status_code == 400 and r.json()["detail"] == "same_host"
        # The target went away: the window stays moving, for a retry or an abort.
        r = await commit()
        assert r.status_code == 409 and r.json()["detail"] == "target_offline"
        assert (await _row(session_id)).status == "moving"
        assert daemons.log == []

    async with _Daemons({"dream": dream, "mac": mac}, watched=session_id) as daemons:
        r = await commit()
        assert r.status_code == 200, r.text
        moved = r.json()
        assert (moved["id"], moved["name"], moved["agent_id"]) == (session_id, "builder", claude)
        assert (moved["host_id"], moved["cwd"], moved["status"]) == (mac, "/work/spawn", "starting")
        # The conversation it carried, by the same id.
        assert moved["agent_session_id"] == "conv-dream"
        assert daemons.log == [("dream", "session.kill", mac), ("mac", "session.restart", mac)]
        restart = json.loads(daemons.sockets["mac"].sent_text[-1])
        assert [skill["name"] for skill in restart["skills"]] == ["move-skill"]
        access = await client.get(f"/api/sessions/{session_id}/access", headers=auth)
        assert [skill["id"] for skill in access.json()["skills"]] == [skill_id]

        # Committed once: a second commit, and an abort after it, are stale.
        r = await commit(expected_host_id=mac, host_id=dream)
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        r = await client.post(
            f"/api/sessions/{session_id}/move/abort",
            json={"expected_host_id": dream},
            headers=auth,
        )
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        r = await client.post(
            f"/api/sessions/{session_id}/move/abort",
            json={"expected_host_id": mac},
            headers=auth,
        )
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        assert (await _row(session_id)).status == "starting"


async def test_a_moving_window_refuses_restart_delete_and_a_fresh_move(client):
    """Only the commit or the abort ends a move. Restart would start a shell on
    the host the conversation is leaving, delete would leave the conversation
    the source set aside with no window to come back to, and a fresh move
    would race the carry; each says so and changes nothing."""
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-fenced@example.com"
    )
    async with _Daemons({"dream": dream, "mac": mac}) as daemons:
        r = await client.post(
            f"/api/sessions/{session_id}/move/begin",
            json={"expected_host_id": dream},
            headers=auth,
        )
        assert r.status_code == 200, r.text

        r = await client.post(f"/api/sessions/{session_id}/restart", headers=auth)
        assert r.status_code == 409 and r.json()["detail"] == "move_in_progress"
        r = await client.delete(f"/api/sessions/{session_id}", headers=auth)
        assert r.status_code == 409 and r.json()["detail"] == "move_in_progress"
        r = await client.post(
            f"/api/sessions/{session_id}/move",
            json={"host_id": mac, "cwd": "/work", "expected_host_id": dream},
            headers=auth,
        )
        assert r.status_code == 409 and r.json()["detail"] == "move_in_progress"
        # Renaming is not a lifecycle change and is allowed.
        r = await client.patch(
            f"/api/sessions/{session_id}", json={"name": "renamed"}, headers=auth
        )
        assert r.status_code == 200 and r.json()["status"] == "moving"

        row = await _row(session_id)
        assert (row.status, row.host_id, row.cwd) == ("moving", dream, "/repo")
        assert daemons.log == []


async def test_move_abort_stops_the_window_where_it_was_and_a_commit_after_it_is_refused(client):
    """An abort after the source reported an exit while the window moved — its
    retire stopped it — leaves the window on its host, stopped: "killed",
    keeping that exit, with the ordinary kill to that host. A commit after
    it, or a second abort, is stale; Restart brings the window back there."""
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-abort@example.com"
    )

    def abort(expected):
        return client.post(
            f"/api/sessions/{session_id}/move/abort",
            json={"expected_host_id": expected},
            headers=auth,
        )

    async with _Daemons({"dream": dream, "mac": mac}, watched=session_id) as daemons:
        # Nothing to abort before a begin.
        r = await abort(dream)
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        r = await client.post(
            f"/api/sessions/{session_id}/move/begin",
            json={"expected_host_id": dream},
            headers=auth,
        )
        assert r.status_code == 200, r.text
        # What the source reported when its retire stopped the shell.
        exited_at = datetime(2026, 10, 4, 9, 30, tzinfo=UTC)
        await _write_row(session_id, exited_at=exited_at, exit_code=143)

        r = await abort(mac)
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        assert (await _row(session_id)).status == "moving"
        r = await abort(dream)
        assert r.status_code == 200, r.text
        aborted = r.json()
        assert (aborted["status"], aborted["host_id"], aborted["cwd"]) == ("killed", dream, "/repo")
        assert aborted["exit_code"] == 143
        assert datetime.fromisoformat(aborted["exited_at"]).replace(tzinfo=UTC) == exited_at
        assert aborted["agent_session_id"] == "conv-dream"
        assert aborted["foreground_command"] is None
        assert daemons.log == [("dream", "session.kill", dream)]

        r = await abort(dream)
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        r = await client.post(
            f"/api/sessions/{session_id}/move",
            json={
                "host_id": mac,
                "cwd": "/work",
                "expected_host_id": dream,
                "agent_session_id": "conv-dream",
                "carried": True,
            },
            headers=auth,
        )
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        assert (await _row(session_id)).host_id == dream

        # Back where it was: Restart resumes it there.
        r = await client.post(f"/api/sessions/{session_id}/restart", headers=auth)
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "starting"
        assert daemons.log[1:] == [("dream", "session.restart", dream)]
        assert daemons.frames("mac") == []


async def test_move_abort_before_anything_stopped_the_window_puts_it_back_running(client):
    """A move given up before the source stopped anything — cancelled before
    the retire, a retire refused (`conversation_live_elsewhere`), the device
    lost — finds no exit recorded while it moved: the worker on the source is
    alive, mid-turn perhaps. The abort puts the window back as it was,
    "running" with its foreground, and sends no kill to anyone, whether or not
    the host is connected."""
    auth, dream, _mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-abort-unretired@example.com"
    )

    def begin():
        return client.post(
            f"/api/sessions/{session_id}/move/begin",
            json={"expected_host_id": dream},
            headers=auth,
        )

    def abort():
        return client.post(
            f"/api/sessions/{session_id}/move/abort",
            json={"expected_host_id": dream},
            headers=auth,
        )

    await _write_row(session_id, status="running", foreground_command="claude")
    async with _Daemons({"dream": dream}, watched=session_id) as daemons:
        r = await begin()
        assert r.status_code == 200, r.text
        r = await abort()
        assert r.status_code == 200, r.text
        back = r.json()
        assert (back["status"], back["host_id"], back["cwd"]) == ("running", dream, "/repo")
        assert back["activity_state"] not in ("moving", "killed", "exited")
        assert (back["exited_at"], back["exit_code"]) == (None, None)
        assert back["foreground_command"] == "claude"
        assert back["agent_session_id"] == "conv-dream"
        assert daemons.log == []

        # The same with the host gone meanwhile: the abort is never held
        # hostage by the host it names, and still stops nothing.
        r = await begin()
        assert r.status_code == 200, r.text
    r = await abort()
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "running"
    assert daemons.log == []
    row = await _row(session_id)
    assert (row.status, row.host_id, row.exited_at) == ("running", dream, None)


async def test_move_abort_of_a_window_stopped_before_the_move_leaves_it_stopped(client):
    """A stopped window moves too. Given up, it is still stopped: "killed",
    with the exit it had, and the ordinary kill goes to its host, where it
    stops nothing."""
    auth, dream, _mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-abort-stopped@example.com"
    )
    exited_at = datetime(2026, 10, 4, 8, 0, tzinfo=UTC)
    await _write_row(session_id, status="exited", exited_at=exited_at, exit_code=0)
    async with _Daemons({"dream": dream}, watched=session_id) as daemons:
        r = await client.post(
            f"/api/sessions/{session_id}/move/begin",
            json={"expected_host_id": dream},
            headers=auth,
        )
        assert r.status_code == 200, r.text
        r = await client.post(
            f"/api/sessions/{session_id}/move/abort",
            json={"expected_host_id": dream},
            headers=auth,
        )
        assert r.status_code == 200, r.text
        assert (r.json()["status"], r.json()["exit_code"]) == ("killed", 0)
        assert datetime.fromisoformat(r.json()["exited_at"]).replace(tzinfo=UTC) == exited_at
        assert daemons.log == [("dream", "session.kill", dream)]


async def test_a_move_begun_after_a_restart_read_the_window_refuses_the_restart(
    client, monkeypatch
):
    """Begin lands between a restart's read and its write: the restart is
    refused with `move_in_progress` and sends nothing, so no shell starts on
    the host the conversation is leaving."""
    auth, dream, _mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-race-restart@example.com"
    )

    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.sql.dml import Update

    real_execute = AsyncSession.execute
    raced = False

    async def execute(self, statement, *args, **kwargs):
        nonlocal raced
        if not raced and isinstance(statement, Update) and statement.table.name == "sessions":
            raced = True
            await _write_row(session_id, status="moving")
        return await real_execute(self, statement, *args, **kwargs)

    async with _Daemons({"dream": dream}) as daemons:
        monkeypatch.setattr(AsyncSession, "execute", execute)
        try:
            r = await client.post(f"/api/sessions/{session_id}/restart", headers=auth)
        finally:
            monkeypatch.setattr(AsyncSession, "execute", real_execute)
        assert raced
        assert r.status_code == 409 and r.json()["detail"] == "move_in_progress"
        assert (await _row(session_id)).status == "moving"
        assert daemons.log == []


async def test_a_restart_overtaken_by_a_begin_before_its_launch_is_refused(client, monkeypatch):
    """The other order: the restart has committed and a begin lands before its
    launch goes out. The launch re-reads the row under the daemon's lifecycle
    lock and is not sent, and the restart says so — `409 move_in_progress`,
    not a "starting" its caller would type a resume into — with a data frame
    for the write it did commit. The window stays moving, and an abort then
    finds it as it really is: still running when it was (no kill), stopped
    when it had stopped before the restart (killed, with its old exit)."""
    auth, dream, _mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-race-restart-dispatch@example.com"
    )
    user_id = await _user_id("session-move-race-restart-dispatch@example.com")

    import asyncio

    from spawn_server.redis import user_alert_channel
    from spawn_server.routes import capabilities as capabilities_mod
    from tests.test_data_events import _ChannelTap

    real_launch_capabilities = capabilities_mod.get_session_launch_capabilities

    async def begin_meanwhile(*args, **kwargs):
        await _write_row(session_id, status="moving")
        return await real_launch_capabilities(*args, **kwargs)

    def abort():
        return client.post(
            f"/api/sessions/{session_id}/move/abort",
            json={"expected_host_id": dream},
            headers=auth,
        )

    stopped_at = datetime(2026, 10, 4, 7, 0, tzinfo=UTC)
    async with _Daemons({"dream": dream}, watched=session_id) as daemons:
        for before, after_abort in (
            ({"status": "running", "exited_at": None}, "running"),
            ({"status": "exited", "exited_at": stopped_at, "exit_code": 1}, "killed"),
        ):
            await _write_row(session_id, **before)
            daemons.log.clear()
            monkeypatch.setattr(
                capabilities_mod, "get_session_launch_capabilities", begin_meanwhile
            )
            async with _ChannelTap(user_alert_channel(user_id)) as tap:
                r = await client.post(f"/api/sessions/{session_id}/restart", headers=auth)
                # Published by the route itself; waited for, not yielded to,
                # so a real Redis has time to deliver it.
                for _ in range(200):
                    if ("data", "sessions", session_id) in [
                        (f.get("type"), f.get("resource"), f.get("id")) for f in tap.frames
                    ]:
                        break
                    await asyncio.sleep(0.01)
                else:
                    raise AssertionError("the refused restart published no data frame")
            monkeypatch.setattr(
                capabilities_mod, "get_session_launch_capabilities", real_launch_capabilities
            )
            assert r.status_code == 409 and r.json()["detail"] == "move_in_progress"
            assert daemons.log == []
            row = await _row(session_id)
            assert row.status == "moving"
            # The restart's commit cleared it; the withheld launch put back
            # when the window had stopped, and left a live one's alone.
            assert _aware(row.exited_at) == before["exited_at"]

            r = await abort()
            assert r.status_code == 200, r.text
            assert r.json()["status"] == after_abort
            expected_log = [] if after_abort == "running" else [("dream", "session.kill", dream)]
            assert daemons.log == expected_log


def _aware(value):
    return value if value is None or value.tzinfo is not None else value.replace(tzinfo=UTC)


async def test_a_restart_raced_by_a_move_never_reaches_the_host_the_window_left(
    client, monkeypatch
):
    """The window-rebind follow-up: restart was not fenced against a move from
    another device. A move that lands between the restart's read and its
    write refuses the restart (`move_conflict`); one that lands after its
    write and before its launch leaves the launch unsent. Either way the
    host the window left is never told to start it again."""
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-race-restart-move@example.com"
    )

    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.sql.dml import Update

    from spawn_server.routes import capabilities as capabilities_mod

    real_execute = AsyncSession.execute
    raced = False

    async def execute(self, statement, *args, **kwargs):
        nonlocal raced
        if not raced and isinstance(statement, Update) and statement.table.name == "sessions":
            raced = True
            await _write_row(session_id, host_id=mac, status="starting")
        return await real_execute(self, statement, *args, **kwargs)

    async with _Daemons({"dream": dream, "mac": mac}) as daemons:
        monkeypatch.setattr(AsyncSession, "execute", execute)
        try:
            r = await client.post(f"/api/sessions/{session_id}/restart", headers=auth)
        finally:
            monkeypatch.setattr(AsyncSession, "execute", real_execute)
        assert raced
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        assert daemons.log == []

        # Back on dream for the second half of the race.
        await _write_row(session_id, host_id=dream, status="running")
        real_launch_capabilities = capabilities_mod.get_session_launch_capabilities

        async def move_meanwhile(*args, **kwargs):
            await _write_row(session_id, host_id=mac, status="starting")
            return await real_launch_capabilities(*args, **kwargs)

        monkeypatch.setattr(capabilities_mod, "get_session_launch_capabilities", move_meanwhile)
        r = await client.post(f"/api/sessions/{session_id}/restart", headers=auth)
        monkeypatch.setattr(
            capabilities_mod, "get_session_launch_capabilities", real_launch_capabilities
        )
        # Nothing restarted, and the caller is told: it was moved meanwhile.
        assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        assert daemons.frames("dream") == []
        assert (await _row(session_id)).host_id == mac


async def test_a_move_overtaken_before_its_launch_is_refused_and_starts_nothing(
    client, monkeypatch
):
    """A move has committed (rebound, the old host told to stop) and another
    device acts on the window before the launch reaches the target. The
    launch is withheld and the mover hears it — `409 move_in_progress` for a
    move begun from the target, `404` for a window closed meanwhile — rather
    than a "starting" it would take control of and type into. A window
    withheld this way never ran on the target, so an abort there finds it
    stopped."""
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-overtaken@example.com"
    )

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Session
    from spawn_server.routes import capabilities as capabilities_mod

    real_launch_capabilities = capabilities_mod.get_session_launch_capabilities

    def move():
        return client.post(
            f"/api/sessions/{session_id}/move",
            json={"host_id": mac, "cwd": "/work", "expected_host_id": dream},
            headers=auth,
        )

    async def begin_meanwhile(*args, **kwargs):
        await _write_row(session_id, status="moving")
        return await real_launch_capabilities(*args, **kwargs)

    async def close_meanwhile(*args, **kwargs):
        async with get_sessionmaker()() as other:
            row = await other.get(Session, session_id)
            assert row is not None
            await other.delete(row)
            await other.commit()
        return await real_launch_capabilities(*args, **kwargs)

    async with _Daemons({"dream": dream, "mac": mac}, watched=session_id) as daemons:
        monkeypatch.setattr(capabilities_mod, "get_session_launch_capabilities", begin_meanwhile)
        r = await move()
        monkeypatch.setattr(
            capabilities_mod, "get_session_launch_capabilities", real_launch_capabilities
        )
        assert r.status_code == 409 and r.json()["detail"] == "move_in_progress"
        assert daemons.log == [("dream", "session.kill", mac)]
        row = await _row(session_id)
        assert (row.host_id, row.status) == (mac, "moving")
        assert row.exited_at is not None

        r = await client.post(
            f"/api/sessions/{session_id}/move/abort",
            json={"expected_host_id": mac},
            headers=auth,
        )
        assert r.status_code == 200, r.text
        assert (r.json()["host_id"], r.json()["status"]) == (mac, "killed")
        assert daemons.log[1:] == [("mac", "session.kill", mac)]

        # Back on dream, and closed this time before the launch.
        await _write_row(session_id, host_id=dream, status="running", exited_at=None)
        daemons.log.clear()
        monkeypatch.setattr(capabilities_mod, "get_session_launch_capabilities", close_meanwhile)
        r = await move()
        monkeypatch.setattr(
            capabilities_mod, "get_session_launch_capabilities", real_launch_capabilities
        )
        assert r.status_code == 404
        assert daemons.log == [("dream", "session.kill", mac)]
        assert await _row(session_id) is None


async def test_a_delete_raced_by_a_move_kills_where_the_window_went(client, monkeypatch):
    """Delete names no host, so it is decided in one statement that reports
    where the window was when it went: a move that lands first is followed,
    and the kill reaches the new host rather than the one it left."""
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-race-delete@example.com"
    )

    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.sql.dml import Delete

    real_execute = AsyncSession.execute
    raced = False

    async def execute(self, statement, *args, **kwargs):
        nonlocal raced
        if not raced and isinstance(statement, Delete) and statement.table.name == "sessions":
            raced = True
            await _write_row(session_id, host_id=mac, status="starting")
        return await real_execute(self, statement, *args, **kwargs)

    async with _Daemons({"dream": dream, "mac": mac}) as daemons:
        monkeypatch.setattr(AsyncSession, "execute", execute)
        try:
            r = await client.delete(f"/api/sessions/{session_id}", headers=auth)
        finally:
            monkeypatch.setattr(AsyncSession, "execute", real_execute)
        assert raced
        assert r.status_code == 204, r.text
        assert daemons.frames("mac") == ["session.kill"]
        assert daemons.frames("dream") == []
        assert await _row(session_id) is None


async def test_move_begin_and_commit_lose_their_compare_and_set_to_a_write_that_landed_first(
    client, monkeypatch
):
    """Two devices: a begin that finds another device's begin landed first is
    `move_in_progress`; a commit that finds the move aborted meanwhile is
    `move_conflict`. Neither writes nor sends anything."""
    auth, dream, mac, _skill_id, _claude, session_id = await _move_fixture(
        client, "session-move-race-cas@example.com"
    )

    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.sql.dml import Update

    real_execute = AsyncSession.execute
    landed: dict[str, object] = {}

    async def execute(self, statement, *args, **kwargs):
        if landed and isinstance(statement, Update) and statement.table.name == "sessions":
            values = dict(landed)
            landed.clear()
            await _write_row(session_id, **values)
        return await real_execute(self, statement, *args, **kwargs)

    async with _Daemons({"dream": dream, "mac": mac}) as daemons:
        monkeypatch.setattr(AsyncSession, "execute", execute)
        try:
            landed.update(status="moving")
            r = await client.post(
                f"/api/sessions/{session_id}/move/begin",
                json={"expected_host_id": dream},
                headers=auth,
            )
            assert r.status_code == 409 and r.json()["detail"] == "move_in_progress"

            landed.update(status="killed")
            r = await client.post(
                f"/api/sessions/{session_id}/move",
                json={
                    "host_id": mac,
                    "cwd": "/work",
                    "expected_host_id": dream,
                    "agent_session_id": "conv-dream",
                    "carried": True,
                },
                headers=auth,
            )
            assert r.status_code == 409 and r.json()["detail"] == "move_conflict"
        finally:
            monkeypatch.setattr(AsyncSession, "execute", real_execute)
        row = await _row(session_id)
        assert (row.host_id, row.status) == (dream, "killed")
        assert daemons.log == []


async def test_a_kill_waits_for_a_launch_already_going_out(client):
    """Kills take the daemon's lifecycle lock, as launches do, so a launch
    that re-read its row before a move's commit reaches the daemon before
    that move's kill, and the kill ends what the launch started."""
    email = "session-kill-lock@example.com"
    await _signup(client, email)
    host_id = await _create_host(email)
    session_id = await _create_session_row(email, host_id)

    import asyncio

    from spawn_server.routes.sessions import send_session_kill

    async with _Daemons({"box": host_id}) as daemons:
        conn = daemons.conns["box"]
        async with conn.lifecycle_lock:  # type: ignore[attr-defined]
            kill = asyncio.create_task(send_session_kill(session_id, host_id))
            for _ in range(20):
                await asyncio.sleep(0)
            assert daemons.frames("box") == []
        await asyncio.wait_for(kill, timeout=1)
        assert daemons.frames("box") == ["session.kill"]
