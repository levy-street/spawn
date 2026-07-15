"""Redis-backed routing primitives for host RTC signaling across server workers."""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from ..redis import get_backend

HOST_CONTROL_PROTOCOL = "spawn.host.ctl"
HOST_CONTROL_VERSION = 1
HOST_RTC_SESSION_TTL_SECONDS = 60
HOST_DAEMON_PRESENCE_TTL_SECONDS = 90
MAX_HOST_RTC_SESSIONS_PER_BROWSER = 8
MAX_HOST_RTC_SESSIONS_PER_HOST = 64
MAX_HOST_RTC_SESSIONS_PER_DAEMON = 64
MAX_HOST_SIGNAL_ENVELOPE_BYTES = 1200 * 1024
HOST_RTC_STATUS_ALLOWLIST = frozenset({"connected", "failed", "unavailable"})


async def wait_for_signal_pump(pump: asyncio.Task[None], ready: asyncio.Event) -> None:
    """Wait until subscribed, failing instead of hanging if the pump dies."""
    ready_task = asyncio.create_task(ready.wait())
    try:
        done, _ = await asyncio.wait({pump, ready_task}, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        ready_task.cancel()
        with suppress(asyncio.CancelledError):
            await ready_task
        raise
    if pump in done:
        ready_task.cancel()
        with suppress(asyncio.CancelledError):
            await ready_task
        await pump
        raise RuntimeError("host signal subscription stopped before becoming ready")
    await ready_task


async def receive_with_signal_pump(
    websocket: Any, pump: asyncio.Task[None]
) -> dict[str, Any]:
    """Receive a websocket frame while treating a dead Redis pump as fatal."""
    receive_task = asyncio.create_task(websocket.receive())
    try:
        done, _ = await asyncio.wait({pump, receive_task}, return_when=asyncio.FIRST_COMPLETED)
    except asyncio.CancelledError:
        receive_task.cancel()
        with suppress(asyncio.CancelledError):
            await receive_task
        raise
    if pump in done:
        receive_task.cancel()
        with suppress(asyncio.CancelledError):
            await receive_task
        await pump
        raise RuntimeError("host signal subscription stopped")
    return await receive_task


def host_signal_channel(host_id: str) -> str:
    return f"spawn:rtc:host:{host_id}:daemon"


def browser_signal_channel(connection_id: str) -> str:
    return f"spawn:rtc:browser:{connection_id}"


def host_presence_key(host_id: str) -> str:
    return f"spawn:rtc:host:{host_id}:owner"


def valid_daemon_connection_id(value: str) -> bool:
    return len(value) == 32 and all(character in "0123456789abcdef" for character in value)


@dataclass(frozen=True)
class HostSignalEnvelope:
    daemon_connection_id: str
    browser_channel: str
    signal: dict[str, Any]


def encode_host_signal(envelope: HostSignalEnvelope) -> bytes:
    payload = json.dumps(
        {
            "daemon_connection_id": envelope.daemon_connection_id,
            "browser_channel": envelope.browser_channel,
            "signal": envelope.signal,
        },
        separators=(",", ":"),
    ).encode()
    if len(payload) > MAX_HOST_SIGNAL_ENVELOPE_BYTES:
        raise ValueError("host signal envelope is too large")
    return payload


def decode_host_signal(payload: bytes) -> HostSignalEnvelope | None:
    if not payload or len(payload) > MAX_HOST_SIGNAL_ENVELOPE_BYTES:
        return None
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    daemon_connection_id = value.get("daemon_connection_id")
    browser_channel = value.get("browser_channel")
    signal = value.get("signal")
    if (
        not isinstance(daemon_connection_id, str)
        or not valid_daemon_connection_id(daemon_connection_id)
        or not isinstance(browser_channel, str)
        or not browser_channel.startswith("spawn:rtc:browser:")
        or not valid_daemon_connection_id(browser_channel.removeprefix("spawn:rtc:browser:"))
        or not isinstance(signal, dict)
    ):
        return None
    return HostSignalEnvelope(daemon_connection_id, browser_channel, signal)


async def publish_host_signal(host_id: str, envelope: HostSignalEnvelope) -> None:
    await get_backend().publish_channel(host_signal_channel(host_id), encode_host_signal(envelope))


@dataclass(eq=False, frozen=True)
class RedisBrowserConn:
    user_id: str
    host_id: str
    channel: str

    @property
    def route_id(self) -> str:
        return self.channel

    async def send_text(self, payload: dict) -> None:
        await get_backend().publish_channel(
            self.channel,
            json.dumps(payload, separators=(",", ":")).encode(),
        )
