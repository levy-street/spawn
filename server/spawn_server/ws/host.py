"""Host-scoped WebRTC signaling; DataChannel payloads never enter this server."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, replace
from typing import Annotated

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from ..config import get_settings
from ..db import get_sessionmaker
from ..models import Host
from ..redis import get_backend
from ..turn import ice_servers_for_session, ice_transport_policy
from .broker import HostBrowserConn, get_broker
from .browser import (
    _resolve_user,
    _schedule_browser_orphan_expiry,
    _valid_rtc_candidate,
    _valid_rtc_sdp,
    _valid_rtc_session_id,
)
from .close_codes import (
    WS_CLOSE_CONTENT_FORBIDDEN,
    WS_CLOSE_PROTOCOL_REQUIRED,
    WS_CLOSE_SERVER_RESTART,
    WS_CLOSE_SUBSCRIPTION_LOST,
)
from .host_signal import (
    HOST_CONTROL_PROTOCOL,
    HOST_CONTROL_VERSION,
    HOST_RTC_SESSION_TTL_SECONDS,
    HOST_RTC_STATUS_ALLOWLIST,
    MAX_HOST_RTC_SESSIONS_PER_BROWSER,
    RTC_BINDING_TOMBSTONE_TTL_SECONDS,
    RTC_CONNECTED_SESSION_TTL_SECONDS,
    RTC_TERMINAL_STATUSES,
    HostPresenceOwner,
    HostSignalEnvelope,
    RedisBrowserConn,
    SubscriptionLostError,
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
    valid_rtc_binding_nonce,
    wait_for_signal_pump,
)
from .reliability import (
    RTC_CONFIG_REQUEST_MIN_INTERVAL_SECONDS,
    WS_KEEPALIVE_SECONDS,
    ErrorFrameSender,
    FrameRateLimiter,
    rtc_config_refresh_seconds,
)
from .signed_signal_relay import (
    CARRIED_ENDORSEMENTS_FIELD,
    MAX_RTC_ROUTING_FRAME_BYTES,
    SIGNED_ENVELOPE_FIELD,
    SignedRtcRelayError,
    reject_raw_sdp_in_signed_mode,
    sanitize_carried_endorsements,
    signed_mode_selected,
    validate_signed_rtc_relay_envelope,
)

router = APIRouter()
log = logging.getLogger("spawn.ws.host")

HOST_WS_SUBPROTOCOL = "spawn.host.v1"
MAX_SIGNAL_FRAME_BYTES = MAX_RTC_ROUTING_FRAME_BYTES
WS_CLOSE_BINARY = WS_CLOSE_CONTENT_FORBIDDEN
MAX_HOST_RTC_BINDING_IDENTITIES = 256


@dataclass(frozen=True)
class BrowserRtcSession:
    session_id: str
    daemon_connection_id: str
    daemon_generation: int
    nonce: str
    expires_at: float
    signed_signal: bool = False
    active_daemon_connection_id: str | None = None
    active_daemon_generation: int | None = None

    @property
    def active_connection_id(self) -> str:
        return self.active_daemon_connection_id or self.daemon_connection_id

    @property
    def active_generation(self) -> int:
        return self.active_daemon_generation or self.daemon_generation


def _metadata_matches(obj: dict, host_id: str, protocol_version: int = 1) -> bool:
    return (
        obj.get("scope_type") == "host"
        and obj.get("scope_id") == host_id
        and obj.get("protocol") == HOST_CONTROL_PROTOCOL
        and type(obj.get("protocol_version")) is int
        and obj.get("protocol_version") == protocol_version
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
    if identity not in retired and len(retired) >= MAX_HOST_RTC_BINDING_IDENTITIES:
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
    for identity in [identity for identity, expires_at in retired.items() if expires_at <= now]:
        retired.pop(identity, None)


def _rtc_binding_capacity_available(
    sessions: dict[str, BrowserRtcSession],
    retired: dict[tuple[str, str, int, str], float],
) -> bool:
    return len(sessions) + len(retired) < MAX_HOST_RTC_BINDING_IDENTITIES


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
        if sessions.get(binding.session_id) is not binding or _binding_identity(binding) in retired:
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
        if not _retire_binding(retired, binding, time.monotonic(), tombstones_changed):
            return False
        sessions.pop(binding.session_id, None)
        return True


async def _send_status(
    conn: HostBrowserConn,
    host_id: str,
    session_id: str,
    status_value: str,
    **values: object,
) -> None:
    await conn.send_text(
        _signal_payload(
            "rtc.status",
            session_id,
            host_id,
            status=status_value,
            protocol_version=conn.rtc_protocol_version,
            **values,
        )
    )


async def _binding_is_current_owner(host_id: str, binding: BrowserRtcSession) -> bool:
    owner = decode_host_presence_owner(
        await get_backend().get_ephemeral(host_presence_key(host_id))
    )
    if owner is None:
        local = get_broker().get_daemon_for_host(host_id)
        if local is not None and await get_broker().reclaim_daemon_presence_if_missing(local):
            owner = decode_host_presence_owner(
                await get_backend().get_ephemeral(host_presence_key(host_id))
            )
    if owner is None or not (
        owner.daemon_connection_id == binding.active_connection_id
        and owner.generation == binding.active_generation
    ):
        return False
    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        return host is not None and (
            host.daemon_connection_id == binding.active_connection_id
            and host.daemon_generation == binding.active_generation
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
            if not isinstance(signal, dict) or not _metadata_matches(
                signal, host_id, conn.rtc_protocol_version
            ):
                continue
            session_id = _valid_rtc_session_id(signal.get("session_id"))
            if session_id is None:
                continue
            frame_type = signal.get("type")
            retired_expiry = False
            async with sessions_lock:
                _prune_sessions(sessions, retired, time.monotonic(), tombstones_changed)
                binding = sessions.get(session_id)
                if binding is None:
                    identity = (
                        session_id,
                        dispatch.session_connection_id,
                        dispatch.session_generation,
                        dispatch.binding_nonce,
                    )
                    retired_expiry = (
                        frame_type == "rtc.status"
                        and signal.get("status") == "expired"
                        and identity in retired
                        and signal.get("binding_nonce") == dispatch.binding_nonce
                        and signal.get("binding_generation") == dispatch.session_generation
                    )
            if binding is None:
                if retired_expiry:
                    await conn.send_text(signal)
                continue
            if not (
                dispatch.session_connection_id == binding.daemon_connection_id
                and dispatch.session_generation == binding.daemon_generation
                and dispatch.binding_nonce == binding.nonce
                and signal.get("binding_nonce") == binding.nonce
            ):
                continue
            if frame_type == "rtc.answer":
                try:
                    if binding.signed_signal:
                        if not signed_mode_selected(signal):
                            continue
                        reject_raw_sdp_in_signed_mode(signal)
                        validate_signed_rtc_relay_envelope(
                            signal[SIGNED_ENVELOPE_FIELD],
                            expected_type="rtc.answer",
                            expected_session_id=binding.session_id,
                            expected_scope_type="host",
                            expected_scope_id=host_id,
                            expected_protocol=HOST_CONTROL_PROTOCOL,
                            expected_protocol_version=conn.rtc_protocol_version,
                        )
                    elif signed_mode_selected(signal) or _valid_rtc_sdp(signal.get("sdp")) is None:
                        continue
                except SignedRtcRelayError:
                    continue
            elif frame_type == "rtc.candidate":
                if _valid_rtc_candidate(signal.get("candidate")) is None:
                    continue
            elif frame_type == "rtc.status":
                if signal.get("status") not in HOST_RTC_STATUS_ALLOWLIST:
                    continue
            else:
                continue
            dispatch_is_active_owner = (
                dispatch.dispatch_connection_id == binding.active_connection_id
                and dispatch.dispatch_generation == binding.active_generation
            )
            rebound = (
                frame_type == "rtc.status"
                and signal.get("status") == "rebound"
                and dispatch.dispatch_generation > binding.active_generation
            )
            if rebound:
                replacement = replace(
                    binding,
                    active_daemon_connection_id=dispatch.dispatch_connection_id,
                    active_daemon_generation=dispatch.dispatch_generation,
                )
                async with sessions_lock:
                    if sessions.get(session_id) is not binding:
                        continue
                    sessions[session_id] = replacement
                binding = replacement
                dispatch_is_active_owner = True
            if not dispatch_is_active_owner:
                if (
                    frame_type != "rtc.status"
                    or signal.get("status") != "unavailable"
                    or dispatch.dispatch_generation <= binding.active_generation
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
                connected=dispatch_is_active_owner and status_value == "connected",
                retire=(not dispatch_is_active_owner or status_value in RTC_TERMINAL_STATUSES),
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
                binding.active_connection_id,
                binding.active_generation,
            )
        ),
        generation=binding.active_generation,
        channel=host_signal_channel(host_id),
        payload=encode_host_signal(
            HostSignalEnvelope(
                daemon_connection_id=binding.active_connection_id,
                daemon_generation=binding.active_generation,
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
    rtc_version: Annotated[int, Query(ge=1, le=2)] = 1,
) -> None:
    offered = websocket.scope.get("subprotocols") or []
    if HOST_WS_SUBPROTOCOL not in offered:
        await websocket.accept()
        await websocket.send_json(
            {
                "type": "protocol.required",
                "protocol": HOST_WS_SUBPROTOCOL,
                "version": 1,
            }
        )
        await websocket.close(
            code=WS_CLOSE_PROTOCOL_REQUIRED,
            reason="protocol upgrade required",
        )
        return
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

    conn = HostBrowserConn(
        user_id=user.id, host_id=host_id, websocket=websocket, rtc_protocol_version=rtc_version
    )

    def signal_payload(
        kind: str, session_id: str, host_id: str, **values: object
    ) -> dict[str, object]:
        return _signal_payload(kind, session_id, host_id, protocol_version=rtc_version, **values)

    errors = ErrorFrameSender(conn.send_text)
    config_requests = FrameRateLimiter(RTC_CONFIG_REQUEST_MIN_INTERVAL_SECONDS)
    response_channel = browser_signal_channel(conn.id)
    sessions: dict[str, BrowserRtcSession] = {}
    retired: dict[tuple[str, str, int, str], float] = {}
    sessions_lock = asyncio.Lock()
    tombstones_changed = asyncio.Event()
    pump_ready = asyncio.Event()

    # Only the opening greeting. Every offer mints its own below: a daemon holds
    # this socket for days, and a TURN credential minted here dies after its TTL
    # while the socket lives on — which is how hosts ended up presenting
    # credentials that coturn had already expired.
    def rtc_config_payload() -> dict[str, object]:
        ice_servers = ice_servers_for_session(get_settings(), label=user.id)
        return {
            "type": "rtc.config",
            "enabled": get_settings().webrtc_enabled,
            "ice_servers": ice_servers,
            "ice_transport_policy": ice_transport_policy(ice_servers),
            "scope_type": "host",
            "scope_id": host_id,
            "protocol": HOST_CONTROL_PROTOCOL,
            "protocol_version": rtc_version,
        }

    async def keepalive() -> None:
        while True:
            await asyncio.sleep(WS_KEEPALIVE_SECONDS)
            await conn.send_text({"type": "ping", "ts": int(time.time() * 1000)})

    async def refresh_rtc_config() -> None:
        while True:
            await asyncio.sleep(rtc_config_refresh_seconds(get_settings()))
            await conn.send_text(rtc_config_payload())

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
    keepalive_task = asyncio.create_task(keepalive())
    config_task = asyncio.create_task(refresh_rtc_config())

    try:
        try:
            await asyncio.wait_for(wait_for_signal_pump(pump_task, pump_ready), timeout=1.0)
        except (TimeoutError, SubscriptionLostError):
            await websocket.close(code=WS_CLOSE_SUBSCRIPTION_LOST, reason="subscription lost")
            return
        await conn.send_text(rtc_config_payload())
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
                await errors.send("invalid_frame", None)
                continue
            if not isinstance(obj, dict):
                await errors.send("invalid_frame", None)
                continue
            frame_type = obj.get("type")
            if frame_type == "pong":
                continue
            if frame_type == "rtc.config.request":
                if set(obj) != {"type"}:
                    await errors.send("invalid_frame", frame_type)
                elif config_requests.allow():
                    await conn.send_text(rtc_config_payload())
                continue
            if not _metadata_matches(obj, host_id, rtc_version):
                await errors.send("invalid_frame", frame_type)
                continue

            session_id = _valid_rtc_session_id(obj.get("session_id"))
            if session_id is None:
                await errors.send("invalid_frame", frame_type)
                continue

            if frame_type == "rtc.resume":
                binding_nonce = obj.get("binding_nonce")
                binding_generation = obj.get("binding_generation")
                if (
                    not valid_rtc_binding_nonce(binding_nonce)
                    or not isinstance(binding_generation, int)
                    or isinstance(binding_generation, bool)
                    or binding_generation < 1
                ):
                    await errors.send("invalid_frame", frame_type)
                    continue
                broker_binding = await get_broker().rtc_session_for(session_id)
                if broker_binding is None:
                    await _send_status(
                        conn,
                        host_id,
                        session_id,
                        "unavailable",
                        binding_nonce=binding_nonce,
                        binding_generation=binding_generation,
                    )
                    continue
                route = RedisBrowserConn(
                    user_id=user.id,
                    host_id=host_id,
                    channel=response_channel,
                    daemon_connection_id=broker_binding.daemon_connection_id,
                    daemon_generation=broker_binding.daemon_generation,
                    binding_nonce=binding_nonce,
                )
                resumed = await get_broker().resume_rtc_session(
                    session_id,
                    route,
                    binding_nonce=binding_nonce,
                    binding_generation=binding_generation,
                    scope_type="host",
                    scope_id=host_id,
                    protocol=HOST_CONTROL_PROTOCOL,
                    protocol_version=rtc_version,
                )
                if resumed is None:
                    await _send_status(
                        conn,
                        host_id,
                        session_id,
                        "unavailable",
                        binding_nonce=binding_nonce,
                        binding_generation=binding_generation,
                    )
                    continue
                async with sessions_lock:
                    sessions[session_id] = BrowserRtcSession(
                        session_id=session_id,
                        daemon_connection_id=resumed.daemon_connection_id,
                        daemon_generation=resumed.daemon_generation,
                        nonce=resumed.nonce,
                        expires_at=resumed.expires_at,
                        signed_signal=resumed.signed_signal,
                        active_daemon_connection_id=resumed.daemon.id,
                        active_daemon_generation=resumed.daemon.host_generation,
                    )
                await conn.send_text(
                    signal_payload(
                        "rtc.status",
                        session_id,
                        host_id,
                        binding_nonce=resumed.nonce,
                        binding_generation=resumed.daemon_generation,
                        status="resumed",
                    )
                )
            elif frame_type == "rtc.offer":
                if not get_settings().webrtc_enabled:
                    await _send_status(conn, host_id, session_id, "failed")
                    continue
                ice_restart = obj.get("ice_restart") is True
                if "ice_restart" in obj and obj.get("ice_restart") is not True:
                    await errors.send("invalid_frame", frame_type)
                    continue
                signed_signal = signed_mode_selected(obj)
                if rtc_version == 2 and not signed_signal:
                    await errors.send("invalid_frame", frame_type)
                    continue
                try:
                    if signed_signal:
                        reject_raw_sdp_in_signed_mode(obj)
                        signed_envelope = validate_signed_rtc_relay_envelope(
                            obj[SIGNED_ENVELOPE_FIELD],
                            expected_type="rtc.offer",
                            expected_session_id=session_id,
                            expected_scope_type="host",
                            expected_scope_id=host_id,
                            expected_protocol=HOST_CONTROL_PROTOCOL,
                            expected_protocol_version=conn.rtc_protocol_version,
                        ).wire
                        sdp = None
                    else:
                        signed_envelope = None
                        sdp = _valid_rtc_sdp(obj.get("sdp"))
                        if sdp is None:
                            await errors.send("invalid_frame", frame_type)
                            continue
                except SignedRtcRelayError:
                    await errors.send("invalid_frame", frame_type)
                    continue
                daemon_owner = decode_host_presence_owner(
                    await get_backend().get_ephemeral(host_presence_key(host_id))
                )
                if daemon_owner is None:
                    local = get_broker().get_daemon_for_host(host_id)
                    if local is not None:
                        await get_broker().reclaim_daemon_presence_if_missing(local)
                        daemon_owner = decode_host_presence_owner(
                            await get_backend().get_ephemeral(host_presence_key(host_id))
                        )
                if daemon_owner is None:
                    await _send_status(conn, host_id, session_id, "unavailable")
                    continue
                if ice_restart:
                    async with sessions_lock:
                        _prune_sessions(
                            sessions,
                            retired,
                            time.monotonic(),
                            tombstones_changed,
                        )
                        binding = sessions.get(session_id)
                    if not (
                        binding is not None
                        and binding.signed_signal == signed_signal
                        and binding.active_connection_id == daemon_owner.daemon_connection_id
                        and binding.active_generation == daemon_owner.generation
                    ):
                        await _send_status(
                            conn,
                            host_id,
                            session_id,
                            "unavailable",
                            binding_nonce=obj.get("binding_nonce"),
                            binding_generation=obj.get("binding_generation"),
                        )
                        continue
                    offer_ice = ice_servers_for_session(get_settings(), label=user.id)
                    values: dict[str, object] = {
                        "binding_nonce": binding.nonce,
                        "binding_generation": binding.daemon_generation,
                        "ice_restart": True,
                        "ice_servers": offer_ice,
                        "ice_transport_policy": ice_transport_policy(offer_ice),
                    }
                    if signed_signal:
                        assert signed_envelope is not None
                        values[SIGNED_ENVELOPE_FIELD] = signed_envelope
                        carried = sanitize_carried_endorsements(obj.get(CARRIED_ENDORSEMENTS_FIELD))
                        if carried is not None:
                            values[CARRIED_ENDORSEMENTS_FIELD] = carried
                    else:
                        assert sdp is not None
                        values["sdp"] = sdp
                    if not await _publish_signal(
                        host_id,
                        response_channel,
                        binding,
                        signal_payload("rtc.offer", session_id, host_id, **values),
                    ):
                        await _send_status(conn, host_id, session_id, "unavailable")
                    continue
                daemon_connection_id = daemon_owner.daemon_connection_id
                proposed_nonce = obj.get("binding_nonce")
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
                            nonce=(
                                proposed_nonce
                                if valid_rtc_binding_nonce(proposed_nonce)
                                else new_rtc_binding_nonce()
                            ),
                            expires_at=now + HOST_RTC_SESSION_TTL_SECONDS,
                            signed_signal=signed_signal,
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
                offer_ice = ice_servers_for_session(get_settings(), label=user.id)
                values: dict[str, object] = {
                    "binding_nonce": binding.nonce,
                    "binding_generation": binding.daemon_generation,
                    "ice_servers": offer_ice,
                    "ice_transport_policy": ice_transport_policy(offer_ice),
                }
                if signed_signal:
                    assert signed_envelope is not None
                    values[SIGNED_ENVELOPE_FIELD] = signed_envelope
                    # Relay carried endorsement edges opaquely so a daemon that
                    # does not directly pin this browser can admit it via a chain.
                    carried = sanitize_carried_endorsements(obj.get(CARRIED_ENDORSEMENTS_FIELD))
                    if carried is not None:
                        values[CARRIED_ENDORSEMENTS_FIELD] = carried
                else:
                    assert sdp is not None
                    values["sdp"] = sdp
                published = await _publish_signal(
                    host_id,
                    response_channel,
                    binding,
                    signal_payload("rtc.offer", session_id, host_id, **values),
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
                    _prune_sessions(sessions, retired, time.monotonic(), tombstones_changed)
                    binding = sessions.get(session_id)
                if candidate is None or binding is None:
                    await errors.send("invalid_frame", frame_type)
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
                    signal_payload(
                        "rtc.candidate",
                        session_id,
                        host_id,
                        binding_nonce=binding.nonce,
                        binding_generation=binding.daemon_generation,
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
                        signal_payload(
                            "rtc.close",
                            session_id,
                            host_id,
                            binding_nonce=binding.nonce,
                            binding_generation=binding.daemon_generation,
                        ),
                    )
            else:
                await errors.send("unknown_frame", frame_type)
    except SubscriptionLostError:
        await websocket.close(code=WS_CLOSE_SUBSCRIPTION_LOST, reason="subscription lost")
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        await websocket.close(code=WS_CLOSE_SERVER_RESTART, reason="server restart")
        raise
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
                broker_binding = await get_broker().rtc_session_for(binding.session_id)
                if (
                    broker_binding is None
                    or not isinstance(broker_binding.browser, RedisBrowserConn)
                    or broker_binding.browser.channel != response_channel
                ):
                    continue
                orphaned = (
                    await get_broker().orphan_rtc_sessions_for_browser(broker_binding.browser)
                    if broker_binding.daemon.keeps_peers_across_reconnect
                    else []
                )
                if orphaned:
                    for item in orphaned:
                        _schedule_browser_orphan_expiry(host_id, item)
                else:
                    published = await _publish_signal(
                        host_id,
                        response_channel,
                        binding,
                        signal_payload(
                            "rtc.close",
                            binding.session_id,
                            host_id,
                            binding_nonce=binding.nonce,
                        ),
                    )
                    if not published:
                        await get_broker().unregister_rtc_session(
                            broker_binding.session_id,
                            broker_binding.browser,
                        )
            except Exception:
                pass
        for task in (
            pump_task,
            tombstone_cleanup_task,
            keepalive_task,
            config_task,
        ):
            task.cancel()
        await asyncio.gather(
            pump_task,
            tombstone_cleanup_task,
            keepalive_task,
            config_task,
            return_exceptions=True,
        )
