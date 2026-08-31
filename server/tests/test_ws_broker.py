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
    get_broker,
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


@pytest.mark.asyncio
async def test_rtc_orphan_rebind_expiry_resume_and_user_isolation():
    broker = Broker()
    old_daemon = DaemonConn("orphan-host", "owner", FakeWS())  # type: ignore[arg-type]
    old_daemon.host_generation = 7
    old_daemon.keeps_peers_across_reconnect = True
    old_browser = BrowserConn("owner", "pty", FakeWS())  # type: ignore[arg-type]
    assert await broker.register_rtc_session(
        "binding-rebind",
        old_browser,
        daemon=old_daemon,
        scope_type="session",
        scope_id="pty",
        protocol="spawn.pty",
        protocol_version=2,
        binding_nonce="a" * 32,
        now=100,
    )
    orphaned = await broker.orphan_rtc_sessions_for_daemon(old_daemon, grace_seconds=60, now=100)
    assert len(orphaned) == 1

    new_daemon = DaemonConn("orphan-host", "owner", FakeWS())  # type: ignore[arg-type]
    new_daemon.host_generation = 8
    live = {
        "session_id": "binding-rebind",
        "binding_nonce": "a" * 32,
        "binding_generation": 7,
        "scope_type": "session",
        "scope_id": "pty",
        "protocol": "spawn.pty",
        "protocol_version": 2,
    }
    rebound, absent, unknown = await broker.reconcile_daemon_live_bindings(
        new_daemon, [live], now=120
    )
    assert len(rebound) == 1 and absent == [] and unknown == []
    assert rebound[0].daemon is new_daemon
    assert rebound[0].daemon_generation == 7

    await broker.orphan_rtc_sessions_for_browser(old_browser, grace_seconds=60, now=130)
    attacker = BrowserConn("other-user", "pty", FakeWS())  # type: ignore[arg-type]
    assert (
        await broker.resume_rtc_session(
            "binding-rebind",
            attacker,
            binding_nonce="a" * 32,
            binding_generation=7,
            scope_type="session",
            scope_id="pty",
            protocol="spawn.pty",
            protocol_version=2,
            now=140,
        )
        is None
    )
    resumed_browser = BrowserConn("owner", "pty", FakeWS())  # type: ignore[arg-type]
    resumed = await broker.resume_rtc_session(
        "binding-rebind",
        resumed_browser,
        binding_nonce="a" * 32,
        binding_generation=7,
        scope_type="session",
        scope_id="pty",
        protocol="spawn.pty",
        protocol_version=2,
        now=140,
    )
    assert resumed is not None and resumed.browser is resumed_browser

    await broker.orphan_rtc_sessions_for_daemon(new_daemon, grace_seconds=10, now=200)
    expired = await broker.expire_rtc_orphan("binding-rebind", "a" * 32, 7, side="daemon", now=211)
    assert expired is not None
    assert await broker.rtc_session_for("binding-rebind", now=211) is None


@pytest.mark.asyncio
async def test_rtc_live_binding_reconcile_revokes_absent_and_closes_unknown():
    broker = Broker()
    daemon = DaemonConn("reconcile-host", "owner", FakeWS())  # type: ignore[arg-type]
    daemon.host_generation = 3
    browser = BrowserConn("owner", "pty", FakeWS())  # type: ignore[arg-type]
    assert await broker.register_rtc_session(
        "known",
        browser,
        daemon=daemon,
        scope_type="session",
        scope_id="pty",
        protocol="spawn.pty",
        protocol_version=2,
        binding_nonce="b" * 32,
    )
    await broker.orphan_rtc_sessions_for_daemon(daemon, now=10)
    replacement = DaemonConn("reconcile-host", "owner", FakeWS())  # type: ignore[arg-type]
    replacement.host_generation = 4
    unknown_item = {
        "session_id": "unknown",
        "binding_nonce": "c" * 32,
        "binding_generation": 3,
        "scope_type": "session",
        "scope_id": "pty",
        "protocol": "spawn.pty",
        "protocol_version": 2,
    }
    rebound, absent, unknown = await broker.reconcile_daemon_live_bindings(
        replacement, [unknown_item], now=20
    )
    assert rebound == []
    assert [binding.session_id for binding in absent] == ["known"]
    assert unknown == [unknown_item]


@pytest.mark.asyncio
async def test_session_rtc_caps_are_per_user_and_browser(monkeypatch):
    from spawn_server.ws import host_signal

    monkeypatch.setattr(host_signal, "MAX_SESSION_RTC_SESSIONS_PER_USER", 2)
    monkeypatch.setattr(host_signal, "MAX_SESSION_RTC_SESSIONS_PER_BROWSER", 1)
    broker = Broker()
    daemon = DaemonConn("cap-host", "owner", FakeWS())  # type: ignore[arg-type]
    first = BrowserConn("owner", "pty-a", FakeWS())  # type: ignore[arg-type]
    second = BrowserConn("owner", "pty-b", FakeWS())  # type: ignore[arg-type]

    async def register(session_id: str, browser: BrowserConn) -> bool:
        return await broker.register_rtc_session(
            session_id,
            browser,
            daemon=daemon,
            scope_type="session",
            scope_id=browser.session_id,
            protocol="spawn.pty",
            protocol_version=2,
        )

    assert await register("one", first)
    assert not await register("same-browser-over-cap", first)
    assert await register("two", second)
    third = BrowserConn("owner", "pty-c", FakeWS())  # type: ignore[arg-type]
    assert not await register("user-over-cap", third)


@pytest.mark.asyncio
async def test_local_accepted_daemon_eagerly_reclaims_lost_presence(app):
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User
    from spawn_server.redis import get_backend
    from spawn_server.ws.host_signal import host_presence_key

    broker = Broker()
    daemon = DaemonConn("reclaim-host", "owner", FakeWS())  # type: ignore[arg-type]
    async with get_sessionmaker()() as session:
        session.add(User(id="owner", email="reclaim@example.com", password_hash="hash"))
        session.add(
            Host(
                id=daemon.host_id,
                owner_user_id="owner",
                name="reclaim",
                status="online",
                daemon_connection_id=daemon.id,
                daemon_generation=9,
                daemon_generation_counter=9,
            )
        )
        await session.commit()
    await _accept_owner(broker, daemon, generation=9)
    current = await get_backend().get_ephemeral(host_presence_key(daemon.host_id))
    assert current is not None
    assert await get_backend().delete_ephemeral_if(host_presence_key(daemon.host_id), current)
    assert await get_backend().get_ephemeral(host_presence_key(daemon.host_id)) is None
    assert await broker.reclaim_daemon_presence_if_missing(daemon)
    assert await get_backend().get_ephemeral(host_presence_key(daemon.host_id)) is not None


@pytest.mark.asyncio
async def test_broker_daemon_reconnect_supersedes_stale_connection_and_reassociates_sessions():
    broker = get_broker()

    host_id = "host-reconnect"
    user_id = "user-1"
    session_id = "00000000-0000-4000-8000-0000000000ad"
    old_ws = FakeWS()
    old_daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=old_ws)  # type: ignore[arg-type]
    await broker.register_daemon(old_daemon)
    await broker.attach_session_to_daemon(session_id, old_daemon)

    assert broker.get_daemon_for_session(session_id) is old_daemon

    new_ws = FakeWS()
    new_daemon = DaemonConn(host_id=host_id, user_id=user_id, websocket=new_ws)  # type: ignore[arg-type]
    await broker.register_daemon(new_daemon)

    assert old_ws.closed == [(4000, "superseded")]
    assert broker.get_daemon_for_host(host_id) is new_daemon
    assert broker.get_daemon_for_session(session_id) is None

    # Mirrors the daemon register(existing_sessions=[...]) path after reconnect.
    await broker.attach_session_to_daemon(session_id, new_daemon)
    assert broker.get_daemon_for_session(session_id) is new_daemon
    assert session_id in new_daemon.session_ids
    assert session_id not in old_daemon.session_ids

    await broker.unregister_daemon(new_daemon)


@pytest.mark.asyncio
async def test_broker_agent_install_request_roundtrip(app):
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
        "agent_id": "00000000-0000-4000-8000-0000000000ef",
        "agent_name": "codex",
        "agent_kind": "codex",
        "command": "codex",
        "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
    }
    task = asyncio.create_task(broker.request_agent_install(daemon, target=target, timeout=1))
    await asyncio.sleep(0)

    sent = json.loads(daemon_ws.sent_text[-1])
    assert sent["type"] == "host.agents.install"
    assert sent["target"] == target

    payload = {
        "type": "host.agents.install_result",
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
    await broker.resolve_agent_install(
        sent["request_id"], payload, daemon=daemon, expected_host_generation=1
    )
    assert await task == payload

    await broker.unregister_daemon(daemon)


@pytest.mark.asyncio
async def test_host_ping_rejects_stale_daemon_and_generation(app):
    broker = Broker()
    old_ws = FakeWS()
    old = DaemonConn("host-ping", "owner", old_ws)  # type: ignore[arg-type]
    await _accept_owner(broker, old, generation=1)

    new_ws = FakeWS()
    new = DaemonConn("host-ping", "owner", new_ws)  # type: ignore[arg-type]
    await _accept_owner(broker, new, generation=2)

    assert not await broker.request_host_ping(old, timeout=0.01)
    assert old_ws.sent_text == []

    task = asyncio.create_task(broker.request_host_ping(new, timeout=1))
    await asyncio.sleep(0)
    sent = json.loads(new_ws.sent_text[-1])
    payload = {"type": "host.pong", "request_id": sent["request_id"]}
    assert not await broker.resolve_host_pong(
        sent["request_id"],
        payload,
        daemon=new,
        expected_host_generation=1,
    )
    assert not task.done()
    assert await broker.resolve_host_pong(
        sent["request_id"],
        payload,
        daemon=new,
        expected_host_generation=2,
    )
    assert await task

    await broker.unregister_daemon(new)


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
        binding_nonce="d" * 32,
    )
    assert await broker.register_rtc_session(
        "rtc-exact-publish",
        browser,
        daemon=daemon,
        scope_type="host",
        scope_id=daemon.host_id,
        protocol="spawn.host.ctl",
        protocol_version=1,
        binding_nonce="d" * 32,
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


@pytest.mark.asyncio
async def test_rtc_binding_nonce_is_immutable_across_session_id_reuse(app):
    broker = Broker()
    daemon = DaemonConn(
        "rtc-nonce-host",
        "owner",
        FakeWS(),  # type: ignore[arg-type]
        host_generation=1,
    )
    await _accept_owner(broker, daemon)
    browser = HostBrowserConn("owner", daemon.host_id, FakeWS())  # type: ignore[arg-type]
    assert await broker.register_rtc_session(
        "reused-session",
        browser,
        daemon=daemon,
        scope_type="host",
        scope_id=daemon.host_id,
        protocol="spawn.host.ctl",
        protocol_version=1,
        binding_nonce="1" * 32,
    )
    first = await broker.rtc_session_for("reused-session")
    assert first is not None and first.nonce == "1" * 32
    await broker.unregister_rtc_session("reused-session", browser)

    # The exact retired identity can never be made live again. Registration
    # rejects atomically, so no caller can observe a transient binding.
    assert not await broker.register_rtc_session(
        "reused-session",
        browser,
        daemon=daemon,
        scope_type="host",
        scope_id=daemon.host_id,
        protocol="spawn.host.ctl",
        protocol_version=1,
        binding_nonce="1" * 32,
    )
    assert await broker.rtc_session_for("reused-session") is None

    assert await broker.register_rtc_session(
        "reused-session",
        browser,
        daemon=daemon,
        scope_type="host",
        scope_id=daemon.host_id,
        protocol="spawn.host.ctl",
        protocol_version=1,
        binding_nonce="2" * 32,
    )
    second = await broker.rtc_session_for("reused-session")
    assert second is not None and second.nonce == "2" * 32
    assert await broker.mark_rtc_session_connected("reused-session", first) is None
    assert await broker.rtc_session_for("reused-session") is second
    await broker.shutdown()


@pytest.mark.asyncio
async def test_broker_rtc_tombstones_cap_and_expire_without_later_operation(app, monkeypatch):
    from spawn_server.ws import host_signal

    monkeypatch.setattr(host_signal, "MAX_RTC_BINDING_IDENTITIES", 2)
    monkeypatch.setattr(host_signal, "RTC_BINDING_TOMBSTONE_TTL_SECONDS", 0.02)
    broker = Broker()
    daemon = DaemonConn(
        "rtc-tombstone-host",
        "owner",
        FakeWS(),  # type: ignore[arg-type]
        host_generation=1,
    )
    await _accept_owner(broker, daemon)
    browser = HostBrowserConn("owner", daemon.host_id, FakeWS())  # type: ignore[arg-type]

    async def register(session_id: str, nonce: str) -> bool:
        return await broker.register_rtc_session(
            session_id,
            browser,
            daemon=daemon,
            scope_type="host",
            scope_id=daemon.host_id,
            protocol="spawn.host.ctl",
            protocol_version=1,
            binding_nonce=nonce,
        )

    assert await register("one", "1" * 32)
    await broker.unregister_rtc_session("one", browser)
    cleanup = broker._rtc_tombstone_cleanup_task
    assert cleanup is not None and not cleanup.done()
    assert await register("two", "2" * 32)
    await broker.unregister_rtc_session("two", browser)
    assert broker._rtc_tombstone_cleanup_task is cleanup
    assert not await register("rejected-at-cap", "3" * 32)

    for _ in range(40):
        if not broker._retired_rtc_bindings:
            break
        await asyncio.sleep(0.005)
    assert not broker._retired_rtc_bindings
    assert cleanup.done()
    assert await register("accepted-after-expiry", "4" * 32)
    await broker.unregister_rtc_session("accepted-after-expiry", browser)
    cleanup = broker._rtc_tombstone_cleanup_task
    assert cleanup is not None
    await broker.shutdown()
    assert cleanup.cancelled()
    assert broker._rtc_tombstone_cleanup_task is None


def test_host_signal_envelopes_reject_unbounded_or_unbound_routes():
    from spawn_server.ws.host_signal import (
        MAX_HOST_SIGNAL_ENVELOPE_BYTES,
        HostOwnerRevocation,
        HostSignalEnvelope,
        RtcSignalDispatch,
        decode_host_owner_revocation,
        decode_host_signal,
        decode_rtc_signal_dispatch,
        encode_host_owner_revocation,
        encode_host_signal,
        encode_rtc_signal_dispatch,
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

    from spawn_server.ws.host_signal import (
        decode_browser_pins_changed,
        encode_browser_pins_changed,
    )

    # The pin-change nudge round-trips and never collides with the other
    # channel event shapes (each decoder must reject the others' payloads).
    assert decode_browser_pins_changed(encode_browser_pins_changed()) is True
    assert decode_browser_pins_changed(encode_host_owner_revocation(revocation)) is False
    assert decode_browser_pins_changed(b"null") is False
    assert decode_host_owner_revocation(encode_browser_pins_changed()) is None
    assert decode_host_signal(encode_browser_pins_changed()) is None
    with pytest.raises(ValueError, match="too large"):
        encode_host_signal(
            HostSignalEnvelope(
                daemon_connection_id="a" * 32,
                daemon_generation=1,
                browser_channel=response_channel,
                signal={"value": "x" * MAX_HOST_SIGNAL_ENVELOPE_BYTES},
            )
        )

    dispatch = RtcSignalDispatch(
        host_id="host-1",
        session_connection_id="a" * 32,
        session_generation=1,
        binding_nonce="c" * 32,
        dispatch_connection_id="a" * 32,
        dispatch_generation=1,
        signal={"type": "rtc.status", "binding_nonce": "c" * 32},
    )
    encoded_dispatch = encode_rtc_signal_dispatch(dispatch)
    assert decode_rtc_signal_dispatch(encoded_dispatch) == dispatch
    assert (
        decode_rtc_signal_dispatch(
            encoded_dispatch.replace(b'"binding_nonce":"cccccccccccccccccccccccccccccccc",', b"")
        )
        is None
    )


class ClosedTransportWS(FakeWS):
    """The socket uvloop hands a handler whose peer left before the first write."""

    def __init__(self, error: BaseException) -> None:
        super().__init__()
        self.error = error

    async def send_text(self, s: str) -> None:
        raise self.error


@pytest.mark.asyncio
async def test_a_send_on_a_closed_transport_reads_as_the_peer_disconnecting():
    from fastapi import WebSocketDisconnect

    gone = RuntimeError(
        "unable to perform operation on <TCPTransport closed=True reading=False 0x1>; "
        "the handler is closed"
    )
    reset = ConnectionResetError("Connection reset by peer")
    for error in (gone, reset):
        for conn in (
            DaemonConn("host-1", "owner", ClosedTransportWS(error)),  # type: ignore[arg-type]
            BrowserConn("owner", "session-1", ClosedTransportWS(error)),  # type: ignore[arg-type]
            HostBrowserConn("owner", "host-1", ClosedTransportWS(error)),  # type: ignore[arg-type]
        ):
            with pytest.raises(WebSocketDisconnect) as raised:
                await conn.send_text({"type": "ping"})
            assert raised.value.code == 1006
            assert raised.value.__cause__ is error

    # Only the transport's own refusals are a disconnect; anything else is a bug
    # and stays loud.
    conn = HostBrowserConn("owner", "host-1", ClosedTransportWS(ValueError("boom")))  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        await conn.send_text({"type": "ping"})
