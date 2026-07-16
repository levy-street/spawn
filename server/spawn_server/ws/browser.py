"""`/ws/browser?agent_id=<uuid>` endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from .. import auth as auth_mod
from ..agent_control import (
    MAX_UPLOAD_CLIENT_ID_LENGTH,
    UploadValidationError,
    decode_upload,
    upload_paste_prefix,
)
from ..config import get_settings
from ..db import get_sessionmaker
from ..models import Agent, User
from ..redis import agent_event_channel, get_backend
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

router = APIRouter()
log = logging.getLogger("spawn.ws.browser")
AGENT_RTC_PROTOCOL = "spawn.pty"
AGENT_RTC_PROTOCOL_VERSION = 2
BROWSER_UPLOAD_TIMEOUT_SECONDS = 30.0
BROWSER_WS_PROTOCOL = "spawn.v2"
WS_CLOSE_PROTOCOL_REQUIRED = 4003
WS_CLOSE_CONTENT_FORBIDDEN = 4002


def _decode_upload(obj: dict) -> tuple[str, str, str, str | None]:
    return decode_upload(
        name=obj.get("name"),
        mime_type=obj.get("mime_type"),
        bytes_b64=obj.get("bytes_b64"),
        destination=obj.get("destination"),
    )


def _decode_image_upload(obj: dict) -> tuple[str, str, str]:
    name, mime_type, bytes_b64, _destination = _decode_upload(obj)
    return name, mime_type, bytes_b64


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


async def _publish_agent_rtc_signal(
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
    agent_id: str = Query(...),
    token: str | None = Query(default=None),
) -> None:
    offered = websocket.scope.get("subprotocols") or []
    if BROWSER_WS_PROTOCOL not in offered:
        await websocket.accept()
        await websocket.send_json(
            {"type": "protocol.required", "protocol": BROWSER_WS_PROTOCOL, "version": 2}
        )
        await websocket.close(code=WS_CLOSE_PROTOCOL_REQUIRED, reason="protocol upgrade required")
        return
    await websocket.accept(subprotocol=BROWSER_WS_PROTOCOL)
    user = await _resolve_user(websocket, token)
    if user is None:
        return

    sm = get_sessionmaker()
    async with sm() as session:
        agent = await session.get(Agent, agent_id)
        if agent is None or agent.owner_user_id != user.id:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="agent not found")
            return
        host_id = agent.host_id
        agent_cwd = agent.cwd
        agent_argv = list(agent.argv or [])
        agent_status = agent.status

    broker = get_broker()
    conn = BrowserConn(user_id=user.id, agent_id=agent_id, websocket=websocket)
    log.info("browser signaling attached agent=%s user=%s", agent_id, user.id)

    # Only content-free signaling/lifecycle metadata is sent on this socket.
    try:
        await conn.send_text(_rtc_config_payload(user.id, binding_nonce_required=True))
        await conn.send_text({"type": "agent.status", "status": agent_status})
    except Exception as e:
        log.warning("initial signaling state send failed: %s", e)

    # Redis remains only for cross-worker lifecycle and RTC signaling events.
    event_ready = asyncio.Event()
    rtc_ready = asyncio.Event()
    rtc_response_channel = browser_signal_channel(conn.id)
    rtc_routes: dict[str, RedisBrowserConn] = {}

    async def _pump_events() -> None:
        try:
            async with get_backend().subscribe_channel(agent_event_channel(agent_id)) as stream:
                event_ready.set()
                async for raw_event in stream:
                    try:
                        event = json.loads(raw_event)
                    except (UnicodeDecodeError, json.JSONDecodeError):
                        continue
                    if not isinstance(event, dict) or event.get("type") not in {
                        "agent.status",
                        "agent.exit",
                        "upload.legacy_saved",
                        "upload.legacy_error",
                    }:
                        continue
                    try:
                        await conn.send_text(event)
                    except Exception as e:
                        log.warning("agent event forward to browser failed: %s", e)
                        return
        except Exception as e:  # noqa: BLE001
            log.warning("agent event subscribe loop crashed: %s", e)
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
                    if not isinstance(signal, dict) or signal.get("agent_id") != agent_id:
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
                        if (
                            not dispatch_is_session_owner
                            or _valid_rtc_sdp(signal.get("sdp")) is None
                        ):
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
                    try:
                        name, mime_type, bytes_b64, destination = _decode_upload(obj)
                    except UploadValidationError as e:
                        await conn.send_text({"type": "upload.error", "message": str(e)})
                        continue
                    client_id = obj.get("client_id")
                    if isinstance(client_id, str) and client_id:
                        client_id = client_id[:MAX_UPLOAD_CLIENT_ID_LENGTH]
                    else:
                        client_id = f"upload-{uuid.uuid4().hex}"

                    daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(
                        host_id
                    )
                    if daemon is None:
                        await conn.send_text(
                            {"type": "upload.error", "message": "No daemon is connected."}
                        )
                        continue
                    try:
                        result = await broker.request_upload(
                            agent_id,
                            daemon,
                            payload={
                                "type": "agent.upload",
                                "agent_id": agent_id,
                                "cwd": agent_cwd,
                                "name": name,
                                "mime_type": mime_type,
                                "bytes_b64": bytes_b64,
                                "paste_prefix": upload_paste_prefix(agent_argv),
                                "paste": bool(obj.get("paste", True)),
                                "destination": destination,
                                "client_id": client_id,
                            },
                            client_id=client_id,
                            timeout=BROWSER_UPLOAD_TIMEOUT_SECONDS,
                        )
                        if result is None:
                            await conn.send_text(
                                {
                                    "type": "upload.error",
                                    "client_id": client_id,
                                    "message": "Upload timed out.",
                                }
                            )
                        elif result.get("type") == "error":
                            await conn.send_text(
                                {
                                    "type": "upload.error",
                                    "client_id": client_id,
                                    "message": result.get("message") or "Image upload failed.",
                                }
                            )
                        else:
                            path = result.get("path")
                            if isinstance(path, str):
                                await conn.send_text(
                                    {
                                        "type": "upload.saved",
                                        "client_id": client_id,
                                        "path": path,
                                    }
                                )
                            else:
                                await conn.send_text(
                                    {
                                        "type": "upload.error",
                                        "client_id": client_id,
                                        "message": "Upload returned an invalid response.",
                                    }
                                )
                    except Exception as e:
                        log.warning("upload forward failed: %s", e)
                        await conn.send_text(
                            {
                                "type": "upload.error",
                                "client_id": client_id,
                                "message": "Upload could not reach the daemon.",
                            }
                        )
                elif ftype == "rtc.offer":
                    proposed_nonce = obj.get("binding_nonce")
                    if not get_settings().webrtc_enabled:
                        disabled: dict[str, object] = {
                            "type": "rtc.status",
                            "session_id": obj.get("session_id"),
                            "status": "disabled",
                            "message": "WebRTC direct terminal transport is disabled.",
                        }
                        if valid_rtc_binding_nonce(proposed_nonce):
                            disabled["binding_nonce"] = proposed_nonce
                        await conn.send_text(disabled)
                        continue
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    sdp = _valid_rtc_sdp(obj.get("sdp"))
                    if (
                        session_id is None
                        or sdp is None
                        or not valid_rtc_binding_nonce(proposed_nonce)
                    ):
                        continue
                    daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(
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
                        scope_type="agent",
                        scope_id=agent_id,
                        protocol=AGENT_RTC_PROTOCOL,
                        protocol_version=AGENT_RTC_PROTOCOL_VERSION,
                        binding_nonce=binding_nonce,
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
                                "agent_id": agent_id,
                                "binding_nonce": binding.nonce,
                                "binding_generation": binding.daemon_generation,
                                "scope_type": binding.scope_type,
                                "scope_id": binding.scope_id,
                                "protocol": binding.protocol,
                                "protocol_version": binding.protocol_version,
                                "status": "negotiating",
                            }
                        )
                    published = binding is not None and await _publish_agent_rtc_signal(
                        host_id,
                        binding,
                        rtc_response_channel,
                        {
                            "type": "rtc.offer",
                            "session_id": session_id,
                            "agent_id": agent_id,
                            "binding_nonce": binding.nonce,
                            "binding_generation": binding.daemon_generation,
                            "scope_type": binding.scope_type,
                            "scope_id": binding.scope_id,
                            "protocol": binding.protocol,
                            "protocol_version": binding.protocol_version,
                            "sdp": sdp,
                            "ice_servers": ice_servers_for_session(
                                get_settings(), label=user.id
                            ),
                        },
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
                    if session_id is None or candidate is None:
                        continue
                    route = rtc_routes.get(session_id)
                    binding = await broker.rtc_session_for(session_id)
                    if (
                        route is None
                        or binding is None
                        or binding.browser is not route
                        or binding.scope_type != "agent"
                        or binding.scope_id != agent_id
                        or binding.protocol != AGENT_RTC_PROTOCOL
                        or binding.protocol_version != AGENT_RTC_PROTOCOL_VERSION
                        or obj.get("binding_nonce") != binding.nonce
                    ):
                        continue
                    await _publish_agent_rtc_signal(
                        host_id,
                        binding,
                        rtc_response_channel,
                        {
                            "type": "rtc.candidate",
                            "session_id": session_id,
                            "agent_id": agent_id,
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
                    if session_id is None:
                        continue
                    route = rtc_routes.get(session_id)
                    binding = await broker.rtc_session_for(session_id)
                    if route is None or binding is None or binding.browser is not route:
                        continue
                    if (
                        obj.get("binding_nonce") != binding.nonce
                    ):
                        continue
                    rtc_routes.pop(session_id, None)
                    await broker.unregister_rtc_session(session_id, route)
                    await _publish_agent_rtc_signal(
                        host_id,
                        binding,
                        rtc_response_channel,
                        {
                            "type": "rtc.close",
                            "session_id": session_id,
                            "agent_id": agent_id,
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
            await _publish_agent_rtc_signal(
                host_id,
                binding,
                rtc_response_channel,
                {
                    "type": "rtc.close",
                    "session_id": binding.session_id,
                    "agent_id": agent_id,
                    "binding_nonce": binding.nonce,
                    "binding_generation": binding.daemon_generation,
                    "scope_type": binding.scope_type,
                    "scope_id": binding.scope_id,
                    "protocol": binding.protocol,
                    "protocol_version": binding.protocol_version,
                },
            )
        log.info("browser detached agent=%s user=%s", agent_id, user.id)
