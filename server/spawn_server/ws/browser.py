"""`/ws/browser?session_id=<uuid>` endpoint."""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from .. import auth as auth_mod
from ..config import get_settings
from ..db import get_sessionmaker
from ..models import Session, User
from ..redis import get_backend, session_event_channel
from ..turn import ice_servers_for_session
from .broker import BrowserConn, RtcSessionBinding, get_broker
from .host_signal import (
    HOST_RTC_SESSION_TTL_SECONDS,
    HostPresenceOwner,
    HostSignalEnvelope,
    RedisBrowserConn,
    browser_signal_channel,
    decode_rtc_signal_dispatch,
    encode_host_presence_owner,
    encode_host_signal,
    host_pending_presence_key,
    host_presence_key,
    host_signal_channel,
    valid_rtc_binding_nonce,
)
from .signed_signal_relay import (
    MAX_RTC_ROUTING_FRAME_BYTES,
    SIGNED_ENVELOPE_FIELD,
    SignedRtcRelayError,
    reject_raw_sdp_in_signed_mode,
    signed_mode_selected,
    validate_signed_rtc_relay_envelope,
)

router = APIRouter()
log = logging.getLogger("spawn.ws.browser")
SESSION_RTC_PROTOCOL = "spawn.pty"
SESSION_RTC_PROTOCOL_VERSION = 2
BROWSER_WS_PROTOCOL = "spawn.v3"
WS_CLOSE_PROTOCOL_REQUIRED = 4003
WS_CLOSE_CONTENT_FORBIDDEN = 4002


def _rtc_config_payload(user_id: str, *, binding_nonce_required: bool = False) -> dict[str, object]:
    settings = get_settings()
    return {
        "type": "rtc.config",
        "enabled": settings.webrtc_enabled,
        "ice_servers": ice_servers_for_session(settings, label=user_id),
        "binding_nonce_required": binding_nonce_required,
    }


def _valid_rtc_session_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 128:
        return None
    return value


def _valid_rtc_sdp(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    if not value or len(value) > 1024 * 1024:
        return None
    return value


def _valid_rtc_candidate(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    candidate = value.get("candidate")
    if not isinstance(candidate, str) or len(candidate) > 64 * 1024:
        return None
    return dict(value)


def _valid_browser_session_rtc_tuple(obj: dict, session_id: str) -> bool:
    """Require the browser to bind every signal to the exact direct-PTY tuple."""
    return (
        obj.get("scope_type") == "session"
        and obj.get("scope_id") == session_id
        and obj.get("protocol") == SESSION_RTC_PROTOCOL
        and obj.get("protocol_version") == SESSION_RTC_PROTOCOL_VERSION
    )


async def _publish_session_rtc_signal(
    host_id: str,
    binding: RtcSessionBinding,
    response_channel: str,
    signal: dict[str, object],
) -> bool:
    generation = binding.daemon.host_generation
    if generation is None:
        return False
    owner = HostPresenceOwner(binding.daemon.id, generation)
    return await get_backend().publish_if_host_owner(
        host_presence_key(host_id),
        host_pending_presence_key(host_id),
        encode_host_presence_owner(owner),
        generation=generation,
        channel=host_signal_channel(host_id),
        payload=encode_host_signal(
            HostSignalEnvelope(
                daemon_connection_id=binding.daemon.id,
                daemon_generation=generation,
                browser_channel=response_channel,
                signal=signal,
            )
        ),
    )


async def _resolve_user(websocket: WebSocket, query_token: str | None) -> User | None:
    raw: str | None = None
    auth_h = websocket.headers.get("authorization")
    if auth_h:
        parts = auth_h.split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "bearer":
            raw = parts[1].strip()
    if raw is None:
        raw = websocket.cookies.get("spawn_session")
    if raw is None and query_token:
        raw = query_token
    if raw is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="not authenticated")
        return None
    try:
        payload = auth_mod.decode_token(raw)
    except Exception:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad token")
        return None
    if payload.get("kind") != auth_mod.KIND_ACCESS:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="wrong token kind")
        return None
    sub = payload.get("sub", "")
    if not sub.startswith("user:"):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad subject")
        return None
    user_id = sub.split(":", 1)[1]
    sm = get_sessionmaker()
    async with sm() as session:
        user = await session.get(User, user_id)
    if user is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="user gone")
        return None
    return user


@router.websocket("/ws/browser")
async def browser_ws(
    websocket: WebSocket,
    pty_session_id: str = Query(..., alias="session_id"),
    token: str | None = Query(default=None),
) -> None:
    offered = websocket.scope.get("subprotocols") or []
    if BROWSER_WS_PROTOCOL not in offered:
        await websocket.accept()
        await websocket.send_json(
            {"type": "protocol.required", "protocol": BROWSER_WS_PROTOCOL, "version": 3}
        )
        await websocket.close(code=WS_CLOSE_PROTOCOL_REQUIRED, reason="protocol upgrade required")
        return
    await websocket.accept(subprotocol=BROWSER_WS_PROTOCOL)
    user = await _resolve_user(websocket, token)
    if user is None:
        return

    sm = get_sessionmaker()
    async with sm() as session:
        session_row = await session.get(Session, pty_session_id)
        if session_row is None or session_row.owner_user_id != user.id:
            await websocket.close(
                code=status.WS_1008_POLICY_VIOLATION, reason="session not found"
            )
            return
        host_id = session_row.host_id
        session_status = session_row.status

    broker = get_broker()
    conn = BrowserConn(user_id=user.id, session_id=pty_session_id, websocket=websocket)
    log.info("browser signaling attached session=%s user=%s", pty_session_id, user.id)

    # Only content-free signaling/lifecycle metadata is sent on this socket.
    try:
        await conn.send_text(_rtc_config_payload(user.id, binding_nonce_required=True))
        await conn.send_text({"type": "session.status", "status": session_status})
    except Exception as e:
        log.warning("initial signaling state send failed: %s", e)

    # Redis remains only for cross-worker lifecycle and RTC signaling events.
    event_ready = asyncio.Event()
    rtc_ready = asyncio.Event()
    rtc_response_channel = browser_signal_channel(conn.id)
    rtc_routes: dict[str, RedisBrowserConn] = {}

    async def _pump_events() -> None:
        try:
            async with get_backend().subscribe_channel(
                session_event_channel(pty_session_id)
            ) as stream:
                event_ready.set()
                async for raw_event in stream:
                    try:
                        event = json.loads(raw_event)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    if not isinstance(event, dict) or event.get("type") not in {
                        "session.status",
                        "session.exit",
                    }:
                        continue
                    try:
                        await conn.send_text(event)
                    except Exception as e:
                        log.warning("session event forward to browser failed: %s", e)
                        return
        except Exception as e:  # noqa: BLE001
            log.warning("session event subscribe loop crashed: %s", e)
        finally:
            event_ready.set()

    async def _pump_rtc_signals() -> None:
        try:
            async with get_backend().subscribe_channel(rtc_response_channel) as stream:
                rtc_ready.set()
                async for raw_signal in stream:
                    dispatch = decode_rtc_signal_dispatch(raw_signal)
                    if dispatch is None or dispatch.host_id != host_id:
                        continue
                    signal = dispatch.signal
                    if (
                        not isinstance(signal, dict)
                        or signal.get("scope_type") != "session"
                        or signal.get("scope_id") != pty_session_id
                    ):
                        continue
                    session_id = _valid_rtc_session_id(signal.get("session_id"))
                    if session_id is None:
                        continue
                    route = rtc_routes.get(session_id)
                    binding = await broker.rtc_session_for(session_id)
                    if route is None or binding is None or binding.browser is not route:
                        continue
                    if not (
                        dispatch.session_connection_id == route.daemon_connection_id
                        and dispatch.session_generation == route.daemon_generation
                        and dispatch.binding_nonce == route.binding_nonce
                        and signal.get("binding_nonce") == binding.nonce
                        and signal.get("binding_generation") == binding.daemon_generation
                    ):
                        continue
                    dispatch_is_session_owner = (
                        dispatch.dispatch_connection_id == route.daemon_connection_id
                        and dispatch.dispatch_generation == route.daemon_generation
                    )
                    frame_type = signal.get("type")
                    if frame_type == "rtc.answer":
                        if not dispatch_is_session_owner:
                            continue
                        try:
                            if binding.signed_signal:
                                if not signed_mode_selected(signal):
                                    continue
                                reject_raw_sdp_in_signed_mode(signal)
                                validate_signed_rtc_relay_envelope(
                                    signal[SIGNED_ENVELOPE_FIELD],
                                    expected_type="rtc.answer",
                                    expected_session_id=binding.session_id,
                                    expected_scope_type=binding.scope_type,
                                    expected_scope_id=binding.scope_id,
                                    expected_protocol=binding.protocol,
                                    expected_protocol_version=binding.protocol_version,
                                )
                            elif signed_mode_selected(signal) or _valid_rtc_sdp(
                                signal.get("sdp")
                            ) is None:
                                continue
                        except SignedRtcRelayError:
                            continue
                    elif frame_type == "rtc.candidate":
                        if (
                            not dispatch_is_session_owner
                            or _valid_rtc_candidate(signal.get("candidate")) is None
                        ):
                            continue
                    elif frame_type == "rtc.status":
                        status_value = signal.get("status")
                        if not isinstance(status_value, str) or len(status_value) > 64:
                            continue
                        if not dispatch_is_session_owner:
                            if (
                                status_value != "unavailable"
                                or dispatch.dispatch_generation <= route.daemon_generation
                            ):
                                continue
                            await broker.unregister_rtc_session(session_id, route)
                            rtc_routes.pop(session_id, None)
                        elif status_value == "connected":
                            connected = await broker.mark_rtc_session_connected(
                                session_id, binding
                            )
                            if connected is None:
                                continue
                            binding = connected
                        elif status_value in {"failed", "unavailable"}:
                            await broker.unregister_rtc_session(session_id, route)
                            rtc_routes.pop(session_id, None)
                    else:
                        continue
                    terminal_status = frame_type == "rtc.status" and signal.get("status") in {
                        "failed",
                        "unavailable",
                    }
                    if not terminal_status and not (
                        await broker.rtc_session_is_current(binding)
                    ):
                        continue
                    await conn.send_text(signal)
        except Exception as e:  # noqa: BLE001
            log.warning("RTC signal subscribe loop crashed: %s", e)
        finally:
            rtc_ready.set()

    event_task = asyncio.create_task(_pump_events())
    rtc_task = asyncio.create_task(_pump_rtc_signals())
    try:
        await asyncio.gather(
            asyncio.wait_for(event_ready.wait(), timeout=1.0),
            asyncio.wait_for(rtc_ready.wait(), timeout=1.0),
        )
    except TimeoutError:
        pass

    try:
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                break
            data_text = msg.get("text")
            data_bytes = msg.get("bytes")

            if data_bytes is not None:
                log.warning("content-bearing binary frame on signaling socket; closing")
                await websocket.close(
                    code=WS_CLOSE_CONTENT_FORBIDDEN,
                    reason="terminal bytes require spawn.pty",
                )
                break

            elif data_text is not None:
                if len(data_text.encode("utf-8")) > MAX_RTC_ROUTING_FRAME_BYTES:
                    await websocket.close(code=1009, reason="signaling frame too large")
                    break
                try:
                    obj = json.loads(data_text)
                except json.JSONDecodeError:
                    continue
                ftype = obj.get("type")
                if ftype in {
                    "resize",
                    "take_control",
                    "scroll",
                    "redraw",
                    "snapshot",
                }:
                    log.warning(
                        "server-visible terminal control on signaling socket; closing",
                    )
                    await websocket.close(
                        code=WS_CLOSE_CONTENT_FORBIDDEN,
                        reason="terminal control belongs on spawn.ctl",
                    )
                    break
                if ftype == "upload":
                    log.warning("retired server-visible agent upload frame; closing")
                    await websocket.close(
                        code=WS_CLOSE_CONTENT_FORBIDDEN,
                        reason="agent uploads belong on spawn.ctl",
                    )
                    break
                elif ftype == "rtc.offer":
                    proposed_nonce = obj.get("binding_nonce")
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    if (
                        session_id is None
                        or not valid_rtc_binding_nonce(proposed_nonce)
                        or not _valid_browser_session_rtc_tuple(obj, pty_session_id)
                    ):
                        continue
                    signed_signal = signed_mode_selected(obj)
                    try:
                        if signed_signal:
                            reject_raw_sdp_in_signed_mode(obj)
                            signed_envelope = validate_signed_rtc_relay_envelope(
                                obj[SIGNED_ENVELOPE_FIELD],
                                expected_type="rtc.offer",
                                expected_session_id=session_id,
                                expected_scope_type="session",
                                expected_scope_id=pty_session_id,
                                expected_protocol=SESSION_RTC_PROTOCOL,
                                expected_protocol_version=SESSION_RTC_PROTOCOL_VERSION,
                            ).wire
                            sdp = None
                        else:
                            signed_envelope = None
                            sdp = _valid_rtc_sdp(obj.get("sdp"))
                            if sdp is None:
                                continue
                    except SignedRtcRelayError:
                        # Presence selects signed mode; malformed/missing signed
                        # data never falls through to the legacy raw-SDP path.
                        continue
                    if not get_settings().webrtc_enabled:
                        disabled: dict[str, object] = {
                            "type": "rtc.status",
                            "session_id": session_id,
                            "binding_nonce": proposed_nonce,
                            "scope_type": "session",
                            "scope_id": pty_session_id,
                            "protocol": SESSION_RTC_PROTOCOL,
                            "protocol_version": SESSION_RTC_PROTOCOL_VERSION,
                            "status": "disabled",
                            "message": "WebRTC direct terminal transport is disabled.",
                        }
                        await conn.send_text(disabled)
                        continue
                    daemon = broker.get_daemon_for_session(pty_session_id) or broker.get_daemon_for_host(
                        host_id
                    )
                    if daemon is None:
                        unavailable: dict[str, object] = {
                            "type": "rtc.status",
                            "session_id": session_id,
                            "status": "unavailable",
                            "message": "No daemon is connected.",
                        }
                        if valid_rtc_binding_nonce(proposed_nonce):
                            unavailable["binding_nonce"] = proposed_nonce
                        await conn.send_text(unavailable)
                        continue
                    generation = daemon.host_generation
                    if generation is None:
                        unavailable = {
                            "type": "rtc.status",
                            "session_id": session_id,
                            "status": "unavailable",
                            "message": "No accepted daemon generation is connected.",
                        }
                        if valid_rtc_binding_nonce(proposed_nonce):
                            unavailable["binding_nonce"] = proposed_nonce
                        await conn.send_text(unavailable)
                        continue
                    binding_nonce = proposed_nonce
                    route = RedisBrowserConn(
                        user_id=user.id,
                        host_id=host_id,
                        channel=rtc_response_channel,
                        daemon_connection_id=daemon.id,
                        daemon_generation=generation,
                        binding_nonce=binding_nonce,
                    )
                    registered = await broker.register_rtc_session(
                        session_id,
                        route,
                        daemon=daemon,
                        scope_type="session",
                        scope_id=pty_session_id,
                        protocol=SESSION_RTC_PROTOCOL,
                        protocol_version=SESSION_RTC_PROTOCOL_VERSION,
                        binding_nonce=binding_nonce,
                        signed_signal=signed_signal,
                        ttl_seconds=HOST_RTC_SESSION_TTL_SECONDS,
                    )
                    if not registered:
                        await conn.send_text(
                            {
                                "type": "rtc.status",
                                "session_id": session_id,
                                "binding_nonce": binding_nonce,
                                "binding_generation": generation,
                                "status": "failed",
                                "message": "RTC session id is already in use.",
                            }
                        )
                        continue
                    rtc_routes[session_id] = route
                    binding = await broker.rtc_session_for(session_id, browser=route)
                    if binding is not None:
                        await conn.send_text(
                            {
                                "type": "rtc.status",
                                "session_id": session_id,
                                    "binding_nonce": binding.nonce,
                                "binding_generation": binding.daemon_generation,
                                "scope_type": binding.scope_type,
                                "scope_id": binding.scope_id,
                                "protocol": binding.protocol,
                                "protocol_version": binding.protocol_version,
                                "status": "negotiating",
                            }
                        )
                    offer_payload: dict[str, object] = {
                        "type": "rtc.offer",
                        "session_id": session_id,
                        "binding_nonce": binding.nonce if binding is not None else binding_nonce,
                        "binding_generation": (
                            binding.daemon_generation if binding is not None else generation
                        ),
                        "scope_type": "session",
                        "scope_id": pty_session_id,
                        "protocol": SESSION_RTC_PROTOCOL,
                        "protocol_version": SESSION_RTC_PROTOCOL_VERSION,
                        "ice_servers": ice_servers_for_session(get_settings(), label=user.id),
                    }
                    if signed_signal:
                        assert signed_envelope is not None
                        offer_payload[SIGNED_ENVELOPE_FIELD] = signed_envelope
                    else:
                        assert sdp is not None
                        offer_payload["sdp"] = sdp
                    published = binding is not None and await _publish_session_rtc_signal(
                        host_id,
                        binding,
                        rtc_response_channel,
                        offer_payload,
                    )
                    if not published:
                        await broker.unregister_rtc_session(session_id, route)
                        rtc_routes.pop(session_id, None)
                        await conn.send_text(
                            {
                                "type": "rtc.status",
                                "session_id": session_id,
                                "binding_nonce": binding_nonce,
                                "binding_generation": generation,
                                "status": "unavailable",
                                "message": "WebRTC signaling could not reach the daemon.",
                            }
                        )
                elif ftype == "rtc.candidate":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    candidate = _valid_rtc_candidate(obj.get("candidate"))
                    if (
                        session_id is None
                        or candidate is None
                        or not _valid_browser_session_rtc_tuple(obj, pty_session_id)
                    ):
                        continue
                    route = rtc_routes.get(session_id)
                    binding = await broker.rtc_session_for(session_id)
                    if (
                        route is None
                        or binding is None
                        or binding.browser is not route
                        or binding.scope_type != "session"
                        or binding.scope_id != pty_session_id
                        or binding.protocol != SESSION_RTC_PROTOCOL
                        or binding.protocol_version != SESSION_RTC_PROTOCOL_VERSION
                        or obj.get("binding_nonce") != binding.nonce
                    ):
                        continue
                    await _publish_session_rtc_signal(
                        host_id,
                        binding,
                        rtc_response_channel,
                        {
                            "type": "rtc.candidate",
                            "session_id": session_id,
                            "binding_nonce": binding.nonce,
                            "binding_generation": binding.daemon_generation,
                            "scope_type": binding.scope_type,
                            "scope_id": binding.scope_id,
                            "protocol": binding.protocol,
                            "protocol_version": binding.protocol_version,
                            "candidate": candidate,
                        },
                    )
                elif ftype == "rtc.close":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    if session_id is None or not _valid_browser_session_rtc_tuple(obj, pty_session_id):
                        continue
                    route = rtc_routes.get(session_id)
                    binding = await broker.rtc_session_for(session_id)
                    if route is None or binding is None or binding.browser is not route:
                        continue
                    if (
                        binding.scope_type != "session"
                        or binding.scope_id != pty_session_id
                        or binding.protocol != SESSION_RTC_PROTOCOL
                        or binding.protocol_version != SESSION_RTC_PROTOCOL_VERSION
                        or obj.get("binding_nonce") != binding.nonce
                    ):
                        continue
                    rtc_routes.pop(session_id, None)
                    await broker.unregister_rtc_session(session_id, route)
                    await _publish_session_rtc_signal(
                        host_id,
                        binding,
                        rtc_response_channel,
                        {
                            "type": "rtc.close",
                            "session_id": session_id,
                            "binding_nonce": binding.nonce,
                            "binding_generation": binding.daemon_generation,
                            "scope_type": binding.scope_type,
                            "scope_id": binding.scope_id,
                            "protocol": binding.protocol,
                            "protocol_version": binding.protocol_version,
                        },
                    )
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("browser ws crashed: %s", e)
    finally:
        rtc_task.cancel()
        try:
            await rtc_task
        except (asyncio.CancelledError, Exception):
            pass
        event_task.cancel()
        try:
            await event_task
        except (asyncio.CancelledError, Exception):
            pass
        bindings: list[RtcSessionBinding] = []
        for route in list(rtc_routes.values()):
            bindings.extend(await broker.unregister_rtc_sessions_for(route))
        rtc_routes.clear()
        for binding in bindings:
            await _publish_session_rtc_signal(
                host_id,
                binding,
                rtc_response_channel,
                {
                    "type": "rtc.close",
                    "session_id": binding.session_id,
                    "binding_nonce": binding.nonce,
                    "binding_generation": binding.daemon_generation,
                    "scope_type": binding.scope_type,
                    "scope_id": binding.scope_id,
                    "protocol": binding.protocol,
                    "protocol_version": binding.protocol_version,
                },
            )
        log.info("browser detached session=%s user=%s", pty_session_id, user.id)
