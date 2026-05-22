"""Multi-tenant scoping: user A cannot see user B's hosts."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field


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


async def test_host_scoping(client):
    a_token = await _signup(client, "a@example.com")
    b_token = await _signup(client, "b@example.com")

    # Create a host for user A directly via the ORM (skip device flow for this test).
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        a = (await session.execute(select(User).where(User.email == "a@example.com"))).scalar_one()
        host = Host(owner_user_id=a.id, name="a-box", status="offline")
        session.add(host)
        await session.commit()
        host_id = host.id

    # User A sees their host.
    r = await client.get("/api/hosts", headers={"Authorization": f"Bearer {a_token}"})
    assert r.status_code == 200
    assert any(h["id"] == host_id for h in r.json())

    # User B does NOT see A's host.
    r = await client.get("/api/hosts", headers={"Authorization": f"Bearer {b_token}"})
    assert r.status_code == 200
    assert not any(h["id"] == host_id for h in r.json())

    # User B can't fetch A's host directly.
    r = await client.get(f"/api/hosts/{host_id}", headers={"Authorization": f"Bearer {b_token}"})
    assert r.status_code == 404

    # User B can't delete it either.
    r = await client.delete(f"/api/hosts/{host_id}", headers={"Authorization": f"Bearer {b_token}"})
    assert r.status_code == 404


async def test_host_tool_check_roundtrip(client):
    token = await _signup(client, "host-tools@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, Preset, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-tools@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="tool-box", status="online")
        session.add(host)
        preset = (
            await session.execute(select(Preset).where(Preset.name == "codex"))
        ).scalar_one()
        await session.commit()
        host_id = host.id
        preset_id = preset.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    task = asyncio.create_task(client.get(f"/api/hosts/{host_id}/tools", headers=auth))
    for _ in range(100):
        if fake_ws.sent_text:
            break
        if task.done():
            break
        await asyncio.sleep(0.01)
    assert fake_ws.sent_text, (await task).text
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "host.tools.check"
    assert any(t["preset_id"] == preset_id and t["command"] == "codex" for t in sent["targets"])
    async with sm() as session:
        from spawn_server.models import HostToolPolicy

        policy_count = (
            await session.execute(
                select(HostToolPolicy).where(HostToolPolicy.host_id == host_id)
            )
        ).scalars().all()
    assert policy_count

    await broker.resolve_tool_check(
        sent["request_id"],
        {
            "type": "host.tools.check_result",
            "request_id": sent["request_id"],
            "tools": [
                {
                    "preset_id": preset_id,
                    "preset_name": "codex",
                    "agent_kind": "codex",
                    "command": "codex",
                    "install": "npm install -g @openai/codex",
                    "installed": True,
                    "path": "/usr/local/bin/codex",
                    "version": "codex 1.2.3",
                    "error": None,
                }
            ],
        },
    )
    r = await task
    assert r.status_code == 200, r.text
    assert r.json()["tools"][0]["version"] == "codex 1.2.3"

    install_task = asyncio.create_task(
        client.post(f"/api/hosts/{host_id}/tools/{preset_id}/install", headers=auth)
    )
    sent_count = len(fake_ws.sent_text)
    for _ in range(100):
        if len(fake_ws.sent_text) > sent_count:
            break
        if install_task.done():
            break
        await asyncio.sleep(0.01)
    assert len(fake_ws.sent_text) > sent_count, (await install_task).text
    install_sent = json.loads(fake_ws.sent_text[-1])
    assert install_sent["type"] == "host.tools.install"
    assert install_sent["target"]["preset_id"] == preset_id

    await broker.resolve_tool_install(
        install_sent["request_id"],
        {
            "type": "host.tools.install_result",
            "request_id": install_sent["request_id"],
            "result": {
                "preset_id": preset_id,
                "preset_name": "codex",
                "agent_kind": "codex",
                "command": "codex",
                "install": "npm install -g @openai/codex",
                "success": True,
                "exit_code": 0,
                "output": "updated",
                "error": None,
                "status": None,
            },
        },
    )
    r = await install_task
    assert r.status_code == 200, r.text
    assert r.json()["output"] == "updated"

    await broker.unregister_daemon(daemon)


async def test_host_tools_require_online_daemon(client):
    token = await _signup(client, "host-tools-offline@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-tools-offline@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="offline-box", status="offline")
        session.add(host)
        await session.commit()
        host_id = host.id

    r = await client.get(f"/api/hosts/{host_id}/tools", headers=auth)
    assert r.status_code == 409


async def test_host_dir_list_roundtrip(client):
    token = await _signup(client, "host-dirs-route@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-dirs-route@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="dir-box", status="online")
        session.add(host)
        await session.commit()
        host_id = host.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    task = asyncio.create_task(
        client.get(f"/api/hosts/{host_id}/dirs?path=/home/me/proj", headers=auth)
    )
    for _ in range(100):
        if fake_ws.sent_text:
            break
        if task.done():
            break
        await asyncio.sleep(0.01)
    assert fake_ws.sent_text, (await task).text
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "host.fs.list"
    assert sent["path"] == "/home/me/proj"

    await broker.resolve_dir_list(
        sent["request_id"],
        {
            "type": "host.fs.list_result",
            "request_id": sent["request_id"],
            "path": "/home/me/proj",
            "home_dir": "/home/me",
            "parent": "/home/me",
            "entries": [{"name": "repo", "path": "/home/me/proj/repo"}],
            "error": None,
        },
    )
    r = await task
    assert r.status_code == 200, r.text
    assert r.json() == {
        "path": "/home/me/proj",
        "home_dir": "/home/me",
        "parent": "/home/me",
        "entries": [{"name": "repo", "path": "/home/me/proj/repo"}],
        "error": None,
    }

    await broker.unregister_daemon(daemon)


async def test_host_daemon_status_timeout_degrades_to_payload(client, monkeypatch):
    token = await _signup(client, "host-daemon-timeout@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.routes import hosts as hosts_mod

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-daemon-timeout@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="slow-daemon", status="online")
        session.add(host)
        await session.commit()
        host_id = host.id

    class TimeoutBroker:
        def get_daemon_for_host(self, _host_id):
            return object()

        async def request_daemon_status_for_host(self, _host_id):
            return None

    monkeypatch.setattr(hosts_mod, "get_broker", lambda: TimeoutBroker())

    r = await client.get(f"/api/hosts/{host_id}/daemon", headers=auth)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "online"
    assert body["agents"] == []
    assert body["update"]["ok"] is False
    assert body["update"]["changes"] == "host daemon status timed out"


async def test_host_tool_policy_auto_update_schedules_install(client):
    token = await _signup(client, "host-tools-auto@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, Preset, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-tools-auto@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="auto-box", status="online")
        session.add(host)
        preset = (
            await session.execute(select(Preset).where(Preset.name == "codex"))
        ).scalar_one()
        await session.commit()
        host_id = host.id
        preset_id = preset.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    r = await client.patch(
        f"/api/hosts/{host_id}/tools/{preset_id}/policy",
        json={"auto_update": True},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    assert r.json()["auto_update"] is True

    check_task = asyncio.create_task(client.get(f"/api/hosts/{host_id}/tools", headers=auth))
    for _ in range(100):
        if fake_ws.sent_text:
            break
        await asyncio.sleep(0.01)
    sent = json.loads(fake_ws.sent_text[-1])
    assert sent["type"] == "host.tools.check"
    await broker.resolve_tool_check(
        sent["request_id"],
        {
            "type": "host.tools.check_result",
            "request_id": sent["request_id"],
            "tools": [
                {
                    "preset_id": preset_id,
                    "preset_name": "codex",
                    "agent_kind": "codex",
                    "command": "codex",
                    "install": "npm install -g @openai/codex",
                    "installed": True,
                    "path": "/usr/local/bin/codex",
                    "version": "codex 1.2.3",
                    "latest_version": "1.2.4",
                    "update_available": True,
                    "error": None,
                }
            ],
        },
    )
    r = await check_task
    assert r.status_code == 200, r.text
    tool = r.json()["tools"][0]
    assert tool["auto_update"] is True
    assert tool["update_available"] is True

    for _ in range(100):
        if any(json.loads(text)["type"] == "host.tools.install" for text in fake_ws.sent_text):
            break
        await asyncio.sleep(0.01)
    sent_frames = [json.loads(text) for text in fake_ws.sent_text]
    install_sent = next(frame for frame in sent_frames if frame["type"] == "host.tools.install")
    assert install_sent["target"]["preset_id"] == preset_id

    await broker.resolve_tool_install(
        install_sent["request_id"],
        {
            "type": "host.tools.install_result",
            "request_id": install_sent["request_id"],
            "result": {
                "preset_id": preset_id,
                "preset_name": "codex",
                "agent_kind": "codex",
                "command": "codex",
                "install": "npm install -g @openai/codex",
                "success": True,
                "exit_code": 0,
                "output": "updated",
                "error": None,
                "status": None,
            },
        },
    )
    await asyncio.sleep(0)
    await broker.unregister_daemon(daemon)
