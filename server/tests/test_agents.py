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


async def test_agent_rename_archive_and_delete(client):
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
    assert r.json()["tmux_session"] == f"spawn-ui-work--{agent_id}"
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


async def test_agent_rename_dispatches_tmux_session_update(client):
    token = await _signup(client, "agent-rename-dispatch@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "agent-rename-dispatch@example.com")
            )
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
            name="old name",
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
    await broker.attach_agent_to_daemon(agent_id, daemon)

    r = await client.patch(
        f"/api/agents/{agent_id}",
        json={"name": "Palette / Codex"},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent == {
        "type": "agent.rename",
        "agent_id": agent_id,
        "tmux_session": f"spawn-palette-codex--{agent_id}",
    }

    await broker.unregister_daemon(daemon)


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
    assert body["tmux_session"] == f"spawn-dream-spawn--{body['id']}"


async def test_agent_create_dispatches_managed_mcp_servers_and_skills(client):
    token = await _signup(client, "agent-capabilities@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    mcp = await client.post(
        "/api/mcp-servers",
        json={
            "name": "spawn",
            "transport": "streamable_http",
            "url": "http://testserver/mcp",
            "headers": {"Authorization": "Bearer test"},
        },
        headers=auth,
    )
    assert mcp.status_code == 201, mcp.text
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
            "mcp_server_ids": [mcp.json()["id"]],
            "skill_ids": [skill.json()["id"]],
        },
        headers=auth,
    )
    assert r.status_code == 201, r.text

    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "agent.create"
    assert sent["mcp_servers"][0]["name"] == "spawn"
    assert sent["mcp_servers"][0]["headers"]["Authorization"] == "Bearer test"
    assert sent["skills"][0]["name"] == "spawn-test"
    assert sent["skills"][0]["content"] == "# Spawn Test\nUse Spawn."

    access = await client.get(f"/api/agents/{r.json()['id']}/access", headers=auth)
    assert access.status_code == 200, access.text
    assert access.json()["mcp_servers"][0]["id"] == mcp.json()["id"]
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
    assert sent["cols"] == 100
    assert sent["rows"] == 40
    assert sent["cwd"] == "/repo"
    assert sent["argv"] == ["codex", "--yolo"]
    assert sent["tmux_session"] == f"spawn-agent--{agent_id}"

    await broker.unregister_daemon(daemon)


async def test_agent_rest_control_dispatches_browser_equivalent_frames(client):
    token = await _signup(client, "agent-rest-control@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    import asyncio
    import base64

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker
    from spawn_server.ws.frames import KIND_INPUT, decode_binary_frame

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
    await broker.attach_agent_to_daemon(agent_id, daemon)

    r = await client.post(
        f"/api/agents/{agent_id}/input",
        json={"text": "hello\n"},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    frame = decode_binary_frame(fake_ws.sent_bytes[-1])
    assert frame.kind == KIND_INPUT
    assert frame.agent_id == agent_id
    assert frame.payload == b"hello\n"

    r = await client.post(
        f"/api/agents/{agent_id}/resize",
        json={"cols": 100, "rows": 40},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    assert json.loads(fake_ws.sent_text[-1]) == {
        "type": "agent.resize",
        "agent_id": agent_id,
        "cols": 100,
        "rows": 40,
    }

    r = await client.post(
        f"/api/agents/{agent_id}/scroll",
        json={"lines": -20},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    assert json.loads(fake_ws.sent_text[-1]) == {
        "type": "agent.scroll",
        "agent_id": agent_id,
        "lines": -20,
    }

    r = await client.post(f"/api/agents/{agent_id}/redraw", headers=auth)
    assert r.status_code == 200, r.text
    assert json.loads(fake_ws.sent_text[-1]) == {"type": "agent.redraw", "agent_id": agent_id}

    snapshot_task = asyncio.create_task(
        client.post(
            f"/api/agents/{agent_id}/snapshot",
            json={"lines": 123, "plain": True},
            headers=auth,
        )
    )
    sent_count = len(fake_ws.sent_text)
    for _ in range(100):
        if len(fake_ws.sent_text) >= sent_count:
            sent = json.loads(fake_ws.sent_text[-1])
            if sent["type"] == "agent.snapshot":
                break
        await asyncio.sleep(0.01)
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent == {"type": "agent.snapshot", "agent_id": agent_id, "lines": 123, "plain": True}
    await broker.resolve_snapshot(agent_id, {"bytes_b64": base64.b64encode(b"screen").decode("ascii")})
    r = await snapshot_task
    assert r.status_code == 200, r.text
    assert base64.b64decode(r.json()["bytes_b64"]) == b"screen"

    upload_task = asyncio.create_task(
        client.post(
            f"/api/agents/{agent_id}/upload",
            json={
                "destination": "cwd",
                "name": "notes.txt",
                "mime_type": "text/plain",
                "bytes_b64": base64.b64encode(b"notes").decode("ascii"),
                "paste": False,
                "client_id": "rest-upload-1",
            },
            headers=auth,
        )
    )
    for _ in range(100):
        sent = json.loads(fake_ws.sent_text[-1])
        if sent["type"] == "agent.upload":
            break
        await asyncio.sleep(0.01)
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "agent.upload"
    assert sent["agent_id"] == agent_id
    assert sent["cwd"] == "/repo"
    assert sent["name"] == "notes.txt"
    assert sent["mime_type"] == "text/plain"
    assert sent["paste_prefix"] == "@"
    assert sent["paste"] is False
    assert sent["destination"] == "cwd"
    assert sent["client_id"] == "rest-upload-1"
    await broker.resolve_upload(
        agent_id,
        "rest-upload-1",
        {"agent_id": agent_id, "path": "/repo/notes.txt", "client_id": "rest-upload-1"},
    )
    r = await upload_task
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "/repo/notes.txt"

    await broker.unregister_daemon(daemon)


async def test_agent_multipart_upload_file_dispatches_daemon_frame(client):
    token = await _signup(client, "agent-multipart-upload@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    import asyncio
    import base64

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "agent-multipart-upload@example.com")
            )
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
    await broker.attach_agent_to_daemon(agent_id, daemon)

    upload_task = asyncio.create_task(
        client.post(
            f"/api/agents/{agent_id}/upload-file",
            data={"destination": "cwd", "paste": "false", "client_id": "multipart-upload-1"},
            files={"file": ("notes.txt", b"multipart notes", "text/plain")},
            headers=auth,
        )
    )
    for _ in range(100):
        if fake_ws.sent_text:
            sent = json.loads(fake_ws.sent_text[-1])
            if sent["type"] == "agent.upload":
                break
        await asyncio.sleep(0.01)
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "agent.upload"
    assert sent["agent_id"] == agent_id
    assert sent["cwd"] == "/repo"
    assert sent["name"] == "notes.txt"
    assert sent["mime_type"] == "text/plain"
    assert base64.b64decode(sent["bytes_b64"]) == b"multipart notes"
    assert sent["paste_prefix"] == "@"
    assert sent["paste"] is False
    assert sent["destination"] == "cwd"
    assert sent["client_id"] == "multipart-upload-1"
    await broker.resolve_upload(
        agent_id,
        "multipart-upload-1",
        {"agent_id": agent_id, "path": "/repo/notes.txt", "client_id": "multipart-upload-1"},
    )
    r = await upload_task
    assert r.status_code == 200, r.text
    assert r.json()["path"] == "/repo/notes.txt"

    await broker.unregister_daemon(daemon)


async def test_agent_multipart_upload_rejects_non_image_without_cwd_destination(client):
    token = await _signup(client, "agent-multipart-reject@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "agent-multipart-reject@example.com")
            )
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="online")
        session.add(host)
        await session.flush()
        agent = Agent(
            owner_user_id=user.id,
            host_id=host.id,
            cwd="/repo",
            argv=["bash"],
            env={},
            name="shell",
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
    await broker.attach_agent_to_daemon(agent_id, daemon)

    r = await client.post(
        f"/api/agents/{agent_id}/upload-file",
        files={"file": ("notes.txt", b"not an image", "text/plain")},
        headers=auth,
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "Only image files can be pasted or dropped here."
    assert all(json.loads(frame)["type"] != "agent.upload" for frame in fake_ws.sent_text)

    await broker.unregister_daemon(daemon)


async def test_agent_multipart_upload_file_rejects_oversize_before_agent_lookup(client, monkeypatch):
    token = await _signup(client, "agent-multipart-oversize@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from spawn_server import agent_control

    monkeypatch.setattr(agent_control, "MAX_UPLOAD_BYTES", 8)

    r = await client.post(
        "/api/agents/not-an-agent/upload-file",
        files={"file": ("too-big.txt", b"123456789", "text/plain")},
        headers=auth,
    )
    assert r.status_code == 400, r.text
    assert r.json()["detail"] == "Upload is too large; the limit is 20 MB."
