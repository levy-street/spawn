"""Host-scoped WebRTC signaling; DataChannel payloads never enter this server."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass

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
    HostSignalEnvelope,
    browser_signal_channel,
    host_presence_key,
    publish_host_signal,
    receive_with_signal_pump,
    valid_daemon_connection_id,
    wait_for_signal_pump,
)

router = APIRouter()
log = logging.getLogger("spawn.ws.host")

HOST_WS_SUBPROTOCOL = "spawn.host.v1"
MAX_SIGNAL_FRAME_BYTES = 1100 * 1024
WS_CLOSE_BINARY = 4002


@dataclass(frozen=True)
class BrowserRtcSession:
    session_id: str
    daemon_connection_id: str
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


def _signal_payload(kind: str, session_id: str, host_id: str, **values: object) -> dict[str, object]:
    return {
        "type": kind,
        "session_id": session_id,
        "scope_type": "host",
        "scope_id": host_id,
        "protocol": HOST_CONTROL_PROTOCOL,
        "protocol_version": HOST_CONTROL_VERSION,
        **values,
    }


def _prune_sessions(sessions: dict[str, BrowserRtcSession], now: float) -> None:
    for session_id in [
        session_id for session_id, binding in sessions.items() if binding.expires_at <= now
    ]:
        sessions.pop(session_id, None)


async def _send_status(
    conn: HostBrowserConn, host_id: str, session_id: str, status_value: str
) -> None:
    await conn.send_text(_signal_payload("rtc.status", session_id, host_id, status=status_value))


async def _binding_is_current_owner(host_id: str, binding: BrowserRtcSession) -> bool:
    owner = await get_backend().get_ephemeral(host_presence_key(host_id))
    return owner == binding.daemon_connection_id.encode("ascii")


async def _pump_browser_signals(
    conn: HostBrowserConn,
    host_id: str,
    channel: str,
    sessions: dict[str, BrowserRtcSession],
    sessions_lock: asyncio.Lock,
    ready: asyncio.Event,
) -> None:
    async with get_backend().subscribe_channel(channel) as stream:
        ready.set()
        async for raw in stream:
            if not raw or len(raw) > MAX_SIGNAL_FRAME_BYTES:
                continue
            try:
                signal = json.loads(raw)
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(signal, dict) or not _metadata_matches(signal, host_id):
                continue
            session_id = _valid_rtc_session_id(signal.get("session_id"))
            if session_id is None:
                continue
            async with sessions_lock:
                _prune_sessions(sessions, time.monotonic())
                binding = sessions.get(session_id)
                if binding is None:
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
            current_owner = await get_backend().get_ephemeral(host_presence_key(host_id))
            binding_is_current = current_owner == binding.daemon_connection_id.encode("ascii")
            if not binding_is_current:
                if frame_type != "rtc.status" or signal.get("status") != "unavailable":
                    continue
                async with sessions_lock:
                    sessions.pop(session_id, None)
            elif frame_type == "rtc.status" and signal.get("status") == "connected":
                async with sessions_lock:
                    current = sessions.get(session_id)
                    if current is None:
                        continue
                    sessions[session_id] = BrowserRtcSession(
                        session_id=current.session_id,
                        daemon_connection_id=current.daemon_connection_id,
                        expires_at=float("inf"),
                    )
            await conn.send_text(signal)


async def _publish_signal(
    host_id: str,
    response_channel: str,
    binding: BrowserRtcSession,
    signal: dict[str, object],
) -> None:
    await publish_host_signal(
        host_id,
        HostSignalEnvelope(
            daemon_connection_id=binding.daemon_connection_id,
            browser_channel=response_channel,
            signal=signal,
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
    sessions_lock = asyncio.Lock()
    pump_ready = asyncio.Event()
    pump_task = asyncio.create_task(
        _pump_browser_signals(
            conn,
            host_id,
            response_channel,
            sessions,
            sessions_lock,
            pump_ready,
        )
    )

    ice_servers = ice_servers_for_session(get_settings(), label=user.id)
    transport_policy = "relay" if _is_turn_only(ice_servers) else "all"

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
                daemon_id_raw = await get_backend().get_ephemeral(host_presence_key(host_id))
                if daemon_id_raw is None:
                    await _send_status(conn, host_id, session_id, "unavailable")
                    continue
                try:
                    daemon_connection_id = daemon_id_raw.decode("ascii")
                except UnicodeDecodeError:
                    await _send_status(conn, host_id, session_id, "unavailable")
                    continue
                if not valid_daemon_connection_id(daemon_connection_id):
                    await _send_status(conn, host_id, session_id, "unavailable")
                    continue
                now = time.monotonic()
                async with sessions_lock:
                    _prune_sessions(sessions, now)
                    if (
                        session_id in sessions
                        or len(sessions) >= MAX_HOST_RTC_SESSIONS_PER_BROWSER
                    ):
                        binding = None
                    else:
                        binding = BrowserRtcSession(
                            session_id=session_id,
                            daemon_connection_id=daemon_connection_id,
                            expires_at=now + HOST_RTC_SESSION_TTL_SECONDS,
                        )
                        sessions[session_id] = binding
                if binding is None:
                    await _send_status(conn, host_id, session_id, "failed")
                    continue
                if not await _binding_is_current_owner(host_id, binding):
                    async with sessions_lock:
                        sessions.pop(session_id, None)
                    await _send_status(conn, host_id, session_id, "unavailable")
                    continue
                await _publish_signal(
                    host_id,
                    response_channel,
                    binding,
                    _signal_payload(
                        "rtc.offer",
                        session_id,
                        host_id,
                        sdp=sdp,
                        ice_servers=ice_servers,
                        ice_transport_policy=transport_policy,
                    ),
                )

            elif frame_type == "rtc.candidate":
                candidate = _valid_rtc_candidate(obj.get("candidate"))
                async with sessions_lock:
                    _prune_sessions(sessions, time.monotonic())
                    binding = sessions.get(session_id)
                if candidate is None or binding is None:
                    continue
                if not await _binding_is_current_owner(host_id, binding):
                    async with sessions_lock:
                        sessions.pop(session_id, None)
                    await _send_status(conn, host_id, session_id, "unavailable")
                    continue
                await _publish_signal(
                    host_id,
                    response_channel,
                    binding,
                    _signal_payload(
                        "rtc.candidate", session_id, host_id, candidate=candidate
                    ),
                )

            elif frame_type == "rtc.close":
                async with sessions_lock:
                    binding = sessions.pop(session_id, None)
                if binding is not None and await _binding_is_current_owner(host_id, binding):
                    await _publish_signal(
                        host_id,
                        response_channel,
                        binding,
                        _signal_payload("rtc.close", session_id, host_id),
                    )
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        log.exception("host signaling websocket crashed: %s", exc)
    finally:
        async with sessions_lock:
            remaining = list(sessions.values())
            sessions.clear()
        for binding in remaining:
            try:
                if not await _binding_is_current_owner(host_id, binding):
                    continue
                await _publish_signal(
                    host_id,
                    response_channel,
                    binding,
                    _signal_payload("rtc.close", binding.session_id, host_id),
                )
            except Exception:
                pass
        pump_task.cancel()
        try:
            await pump_task
        except (asyncio.CancelledError, Exception):
            pass
