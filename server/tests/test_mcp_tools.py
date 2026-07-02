"""Spawn MCP tool surface behavior."""

from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass, field

from mcp.server.auth.provider import AccessToken


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


async def _user_id_for_email(email: str) -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        return user.id


async def _create_host_for_user(email: str) -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        host = Host(owner_user_id=user.id, name="mcp-host", status="online")
        session.add(host)
        await session.commit()
        return host.id


@dataclass
class _FakeWS:
    sent_text: list[str] = field(default_factory=list)
    sent_bytes: list[bytes] = field(default_factory=list)
    closed: list[dict[str, object]] = field(default_factory=list)

    async def send_text(self, value: str) -> None:
        self.sent_text.append(value)

    async def send_bytes(self, value: bytes) -> None:
        self.sent_bytes.append(value)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed.append({"code": code, "reason": reason})


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


async def test_mcp_token_verifier_accepts_user_tokens_only(client):
    token = await _signup(client, "mcp-verifier@example.com")
    user_id = await _user_id_for_email("mcp-verifier@example.com")
    host_id = await _create_host_for_user("mcp-verifier@example.com")

    from spawn_server import auth
    from spawn_server.mcp import SpawnTokenVerifier

    verifier = SpawnTokenVerifier()
    access = await verifier.verify_token(token)
    assert access is not None
    assert access.client_id == user_id
    assert access.scopes == ["spawn"]

    daemon_token = auth.issue_daemon_token(host_id, user_id)
    assert await verifier.verify_token(daemon_token) is None
    assert await verifier.verify_token("not-a-token") is None


async def test_mcp_tool_metadata_guides_confirmations_and_terminal_control():
    from spawn_server import mcp as spawn_mcp_tools

    tools = {tool.name: tool for tool in await spawn_mcp_tools.spawn_mcp.list_tools()}

    assert tools["list_agents"].annotations is not None
    assert tools["list_agents"].annotations.readOnlyHint is True
    assert tools["snapshot_agent"].annotations is not None
    assert tools["snapshot_agent"].annotations.readOnlyHint is True

    send_input = tools["send_agent_input"]
    assert send_input.annotations is not None
    assert send_input.annotations.readOnlyHint is False
    assert send_input.annotations.destructiveHint is False
    assert send_input.description is not None
    assert 'text="<prompt>\\r"' in send_input.description
    assert '"\\n"' in send_input.description
    assert '"\\x15"' in send_input.description
    assert "only confirms input delivery" in send_input.description

    assert tools["delete_agent"].annotations is not None
    assert tools["delete_agent"].annotations.readOnlyHint is False
    assert tools["delete_agent"].annotations.destructiveHint is True


async def test_mcp_tools_can_manage_capabilities_start_agent_and_interact(
    client, monkeypatch
):
    await _signup(client, "mcp-tools@example.com")
    user_id = await _user_id_for_email("mcp-tools@example.com")
    host_id = await _create_host_for_user("mcp-tools@example.com")

    from spawn_server import mcp as spawn_mcp_tools
    from spawn_server.ws.broker import DaemonConn, get_broker
    from spawn_server.ws.frames import KIND_INPUT, decode_binary_frame

    monkeypatch.setattr(
        spawn_mcp_tools,
        "get_access_token",
        lambda: AccessToken(token="test", client_id=user_id, scopes=["spawn"]),
    )

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    spawn_server = await spawn_mcp_tools.create_spawn_mcp_server(
        name="spawn",
        enabled_by_default=True,
    )
    skill = await spawn_mcp_tools.create_skill(
        name="spawn-operator",
        description="Operate Spawn from an agent.",
        content="# Spawn Operator\nUse the spawn MCP tools.",
        enabled_by_default=True,
    )

    assert [server["id"] for server in await spawn_mcp_tools.list_mcp_servers()] == [
        spawn_server["id"]
    ]
    assert [row["id"] for row in await spawn_mcp_tools.list_skills()] == [skill["id"]]

    agent = await spawn_mcp_tools.create_agent(
        host_id=host_id,
        cwd="/repo",
        argv=["sh", "-lc", "cat"],
        name="mcp-started",
        cols=100,
        rows=30,
    )
    assert agent["name"] == "mcp-started"

    sent_create = json.loads(fake_ws.sent_text[-1])
    assert sent_create["type"] == "agent.create"
    assert sent_create["agent_id"] == agent["id"]
    assert sent_create["mcp_servers"][0]["id"] == spawn_server["id"]
    assert sent_create["mcp_servers"][0]["headers"]["Authorization"].startswith("Bearer ")
    assert sent_create["skills"][0]["id"] == skill["id"]
    assert sent_create["skills"][0]["content"] == "# Spawn Operator\nUse the spawn MCP tools."

    access = await spawn_mcp_tools.get_agent_access(agent["id"])
    assert [server["id"] for server in access["mcp_servers"]] == [spawn_server["id"]]
    assert [row["id"] for row in access["skills"]] == [skill["id"]]

    input_result = await spawn_mcp_tools.send_agent_input(agent["id"], text="hello from mcp\n")
    assert input_result == {"agent_id": agent["id"], "bytes": len("hello from mcp\n")}
    frame = decode_binary_frame(fake_ws.sent_bytes[-1])
    assert frame.kind == KIND_INPUT
    assert frame.agent_id == agent["id"]
    assert frame.payload == b"hello from mcp\n"

    manual_submit_result = await spawn_mcp_tools.send_agent_input(
        agent["id"],
        text="\x15hello from mcp\r",
    )
    assert manual_submit_result == {"agent_id": agent["id"], "bytes": len("\x15hello from mcp\r")}
    frame = decode_binary_frame(fake_ws.sent_bytes[-1])
    assert frame.kind == KIND_INPUT
    assert frame.agent_id == agent["id"]
    assert frame.payload == b"\x15hello from mcp\r"

    snapshot_task = asyncio.create_task(
        spawn_mcp_tools.snapshot_agent(agent["id"], lines=200, plain=True)
    )
    for _ in range(100):
        if fake_ws.sent_text and json.loads(fake_ws.sent_text[-1]).get("type") == "agent.snapshot":
            break
        await asyncio.sleep(0.01)
    snapshot_request = json.loads(fake_ws.sent_text[-1])
    assert snapshot_request == {
        "type": "agent.snapshot",
        "agent_id": agent["id"],
        "lines": 200,
        "plain": True,
    }
    await broker.resolve_snapshot(
        agent["id"],
        {"bytes_b64": base64.b64encode(b"mcp snapshot").decode("ascii")},
    )
    snapshot = await snapshot_task
    assert base64.b64decode(snapshot["bytes_b64"]) == b"mcp snapshot"
    assert snapshot["plain"] is True

    await spawn_mcp_tools.set_agent_access(agent["id"], mcp_server_ids=[], skill_ids=[])
    cleared = await spawn_mcp_tools.get_agent_access(agent["id"])
    assert cleared["mcp_servers"] == []
    assert cleared["skills"] == []

    updated_server = await spawn_mcp_tools.update_mcp_server(
        spawn_server["id"],
        name="spawn-updated",
        enabled_by_default=False,
    )
    assert updated_server["name"] == "spawn-updated"
    assert updated_server["enabled_by_default"] is False

    updated_skill = await spawn_mcp_tools.update_skill(
        skill["id"],
        name="spawn-operator-updated",
        description="updated",
        content="# Updated Spawn Operator",
        enabled_by_default=False,
    )
    assert updated_skill["name"] == "spawn-operator-updated"
    assert updated_skill["description"] == "updated"
    assert updated_skill["content"] == "# Updated Spawn Operator"
    assert updated_skill["enabled_by_default"] is False

    assert await spawn_mcp_tools.delete_mcp_server(spawn_server["id"]) == {
        "deleted": True,
        "mcp_server_id": spawn_server["id"],
    }
    assert await spawn_mcp_tools.delete_skill(skill["id"]) == {
        "deleted": True,
        "skill_id": skill["id"],
    }
    assert await spawn_mcp_tools.list_mcp_servers() == []
    assert await spawn_mcp_tools.list_skills() == []

    await broker.unregister_daemon(daemon)


async def test_mcp_tools_cover_host_preset_and_agent_control_roundtrips(client, monkeypatch):
    await _signup(client, "mcp-control@example.com")
    user_id = await _user_id_for_email("mcp-control@example.com")
    host_id = await _create_host_for_user("mcp-control@example.com")

    from spawn_server import mcp as spawn_mcp_tools
    from spawn_server.ws.broker import DaemonConn, get_broker
    from spawn_server.ws.frames import KIND_INPUT, decode_binary_frame

    monkeypatch.setattr(
        spawn_mcp_tools,
        "get_access_token",
        lambda: AccessToken(token="test", client_id=user_id, scopes=["spawn"]),
    )

    broker = get_broker()
    fake_ws = _FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=fake_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)

    renamed_host = await spawn_mcp_tools.rename_host(host_id, "mcp-renamed-host")
    assert renamed_host["name"] == "mcp-renamed-host"
    assert (await spawn_mcp_tools.get_host(host_id))["name"] == "mcp-renamed-host"
    assert [host["id"] for host in await spawn_mcp_tools.list_hosts()] == [host_id]

    dirs_start = len(fake_ws.sent_text)
    dirs_task = asyncio.create_task(spawn_mcp_tools.list_host_dirs(host_id, path="/repo"))
    dirs_request = await _wait_for_text_frame(fake_ws, "host.fs.list", start=dirs_start)
    assert dirs_request["path"] == "/repo"
    await broker.resolve_dir_list(
        dirs_request["request_id"],
        {
            "path": "/repo",
            "home_dir": "/home/mcp-control",
            "parent": "/",
            "entries": [{"name": "src", "path": "/repo/src"}],
        },
    )
    dirs = await dirs_task
    assert dirs["path"] == "/repo"
    assert dirs["entries"] == [{"name": "src", "path": "/repo/src"}]

    preset = await spawn_mcp_tools.create_preset(
        name="mcp-shell",
        agent_kind="shell",
        default_argv=["sh", "-lc", "cat"],
        env_template={"FROM_PRESET": "1"},
        install="printf install-mcp-shell",
    )
    assert preset["name"] == "mcp-shell"
    updated_preset = await spawn_mcp_tools.update_preset(
        preset["id"],
        name="mcp-shell-updated",
        install="printf install-updated",
    )
    assert updated_preset["name"] == "mcp-shell-updated"
    assert updated_preset["install"] == "printf install-updated"
    assert any(row["id"] == preset["id"] for row in await spawn_mcp_tools.list_presets())

    policy = await spawn_mcp_tools.set_host_tool_auto_update(host_id, preset["id"], True)
    assert policy["preset_id"] == preset["id"]
    assert policy["auto_update"] is True

    tools_start = len(fake_ws.sent_text)
    tools_task = asyncio.create_task(spawn_mcp_tools.list_host_tools(host_id))
    tools_request = await _wait_for_text_frame(fake_ws, "host.tools.check", start=tools_start)
    assert any(target["preset_id"] == preset["id"] for target in tools_request["targets"])
    await broker.resolve_tool_check(
        tools_request["request_id"],
        {
            "type": "host.tools.check_result",
            "request_id": tools_request["request_id"],
            "tools": [
                {
                    "preset_id": preset["id"],
                    "preset_name": "mcp-shell-updated",
                    "agent_kind": "shell",
                    "command": "sh",
                    "install": "printf install-updated",
                    "installed": True,
                    "path": "/bin/sh",
                    "version": "sh 1.0",
                    "latest_version": "sh 1.0",
                    "update_available": False,
                    "error": None,
                }
            ],
        },
    )
    tools = await tools_task
    assert tools["tools"][0]["preset_id"] == preset["id"]
    assert tools["tools"][0]["auto_update"] is True

    install_start = len(fake_ws.sent_text)
    install_task = asyncio.create_task(spawn_mcp_tools.install_host_tool(host_id, preset["id"]))
    install_request = await _wait_for_text_frame(
        fake_ws,
        "host.tools.install",
        start=install_start,
    )
    assert install_request["target"]["preset_id"] == preset["id"]
    await broker.resolve_tool_install(
        install_request["request_id"],
        {
            "type": "host.tools.install_result",
            "request_id": install_request["request_id"],
            "result": {
                "preset_id": preset["id"],
                "preset_name": "mcp-shell-updated",
                "agent_kind": "shell",
                "command": "sh",
                "install": "printf install-updated",
                "success": True,
                "exit_code": 0,
                "output": "installed through mcp",
                "error": None,
                "status": None,
            },
        },
    )
    install = await install_task
    assert install["success"] is True
    assert install["output"] == "installed through mcp"

    create_start = len(fake_ws.sent_text)
    agent = await spawn_mcp_tools.create_agent(
        host_id=host_id,
        cwd="/repo",
        preset_id=preset["id"],
        name="mcp-control-agent",
        cols=101,
        rows=33,
    )
    create_request = await _wait_for_text_frame(fake_ws, "agent.create", start=create_start)
    assert create_request["agent_id"] == agent["id"]
    assert create_request["argv"] == ["sh", "-lc", "cat"]
    assert create_request["env"] == {"FROM_PRESET": "1"}
    assert create_request["cols"] == 101
    assert create_request["rows"] == 33

    assert [row["id"] for row in await spawn_mcp_tools.list_agents(host_id=host_id)] == [
        agent["id"]
    ]
    assert (await spawn_mcp_tools.get_agent(agent["id"]))["name"] == "mcp-control-agent"

    rename_start = len(fake_ws.sent_text)
    renamed_agent = await spawn_mcp_tools.rename_agent(agent["id"], "mcp-control-renamed")
    assert renamed_agent["name"] == "mcp-control-renamed"
    rename_request = await _wait_for_text_frame(fake_ws, "agent.rename", start=rename_start)
    assert rename_request["agent_id"] == agent["id"]
    assert rename_request["tmux_session"].startswith("spawn-mcp-control-renamed--")

    assert (await spawn_mcp_tools.pin_agent(agent["id"], True))["pinned_at"] is not None
    assert (await spawn_mcp_tools.pin_agent(agent["id"], False))["pinned_at"] is None

    archived = await spawn_mcp_tools.archive_agent(agent["id"], True)
    assert archived["archived_at"] is not None
    assert await spawn_mcp_tools.list_agents(host_id=host_id) == []
    assert [row["id"] for row in await spawn_mcp_tools.list_agents(include_archived=True)] == [
        agent["id"]
    ]
    assert (await spawn_mcp_tools.archive_agent(agent["id"], False))["archived_at"] is None

    restart_start = len(fake_ws.sent_text)
    restarted = await spawn_mcp_tools.restart_agent(agent["id"], cols=120, rows=40)
    restart_request = await _wait_for_text_frame(fake_ws, "agent.restart", start=restart_start)
    assert restarted["status"] == "starting"
    assert restart_request["agent_id"] == agent["id"]
    assert restart_request["cols"] == 120
    assert restart_request["rows"] == 40

    resize = await spawn_mcp_tools.resize_agent(agent["id"], cols=500, rows=1)
    assert resize == {"agent_id": agent["id"], "cols": 400, "rows": 5}
    assert json.loads(fake_ws.sent_text[-1]) == {
        "type": "agent.resize",
        "agent_id": agent["id"],
        "cols": 400,
        "rows": 5,
    }

    scroll = await spawn_mcp_tools.scroll_agent(agent["id"], lines=-999)
    assert scroll == {"agent_id": agent["id"], "lines": -200}
    assert json.loads(fake_ws.sent_text[-1]) == {
        "type": "agent.scroll",
        "agent_id": agent["id"],
        "lines": -200,
    }

    redraw = await spawn_mcp_tools.redraw_agent(agent["id"])
    assert redraw == {"agent_id": agent["id"], "redraw": True}
    assert json.loads(fake_ws.sent_text[-1]) == {
        "type": "agent.redraw",
        "agent_id": agent["id"],
    }

    input_result = await spawn_mcp_tools.send_agent_input(
        agent["id"],
        bytes_b64=base64.b64encode(b"bytes from mcp\n").decode("ascii"),
    )
    assert input_result == {"agent_id": agent["id"], "bytes": len(b"bytes from mcp\n")}
    input_frame = decode_binary_frame(fake_ws.sent_bytes[-1])
    assert input_frame.kind == KIND_INPUT
    assert input_frame.agent_id == agent["id"]
    assert input_frame.payload == b"bytes from mcp\n"

    upload_start = len(fake_ws.sent_text)
    upload_task = asyncio.create_task(
        spawn_mcp_tools.upload_agent_file(
            agent["id"],
            name="mcp-control.txt",
            mime_type="text/plain",
            bytes_b64=base64.b64encode(b"uploaded through mcp control").decode("ascii"),
            paste=False,
            destination="cwd",
        )
    )
    upload_request = await _wait_for_text_frame(fake_ws, "agent.upload", start=upload_start)
    assert upload_request["agent_id"] == agent["id"]
    assert upload_request["name"] == "mcp-control.txt"
    assert upload_request["destination"] == "cwd"
    assert upload_request["paste"] is False
    await broker.resolve_upload(
        agent["id"],
        upload_request["client_id"],
        {
            "agent_id": agent["id"],
            "path": "/repo/mcp-control.txt",
            "client_id": upload_request["client_id"],
        },
    )
    upload = await upload_task
    assert upload["path"] == "/repo/mcp-control.txt"
    assert upload["pasted"] is False

    delete_start = len(fake_ws.sent_text)
    assert await spawn_mcp_tools.delete_agent(agent["id"]) == {
        "agent_id": agent["id"],
        "deleted": True,
    }
    kill_request = await _wait_for_text_frame(fake_ws, "agent.kill", start=delete_start)
    assert kill_request["agent_id"] == agent["id"]
    assert kill_request["signal"] == "TERM"

    assert await spawn_mcp_tools.delete_preset(preset["id"]) == {
        "deleted": True,
        "preset_id": preset["id"],
    }
    assert await spawn_mcp_tools.delete_host(host_id) == {"host_id": host_id, "deleted": True}
    assert fake_ws.closed[-1] == {"code": 4001, "reason": "host revoked"}

    await broker.unregister_daemon(daemon)


async def test_mcp_tools_require_authenticated_context(client, monkeypatch):
    await _signup(client, "mcp-auth-required@example.com")

    from spawn_server import mcp as spawn_mcp_tools

    monkeypatch.setattr(spawn_mcp_tools, "get_access_token", lambda: None)

    try:
        await spawn_mcp_tools.list_hosts()
    except RuntimeError as exc:
        assert "not authenticated" in str(exc)
    else:
        raise AssertionError("expected unauthenticated MCP tool call to fail")
