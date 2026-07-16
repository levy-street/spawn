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


async def _wait_for_text_frame(
    fake_ws: _FakeWS,
    frame_type: str,
    *,
    start: int = 0,
) -> dict:
    for _ in range(100):
        for raw in fake_ws.sent_text[start:]:
            frame = json.loads(raw)
            if frame.get("type") == frame_type:
                return frame
        await asyncio.sleep(0.01)
    raise AssertionError(f"did not receive {frame_type}; got {fake_ws.sent_text[start:]!r}")


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
    await _accept_daemon(daemon)

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
                    "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                    "installed": True,
                    "path": "/usr/local/bin/codex",
                    "version": "codex 1.2.3",
                    "error": None,
                }
            ],
        },
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
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
                "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                "success": True,
                "exit_code": 0,
                "output": "updated",
                "error": None,
                "status": None,
            },
        },
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
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


async def test_host_dirs_roundtrip_requires_owned_online_daemon(client):
    a_token = await _signup(client, "host-dirs-a@example.com")
    b_token = await _signup(client, "host-dirs-b@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    b_auth = {"Authorization": f"Bearer {b_token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-dirs-a@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="dir-box", status="online")
        offline_host = Host(owner_user_id=user.id, name="offline-dir-box", status="offline")
        session.add_all([host, offline_host])
        await session.commit()
        host_id = host.id
        offline_host_id = offline_host.id

    assert (
        await client.get(f"/api/hosts/{host_id}/dirs?path=/repo", headers=b_auth)
    ).status_code == 404
    assert (await client.get(f"/api/hosts/{offline_host_id}/dirs", headers=a_auth)).status_code == 409

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)

    task = asyncio.create_task(client.get(f"/api/hosts/{host_id}/dirs?path=/repo", headers=a_auth))
    sent = await _wait_for_text_frame(fake_ws, "host.fs.list")
    assert sent["path"] == "/repo"
    await broker.resolve_dir_list(
        sent["request_id"],
        {
            "path": "/repo",
            "home_dir": "/home/oem",
            "parent": "/",
            "entries": [{"name": "src", "path": "/repo/src"}],
        },
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    r = await task
    assert r.status_code == 200, r.text
    assert r.json() == {
        "path": "/repo",
        "home_dir": "/home/oem",
        "parent": "/",
        "entries": [
            {"name": "src", "path": "/repo/src", "is_dir": None, "size": None, "modified_at": None}
        ],
        "error": None,
    }

    await broker.unregister_daemon(daemon)


async def test_host_files_listing_download_and_ops(client):
    import base64

    token = await _signup(client, "host-files@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-files@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="files-box", status="online")
        session.add(host)
        await session.commit()
        host_id = host.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)

    # Listing requests include files and pass metadata through.
    task = asyncio.create_task(client.get(f"/api/hosts/{host_id}/files?path=/repo", headers=auth))
    sent = await _wait_for_text_frame(fake_ws, "host.fs.list")
    assert sent["include_files"] is True
    await broker.resolve_dir_list(
        sent["request_id"],
        {
            "path": "/repo",
            "home_dir": "/home/oem",
            "parent": "/",
            "entries": [
                {"name": "src", "path": "/repo/src", "is_dir": True},
                {
                    "name": "a.txt",
                    "path": "/repo/a.txt",
                    "is_dir": False,
                    "size": 2,
                    "modified_at": 1750000000,
                },
            ],
        },
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    r = await task
    assert r.status_code == 200, r.text
    entries = r.json()["entries"]
    assert entries[1]["size"] == 2
    assert entries[1]["modified_at"] == 1750000000

    # Download decodes the daemon payload and sets a filename.
    start = len(fake_ws.sent_text)
    task = asyncio.create_task(
        client.get(f"/api/hosts/{host_id}/files/download?path=/repo/a.txt", headers=auth)
    )
    sent = await _wait_for_text_frame(fake_ws, "host.fs.read", start=start)
    assert sent["path"] == "/repo/a.txt"
    await broker.resolve_fs_result(
        sent["request_id"],
        {
            "request_id": sent["request_id"],
            "path": "/repo/a.txt",
            "name": "a.txt",
            "size": 2,
            "bytes_b64": base64.b64encode(b"hi").decode(),
        },
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    r = await task
    assert r.status_code == 200, r.text
    assert r.content == b"hi"
    assert 'filename="a.txt"' in r.headers["content-disposition"]

    # Upload turns multipart into an fs.write frame.
    start = len(fake_ws.sent_text)
    task = asyncio.create_task(
        client.post(
            f"/api/hosts/{host_id}/files/upload",
            headers=auth,
            data={"dir": "/repo"},
            files={"file": ("notes.txt", b"hello", "text/plain")},
        )
    )
    sent = await _wait_for_text_frame(fake_ws, "host.fs.write", start=start)
    assert sent["dir"] == "/repo"
    assert sent["name"] == "notes.txt"
    assert base64.b64decode(sent["bytes_b64"]) == b"hello"
    await broker.resolve_fs_result(
        sent["request_id"],
        {"request_id": sent["request_id"], "path": "/repo/notes.txt"},
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    r = await task
    assert r.status_code == 200, r.text
    assert r.json() == {"path": "/repo/notes.txt"}

    # Rename round-trips through the daemon.
    start = len(fake_ws.sent_text)
    task = asyncio.create_task(
        client.post(
            f"/api/hosts/{host_id}/files/rename",
            headers=auth,
            json={"path": "/repo/notes.txt", "name": "notes-v2.txt"},
        )
    )
    sent = await _wait_for_text_frame(fake_ws, "host.fs.rename", start=start)
    assert sent["path"] == "/repo/notes.txt"
    assert sent["name"] == "notes-v2.txt"
    await broker.resolve_fs_result(
        sent["request_id"],
        {"request_id": sent["request_id"], "path": "/repo/notes-v2.txt"},
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    r = await task
    assert r.status_code == 200, r.text
    assert r.json() == {"path": "/repo/notes-v2.txt"}

    # mkdir + delete round-trip; daemon errors surface as 400s.
    start = len(fake_ws.sent_text)
    task = asyncio.create_task(
        client.post(
            f"/api/hosts/{host_id}/files/mkdir", headers=auth, json={"path": "/repo/new"}
        )
    )
    sent = await _wait_for_text_frame(fake_ws, "host.fs.mkdir", start=start)
    await broker.resolve_fs_result(
        sent["request_id"],
        {"request_id": sent["request_id"], "path": "/repo/new"},
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    assert (await task).status_code == 200

    start = len(fake_ws.sent_text)
    task = asyncio.create_task(
        client.post(
            f"/api/hosts/{host_id}/files/delete",
            headers=auth,
            json={"path": "/repo/new", "recursive": True},
        )
    )
    sent = await _wait_for_text_frame(fake_ws, "host.fs.remove", start=start)
    assert sent["recursive"] is True
    await broker.resolve_fs_result(
        sent["request_id"],
        {"request_id": sent["request_id"], "path": "/repo/new", "error": "permission denied"},
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    r = await task
    assert r.status_code == 400
    assert "permission denied" in r.json()["detail"]

    await broker.unregister_daemon(daemon)


async def test_host_file_transfer_pulls_from_source_and_pushes_to_dest(client):
    import base64

    token = await _signup(client, "host-transfer@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(select(User).where(User.email == "host-transfer@example.com"))
        ).scalar_one()
        src = Host(owner_user_id=user.id, name="src-box", status="online")
        dest = Host(owner_user_id=user.id, name="dest-box", status="online")
        session.add_all([src, dest])
        await session.commit()
        src_id = src.id
        dest_id = dest.id

    broker = get_broker()
    src_ws = _FakeWS()
    dest_ws = _FakeWS()
    src_daemon = DaemonConn(host_id=src_id, user_id="user", websocket=src_ws)  # type: ignore[arg-type]
    dest_daemon = DaemonConn(host_id=dest_id, user_id="user", websocket=dest_ws)  # type: ignore[arg-type]
    await broker.register_daemon(src_daemon)
    await broker.register_daemon(dest_daemon)
    await _accept_daemon(src_daemon)
    await _accept_daemon(dest_daemon)

    task = asyncio.create_task(
        client.post(
            f"/api/hosts/{src_id}/files/transfer",
            headers=auth,
            json={"path": "/repo/a.txt", "dest_host_id": dest_id, "dest_dir": "/inbox"},
        )
    )
    read_frame = await _wait_for_text_frame(src_ws, "host.fs.read")
    await broker.resolve_fs_result(
        read_frame["request_id"],
        {
            "request_id": read_frame["request_id"],
            "path": "/repo/a.txt",
            "name": "a.txt",
            "size": 2,
            "bytes_b64": base64.b64encode(b"hi").decode(),
        },
        daemon=src_daemon,
        expected_host_generation=src_daemon.host_generation,
    )
    write_frame = await _wait_for_text_frame(dest_ws, "host.fs.write")
    assert write_frame["dir"] == "/inbox"
    assert write_frame["name"] == "a.txt"
    assert base64.b64decode(write_frame["bytes_b64"]) == b"hi"
    await broker.resolve_fs_result(
        write_frame["request_id"],
        {"request_id": write_frame["request_id"], "path": "/inbox/a.txt"},
        daemon=dest_daemon,
        expected_host_generation=dest_daemon.host_generation,
    )
    r = await task
    assert r.status_code == 200, r.text
    assert r.json() == {"path": "/inbox/a.txt"}

    await broker.unregister_daemon(src_daemon)
    await broker.unregister_daemon(dest_daemon)


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
    await _accept_daemon(daemon)

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
                    "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                    "installed": True,
                    "path": "/usr/local/bin/codex",
                    "version": "codex 1.2.3",
                    "latest_version": "1.2.4",
                    "update_available": True,
                    "error": None,
                }
            ],
        },
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
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
                "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                "success": True,
                "exit_code": 0,
                "output": "updated",
                "error": None,
                "status": None,
            },
        },
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    await asyncio.sleep(0)
    await broker.unregister_daemon(daemon)


async def test_background_auto_update_checker_records_result_and_throttles(client):
    await _signup(client, "host-tools-background@example.com")

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, HostToolPolicy, Preset, User
    from spawn_server.routes import hosts as hosts_routes
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (
            await session.execute(
                select(User).where(User.email == "host-tools-background@example.com")
            )
        ).scalar_one()
        host = Host(owner_user_id=user.id, name="background-auto-box", status="online")
        preset = (
            await session.execute(select(Preset).where(Preset.name == "codex"))
        ).scalar_one()
        session.add(host)
        await session.flush()
        policy = HostToolPolicy(
            owner_user_id=user.id,
            host_id=host.id,
            preset_id=preset.id,
            auto_update=True,
        )
        session.add(policy)
        await session.commit()
        user_id = user.id
        host_id = host.id
        preset_id = preset.id
        policy_id = policy.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)

    try:
        first_start = len(fake_ws.sent_text)
        first_task = asyncio.create_task(hosts_routes.run_auto_update_checks_once())
        check = await _wait_for_text_frame(fake_ws, "host.tools.check", start=first_start)
        assert any(target["preset_id"] == preset_id for target in check["targets"])
        await broker.resolve_tool_check(
            check["request_id"],
            {
                "type": "host.tools.check_result",
                "request_id": check["request_id"],
                "tools": [
                    {
                        "preset_id": preset_id,
                        "preset_name": "codex",
                        "agent_kind": "codex",
                        "command": "codex",
                        "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                        "installed": True,
                        "path": "/usr/local/bin/codex",
                        "version": "codex 1.2.3",
                        "latest_version": "1.2.4",
                        "update_available": True,
                        "error": None,
                    }
                ],
            },
            daemon=daemon,
            expected_host_generation=daemon.host_generation,
        )
        await first_task

        install = await _wait_for_text_frame(fake_ws, "host.tools.install", start=first_start)
        assert install["target"]["preset_id"] == preset_id
        await broker.resolve_tool_install(
            install["request_id"],
            {
                "type": "host.tools.install_result",
                "request_id": install["request_id"],
                "result": {
                    "preset_id": preset_id,
                    "preset_name": "codex",
                    "agent_kind": "codex",
                    "command": "codex",
                    "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                    "success": False,
                    "exit_code": 1,
                    "output": "failed",
                    "error": "failed install",
                    "status": None,
                },
            },
            daemon=daemon,
            expected_host_generation=daemon.host_generation,
        )

        for _ in range(100):
            async with sm() as session:
                stored = await session.get(HostToolPolicy, policy_id)
                assert stored is not None
                last_auto_update_at = stored.last_auto_update_at
                last_auto_update_error = stored.last_auto_update_error
            if last_auto_update_error == "failed install":
                break
            await asyncio.sleep(0.01)
        assert last_auto_update_at is not None
        assert last_auto_update_error == "failed install"

        second_start = len(fake_ws.sent_text)
        second_task = asyncio.create_task(hosts_routes.run_auto_update_checks_once())
        check = await _wait_for_text_frame(fake_ws, "host.tools.check", start=second_start)
        await broker.resolve_tool_check(
            check["request_id"],
            {
                "type": "host.tools.check_result",
                "request_id": check["request_id"],
                "tools": [
                    {
                        "preset_id": preset_id,
                        "preset_name": "codex",
                        "agent_kind": "codex",
                        "command": "codex",
                        "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
                        "installed": True,
                        "path": "/usr/local/bin/codex",
                        "version": "codex 1.2.3",
                        "latest_version": "1.2.4",
                        "update_available": True,
                        "error": None,
                    }
                ],
            },
            daemon=daemon,
            expected_host_generation=daemon.host_generation,
        )
        await second_task
        await asyncio.sleep(0)
        assert not any(
            json.loads(raw).get("type") == "host.tools.install"
            for raw in fake_ws.sent_text[second_start:]
        )
    finally:
        hosts_routes._AUTO_UPDATE_IN_FLIGHT.clear()
        await broker.unregister_daemon(daemon)
