"""Host-scoped WebRTC signaling; DataChannel payloads never enter this server."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, replace

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from ..config import get_settings
from ..db import get_sessionmaker
from ..models import Host
from ..redis import get_backend
from ..turn import ice_servers_for_session
from .broker import HostBrowserConn
from .browser import _resolve_user, _valid_rtc_candidate, _valid_rtc_sdp, _valid_rtc_session_id
from .host_signal import (
    HOST_CONTROL_PROTOCOL,
    HOST_CONTROL_VERSION,
    HOST_RTC_SESSION_TTL_SECONDS,
    HOST_RTC_STATUS_ALLOWLIST,
    MAX_HOST_RTC_SESSIONS_PER_BROWSER,
    RTC_BINDING_TOMBSTONE_TTL_SECONDS,
    RTC_CONNECTED_SESSION_TTL_SECONDS,
    HostPresenceOwner,
    HostSignalEnvelope,
    browser_signal_channel,
    decode_host_presence_owner,
    decode_rtc_signal_dispatch,
    encode_host_presence_owner,
    encode_host_signal,
    host_pending_presence_key,
    host_presence_key,
    host_signal_channel,
    new_rtc_binding_nonce,
    receive_with_signal_pump,
    wait_for_signal_pump,
)

router = APIRouter()
log = logging.getLogger("spawn.ws.host")

HOST_WS_SUBPROTOCOL = "spawn.host.v1"
MAX_SIGNAL_FRAME_BYTES = 1100 * 1024
WS_CLOSE_BINARY = 4002
MAX_HOST_RTC_BINDING_IDENTITIES = 256


@dataclass(frozen=True)
class BrowserRtcSession:
    session_id: str
    daemon_connection_id: str
    daemon_generation: int
    nonce: str
    expires_at: float


def _is_turn_only(ice_servers: list[dict[str, object]]) -> bool:
    urls: list[str] = []
    for server in ice_servers:
        raw = server.get("urls")
        if isinstance(raw, str):
            urls.append(raw)
        elif isinstance(raw, list):
            urls.extend(value for value in raw if isinstance(value, str))
    return bool(urls) and all(url.startswith(("turn:", "turns:")) for url in urls)


def _metadata_matches(obj: dict, host_id: str) -> bool:
    return (
        obj.get("scope_type") == "host"
        and obj.get("scope_id") == host_id
        and obj.get("protocol") == HOST_CONTROL_PROTOCOL
        and obj.get("protocol_version") == HOST_CONTROL_VERSION
    )


def _signal_payload(
    kind: str, session_id: str, host_id: str, **values: object
) -> dict[str, object]:
    return {
        "type": kind,
        "session_id": session_id,
        "scope_type": "host",
        "scope_id": host_id,
        "protocol": HOST_CONTROL_PROTOCOL,
        "protocol_version": HOST_CONTROL_VERSION,
        **values,
    }


def _binding_identity(binding: BrowserRtcSession) -> tuple[str, str, int, str]:
    return (
        binding.session_id,
        binding.daemon_connection_id,
        binding.daemon_generation,
        binding.nonce,
    )


def _retire_binding(
    retired: dict[tuple[str, str, int, str], float],
    binding: BrowserRtcSession,
    now: float,
    changed: asyncio.Event | None = None,
) -> bool:
    identity = _binding_identity(binding)
    if (
        identity not in retired
        and len(retired) >= MAX_HOST_RTC_BINDING_IDENTITIES
    ):
        return False
    retired[_binding_identity(binding)] = now + RTC_BINDING_TOMBSTONE_TTL_SECONDS
    if changed is not None:
        changed.set()
    return True


def _prune_sessions(
    sessions: dict[str, BrowserRtcSession],
    retired: dict[tuple[str, str, int, str], float],
    now: float,
    changed: asyncio.Event | None = None,
) -> None:
    for session_id in [
        session_id for session_id, binding in sessions.items() if binding.expires_at <= now
    ]:
        binding = sessions.get(session_id)
        if binding is not None and _retire_binding(retired, binding, now, changed):
            sessions.pop(session_id, None)
    for identity in [
        identity for identity, expires_at in retired.items() if expires_at <= now
    ]:
        retired.pop(identity, None)


def _rtc_binding_capacity_available(
    sessions: dict[str, BrowserRtcSession],
    retired: dict[tuple[str, str, int, str], float],
) -> bool:
    return (
        len(sessions) + len(retired) < MAX_HOST_RTC_BINDING_IDENTITIES
    )


async def _cleanup_retired_bindings(
    sessions: dict[str, BrowserRtcSession],
    retired: dict[tuple[str, str, int, str], float],
    sessions_lock: asyncio.Lock,
    changed: asyncio.Event,
) -> None:
    """Expire local tombstones even when the signaling connection is idle."""
    while True:
        async with sessions_lock:
            now = time.monotonic()
            _prune_sessions(sessions, retired, now, changed)
            deadline = min(retired.values()) if retired else None
            changed.clear()
        try:
            if deadline is None:
                await changed.wait()
            else:
                await asyncio.wait_for(
                    changed.wait(), timeout=max(0.0, deadline - time.monotonic())
                )
        except TimeoutError:
            pass


async def _forward_if_exact_binding(
    conn: HostBrowserConn,
    signal: dict[str, object],
    binding: BrowserRtcSession,
    sessions: dict[str, BrowserRtcSession],
    retired: dict[tuple[str, str, int, str], float],
    sessions_lock: asyncio.Lock,
    tombstones_changed: asyncio.Event | None = None,
    *,
    connected: bool = False,
    retire: bool = False,
) -> bool:
    """CAS the captured identity and keep it stable through browser delivery."""
    async with sessions_lock:
        now = time.monotonic()
        _prune_sessions(sessions, retired, now, tombstones_changed)
        if (
            sessions.get(binding.session_id) is not binding
            or _binding_identity(binding) in retired
        ):
            return False
        if retire:
            if not _retire_binding(retired, binding, now, tombstones_changed):
                return False
            sessions.pop(binding.session_id, None)
        elif connected:
            sessions[binding.session_id] = replace(
                binding,
                expires_at=now + RTC_CONNECTED_SESSION_TTL_SECONDS,
            )
        await conn.send_text(signal)
        return True


async def _retire_if_exact_binding(
    binding: BrowserRtcSession,
    sessions: dict[str, BrowserRtcSession],
    retired: dict[tuple[str, str, int, str], float],
    sessions_lock: asyncio.Lock,
    tombstones_changed: asyncio.Event | None = None,
) -> bool:
    async with sessions_lock:
        if sessions.get(binding.session_id) is not binding:
            return False
        if not _retire_binding(
            retired, binding, time.monotonic(), tombstones_changed
        ):
            return False
        sessions.pop(binding.session_id, None)
        return True


async def _send_status(
    conn: HostBrowserConn, host_id: str, session_id: str, status_value: str
) -> None:
    await conn.send_text(_signal_payload("rtc.status", session_id, host_id, status=status_value))


async def _binding_is_current_owner(host_id: str, binding: BrowserRtcSession) -> bool:
    owner = decode_host_presence_owner(
        await get_backend().get_ephemeral(host_presence_key(host_id))
    )
    if owner is None or not (
        owner.daemon_connection_id == binding.daemon_connection_id
        and owner.generation == binding.daemon_generation
    ):
        return False
    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        return host is not None and (
            host.daemon_connection_id == binding.daemon_connection_id
            and host.daemon_generation == binding.daemon_generation
            and host.status == "online"
        )


async def _pump_browser_signals(
    conn: HostBrowserConn,
    host_id: str,
    channel: str,
    sessions: dict[str, BrowserRtcSession],
    retired: dict[tuple[str, str, int, str], float],
    sessions_lock: asyncio.Lock,
    tombstones_changed: asyncio.Event,
    ready: asyncio.Event,
) -> None:
    async with get_backend().subscribe_channel(channel) as stream:
        ready.set()
        async for raw in stream:
            dispatch = decode_rtc_signal_dispatch(raw)
            if dispatch is None or dispatch.host_id != host_id:
                continue
            signal = dispatch.signal
            if not isinstance(signal, dict) or not _metadata_matches(signal, host_id):
                continue
            session_id = _valid_rtc_session_id(signal.get("session_id"))
            if session_id is None:
                continue
            async with sessions_lock:
                _prune_sessions(
                    sessions, retired, time.monotonic(), tombstones_changed
                )
                binding = sessions.get(session_id)
                if binding is None:
                    continue
            if not (
                dispatch.session_connection_id == binding.daemon_connection_id
                and dispatch.session_generation == binding.daemon_generation
                and dispatch.binding_nonce == binding.nonce
                and signal.get("binding_nonce") == binding.nonce
            ):
                continue
            frame_type = signal.get("type")
            if frame_type == "rtc.answer":
                if _valid_rtc_sdp(signal.get("sdp")) is None:
                    continue
            elif frame_type == "rtc.candidate":
                if _valid_rtc_candidate(signal.get("candidate")) is None:
                    continue
            elif frame_type == "rtc.status":
                if signal.get("status") not in HOST_RTC_STATUS_ALLOWLIST:
                    continue
            else:
                continue
            dispatch_is_session_owner = (
                dispatch.dispatch_connection_id == binding.daemon_connection_id
                and dispatch.dispatch_generation == binding.daemon_generation
            )
            if not dispatch_is_session_owner:
                if (
                    frame_type != "rtc.status"
                    or signal.get("status") != "unavailable"
                    or dispatch.dispatch_generation <= binding.daemon_generation
                ):
                    continue
            status_value = signal.get("status") if frame_type == "rtc.status" else None
            await _forward_if_exact_binding(
                conn,
                signal,
                binding,
                sessions,
                retired,
                sessions_lock,
                tombstones_changed,
                connected=dispatch_is_session_owner and status_value == "connected",
                retire=(
                    not dispatch_is_session_owner
                    or status_value in {"failed", "unavailable"}
                ),
            )


async def _publish_signal(
    host_id: str,
    response_channel: str,
    binding: BrowserRtcSession,
    signal: dict[str, object],
) -> bool:
    return await get_backend().publish_if_host_owner(
        host_presence_key(host_id),
        host_pending_presence_key(host_id),
        encode_host_presence_owner(
            HostPresenceOwner(
                binding.daemon_connection_id,
                binding.daemon_generation,
            )
        ),
        generation=binding.daemon_generation,
        channel=host_signal_channel(host_id),
        payload=encode_host_signal(
            HostSignalEnvelope(
                daemon_connection_id=binding.daemon_connection_id,
                daemon_generation=binding.daemon_generation,
                browser_channel=response_channel,
                signal=signal,
            )
        ),
    )


@router.websocket("/ws/host")
async def host_ws(
    websocket: WebSocket,
    host_id: str = Query(...),
    token: str | None = Query(default=None),
) -> None:
    await websocket.accept(subprotocol=HOST_WS_SUBPROTOCOL)
    user = await _resolve_user(websocket, token)
    if user is None:
        return

    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        if host is None or host.owner_user_id != user.id:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="host not found")
            return

    conn = HostBrowserConn(user_id=user.id, host_id=host_id, websocket=websocket)
    response_channel = browser_signal_channel(conn.id)
    sessions: dict[str, BrowserRtcSession] = {}
    retired: dict[tuple[str, str, int, str], float] = {}
    sessions_lock = asyncio.Lock()
    tombstones_changed = asyncio.Event()
    pump_ready = asyncio.Event()

    ice_servers = ice_servers_for_session(get_settings(), label=user.id)
    transport_policy = "relay" if _is_turn_only(ice_servers) else "all"

    pump_task = asyncio.create_task(
        _pump_browser_signals(
            conn,
            host_id,
            response_channel,
            sessions,
            retired,
            sessions_lock,
            tombstones_changed,
            pump_ready,
        )
    )
    tombstone_cleanup_task = asyncio.create_task(
        _cleanup_retired_bindings(
            sessions,
            retired,
            sessions_lock,
            tombstones_changed,
        )
    )

    try:
        await wait_for_signal_pump(pump_task, pump_ready)
        await conn.send_text(
            {
                "type": "rtc.config",
                "enabled": get_settings().webrtc_enabled,
                "ice_servers": ice_servers,
                "ice_transport_policy": transport_policy,
                "scope_type": "host",
                "scope_id": host_id,
                "protocol": HOST_CONTROL_PROTOCOL,
                "protocol_version": HOST_CONTROL_VERSION,
            }
        )
        while True:
            message = await receive_with_signal_pump(websocket, pump_task)
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                await websocket.close(
                    code=WS_CLOSE_BINARY,
                    reason="binary frames are not allowed on the signaling websocket",
                )
                break
            raw = message.get("text")
            if raw is None:
                continue
            if len(raw.encode("utf-8")) > MAX_SIGNAL_FRAME_BYTES:
                await websocket.close(code=1009, reason="signaling frame too large")
                break
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict) or not _metadata_matches(obj, host_id):
                continue

            frame_type = obj.get("type")
            session_id = _valid_rtc_session_id(obj.get("session_id"))
            if session_id is None:
                continue

            if frame_type == "rtc.offer":
                if not get_settings().webrtc_enabled:
                    await _send_status(conn, host_id, session_id, "failed")
                    continue
                sdp = _valid_rtc_sdp(obj.get("sdp"))
                if sdp is None:
                    continue
                daemon_owner = decode_host_presence_owner(
                    await get_backend().get_ephemeral(host_presence_key(host_id))
                )
                if daemon_owner is None:
                    await _send_status(conn, host_id, session_id, "unavailable")
                    continue
                daemon_connection_id = daemon_owner.daemon_connection_id
                now = time.monotonic()
                async with sessions_lock:
                    _prune_sessions(sessions, retired, now, tombstones_changed)
                    if (
                        session_id in sessions
                        or len(sessions) >= MAX_HOST_RTC_SESSIONS_PER_BROWSER
                        or not _rtc_binding_capacity_available(sessions, retired)
                    ):
                        binding = None
                    else:
                        binding = BrowserRtcSession(
                            session_id=session_id,
                            daemon_connection_id=daemon_connection_id,
                            daemon_generation=daemon_owner.generation,
                            nonce=new_rtc_binding_nonce(),
                            expires_at=now + HOST_RTC_SESSION_TTL_SECONDS,
                        )
                        sessions[session_id] = binding
                if binding is None:
                    await _send_status(conn, host_id, session_id, "failed")
                    continue
                if not await _binding_is_current_owner(host_id, binding):
                    await _retire_if_exact_binding(
                        binding,
                        sessions,
                        retired,
                        sessions_lock,
                        tombstones_changed,
                    )
                    await _send_status(conn, host_id, session_id, "unavailable")
                    continue
                published = await _publish_signal(
                    host_id,
                    response_channel,
                    binding,
                    _signal_payload(
                        "rtc.offer",
                        session_id,
                        host_id,
                        binding_nonce=binding.nonce,
                        sdp=sdp,
                        ice_servers=ice_servers,
                        ice_transport_policy=transport_policy,
                    ),
                )
                if not published:
                    await _retire_if_exact_binding(
                        binding,
                        sessions,
                        retired,
                        sessions_lock,
                        tombstones_changed,
                    )
                    await _send_status(conn, host_id, session_id, "unavailable")

            elif frame_type == "rtc.candidate":
                candidate = _valid_rtc_candidate(obj.get("candidate"))
                async with sessions_lock:
                    _prune_sessions(
                        sessions, retired, time.monotonic(), tombstones_changed
                    )
                    binding = sessions.get(session_id)
                if candidate is None or binding is None:
                    continue
                if not await _binding_is_current_owner(host_id, binding):
                    await _retire_if_exact_binding(
                        binding,
                        sessions,
                        retired,
                        sessions_lock,
                        tombstones_changed,
                    )
                    await _send_status(conn, host_id, session_id, "unavailable")
                    continue
                published = await _publish_signal(
                    host_id,
                    response_channel,
                    binding,
                    _signal_payload(
                        "rtc.candidate",
                        session_id,
                        host_id,
                        binding_nonce=binding.nonce,
                        candidate=candidate,
                    ),
                )
                if not published:
                    await _retire_if_exact_binding(
                        binding,
                        sessions,
                        retired,
                        sessions_lock,
                        tombstones_changed,
                    )
                    await _send_status(conn, host_id, session_id, "unavailable")

            elif frame_type == "rtc.close":
                async with sessions_lock:
                    binding = sessions.get(session_id)
                    if binding is not None and _retire_binding(
                            retired,
                            binding,
                            time.monotonic(),
                            tombstones_changed,
                        ):
                        sessions.pop(session_id, None)
                if binding is not None and await _binding_is_current_owner(host_id, binding):
                    await _publish_signal(
                        host_id,
                        response_channel,
                        binding,
                        _signal_payload(
                            "rtc.close",
                            session_id,
                            host_id,
                            binding_nonce=binding.nonce,
                        ),
                    )
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        log.exception("host signaling websocket crashed: %s", exc)
    finally:
        async with sessions_lock:
            remaining = list(sessions.values())
            sessions.clear()
            now = time.monotonic()
            for binding in remaining:
                _retire_binding(retired, binding, now, tombstones_changed)
        for binding in remaining:
            try:
                if not await _binding_is_current_owner(host_id, binding):
                    continue
                await _publish_signal(
                    host_id,
                    response_channel,
                    binding,
                    _signal_payload(
                        "rtc.close",
                        binding.session_id,
                        host_id,
                        binding_nonce=binding.nonce,
                    ),
                )
            except Exception:
                pass
        pump_task.cancel()
        try:
            await pump_task
        except (asyncio.CancelledError, Exception):
            pass
        tombstone_cleanup_task.cancel()
        try:
            await tombstone_cleanup_task
        except (asyncio.CancelledError, Exception):
            pass
