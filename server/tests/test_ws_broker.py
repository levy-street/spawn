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
    assert sent == {"type": "agent.snapshot", "agent_id": agent_id, "lines": 123}

    await broker.resolve_snapshot(agent_id, "aGVsbG8=")
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
    assert sent == {
        "type": "agent.snapshot",
        "agent_id": agent_id,
        "lines": 321,
        "plain": True,
    }

    await broker.resolve_snapshot(agent_id, "cGxhaW4=")
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
