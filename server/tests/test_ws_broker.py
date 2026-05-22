"""Broker routing without a real PTY: fake daemon + fake browser objects."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

import pytest

from spawn_server.ws.broker import BrowserConn, DaemonConn, get_broker
from spawn_server.ws.frames import (
    KIND_INPUT,
    KIND_OUTPUT,
    decode_binary_frame,
    encode_binary_frame,
)


@dataclass
class FakeWS:
    """Minimal stand-in for a Starlette WebSocket capturing send_*."""

    sent_text: list[str] = field(default_factory=list)
    sent_bytes: list[bytes] = field(default_factory=list)

    async def send_text(self, s: str) -> None:
        self.sent_text.append(s)

    async def send_bytes(self, b: bytes) -> None:
        self.sent_bytes.append(b)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        pass


def test_frame_roundtrip():
    aid = "00000000-0000-4000-8000-00000000abcd"
    payload = b"hello terminal"
    raw = encode_binary_frame(KIND_OUTPUT, aid, payload)
    f = decode_binary_frame(raw)
    assert f.kind == KIND_OUTPUT
    assert f.agent_id == aid
    assert f.payload == payload


@pytest.mark.asyncio
async def test_broker_display_control_first_browser_owns_later_browsers_view():
    broker = get_broker()

    agent_id = "00000000-0000-4000-8000-0000000000d1"
    user_id = "user-1"
    first = BrowserConn(
        user_id=user_id,
        agent_id=agent_id,
        websocket=FakeWS(),  # type: ignore[arg-type]
    )
    second = BrowserConn(
        user_id=user_id,
        agent_id=agent_id,
        websocket=FakeWS(),  # type: ignore[arg-type]
    )

    first_state = await broker.attach_browser(first, cols=132, rows=43)
    second_state = await broker.attach_browser(second, cols=60, rows=20)

    assert first_state.owner is True
    assert first_state.cols == 132
    assert first_state.rows == 43
    assert first_state.viewers == 1

    assert second_state.owner is False
    assert second_state.cols == 132
    assert second_state.rows == 43
    assert second_state.viewers == 2

    ignored = await broker.update_display_size(second, cols=61, rows=21)
    assert ignored is None

    owner_update = await broker.update_display_size(first, cols=140, rows=44)
    assert owner_update is not None
    assert owner_update.owner is True
    assert owner_update.cols == 140
    assert owner_update.rows == 44

    states = dict(await broker.display_states_for_agent(agent_id))
    assert states[first].owner is True
    assert states[second].owner is False
    assert states[second].cols == 140
    assert states[second].rows == 44

    await broker.detach_browser(first)
    await broker.detach_browser(second)


@pytest.mark.asyncio
async def test_broker_display_control_can_be_taken_by_viewer():
    broker = get_broker()

    agent_id = "00000000-0000-4000-8000-0000000000d2"
    user_id = "user-1"
    first = BrowserConn(
        user_id=user_id,
        agent_id=agent_id,
        websocket=FakeWS(),  # type: ignore[arg-type]
    )
    second = BrowserConn(
        user_id=user_id,
        agent_id=agent_id,
        websocket=FakeWS(),  # type: ignore[arg-type]
    )

    await broker.attach_browser(first, cols=132, rows=43)
    await broker.attach_browser(second, cols=60, rows=20)

    second_state = await broker.take_display_control(second, cols=60, rows=20)
    assert second_state.owner is True
    assert second_state.cols == 60
    assert second_state.rows == 20
    assert second_state.viewers == 2

    states = dict(await broker.display_states_for_agent(agent_id))
    assert states[first].owner is False
    assert states[second].owner is True

    await broker.detach_browser(second)
    states = dict(await broker.display_states_for_agent(agent_id))
    assert states[first].owner is True
    assert states[first].cols == 60
    assert states[first].rows == 20

    await broker.detach_browser(first)


@pytest.mark.asyncio
async def test_broker_promotes_next_browser_when_owner_detaches():
    broker = get_broker()

    agent_id = "00000000-0000-4000-8000-0000000000d3"
    user_id = "user-1"
    first = BrowserConn(
        user_id=user_id,
        agent_id=agent_id,
        websocket=FakeWS(),  # type: ignore[arg-type]
    )
    second = BrowserConn(
        user_id=user_id,
        agent_id=agent_id,
        websocket=FakeWS(),  # type: ignore[arg-type]
    )

    await broker.attach_browser(first, cols=132, rows=43)
    await broker.attach_browser(second, cols=60, rows=20)
    await broker.detach_browser(first)

    states = dict(await broker.display_states_for_agent(agent_id))
    assert states[second].owner is True
    assert states[second].cols == 132
    assert states[second].rows == 43

    owner_update = await broker.update_display_size(second, cols=60, rows=20)
    assert owner_update is not None
    assert owner_update.owner is True
    assert owner_update.cols == 60
    assert owner_update.rows == 20

    await broker.detach_browser(second)


@pytest.mark.asyncio
async def test_broker_display_control_uses_shared_backend_when_available(app):
    broker = get_broker()

    agent_id = "00000000-0000-4000-8000-0000000000d4"
    first = BrowserConn(
        user_id="user-1",
        agent_id=agent_id,
        websocket=FakeWS(),  # type: ignore[arg-type]
    )
    second = BrowserConn(
        user_id="user-1",
        agent_id=agent_id,
        websocket=FakeWS(),  # type: ignore[arg-type]
    )

    first_state = await broker.attach_browser(first, cols=132, rows=43)
    second_state = await broker.attach_browser(second, cols=60, rows=20)

    assert first_state.owner is True
    assert second_state.owner is False
    assert second_state.cols == 132
    assert second_state.rows == 43
    assert second_state.viewers == 2

    ignored = await broker.update_display_size(second, cols=61, rows=21)
    assert ignored is None

    taken = await broker.take_display_control(second, cols=61, rows=21)
    assert taken.owner is True
    states = dict(await broker.display_states_for_agent(agent_id))
    assert states[first].owner is False
    assert states[second].owner is True
    assert states[first].cols == 61
    assert states[first].rows == 21

    await broker.detach_browser(second)
    states = dict(await broker.display_states_for_agent(agent_id))
    assert states[first].owner is True

    await broker.detach_browser(first)


@pytest.mark.asyncio
async def test_broker_routes_browser_to_daemon():
    broker = get_broker()

    host_id = "host-xyz"
    user_id = "user-1"
    agent_id = "00000000-0000-4000-8000-0000000000aa"

    daemon_ws = FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await broker.attach_agent_to_daemon(agent_id, daemon)

    browser_ws = FakeWS()
    browser = BrowserConn(user_id=user_id, agent_id=agent_id, websocket=browser_ws)  # type: ignore[arg-type]
    await broker.attach_browser(browser)

    # Browser sends stdin → server should wrap and forward to daemon.
    stdin_bytes = b"ls -la\r"
    fake_frame = encode_binary_frame(KIND_INPUT, agent_id, stdin_bytes)
    await daemon.send_bytes(fake_frame)
    assert daemon_ws.sent_bytes[-1] == fake_frame
    decoded = decode_binary_frame(daemon_ws.sent_bytes[-1])
    assert decoded.kind == KIND_INPUT
    assert decoded.payload == stdin_bytes

    # Daemon emits output → broker fans out to subscribed browsers.
    out_bytes = b"total 0\n"
    for b in broker.browsers_for(agent_id):
        await b.send_bytes(out_bytes)
    assert browser_ws.sent_bytes == [out_bytes]

    # Cleanup.
    await broker.detach_browser(browser)
    await broker.unregister_daemon(daemon)
    assert broker.get_daemon_for_host(host_id) is None
    assert broker.get_daemon_for_agent(agent_id) is None

    await asyncio.sleep(0)  # let any pending tasks settle


@pytest.mark.asyncio
async def test_broker_snapshot_request_roundtrip():
    broker = get_broker()

    host_id = "host-snapshot"
    user_id = "user-1"
    agent_id = "00000000-0000-4000-8000-0000000000cc"

    daemon_ws = FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    await broker.register_daemon(daemon)
    await broker.attach_agent_to_daemon(agent_id, daemon)

    task = asyncio.create_task(broker.request_snapshot(agent_id, daemon, lines=123, timeout=1))
    await asyncio.sleep(0)

    sent = json.loads(daemon_ws.sent_text[-1])
    assert sent["type"] == "agent.snapshot"
    assert sent["agent_id"] == agent_id
    assert sent["lines"] == 123
    assert isinstance(sent["request_id"], str)

    await broker.resolve_snapshot(agent_id, "aGVsbG8=", request_id=sent["request_id"])
    assert await task == "aGVsbG8="

    await broker.unregister_daemon(daemon)


@pytest.mark.asyncio
async def test_broker_plain_snapshot_request_roundtrip():
    broker = get_broker()

    daemon_ws = FakeWS()
    daemon = DaemonConn(
        host_id="host-plain-snapshot",
        user_id="user-1",
        websocket=daemon_ws,  # type: ignore[arg-type]
    )
    await broker.register_daemon(daemon)
    agent_id = "00000000-0000-4000-8000-0000000000cd"
    await broker.attach_agent_to_daemon(agent_id, daemon)

    task = asyncio.create_task(broker.request_snapshot(agent_id, daemon, lines=321, plain=True))
    await asyncio.sleep(0)

    sent = json.loads(daemon_ws.sent_text[-1])
    assert sent["type"] == "agent.snapshot"
    assert sent["agent_id"] == agent_id
    assert sent["lines"] == 321
    assert sent["plain"] is True
    assert isinstance(sent["request_id"], str)

    await broker.resolve_snapshot(agent_id, "cGxhaW4=", request_id=sent["request_id"])
    assert await task == "cGxhaW4="

    await broker.unregister_daemon(daemon)


@pytest.mark.asyncio
async def test_broker_directory_request_roundtrip():
    broker = get_broker()

    host_id = "host-dirs"
    user_id = "user-1"
    daemon_ws = FakeWS()
    daemon = DaemonConn(
        host_id=host_id,
        user_id=user_id,
        websocket=daemon_ws,  # type: ignore[arg-type]
        home_dir="/home/me",
    )
    await broker.register_daemon(daemon)

    task = asyncio.create_task(broker.request_dir_list(daemon, path="/home/me", timeout=1))
    await asyncio.sleep(0)

    sent = json.loads(daemon_ws.sent_text[-1])
    assert sent["type"] == "host.fs.list"
    assert sent["path"] == "/home/me"
    request_id = sent["request_id"]

    payload = {
        "type": "host.fs.list_result",
        "request_id": request_id,
        "path": "/home/me",
        "home_dir": "/home/me",
        "parent": "/home",
        "entries": [{"name": "src", "path": "/home/me/src"}],
        "error": None,
    }
    await broker.resolve_dir_list(request_id, payload)
    assert await task == payload

    await broker.unregister_daemon(daemon)


@pytest.mark.asyncio
async def test_broker_tool_install_request_roundtrip():
    broker = get_broker()

    host_id = "host-tools-install"
    daemon_ws = FakeWS()
    daemon = DaemonConn(
        host_id=host_id,
        user_id="user-1",
        websocket=daemon_ws,  # type: ignore[arg-type]
    )
    await broker.register_daemon(daemon)

    target = {
        "preset_id": "00000000-0000-4000-8000-0000000000ef",
        "preset_name": "codex",
        "agent_kind": "codex",
        "command": "codex",
        "install": "npm install -g @openai/codex",
    }
    task = asyncio.create_task(broker.request_tool_install(daemon, target=target, timeout=1))
    await asyncio.sleep(0)

    sent = json.loads(daemon_ws.sent_text[-1])
    assert sent["type"] == "host.tools.install"
    assert sent["target"] == target

    payload = {
        "type": "host.tools.install_result",
        "request_id": sent["request_id"],
        "result": {
            **target,
            "success": True,
            "exit_code": 0,
            "output": "updated",
            "error": None,
            "status": None,
        },
    }
    await broker.resolve_tool_install(sent["request_id"], payload)
    assert await task == payload

    await broker.unregister_daemon(daemon)


@pytest.mark.asyncio
async def test_broker_daemon_status_request_roundtrip():
    broker = get_broker()

    daemon_ws = FakeWS()
    daemon = DaemonConn(
        host_id="host-daemon-status",
        user_id="user-1",
        websocket=daemon_ws,  # type: ignore[arg-type]
    )
    await broker.register_daemon(daemon)

    task = asyncio.create_task(broker.request_daemon_status(daemon, timeout=1))
    await asyncio.sleep(0)

    sent = json.loads(daemon_ws.sent_text[-1])
    assert sent["type"] == "host.daemon.status"
    payload = {
        "type": "host.daemon.status_result",
        "request_id": sent["request_id"],
        "status": "online",
        "agents": [{"agent_id": "00000000-0000-4000-8000-000000000011", "pid": "123"}],
        "update": {"ok": True, "clean": True},
    }
    await broker.resolve_daemon_status(sent["request_id"], payload)
    assert await task == payload

    await broker.unregister_daemon(daemon)


@pytest.mark.asyncio
async def test_pubsub_publish_subscribe_roundtrip(app):
    """publish() on one side reaches subscribe() on the other (in-proc pubsub)."""
    from spawn_server.redis import get_backend

    backend = get_backend()
    agent_id = "00000000-0000-4000-8000-0000000000bb"

    received: list[bytes] = []
    ready = asyncio.Event()
    done = asyncio.Event()

    async def consumer():
        async with backend.subscribe(agent_id) as stream:
            ready.set()
            async for chunk in stream:
                received.append(chunk)
                if len(received) == 2:
                    done.set()
                    return

    task = asyncio.create_task(consumer())
    await ready.wait()

    await backend.publish(agent_id, b"hello ")
    await backend.publish(agent_id, b"world")

    await asyncio.wait_for(done.wait(), timeout=1.0)
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass

    assert received == [b"hello ", b"world"]


@pytest.mark.asyncio
async def test_agent_event_publish_subscribe_roundtrip(app):
    from spawn_server.redis import get_backend

    backend = get_backend()
    agent_id = "00000000-0000-4000-8000-0000000000bc"

    async with backend.subscribe_agent_events(agent_id) as stream:
        await backend.publish_agent_event(agent_id, {"type": "agent.status", "status": "running"})
        assert await asyncio.wait_for(anext(stream), timeout=1) == {
            "type": "agent.status",
            "status": "running",
        }


@pytest.mark.asyncio
async def test_remote_host_command_publish_roundtrip(app):
    from spawn_server.redis import get_backend

    broker = get_broker()
    host_id = "remote-host-command"
    payload = {"type": "agent.redraw", "agent_id": "00000000-0000-4000-8000-0000000000f1"}

    async with get_backend().subscribe_host_commands(host_id) as stream:
        assert await broker.send_text_to_host(host_id, payload) is True
        received = await asyncio.wait_for(anext(stream), timeout=1)

    assert received == {"kind": "text", "payload": payload}


@pytest.mark.asyncio
async def test_registered_daemon_consumes_remote_host_commands(app):
    from spawn_server.redis import get_backend

    broker = get_broker()
    host_id = "host-command-pump"
    daemon_ws = FakeWS()
    daemon = DaemonConn(
        host_id=host_id,
        user_id="user-1",
        websocket=daemon_ws,  # type: ignore[arg-type]
    )
    await broker.register_daemon(daemon)
    try:
        subscribers = 0
        for _ in range(100):
            subscribers = await get_backend().publish_host_command(
                host_id,
                {"kind": "text", "payload": {"type": "host.daemon.status", "request_id": "r1"}},
            )
            if subscribers >= 1:
                break
            await asyncio.sleep(0.01)
        assert subscribers >= 1
        for _ in range(100):
            if daemon_ws.sent_text:
                break
            await asyncio.sleep(0.01)
        assert json.loads(daemon_ws.sent_text[-1]) == {
            "type": "host.daemon.status",
            "request_id": "r1",
        }
    finally:
        await broker.unregister_daemon(daemon)


@pytest.mark.asyncio
async def test_remote_daemon_status_request_uses_response_channel(app):
    from spawn_server.redis import get_backend

    broker = get_broker()
    host_id = "remote-status-host"
    ready = asyncio.Event()

    async def fake_daemon() -> None:
        async with get_backend().subscribe_host_commands(host_id) as stream:
            ready.set()
            command = await asyncio.wait_for(anext(stream), timeout=1)
            payload = command["payload"]
            assert payload["type"] == "host.daemon.status"
            request_id = payload["request_id"]
            await get_backend().publish_request_response(
                request_id,
                {
                    "type": "host.daemon.status_result",
                    "request_id": request_id,
                    "status": "online",
                    "agents": [],
                    "update": {"ok": True, "clean": True},
                },
            )

    daemon_task = asyncio.create_task(fake_daemon())
    await ready.wait()
    result = await broker.request_daemon_status_for_host(host_id, timeout=1)
    await daemon_task

    assert result is not None
    assert result["type"] == "host.daemon.status_result"
    assert result["status"] == "online"
