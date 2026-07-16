"""Redis-backed routing primitives for host RTC signaling across server workers."""

from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from ..limits import MAX_SAFE_FENCING_GENERATION
from ..redis import get_backend

HOST_CONTROL_PROTOCOL = "spawn.host.ctl"
HOST_CONTROL_VERSION = 1
HOST_RTC_SESSION_TTL_SECONDS = 60
RTC_CONNECTED_SESSION_TTL_SECONDS = 24 * 60 * 60
HOST_DAEMON_PRESENCE_TTL_SECONDS = 90
MAX_HOST_RTC_SESSIONS_PER_BROWSER = 8
MAX_HOST_RTC_SESSIONS_PER_HOST = 64
MAX_HOST_RTC_SESSIONS_PER_DAEMON = 64
MAX_HOST_SIGNAL_ENVELOPE_BYTES = 1200 * 1024
HOST_RTC_STATUS_ALLOWLIST = frozenset({"connected", "failed", "unavailable"})
HOST_OWNER_REVOKED_EVENT = "host.owner_revoked"


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


async def receive_with_signal_pump(websocket: Any, pump: asyncio.Task[None]) -> dict[str, Any]:
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


def host_pending_presence_key(host_id: str) -> str:
    return f"spawn:rtc:host:{host_id}:pending"


def valid_daemon_connection_id(value: str) -> bool:
    return len(value) == 32 and all(character in "0123456789abcdef" for character in value)


@dataclass(frozen=True)
class HostPresenceOwner:
    daemon_connection_id: str
    generation: int


def encode_host_presence_owner(owner: HostPresenceOwner) -> bytes:
    if not valid_daemon_connection_id(owner.daemon_connection_id):
        raise ValueError("invalid host signaling owner")
    if owner.generation < 1 or owner.generation > MAX_SAFE_FENCING_GENERATION:
        raise ValueError("invalid host signaling generation")
    return f"{owner.generation}:{owner.daemon_connection_id}".encode("ascii")


def decode_host_presence_owner(value: bytes | None) -> HostPresenceOwner | None:
    if value is None or len(value) > 64:
        return None
    try:
        generation_raw, connection_id_raw = value.decode("ascii").split(":", 1)
    except (UnicodeDecodeError, ValueError):
        return None
    if not generation_raw.isdecimal() or not valid_daemon_connection_id(connection_id_raw):
        return None
    generation = int(generation_raw)
    if generation < 1 or generation > MAX_SAFE_FENCING_GENERATION:
        return None
    return HostPresenceOwner(connection_id_raw, generation)


@dataclass(frozen=True)
class HostSignalEnvelope:
    daemon_connection_id: str
    daemon_generation: int
    browser_channel: str
    signal: dict[str, Any]


@dataclass(frozen=True)
class HostOwnerRevocation:
    revoked_connection_id: str
    replacement_connection_id: str


@dataclass(frozen=True)
class RtcSignalDispatch:
    host_id: str
    session_connection_id: str
    session_generation: int
    dispatch_connection_id: str
    dispatch_generation: int
    signal: dict[str, Any]


def encode_host_owner_revocation(event: HostOwnerRevocation) -> bytes:
    if not valid_daemon_connection_id(
        event.revoked_connection_id
    ) or not valid_daemon_connection_id(event.replacement_connection_id):
        raise ValueError("invalid host signaling owner")
    return json.dumps(
        {
            "type": HOST_OWNER_REVOKED_EVENT,
            "revoked_connection_id": event.revoked_connection_id,
            "replacement_connection_id": event.replacement_connection_id,
        },
        separators=(",", ":"),
    ).encode()


def decode_host_owner_revocation(payload: bytes) -> HostOwnerRevocation | None:
    if not payload or len(payload) > 512:
        return None
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("type") != HOST_OWNER_REVOKED_EVENT:
        return None
    revoked = value.get("revoked_connection_id")
    replacement = value.get("replacement_connection_id")
    if (
        not isinstance(revoked, str)
        or not valid_daemon_connection_id(revoked)
        or not isinstance(replacement, str)
        or not valid_daemon_connection_id(replacement)
        or revoked == replacement
    ):
        return None
    return HostOwnerRevocation(revoked, replacement)


def encode_rtc_signal_dispatch(dispatch: RtcSignalDispatch) -> bytes:
    payload = json.dumps(
        {
            "host_id": dispatch.host_id,
            "session_connection_id": dispatch.session_connection_id,
            "session_generation": dispatch.session_generation,
            "dispatch_connection_id": dispatch.dispatch_connection_id,
            "dispatch_generation": dispatch.dispatch_generation,
            "signal": dispatch.signal,
        },
        separators=(",", ":"),
    ).encode()
    if len(payload) > MAX_HOST_SIGNAL_ENVELOPE_BYTES:
        raise ValueError("RTC signal dispatch is too large")
    return payload


def decode_rtc_signal_dispatch(payload: bytes) -> RtcSignalDispatch | None:
    if not payload or len(payload) > MAX_HOST_SIGNAL_ENVELOPE_BYTES:
        return None
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict):
        return None
    host_id = value.get("host_id")
    session_connection_id = value.get("session_connection_id")
    session_generation = value.get("session_generation")
    dispatch_connection_id = value.get("dispatch_connection_id")
    dispatch_generation = value.get("dispatch_generation")
    signal = value.get("signal")
    if (
        not isinstance(host_id, str)
        or not host_id
        or len(host_id) > 128
        or not isinstance(session_connection_id, str)
        or not valid_daemon_connection_id(session_connection_id)
        or not isinstance(dispatch_connection_id, str)
        or not valid_daemon_connection_id(dispatch_connection_id)
        or not isinstance(session_generation, int)
        or isinstance(session_generation, bool)
        or session_generation < 1
        or session_generation > MAX_SAFE_FENCING_GENERATION
        or not isinstance(dispatch_generation, int)
        or isinstance(dispatch_generation, bool)
        or dispatch_generation < 1
        or dispatch_generation > MAX_SAFE_FENCING_GENERATION
        or not isinstance(signal, dict)
    ):
        return None
    return RtcSignalDispatch(
        host_id,
        session_connection_id,
        session_generation,
        dispatch_connection_id,
        dispatch_generation,
        signal,
    )


def encode_host_signal(envelope: HostSignalEnvelope) -> bytes:
    payload = json.dumps(
        {
            "daemon_connection_id": envelope.daemon_connection_id,
            "daemon_generation": envelope.daemon_generation,
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
    daemon_generation = value.get("daemon_generation")
    browser_channel = value.get("browser_channel")
    signal = value.get("signal")
    if (
        not isinstance(daemon_connection_id, str)
        or not valid_daemon_connection_id(daemon_connection_id)
        or not isinstance(daemon_generation, int)
        or isinstance(daemon_generation, bool)
        or daemon_generation < 1
        or daemon_generation > MAX_SAFE_FENCING_GENERATION
        or not isinstance(browser_channel, str)
        or not browser_channel.startswith("spawn:rtc:browser:")
        or not valid_daemon_connection_id(browser_channel.removeprefix("spawn:rtc:browser:"))
        or not isinstance(signal, dict)
    ):
        return None
    return HostSignalEnvelope(
        daemon_connection_id,
        daemon_generation,
        browser_channel,
        signal,
    )


async def publish_host_signal(host_id: str, envelope: HostSignalEnvelope) -> None:
    await get_backend().publish_channel(host_signal_channel(host_id), encode_host_signal(envelope))


async def publish_host_owner_revocation(host_id: str, event: HostOwnerRevocation) -> None:
    await get_backend().publish_channel(
        host_signal_channel(host_id), encode_host_owner_revocation(event)
    )


@dataclass(eq=False, frozen=True)
class RedisBrowserConn:
    user_id: str
    host_id: str
    channel: str
    daemon_connection_id: str
    daemon_generation: int

    @property
    def route_id(self) -> str:
        return self.channel

    async def _send_text_as_owner(self, payload: dict, owner: HostPresenceOwner) -> None:
        dispatch = RtcSignalDispatch(
            host_id=self.host_id,
            session_connection_id=self.daemon_connection_id,
            session_generation=self.daemon_generation,
            dispatch_connection_id=owner.daemon_connection_id,
            dispatch_generation=owner.generation,
            signal=payload,
        )
        published = await get_backend().publish_if_host_owner(
            host_presence_key(self.host_id),
            host_pending_presence_key(self.host_id),
            encode_host_presence_owner(owner),
            generation=owner.generation,
            channel=self.channel,
            payload=encode_rtc_signal_dispatch(dispatch),
        )
        if not published:
            raise StaleHostOwnerError("host RTC response owner is no longer current")

    async def send_text(self, payload: dict) -> None:
        await self._send_text_as_owner(
            payload,
            HostPresenceOwner(
                self.daemon_connection_id,
                self.daemon_generation,
            ),
        )

    async def send_owner_revocation(self, payload: dict, replacement: HostPresenceOwner) -> None:
        """Publish unavailable using the replacement's explicit owner token."""
        if replacement.daemon_connection_id == self.daemon_connection_id:
            raise StaleHostOwnerError("revocation requires a replacement owner")
        await self._send_text_as_owner(payload, replacement)


class StaleHostOwnerError(RuntimeError):
    """An exact-owner RTC publication lost its Redis fencing token."""
