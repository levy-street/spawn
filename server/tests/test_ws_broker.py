"""Broker routing without a real PTY: fake daemon + fake browser objects."""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

import pytest

from spawn_server.ws.broker import (
    Broker,
    BrowserConn,
    DaemonConn,
    HostBrowserConn,
    UploadResolution,
    get_broker,
)
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
    closed: list[tuple[int, str]] = field(default_factory=list)

    async def send_text(self, s: str) -> None:
        self.sent_text.append(s)

    async def send_bytes(self, b: bytes) -> None:
        self.sent_bytes.append(b)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed.append((code, reason))


async def _accept_owner(broker: Broker, daemon: DaemonConn, generation: int = 1) -> None:
    from spawn_server.redis import get_backend
    from spawn_server.ws.host_signal import (
        HostPresenceOwner,
        encode_host_presence_owner,
        host_presence_key,
    )

    daemon.host_generation = generation
    assert await broker.accept_daemon_owner(daemon, generation)
    await get_backend().set_ephemeral(
        host_presence_key(daemon.host_id),
        encode_host_presence_owner(HostPresenceOwner(daemon.id, generation)),
        ttl_seconds=60,
    )


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
async def test_broker_daemon_reconnect_supersedes_stale_connection_and_reassociates_agents():
    broker = get_broker()

    host_id = "host-reconnect"
    user_id = "user-1"
    agent_id = "00000000-0000-4000-8000-0000000000ad"
    old_ws = FakeWS()
    old_daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=old_ws)  # type: ignore[arg-type]
    await broker.register_daemon(old_daemon)
    await broker.attach_agent_to_daemon(agent_id, old_daemon)

    assert broker.get_daemon_for_agent(agent_id) is old_daemon

    new_ws = FakeWS()
    new_daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=new_ws)  # type: ignore[arg-type]
    await broker.register_daemon(new_daemon)

    assert old_ws.closed == [(4000, "superseded")]
    assert broker.get_daemon_for_host(host_id) is new_daemon
    assert broker.get_daemon_for_agent(agent_id) is None

    # Mirrors the daemon register(existing_agents=[...]) path after reconnect.
    await broker.attach_agent_to_daemon(agent_id, new_daemon)
    assert broker.get_daemon_for_agent(agent_id) is new_daemon
    assert agent_id in new_daemon.agent_ids
    assert agent_id not in old_daemon.agent_ids

    await broker.unregister_daemon(new_daemon)


@pytest.mark.asyncio
async def test_broker_snapshot_request_roundtrip(app):
    broker = get_broker()

    host_id = "host-snapshot"
    user_id = "user-1"
    agent_id = "00000000-0000-4000-8000-0000000000cc"

    daemon_ws = FakeWS()
    daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=daemon_ws)  # type: ignore[arg-type]
    await _accept_owner(broker, daemon)
    await broker.attach_agent_to_daemon(agent_id, daemon)

    task = asyncio.create_task(broker.request_snapshot(agent_id, daemon, lines=123, timeout=1))
    await asyncio.sleep(0)

    sent = json.loads(daemon_ws.sent_text[-1])
    assert sent["type"] == "agent.snapshot"
    assert sent["agent_id"] == agent_id
    assert sent["lines"] == 123

    payload = {"request_id": sent["request_id"], "bytes_b64": "aGVsbG8="}
    await broker.resolve_snapshot(
        agent_id, payload, daemon=daemon, expected_host_generation=1
    )
    assert await task == payload

    await broker.unregister_daemon(daemon)


@pytest.mark.asyncio
async def test_broker_plain_snapshot_request_roundtrip(app):
    broker = get_broker()

    daemon_ws = FakeWS()
    daemon = DaemonConn(
        host_id="host-plain-snapshot",
        user_id="user-1",
        websocket=daemon_ws,  # type: ignore[arg-type]
    )
    await _accept_owner(broker, daemon)
    agent_id = "00000000-0000-4000-8000-0000000000cd"
    await broker.attach_agent_to_daemon(agent_id, daemon)

    task = asyncio.create_task(broker.request_snapshot(agent_id, daemon, lines=321, plain=True))
    await asyncio.sleep(0)

    sent = json.loads(daemon_ws.sent_text[-1])
    assert sent == {
        "type": "agent.snapshot",
        "request_id": sent["request_id"],
        "agent_id": agent_id,
        "lines": 321,
        "plain": True,
    }

    payload = {"request_id": sent["request_id"], "bytes_b64": "cGxhaW4="}
    await broker.resolve_snapshot(
        agent_id, payload, daemon=daemon, expected_host_generation=1
    )
    assert await task == payload

    await broker.unregister_daemon(daemon)


@pytest.mark.asyncio
async def test_broker_directory_request_roundtrip(app):
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
    await _accept_owner(broker, daemon)

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
    await broker.resolve_dir_list(
        request_id, payload, daemon=daemon, expected_host_generation=1
    )
    assert await task == payload

    await broker.unregister_daemon(daemon)


@pytest.mark.asyncio
async def test_broker_tool_install_request_roundtrip(app):
    broker = get_broker()

    host_id = "host-tools-install"
    daemon_ws = FakeWS()
    daemon = DaemonConn(
        host_id=host_id,
        user_id="user-1",
        websocket=daemon_ws,  # type: ignore[arg-type]
    )
    await _accept_owner(broker, daemon)

    target = {
        "preset_id": "00000000-0000-4000-8000-0000000000ef",
        "preset_name": "codex",
        "agent_kind": "codex",
        "command": "codex",
        "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
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
    await broker.resolve_tool_install(
        sent["request_id"], payload, daemon=daemon, expected_host_generation=1
    )
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
async def test_host_rtc_bindings_enforce_caps_and_expire_deterministically(monkeypatch):
    from spawn_server.ws import host_signal

    monkeypatch.setattr(host_signal, "MAX_HOST_RTC_SESSIONS_PER_BROWSER", 2)
    monkeypatch.setattr(host_signal, "MAX_HOST_RTC_SESSIONS_PER_HOST", 3)
    monkeypatch.setattr(host_signal, "MAX_HOST_RTC_SESSIONS_PER_DAEMON", 3)
    broker = Broker()
    daemon = DaemonConn("bounded-host", "owner", FakeWS())  # type: ignore[arg-type]
    first = HostBrowserConn("owner", "bounded-host", FakeWS())  # type: ignore[arg-type]
    second = HostBrowserConn("owner", "bounded-host", FakeWS())  # type: ignore[arg-type]

    async def register(session_id: str, browser: HostBrowserConn) -> bool:
        return await broker.register_rtc_session(
            session_id,
            browser,
            daemon=daemon,
            scope_type="host",
            scope_id="bounded-host",
            protocol="spawn.host.ctl",
            protocol_version=1,
            ttl_seconds=10,
            now=100,
        )

    assert await register("bounded-1", first)
    assert await register("bounded-2", first)
    assert not await register("browser-over-cap", first)
    assert await register("bounded-3", second)
    assert not await register("host-and-daemon-over-cap", second)
    first_binding = await broker.rtc_session_for("bounded-1", now=109)
    assert first_binding is not None
    assert await broker.mark_rtc_session_connected("bounded-1", first_binding) is not None
    assert await broker.rtc_session_for("bounded-1", now=110) is not None
    assert await broker.rtc_session_for("bounded-2", now=110) is None

    # Expiry prunes every stale binding, freeing capacity for a fresh offer.
    assert await register("after-expiry", first)


@pytest.mark.asyncio
async def test_distributed_presence_refresh_cannot_be_stolen_by_old_daemon(app):
    from spawn_server.limits import MAX_SAFE_FENCING_GENERATION
    from spawn_server.redis import get_backend
    from spawn_server.ws.host_signal import (
        HostPresenceOwner,
        decode_host_presence_owner,
        encode_host_presence_owner,
    )

    backend = get_backend()
    key = "spawn:rtc:host:presence-test:owner"
    old = encode_host_presence_owner(HostPresenceOwner("a" * 32, 1))
    new = encode_host_presence_owner(HostPresenceOwner("b" * 32, 2))
    await backend.set_ephemeral(key, old, ttl_seconds=60)
    claimed, previous = await backend.set_ephemeral_if_newer(key, new, generation=2, ttl_seconds=60)
    assert claimed
    assert previous == old

    assert not await backend.refresh_ephemeral_if(key, old, ttl_seconds=60)
    assert await backend.get_ephemeral(key) == new
    assert await backend.refresh_ephemeral_if(key, new, ttl_seconds=60)

    claimed, previous = await backend.set_ephemeral_if_newer(key, old, generation=1, ttl_seconds=60)
    assert not claimed
    assert previous == new
    assert await backend.get_ephemeral(key) == new

    for corrupt in (
        b"corrupt",
        b"NaN:" + b"c" * 32,
        f"{MAX_SAFE_FENCING_GENERATION + 1}:{'c' * 32}".encode(),
        b"3:invalid-owner",
    ):
        await backend.set_ephemeral(key, corrupt, ttl_seconds=60)
        claimed, previous = await backend.set_ephemeral_if_newer(
            key,
            encode_host_presence_owner(HostPresenceOwner("c" * 32, 3)),
            generation=3,
            ttl_seconds=60,
        )
        assert not claimed
        assert previous == corrupt
        assert await backend.get_ephemeral(key) == corrupt
    assert decode_host_presence_owner(b"not-a-generation:invalid") is None
    assert (
        decode_host_presence_owner(f"{MAX_SAFE_FENCING_GENERATION + 1}:{'d' * 32}".encode()) is None
    )

    await backend.delete_ephemeral_if(key, b"3:invalid-owner")
    maximum = encode_host_presence_owner(HostPresenceOwner("d" * 32, MAX_SAFE_FENCING_GENERATION))
    claimed, _ = await backend.set_ephemeral_if_newer(
        key,
        maximum,
        generation=MAX_SAFE_FENCING_GENERATION,
        ttl_seconds=60,
    )
    assert claimed
    with pytest.raises(ValueError, match="exact integer range"):
        await backend.set_ephemeral_if_newer(
            key,
            maximum,
            generation=MAX_SAFE_FENCING_GENERATION + 1,
            ttl_seconds=60,
        )


@pytest.mark.asyncio
async def test_committed_owner_promotion_repairs_older_cache_but_never_overwrites_successor(app):
    from spawn_server.redis import get_backend
    from spawn_server.ws.host_signal import HostPresenceOwner, encode_host_presence_owner

    backend = get_backend()
    active_key = "spawn:rtc:host:activation-recovery:owner"
    pending_key = "spawn:rtc:host:activation-recovery:pending"
    owner_a = encode_host_presence_owner(HostPresenceOwner("a" * 32, 1))
    owner_c = encode_host_presence_owner(HostPresenceOwner("c" * 32, 3))
    owner_c_other = encode_host_presence_owner(HostPresenceOwner("e" * 32, 3))
    owner_d = encode_host_presence_owner(HostPresenceOwner("d" * 32, 4))

    # DB has committed C while Redis still reflects A: exact pending C may
    # atomically repair the older active cache.
    await backend.set_ephemeral(active_key, owner_a, ttl_seconds=60)
    await backend.set_ephemeral(pending_key, owner_c, ttl_seconds=60)
    assert await backend.activate_ephemeral_if_newer(
        pending_key,
        owner_c,
        active_key,
        generation=3,
        ttl_seconds=60,
    )
    assert await backend.get_ephemeral(active_key) == owner_c
    assert await backend.get_ephemeral(pending_key) is None

    # A successor replacing pending C fences C's delayed recovery.
    await backend.set_ephemeral(active_key, owner_a, ttl_seconds=60)
    await backend.set_ephemeral(pending_key, owner_d, ttl_seconds=60)
    assert not await backend.activate_ephemeral_if_newer(
        pending_key,
        owner_c,
        active_key,
        generation=3,
        ttl_seconds=60,
    )
    assert await backend.activate_ephemeral_if_newer(
        pending_key,
        owner_d,
        active_key,
        generation=4,
        ttl_seconds=60,
    )
    assert await backend.get_ephemeral(active_key) == owner_d

    # Equal-generation other owners, higher owners, and corrupt cache values
    # are never overwritten by recovery.
    for protected in (owner_c_other, owner_d, b"corrupt"):
        await backend.set_ephemeral(active_key, protected, ttl_seconds=60)
        await backend.set_ephemeral(pending_key, owner_c, ttl_seconds=60)
        assert not await backend.activate_ephemeral_if_newer(
            pending_key,
            owner_c,
            active_key,
            generation=3,
            ttl_seconds=60,
        )
        assert await backend.get_ephemeral(active_key) == protected


@pytest.mark.asyncio
async def test_distributed_result_rejects_owner_when_successor_is_pending(app):
    from spawn_server.redis import get_backend
    from spawn_server.ws.host_signal import (
        HostPresenceOwner,
        encode_host_presence_owner,
        host_pending_presence_key,
    )

    broker = Broker()
    daemon = DaemonConn(
        host_id="host-result-pending-fence",
        user_id="user-1",
        websocket=FakeWS(),  # type: ignore[arg-type]
    )
    await _accept_owner(broker, daemon, generation=1)
    task = asyncio.create_task(broker.request_snapshot("agent-1", daemon, timeout=0.05))
    await asyncio.sleep(0)
    request = json.loads(daemon.websocket.sent_text[-1])

    successor = encode_host_presence_owner(HostPresenceOwner("b" * 32, 2))
    await get_backend().set_ephemeral(
        host_pending_presence_key(daemon.host_id),
        successor,
        ttl_seconds=60,
    )
    assert not await broker.resolve_snapshot(
        "agent-1",
        {"request_id": request["request_id"], "bytes_b64": "c3RhbGU="},
        daemon=daemon,
        expected_host_generation=1,
    )
    assert await task is None


@pytest.mark.asyncio
async def test_distributed_result_waiter_matches_complete_owner_and_request_identity(app):
    from spawn_server.redis import get_backend
    from spawn_server.ws.owner_dispatch import OwnerResultEnvelope, encode_owner_result

    broker = Broker()
    daemon = DaemonConn(
        host_id="host-result-identity",
        user_id="user-1",
        websocket=FakeWS(),  # type: ignore[arg-type]
    )
    await _accept_owner(broker, daemon, generation=1)
    task = asyncio.create_task(broker.request_snapshot("agent-1", daemon, timeout=1))
    await asyncio.sleep(0)
    request = json.loads(daemon.websocket.sent_text[-1])
    request_id = request["request_id"]

    # Even on the deterministic request channel, a mismatched envelope cannot
    # resolve or mutate the generation-bound waiter.
    await get_backend().publish_channel(
        f"spawn:host-result:{daemon.host_id}:agent.snapshot:{request_id}",
        encode_owner_result(
            OwnerResultEnvelope(
                daemon.host_id,
                daemon.id,
                1,
                "agent.snapshot",
                "different-request",
                {"bytes_b64": "d3Jvbmc="},
            )
        ),
    )
    await asyncio.sleep(0)
    assert not task.done()

    valid = {"request_id": request_id, "bytes_b64": "dmFsaWQ="}
    assert await broker.resolve_snapshot(
        "agent-1",
        valid,
        daemon=daemon,
        expected_host_generation=1,
    )
    assert await task == valid

    # A result after the requester has gone is safe and cannot mutate a reused
    # local future because there are no process-local waiter maps.
    assert await broker.resolve_snapshot(
        "agent-1",
        valid,
        daemon=daemon,
        expected_host_generation=1,
    )


@pytest.mark.asyncio
async def test_distributed_result_wait_is_cancellable_and_unsubscribes(app):
    from spawn_server.redis import get_backend
    from spawn_server.ws.owner_dispatch import owner_result_channel

    broker = Broker()
    daemon = DaemonConn(
        host_id="host-result-cancel",
        user_id="user-1",
        websocket=FakeWS(),  # type: ignore[arg-type]
    )
    await _accept_owner(broker, daemon, generation=1)
    task = asyncio.create_task(broker.request_snapshot("agent-1", daemon, timeout=30))
    await asyncio.sleep(0)
    request = json.loads(daemon.websocket.sent_text[-1])
    channel = owner_result_channel(
        daemon.host_id,
        "agent.snapshot",
        request["request_id"],
    )
    backend = get_backend()
    assert backend.inproc is not None
    assert len(backend.inproc._subs.get(channel, ())) == 1

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not backend.inproc._subs.get(channel)


@pytest.mark.asyncio
async def test_upload_resolution_distinguishes_missing_waiter_from_stale_owner(app):
    broker = Broker()
    current = DaemonConn(
        host_id="host-upload-resolution",
        user_id="user-1",
        websocket=FakeWS(),  # type: ignore[arg-type]
        host_generation=1,
    )
    await _accept_owner(broker, current)
    assert (
        await broker.resolve_upload(
            "agent-1",
            None,
            {},
            daemon=current,
            expected_host_generation=1,
        )
        is UploadResolution.NO_WAITER
    )
    stale = DaemonConn(
        host_id=current.host_id,
        user_id=current.user_id,
        websocket=FakeWS(),  # type: ignore[arg-type]
        host_generation=0,
    )
    assert (
        await broker.resolve_upload(
            "agent-1",
            "timed-out-client",
            {},
            daemon=stale,
            expected_host_generation=0,
        )
        is UploadResolution.STALE_OWNER
    )


@pytest.mark.asyncio
async def test_upload_result_uses_server_request_identity_not_reusable_client_id(app):
    broker = Broker()
    daemon = DaemonConn(
        host_id="host-upload-request-id",
        user_id="user-1",
        websocket=FakeWS(),  # type: ignore[arg-type]
    )
    await _accept_owner(broker, daemon)
    task = asyncio.create_task(
        broker.request_upload(
            "agent-1",
            daemon,
            payload={
                "type": "agent.upload",
                "agent_id": "agent-1",
                "client_id": "reusable-client-id",
            },
            client_id="reusable-client-id",
            timeout=1,
        )
    )
    await asyncio.sleep(0)
    request = json.loads(daemon.websocket.sent_text[-1])
    assert request["client_id"] == "reusable-client-id"
    assert request["request_id"] != request["client_id"]

    result = {
        "type": "agent.uploaded",
        "agent_id": "agent-1",
        "client_id": "reusable-client-id",
        "request_id": request["request_id"],
        "path": "/repo/upload.txt",
    }
    assert (
        await broker.resolve_upload(
            "agent-1",
            request["request_id"],
            result,
            daemon=daemon,
            expected_host_generation=1,
        )
        is UploadResolution.RESOLVED
    )
    assert await task == result


@pytest.mark.asyncio
async def test_host_rtc_replacement_blocks_stale_publish_and_preserves_binding(app):
    from spawn_server.redis import get_backend
    from spawn_server.ws.host_signal import (
        HostPresenceOwner,
        RedisBrowserConn,
        StaleHostOwnerError,
        encode_host_presence_owner,
        host_pending_presence_key,
        host_presence_key,
    )

    broker = Broker()
    daemon = DaemonConn(
        host_id="host-rtc-exact-publish",
        user_id="user-1",
        websocket=FakeWS(),  # type: ignore[arg-type]
        host_generation=1,
    )
    assert await broker.accept_daemon_owner(daemon, 1)
    channel = f"spawn:rtc:browser:{'c' * 32}"
    browser = RedisBrowserConn(
        user_id=daemon.user_id,
        host_id=daemon.host_id,
        channel=channel,
        daemon_connection_id=daemon.id,
        daemon_generation=1,
    )
    assert await broker.register_rtc_session(
        "rtc-exact-publish",
        browser,
        daemon=daemon,
        scope_type="host",
        scope_id=daemon.host_id,
        protocol="spawn.host.ctl",
        protocol_version=1,
        ttl_seconds=60,
    )
    binding = await broker.rtc_session_for("rtc-exact-publish", daemon=daemon)
    assert binding is not None

    backend = get_backend()
    replacement = HostPresenceOwner("d" * 32, 2)
    await backend.set_ephemeral(
        host_presence_key(daemon.host_id),
        encode_host_presence_owner(HostPresenceOwner(daemon.id, 1)),
        ttl_seconds=60,
    )
    await backend.set_ephemeral(
        host_pending_presence_key(daemon.host_id),
        encode_host_presence_owner(replacement),
        ttl_seconds=60,
    )
    async with backend.subscribe_channel(channel) as stream:
        for payload in (
            {"type": "rtc.answer", "sdp": "v=0\r\n"},
            {"type": "rtc.status", "status": "connected"},
        ):
            with pytest.raises(StaleHostOwnerError):
                await browser.send_text(payload)
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.05):
                await anext(stream)

    assert await broker.rtc_session_for("rtc-exact-publish", daemon=daemon) is binding
    assert binding.expires_at != float("inf")


def test_host_signal_envelopes_reject_unbounded_or_unbound_routes():
    from spawn_server.ws.host_signal import (
        MAX_HOST_SIGNAL_ENVELOPE_BYTES,
        HostOwnerRevocation,
        HostSignalEnvelope,
        decode_host_owner_revocation,
        decode_host_signal,
        encode_host_owner_revocation,
        encode_host_signal,
    )

    response_channel = f"spawn:rtc:browser:{'b' * 32}"
    valid = HostSignalEnvelope(
        daemon_connection_id="a" * 32,
        daemon_generation=1,
        browser_channel=response_channel,
        signal={"type": "rtc.close"},
    )
    assert decode_host_signal(encode_host_signal(valid)) == valid
    bool_generation = encode_host_signal(valid).replace(
        b'"daemon_generation":1', b'"daemon_generation":true'
    )
    assert decode_host_signal(bool_generation) is None
    assert (
        decode_host_signal(
            encode_host_signal(valid).replace(b'"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"', b'"invalid"')
        )
        is None
    )
    revocation = HostOwnerRevocation("a" * 32, "d" * 32)
    assert decode_host_owner_revocation(encode_host_owner_revocation(revocation)) == revocation
    assert decode_host_owner_revocation(b"null") is None
    with pytest.raises(ValueError, match="too large"):
        encode_host_signal(
            HostSignalEnvelope(
                daemon_connection_id="a" * 32,
                daemon_generation=1,
                browser_channel=response_channel,
                signal={"value": "x" * MAX_HOST_SIGNAL_ENVELOPE_BYTES},
            )
        )
