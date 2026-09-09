"""An early timer must not strand a disconnected RTC binding indefinitely."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from spawn_server.ws import broker as broker_mod
from spawn_server.ws import browser, daemon
from spawn_server.ws.host_signal import RedisBrowserConn


@pytest.mark.parametrize("side", ["browser", "daemon"])
@pytest.mark.parametrize("resumed", [False, True])
async def test_orphan_deadline_survives_early_timer(monkeypatch, side, resumed):
    clock = SimpleNamespace(now=100.0)
    monotonic = SimpleNamespace(monotonic=lambda: clock.now)
    broker = broker_mod.Broker()
    owner = broker_mod.DaemonConn("host", "user", object())
    owner.host_generation = 1
    route = RedisBrowserConn("user", "host", "channel", owner.id, 1, "a" * 32)
    scheduler = browser if side == "browser" else daemon
    monkeypatch.setattr(broker_mod, "time", monotonic)
    monkeypatch.setattr(scheduler, "time", monotonic)
    monkeypatch.setattr(scheduler, "get_broker", lambda: broker)
    notification = AsyncMock()
    monkeypatch.setattr(
        scheduler,
        "_publish_session_rtc_signal" if side == "browser" else "_send_server_binding_status",
        notification,
    )
    assert await broker.register_rtc_session(
        "rtc-id",
        route,
        daemon=owner,
        scope_type="session",
        scope_id="pty",
        protocol="spawn.pty",
        protocol_version=2,
        binding_nonce="a" * 32,
        ttl_seconds=120,
    )
    binding = await broker.rtc_session_for("rtc-id")
    await broker.mark_rtc_session_connected("rtc-id", binding)
    orphan = (
        await broker.orphan_rtc_sessions_for_browser(route)
        if side == "browser"
        else await broker.orphan_rtc_sessions_for_daemon(owner)
    )[0]
    deadline = getattr(orphan, f"{side}_orphaned_until")
    sleeps = []

    async def early_sleep(delay):
        sleeps.append(delay)
        clock.now = deadline - 0.0003 if len(sleeps) == 1 else deadline
        if resumed and len(sleeps) == 1:
            if side == "browser":
                assert await broker.resume_rtc_session(
                    "rtc-id",
                    route,
                    binding_nonce="a" * 32,
                    binding_generation=1,
                    scope_type="session",
                    scope_id="pty",
                    protocol="spawn.pty",
                    protocol_version=2,
                )
            else:
                live = browser._binding_frame(orphan, "unused")
                live.pop("type")
                rebound, absent, unknown = await broker.reconcile_daemon_live_bindings(
                    owner, [live]
                )
                assert len(rebound) == 1 and not absent and not unknown
        await asyncio.sleep(0)

    monkeypatch.setattr(
        scheduler, "asyncio", SimpleNamespace(sleep=early_sleep, create_task=asyncio.create_task)
    )
    tasks = (
        browser._orphan_expiry_tasks if side == "browser" else daemon._daemon_orphan_expiry_tasks
    )
    previous = set(tasks)
    try:
        if side == "browser":
            browser._schedule_browser_orphan_expiry("host", orphan)
        else:
            daemon._schedule_daemon_orphan_expiry(orphan)
        await asyncio.wait_for(asyncio.gather(*(set(tasks) - previous)), timeout=1)
        clock.now = deadline + 1
        remaining = await broker.rtc_session_for("rtc-id")
        if resumed:
            assert remaining is not None
            notification.assert_not_awaited()
        else:
            assert remaining is None, "timer exited early and stranded the orphan for 24 hours"
            notification.assert_awaited_once()
    finally:
        await broker.shutdown()
