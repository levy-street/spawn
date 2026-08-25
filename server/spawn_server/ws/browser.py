"""`/ws/browser?session_id=<uuid>` endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from .. import auth as auth_mod
from ..config import get_settings
from ..db import get_sessionmaker
from ..models import Session, User
from ..redis import get_backend, session_event_channel
from ..turn import ice_servers_for_session, ice_transport_policy
from .broker import BrowserConn, RtcSessionBinding, get_broker
from .close_codes import (
    WS_CLOSE_CONTENT_FORBIDDEN,
    WS_CLOSE_PROTOCOL_REQUIRED,
    WS_CLOSE_SERVER_RESTART,
    WS_CLOSE_SUBSCRIPTION_LOST,
)
from .host_signal import (
    HOST_RTC_SESSION_TTL_SECONDS,
    HostPresenceOwner,
    HostSignalEnvelope,
    RedisBrowserConn,
    SubscriptionLostError,
    browser_signal_channel,
    decode_rtc_signal_dispatch,
    encode_host_presence_owner,
    encode_host_signal,
    host_pending_presence_key,
    host_presence_key,
    host_signal_channel,
    receive_with_signal_pumps,
    valid_rtc_binding_nonce,
)
from .reliability import (
    RTC_CONFIG_REQUEST_MIN_INTERVAL_SECONDS,
    WS_KEEPALIVE_SECONDS,
    ErrorFrameSender,
    FrameRateLimiter,
    rtc_config_refresh_seconds,
    warn_query_token_once,
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
log = logging.getLogger("spawn.ws.browser")
SESSION_RTC_PROTOCOL = "spawn.pty"
SESSION_RTC_PROTOCOL_VERSION = 2
BROWSER_WS_PROTOCOL = "spawn.v3"


def _rtc_config_payload(user_id: str, *, binding_nonce_required: bool = False) -> dict[str, object]:
    settings = get_settings()
    ice_servers = ice_servers_for_session(settings, label=user_id)
    return {
        "type": "rtc.config",
        "enabled": settings.webrtc_enabled,
        "ice_servers": ice_servers,
        # The terminal is the channel that matters most on a hostile network,
        # and it was the one channel never told whether a direct path exists.
        "ice_transport_policy": ice_transport_policy(ice_servers),
        "binding_nonce_required": binding_nonce_required,
    }


def _offer_ice(user_id: str, daemon: object | None = None) -> dict[str, object]:
    """Freshly minted ICE for one session offer.

    Deliberately *without* `ice_transport_policy`. On the wire to a daemon that
    field is not a setting, it is the discriminator that tells a session offer
    from a host one: `daemon/src/run.rs` runs the session path only when the
    field is absent (`ice_transport_policy.is_none()`). Adding it here would
    make every already-deployed daemon silently drop every terminal offer.

    The client learns the policy from `rtc.config` on its own socket instead.
    A daemon that advertises `session_ice_policy` opts into receiving the same
    policy on offers; capability absence keeps the legacy wire shape exact.
    """
    ice_servers = ice_servers_for_session(get_settings(), label=user_id)
    payload: dict[str, object] = {"ice_servers": ice_servers}
    if getattr(daemon, "session_ice_policy", False) is True:
        payload["ice_transport_policy"] = ice_transport_policy(ice_servers)
    return payload


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
    if not isinstance(candidate, str) or len(candidate) > 1024:
        return None
    sanitized: dict[str, object] = {"candidate": candidate}
    optional_strings = {"sdpMid": 64, "usernameFragment": 256}
    for field, limit in optional_strings.items():
        item = value.get(field)
        if field in value:
            if not isinstance(item, str) or len(item) > limit:
                return None
            sanitized[field] = item
    if "sdpMLineIndex" in value:
        line_index = value.get("sdpMLineIndex")
        if (
            not isinstance(line_index, int)
            or isinstance(line_index, bool)
            or not 0 <= line_index <= 65535
        ):
            return None
        sanitized["sdpMLineIndex"] = line_index
    return sanitized


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


_orphan_expiry_tasks: set[asyncio.Task[None]] = set()


def _binding_frame(
    binding: RtcSessionBinding,
    frame_type: str,
    **values: object,
) -> dict[str, object]:
    return {
        "type": frame_type,
        "session_id": binding.session_id,
        "binding_nonce": binding.nonce,
        "binding_generation": binding.daemon_generation,
        "scope_type": binding.scope_type,
        "scope_id": binding.scope_id,
        "protocol": binding.protocol,
        "protocol_version": binding.protocol_version,
        **values,
    }


def _schedule_browser_orphan_expiry(host_id: str, binding: RtcSessionBinding) -> None:
    async def expire() -> None:
        deadline = binding.browser_orphaned_until
        if deadline is None:
            return
        await asyncio.sleep(max(0.0, deadline - time.monotonic()))
        expired = await get_broker().expire_rtc_orphan(
            binding.session_id,
            binding.nonce,
            binding.daemon_generation,
            side="browser",
        )
        if expired is None or not isinstance(expired.browser, RedisBrowserConn):
            return
        await _publish_session_rtc_signal(
            host_id,
            expired,
            expired.browser.channel,
            _binding_frame(expired, "rtc.close"),
        )

    task = asyncio.create_task(expire())
    _orphan_expiry_tasks.add(task)
    task.add_done_callback(_orphan_expiry_tasks.discard)


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
        warn_query_token_once(log)
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
    if int(payload.get("epoch", 0) or 0) != int(user.session_epoch or 0):
        await websocket.close(
            code=status.WS_1008_POLICY_VIOLATION,
            reason="not authenticated",
        )
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
    errors = ErrorFrameSender(conn.send_text)
    config_requests = FrameRateLimiter(RTC_CONFIG_REQUEST_MIN_INTERVAL_SECONDS)
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

    async def _keepalive() -> None:
        while True:
            await asyncio.sleep(WS_KEEPALIVE_SECONDS)
            await conn.send_text({"type": "ping", "ts": int(time.time() * 1000)})

    async def _refresh_rtc_config() -> None:
        while True:
            await asyncio.sleep(rtc_config_refresh_seconds(get_settings()))
            await conn.send_text(_rtc_config_payload(user.id, binding_nonce_required=True))

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
                    if route is None:
                        continue
                    if binding is None:
                        if (
                            signal.get("type") == "rtc.status"
                            and signal.get("status") in {"unavailable", "expired"}
                            and dispatch.session_connection_id == route.daemon_connection_id
                            and dispatch.session_generation == route.daemon_generation
                            and dispatch.binding_nonce == route.binding_nonce
                            and signal.get("binding_nonce") == route.binding_nonce
                            and signal.get("binding_generation") == route.daemon_generation
                        ):
                            rtc_routes.pop(session_id, None)
                            await conn.send_text(signal)
                        continue
                    if binding.browser is not route:
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
                        binding.daemon.host_generation is not None
                        and dispatch.dispatch_connection_id == binding.daemon.id
                        and dispatch.dispatch_generation == binding.daemon.host_generation
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
                            elif (
                                signed_mode_selected(signal)
                                or _valid_rtc_sdp(signal.get("sdp")) is None
                            ):
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
                            connected = await broker.mark_rtc_session_connected(session_id, binding)
                            if connected is None:
                                continue
                            binding = connected
                        elif status_value in {"failed", "unavailable", "expired"}:
                            await broker.unregister_rtc_session(session_id, route)
                            rtc_routes.pop(session_id, None)
                    else:
                        continue
                    terminal_status = frame_type == "rtc.status" and signal.get("status") in {
                        "failed",
                        "unavailable",
                        "expired",
                    }
                    if not terminal_status and not (await broker.rtc_session_is_current(binding)):
                        continue
                    await conn.send_text(signal)
        except Exception as e:  # noqa: BLE001
            log.warning("RTC signal subscribe loop crashed: %s", e)
        finally:
            rtc_ready.set()

    event_task = asyncio.create_task(_pump_events())
    rtc_task = asyncio.create_task(_pump_rtc_signals())
    keepalive_task = asyncio.create_task(_keepalive())
    config_task = asyncio.create_task(_refresh_rtc_config())

    try:
        try:
            await asyncio.gather(
                asyncio.wait_for(event_ready.wait(), timeout=1.0),
                asyncio.wait_for(rtc_ready.wait(), timeout=1.0),
            )
            if event_task.done() or rtc_task.done():
                raise SubscriptionLostError("browser subscription stopped")
        except (TimeoutError, SubscriptionLostError):
            await websocket.close(
                code=WS_CLOSE_SUBSCRIPTION_LOST,
                reason="subscription lost",
            )
            return
        while True:
            msg = await receive_with_signal_pumps(websocket, (event_task, rtc_task))
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
                    await errors.send("invalid_frame", None)
                    continue
                if not isinstance(obj, dict):
                    await errors.send("invalid_frame", None)
                    continue
                ftype = obj.get("type")
                if ftype == "pong":
                    continue
                if ftype == "rtc.config.request":
                    if set(obj) != {"type"}:
                        await errors.send("invalid_frame", ftype)
                    elif config_requests.allow():
                        await conn.send_text(
                            _rtc_config_payload(user.id, binding_nonce_required=True)
                        )
                    continue
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
                elif ftype == "rtc.resume":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    binding_nonce = obj.get("binding_nonce")
                    binding_generation = obj.get("binding_generation")
                    if (
                        session_id is None
                        or not valid_rtc_binding_nonce(binding_nonce)
                        or not isinstance(binding_generation, int)
                        or isinstance(binding_generation, bool)
                        or binding_generation < 1
                        or not _valid_browser_session_rtc_tuple(obj, pty_session_id)
                    ):
                        await errors.send("invalid_frame", ftype)
                        continue
                    existing = await broker.rtc_session_for(session_id)
                    if existing is None:
                        await conn.send_text(
                            {
                                "type": "rtc.status",
                                "session_id": session_id,
                                "binding_nonce": binding_nonce,
                                "binding_generation": binding_generation,
                                "scope_type": "session",
                                "scope_id": pty_session_id,
                                "protocol": SESSION_RTC_PROTOCOL,
                                "protocol_version": SESSION_RTC_PROTOCOL_VERSION,
                                "status": "unavailable",
                            }
                        )
                        continue
                    route = RedisBrowserConn(
                        user_id=user.id,
                        host_id=host_id,
                        channel=rtc_response_channel,
                        daemon_connection_id=existing.daemon_connection_id,
                        daemon_generation=existing.daemon_generation,
                        binding_nonce=binding_nonce,
                    )
                    resumed = await broker.resume_rtc_session(
                        session_id,
                        route,
                        binding_nonce=binding_nonce,
                        binding_generation=binding_generation,
                        scope_type="session",
                        scope_id=pty_session_id,
                        protocol=SESSION_RTC_PROTOCOL,
                        protocol_version=SESSION_RTC_PROTOCOL_VERSION,
                    )
                    if resumed is None:
                        await conn.send_text(
                            {
                                "type": "rtc.status",
                                "session_id": session_id,
                                "binding_nonce": binding_nonce,
                                "binding_generation": binding_generation,
                                "scope_type": "session",
                                "scope_id": pty_session_id,
                                "protocol": SESSION_RTC_PROTOCOL,
                                "protocol_version": SESSION_RTC_PROTOCOL_VERSION,
                                "status": "unavailable",
                            }
                        )
                        continue
                    rtc_routes[session_id] = route
                    await conn.send_text(_binding_frame(resumed, "rtc.status", status="resumed"))
                elif ftype == "rtc.offer":
                    proposed_nonce = obj.get("binding_nonce")
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    if (
                        session_id is None
                        or not valid_rtc_binding_nonce(proposed_nonce)
                        or not _valid_browser_session_rtc_tuple(obj, pty_session_id)
                    ):
                        await errors.send("invalid_frame", ftype)
                        continue
                    ice_restart = obj.get("ice_restart") is True
                    if "ice_restart" in obj and obj.get("ice_restart") is not True:
                        await errors.send("invalid_frame", ftype)
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
                                await errors.send("invalid_frame", ftype)
                                continue
                    except SignedRtcRelayError:
                        # Presence selects signed mode; malformed/missing signed
                        # data never falls through to the legacy raw-SDP path.
                        await errors.send("invalid_frame", ftype)
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
                    daemon = broker.get_daemon_for_session(
                        pty_session_id
                    ) or broker.get_daemon_for_host(host_id)
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
                    if not await broker.reclaim_daemon_presence_if_missing(daemon):
                        await conn.send_text(
                            {
                                "type": "rtc.status",
                                "session_id": session_id,
                                "binding_nonce": proposed_nonce,
                                "status": "unavailable",
                                "message": "WebRTC signaling could not reach the daemon.",
                            }
                        )
                        continue
                    if ice_restart:
                        route = rtc_routes.get(session_id)
                        binding = await broker.rtc_session_for(session_id)
                        if not (
                            route is not None
                            and binding is not None
                            and binding.browser is route
                            and binding.daemon is daemon
                            and binding.daemon_orphaned_until is None
                            and binding.scope_type == "session"
                            and binding.scope_id == pty_session_id
                            and binding.protocol == SESSION_RTC_PROTOCOL
                            and binding.protocol_version == SESSION_RTC_PROTOCOL_VERSION
                            and binding.nonce == proposed_nonce
                            and obj.get("binding_generation") == binding.daemon_generation
                            and binding.signed_signal == signed_signal
                        ):
                            await conn.send_text(
                                {
                                    "type": "rtc.status",
                                    "session_id": session_id,
                                    "binding_nonce": proposed_nonce,
                                    "binding_generation": obj.get("binding_generation"),
                                    "scope_type": "session",
                                    "scope_id": pty_session_id,
                                    "protocol": SESSION_RTC_PROTOCOL,
                                    "protocol_version": SESSION_RTC_PROTOCOL_VERSION,
                                    "status": "unavailable",
                                }
                            )
                            continue
                        offer_payload = _binding_frame(
                            binding,
                            "rtc.offer",
                            ice_restart=True,
                            **_offer_ice(user.id, daemon),
                        )
                        if signed_signal:
                            assert signed_envelope is not None
                            offer_payload[SIGNED_ENVELOPE_FIELD] = signed_envelope
                            carried = sanitize_carried_endorsements(
                                obj.get(CARRIED_ENDORSEMENTS_FIELD)
                            )
                            if carried is not None:
                                offer_payload[CARRIED_ENDORSEMENTS_FIELD] = carried
                        else:
                            assert sdp is not None
                            offer_payload["sdp"] = sdp
                        if not await _publish_session_rtc_signal(
                            host_id,
                            binding,
                            rtc_response_channel,
                            offer_payload,
                        ):
                            await conn.send_text(
                                _binding_frame(
                                    binding,
                                    "rtc.status",
                                    status="unavailable",
                                )
                            )
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
                    capacity_available = await broker.session_rtc_capacity_available(
                        user_id=user.id,
                        route_id=route.route_id,
                    )
                    if not capacity_available:
                        await conn.send_text(
                            {
                                "type": "rtc.status",
                                "session_id": session_id,
                                "binding_nonce": binding_nonce,
                                "binding_generation": generation,
                                "status": "failed",
                                "message": "RTC session limit reached.",
                            }
                        )
                        continue
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
                        **_offer_ice(user.id, daemon),
                    }
                    if signed_signal:
                        assert signed_envelope is not None
                        offer_payload[SIGNED_ENVELOPE_FIELD] = signed_envelope
                        # Relay any carried endorsement edges opaquely so a daemon
                        # that does not directly pin this browser can still admit
                        # it via a chain. The daemon re-verifies every edge.
                        carried = sanitize_carried_endorsements(obj.get(CARRIED_ENDORSEMENTS_FIELD))
                        if carried is not None:
                            offer_payload[CARRIED_ENDORSEMENTS_FIELD] = carried
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
                        await errors.send("invalid_frame", ftype)
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
                        or (
                            "binding_generation" in obj
                            and obj.get("binding_generation") != binding.daemon_generation
                        )
                    ):
                        await errors.send("invalid_frame", ftype)
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
                    if session_id is None or not _valid_browser_session_rtc_tuple(
                        obj, pty_session_id
                    ):
                        await errors.send("invalid_frame", ftype)
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
                        or (
                            "binding_generation" in obj
                            and obj.get("binding_generation") != binding.daemon_generation
                        )
                    ):
                        await errors.send("invalid_frame", ftype)
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
                else:
                    await errors.send("unknown_frame", ftype)
    except SubscriptionLostError:
        await websocket.close(
            code=WS_CLOSE_SUBSCRIPTION_LOST,
            reason="subscription lost",
        )
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        await websocket.close(code=WS_CLOSE_SERVER_RESTART, reason="server restart")
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("browser ws crashed: %s", e)
    finally:
        for task in (rtc_task, event_task, keepalive_task, config_task):
            task.cancel()
        await asyncio.gather(
            rtc_task,
            event_task,
            keepalive_task,
            config_task,
            return_exceptions=True,
        )
        bindings: list[RtcSessionBinding] = []
        for session_id, route in list(rtc_routes.items()):
            binding = await broker.rtc_session_for(session_id, browser=route)
            if binding is None:
                continue
            if binding.daemon.keeps_peers_across_reconnect:
                bindings.extend(await broker.orphan_rtc_sessions_for_browser(route))
                continue
            await broker.unregister_rtc_session(binding.session_id, route)
            await _publish_session_rtc_signal(
                host_id,
                binding,
                route.channel,
                _binding_frame(binding, "rtc.close"),
            )
        rtc_routes.clear()
        for binding in bindings:
            _schedule_browser_orphan_expiry(host_id, binding)
        log.info("browser detached session=%s user=%s", pty_session_id, user.id)
