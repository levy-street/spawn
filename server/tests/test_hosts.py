"""Multi-tenant scoping: user A cannot see user B's hosts."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

from spawn_server.routes import hosts as hosts_routes


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


async def test_host_control_ping_is_owner_authorized_content_free_and_current(client):
    owner_token = await _signup(client, "host-ping-owner@example.com")
    other_token = await _signup(client, "host-ping-other@example.com")
    owner_auth = {"Authorization": f"Bearer {owner_token}"}
    other_auth = {"Authorization": f"Bearer {other_token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        owner = (
            await session.execute(select(User).where(User.email == "host-ping-owner@example.com"))
        ).scalar_one()
        host = Host(owner_user_id=owner.id, name="ping-box", status="online")
        session.add(host)
        await session.commit()
        host_id = host.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id=owner.id, websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)

    unauthorized = await client.post(f"/api/hosts/{host_id}/control/ping", headers=other_auth)
    assert unauthorized.status_code == 404
    assert not fake_ws.sent_text

    task = asyncio.create_task(
        client.post(f"/api/hosts/{host_id}/control/ping", headers=owner_auth)
    )
    sent = await _wait_for_text_frame(fake_ws, "host.ping")
    assert set(sent) == {"type", "request_id"}
    assert await broker.resolve_host_pong(
        sent["request_id"],
        {"type": "host.pong", "request_id": sent["request_id"]},
        daemon=daemon,
        expected_host_generation=daemon.host_generation,
    )
    response = await task
    assert response.status_code == 204
    assert response.content == b""

    await broker.unregister_daemon(daemon)


async def test_host_control_ping_rejects_stale_online_status(client):
    token = await _signup(client, "host-ping-stale-status@example.com")

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        owner = (
            await session.execute(
                select(User).where(User.email == "host-ping-stale-status@example.com")
            )
        ).scalar_one()
        host = Host(owner_user_id=owner.id, name="stale-ping-box", status="online")
        session.add(host)
        await session.commit()
        host_id = host.id

    response = await client.post(
        f"/api/hosts/{host_id}/control/ping",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 409


async def test_host_file_rest_surfaces_are_retired_without_content_forwarding(client):
    a_token = await _signup(client, "host-dirs-a@example.com")
    auth = {"Authorization": f"Bearer {a_token}"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.ws.broker import DaemonConn, get_broker

    sm = get_sessionmaker()
    async with sm() as session:
        user = (await session.execute(select(User).where(User.email == "host-dirs-a@example.com"))).scalar_one()
        host = Host(owner_user_id=user.id, name="dir-box", status="online")
        session.add(host)
        await session.commit()
        host_id = host.id

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id="user", websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await _accept_daemon(daemon)

    secret = "private-path-canary"
    paths = [
        f"/api/hosts/{host_id}/dirs?path=/{secret}",
        f"/api/hosts/{host_id}/files?path=/{secret}",
        f"/api/hosts/{host_id}/files/download?path=/{secret}",
        f"/api/hosts/{host_id}/files/upload",
        f"/api/hosts/{host_id}/files/mkdir",
        f"/api/hosts/{host_id}/files/rename",
        f"/api/hosts/{host_id}/files/delete",
        f"/api/hosts/{host_id}/files/transfer",
    ]
    for path in paths:
        response = await client.request("POST" if path.rsplit("/", 1)[-1] in {"upload", "mkdir", "rename", "delete", "transfer"} else "GET", path, headers=auth, json={"path": secret})
        assert response.status_code == 404
    assert fake_ws.sent_text == []
    openapi = (await client.get("/openapi.json")).text
    assert "/files" not in openapi
    assert '"home_dir"' not in openapi
    assert "host.fs" not in openapi

    await broker.unregister_daemon(daemon)


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
    assert await hosts_routes.wait_for_auto_update_tasks_idle(timeout=1.0)
    assert not hosts_routes._AUTO_UPDATE_TASKS
    assert not hosts_routes._AUTO_UPDATE_IN_FLIGHT
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
        assert await hosts_routes.wait_for_auto_update_tasks_idle(timeout=1.0)
        async with sm() as session:
            stored = await session.get(HostToolPolicy, policy_id)
            assert stored is not None
            last_auto_update_at = stored.last_auto_update_at
            last_auto_update_error = stored.last_auto_update_error
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
        assert not any(
            json.loads(raw).get("type") == "host.tools.install"
            for raw in fake_ws.sent_text[second_start:]
        )
    finally:
        hosts_routes._AUTO_UPDATE_IN_FLIGHT.clear()
        await broker.unregister_daemon(daemon)


async def test_auto_update_task_registry_observes_errors_and_clears_inflight(
    client, monkeypatch, caplog
):
    started = asyncio.Event()

    async def fail_update(**_kwargs) -> None:
        started.set()
        raise RuntimeError("owned update failed")

    monkeypatch.setattr(hosts_routes, "_run_auto_update", fail_update)
    caplog.set_level("ERROR", logger="spawn.routes.hosts")
    key = ("user", "host", "preset")

    assert hosts_routes._start_auto_update(
        user_id=key[0],
        host_id=key[1],
        preset_id=key[2],
        target={},
    )
    await started.wait()
    assert await hosts_routes.wait_for_auto_update_tasks_idle(timeout=1.0)

    assert key not in hosts_routes._AUTO_UPDATE_IN_FLIGHT
    assert not hosts_routes._AUTO_UPDATE_TASKS
    assert "owned auto update task failed" in caplog.text
    assert "owned update failed" in caplog.text


async def test_auto_update_shutdown_drains_owned_tasks(client, monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()
    cancelled = False

    async def drain_update(**_kwargs) -> None:
        nonlocal cancelled
        started.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled = True
            raise

    monkeypatch.setattr(hosts_routes, "_run_auto_update", drain_update)
    key = ("user-drain", "host-drain", "preset-drain")
    assert hosts_routes._start_auto_update(
        user_id=key[0],
        host_id=key[1],
        preset_id=key[2],
        target={},
    )
    await started.wait()

    stop = asyncio.create_task(hosts_routes.stop_auto_update_checker())
    await asyncio.sleep(0)
    assert not stop.done()
    release.set()
    await stop

    assert not cancelled
    assert key not in hosts_routes._AUTO_UPDATE_IN_FLIGHT
    assert not hosts_routes._AUTO_UPDATE_TASKS


async def test_auto_update_shutdown_cancels_after_drain_and_clears_inflight(
    client, monkeypatch
):
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def blocked_update(**_kwargs) -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(hosts_routes, "_run_auto_update", blocked_update)
    monkeypatch.setattr(hosts_routes, "AUTO_UPDATE_SHUTDOWN_DRAIN_SECONDS", 0.01)
    key = ("user-cancel", "host-cancel", "preset-cancel")
    assert hosts_routes._start_auto_update(
        user_id=key[0],
        host_id=key[1],
        preset_id=key[2],
        target={},
    )
    await started.wait()

    await hosts_routes.stop_auto_update_checker()
    assert cancelled.is_set()
    assert key not in hosts_routes._AUTO_UPDATE_IN_FLIGHT
    assert not hosts_routes._AUTO_UPDATE_TASKS
