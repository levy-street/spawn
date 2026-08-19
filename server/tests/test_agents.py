"""Agent metadata and lifecycle API behavior."""

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


async def _accept_daemon(daemon, *, generation: int = 1) -> None:
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host
    from spawn_server.redis import get_backend
    from spawn_server.ws.broker import get_broker
    from spawn_server.ws.host_signal import (
        HOST_DAEMON_PRESENCE_TTL_SECONDS,
        HostPresenceOwner,
        encode_host_presence_owner,
        host_presence_key,
    )

    daemon.host_generation = generation
    async with get_sessionmaker()() as session:
        host = await session.get(Host, daemon.host_id)
        assert host is not None
        host.daemon_connection_id = daemon.id
        host.daemon_generation = generation
        host.daemon_generation_counter = generation
        host.daemon_pending_connection_id = None
        host.daemon_pending_generation = None
        await session.commit()
    await get_backend().set_ephemeral(
        host_presence_key(daemon.host_id),
        encode_host_presence_owner(HostPresenceOwner(daemon.id, generation)),
        ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
    )
    assert await get_broker().accept_daemon_owner(daemon, generation)


async def test_agent_patch_name_archive_and_delete(client):
    token = await _signup(client, "agent-owner@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "agent-owner@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="offline")
        session.add(host)
        await session.flush()
        agent = Agent(
            owner_user_id=user.id,
            host_id=host.id,
            cwd="/repo",
            argv=["codex"],
            env={},
            status="running",
        )
        session.add(agent)
        await session.commit()
        agent_id = agent.id

    r = await client.patch(f"/api/agents/{agent_id}", json={"name": "  ui work  "}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "ui work"
    assert r.json()["archived_at"] is None
    assert r.json()["pinned_at"] is None

    r = await client.patch(f"/api/agents/{agent_id}", json={"pinned": True}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["pinned_at"] is not None

    r = await client.patch(f"/api/agents/{agent_id}", json={"pinned": False}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["pinned_at"] is None

    r = await client.patch(f"/api/agents/{agent_id}", json={"archived": True}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["archived_at"] is not None

    r = await client.get("/api/agents", headers=auth)
    assert r.status_code == 200
    assert all(a["id"] != agent_id for a in r.json())

    r = await client.get("/api/agents?include_archived=true", headers=auth)
    assert r.status_code == 200
    assert any(a["id"] == agent_id for a in r.json())

    r = await client.delete(f"/api/agents/{agent_id}", headers=auth)
    assert r.status_code == 204, r.text

    r = await client.get(f"/api/agents/{agent_id}", headers=auth)
    assert r.status_code == 404


async def test_agent_create_defaults_name_from_host_and_cwd(client):
    token = await _signup(client, "default-name@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "default-name@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="dream", status="offline")
        session.add(host)
        await session.commit()
        host_id = host.id

    r = await client.post(
        "/api/agents",
        json={"host_id": host_id, "cwd": "/home/oem/projects/spawn", "argv": ["codex"]},
        headers=auth,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["name"] == "dream - spawn"
    assert body["host_name"] == "dream"


async def test_agent_create_dispatches_managed_skills(client):
    token = await _signup(client, "agent-capabilities@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
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

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "agent-capabilities@example.com")
            )
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="online")
        session.add(host)
        await session.commit()
        host_id = host.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    r = await client.post(
        "/api/agents",
        json={
            "name": "capability agent",
            "host_id": host_id,
            "cwd": "/tmp",
            "argv": ["bash", "-lc", "cat"],
            "skill_ids": [skill.json()["id"]],
        },
        headers=auth,
    )
    assert r.status_code == 201, r.text

    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "agent.create"
    assert "mcp_servers" not in sent
    assert sent["skills"][0]["name"] == "spawn-test"
    assert sent["skills"][0]["content"] == "# Spawn Test\nUse Spawn."

    access = await client.get(f"/api/agents/{r.json()['id']}/access", headers=auth)
    assert access.status_code == 200, access.text
    assert access.json()["skills"][0]["id"] == skill.json()["id"]

    await broker.unregister_daemon(daemon)


async def test_agent_activity_fields(client):
    token = await _signup(client, "agent-activity@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User

    now = datetime.now(UTC)
    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "agent-activity@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="online")
        session.add(host)
        await session.flush()
        agent = Agent(
            owner_user_id=user.id,
            host_id=host.id,
            cwd="/repo",
            argv=["codex"],
            env={},
            status="running",
            last_output_at=now - timedelta(seconds=30),
        )
        session.add(agent)
        await session.commit()
        agent_id = agent.id

    r = await client.get(f"/api/agents/{agent_id}", headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["activity_state"] == "waiting"
    assert body["activity_label"] == "Awaiting input"
    assert body["last_output_at"] is not None
    assert body["last_activity_at"] is not None


async def test_agent_restart_dispatches_existing_agent(client):
    token = await _signup(client, "agent-restart@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, Preset, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "agent-restart@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="online")
        preset = (
            await session.execute(select(Preset).where(Preset.name == "codex"))
        ).scalar_one()
        session.add(host)
        await session.flush()
        agent = Agent(
            owner_user_id=user.id,
            host_id=host.id,
            preset_id=preset.id,
            cwd="/repo",
            argv=["codex", "--yolo"],
            env={"A": "B"},
            status="running",
        )
        session.add(agent)
        await session.commit()
        host_id = host.id
        agent_id = agent.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    r = await client.post(
        f"/api/agents/{agent_id}/restart",
        json={"cols": 100, "rows": 40},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "starting"
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "agent.restart"
    assert sent["agent_id"] == agent_id
    assert "cols" not in sent
    assert "rows" not in sent
    assert sent["cwd"] == "/repo"
    assert sent["argv"] == ["codex", "--yolo"]

    await broker.unregister_daemon(daemon)


async def test_agent_terminal_content_routes_are_removed(client):
    token = await _signup(client, "agent-rest-control@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "agent-rest-control@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="online")
        session.add(host)
        await session.flush()
        agent = Agent(
            owner_user_id=user.id,
            host_id=host.id,
            cwd="/repo",
            argv=["codex", "--yolo"],
            env={},
            name="palette",
            status="running",
        )
        session.add(agent)
        await session.commit()
        host_id = host.id
        agent_id = agent.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)
    await broker.attach_agent_to_daemon(agent_id, daemon)

    for path, body in (
        ("input", {"text": "hello\n"}),
        ("resize", {"cols": 100, "rows": 40}),
        ("scroll", {"lines": -20}),
        ("redraw", None),
        ("snapshot", {"lines": 123, "plain": True}),
    ):
        r = await client.post(f"/api/agents/{agent_id}/{path}", json=body, headers=auth)
        assert r.status_code == 404
    assert fake_ws.sent_bytes == []
    assert all(
        json.loads(frame).get("type")
        not in {"agent.resize", "agent.scroll", "agent.redraw", "agent.snapshot"}
        for frame in fake_ws.sent_text
    )

    r = await client.post(
        f"/api/agents/{agent_id}/upload",
        json={
            "destination": "cwd",
            "name": "secret-rest-name.txt",
            "mime_type": "text/plain",
            "bytes_b64": "c2VjcmV0LXJlc3QtY29udGVudA==",
        },
        headers=auth,
    )
    assert r.status_code == 404
    r = await client.post(
        f"/api/agents/{agent_id}/upload-file",
        files={
            "file": (
                "secret-multipart-name.txt",
                b"secret-multipart-content",
                "text/plain",
            )
        },
        headers=auth,
    )
    assert r.status_code == 404
    assert all(json.loads(frame).get("type") != "agent.upload" for frame in fake_ws.sent_text)

    await broker.unregister_daemon(daemon)


async def _host_and_preset(client, email: str, preset_name: str) -> tuple[dict, str, str]:
    """A signed-in account with a host, plus the id of one built-in preset."""

    token = await _signup(client, email)
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, Preset, User

    async with get_sessionmaker()() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="offline")
        session.add(host)
        await session.commit()
        preset = (
            await session.execute(
                select(Preset).where(Preset.owner_user_id.is_(None), Preset.name == preset_name)
            )
        ).scalar_one()
        return auth, host.id, preset.id


async def test_yolo_appends_the_presets_flag_and_keeps_the_preset(client):
    """The point of composing server-side rather than sending a custom argv.

    A custom argv replaces the preset wholesale and loses `preset_id`, and
    with it the daemon's install-when-missing path.
    """

    auth, host_id, preset_id = await _host_and_preset(client, "yolo-on@example.com", "codex")

    r = await client.post(
        "/api/agents",
        json={"host_id": host_id, "cwd": "/repo", "preset_id": preset_id, "yolo": True},
        headers=auth,
    )
    assert r.status_code == 201, r.text
    assert r.json()["argv"] == ["codex", "--yolo"]
    assert r.json()["preset_id"] == preset_id


async def test_yolo_off_is_the_untouched_preset_command(client):
    auth, host_id, preset_id = await _host_and_preset(client, "yolo-off@example.com", "codex")

    r = await client.post(
        "/api/agents",
        json={"host_id": host_id, "cwd": "/repo", "preset_id": preset_id, "yolo": False},
        headers=auth,
    )
    assert r.status_code == 201, r.text
    assert r.json()["argv"] == ["codex"]

    # Omitting the field entirely is the same as off: an API client that
    # predates this must not silently start ungating agents.
    r = await client.post(
        "/api/agents",
        json={"host_id": host_id, "cwd": "/repo", "preset_id": preset_id},
        headers=auth,
    )
    assert r.status_code == 201, r.text
    assert r.json()["argv"] == ["codex"]


async def test_yolo_on_a_preset_with_no_flag_changes_nothing(client):
    """opencode is config-driven and a shell was never gated."""

    for email, preset_name, expected in (
        ("yolo-opencode@example.com", "opencode", ["opencode"]),
        ("yolo-shell@example.com", "shell", ["bash", "-l"]),
    ):
        auth, host_id, preset_id = await _host_and_preset(client, email, preset_name)
        r = await client.post(
            "/api/agents",
            json={"host_id": host_id, "cwd": "/repo", "preset_id": preset_id, "yolo": True},
            headers=auth,
        )
        assert r.status_code == 201, r.text
        assert r.json()["argv"] == expected


async def test_yolo_never_edits_a_hand_written_command(client):
    """A custom argv is exactly what the operator asked for."""

    auth, host_id, _ = await _host_and_preset(client, "yolo-custom@example.com", "codex")

    r = await client.post(
        "/api/agents",
        json={
            "host_id": host_id,
            "cwd": "/repo",
            "argv": ["codex", "--search"],
            "yolo": True,
        },
        headers=auth,
    )
    assert r.status_code == 201, r.text
    assert r.json()["argv"] == ["codex", "--search"]


async def test_a_yolo_agent_still_runs_ungated_after_a_restart(client):
    """The flag lives in the stored argv, so a restart cannot quietly drop it."""

    auth, host_id, preset_id = await _host_and_preset(client, "yolo-restart@example.com", "codex")
    created = await client.post(
        "/api/agents",
        json={"host_id": host_id, "cwd": "/repo", "preset_id": preset_id, "yolo": True},
        headers=auth,
    )
    assert created.status_code == 201, created.text
    agent_id = created.json()["id"]

    from spawn_server.ws.broker import DaemonConn, get_broker

    broker = get_broker()
    ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    restarted = await client.post(f"/api/agents/{agent_id}/restart", json={}, headers=auth)
    assert restarted.status_code == 200, restarted.text
    assert restarted.json()["argv"] == ["codex", "--yolo"]
    dispatched = [json.loads(frame) for frame in ws.sent_text]
    launch = next(frame for frame in dispatched if frame.get("type") == "agent.restart")
    assert launch["argv"] == ["codex", "--yolo"]
    await broker.unregister_daemon(daemon)
