"""Host-scoped WebRTC signaling; DataChannel payloads never enter this server."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from ..config import get_settings
from ..db import get_sessionmaker
from ..models import Host
from ..turn import ice_servers_for_session
from .broker import HostBrowserConn, RtcSessionBinding, get_broker
from .browser import _resolve_user, _valid_rtc_candidate, _valid_rtc_sdp, _valid_rtc_session_id

router = APIRouter()
log = logging.getLogger("spawn.ws.host")

HOST_CONTROL_PROTOCOL = "spawn.host.ctl"
HOST_CONTROL_VERSION = 1
HOST_WS_SUBPROTOCOL = "spawn.host.v1"
MAX_SIGNAL_FRAME_BYTES = 1100 * 1024
WS_CLOSE_BINARY = 4002


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
    kind: str,
    binding: RtcSessionBinding,
    **values: object,
) -> dict[str, object]:
    return {
        "type": kind,
        "session_id": binding.session_id,
        "scope_type": binding.scope_type,
        "scope_id": binding.scope_id,
        "protocol": binding.protocol,
        "protocol_version": binding.protocol_version,
        **values,
    }


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

    broker = get_broker()
    conn = HostBrowserConn(user_id=user.id, host_id=host_id, websocket=websocket)
    ice_servers = ice_servers_for_session(get_settings(), label=user.id)
    transport_policy = "relay" if _is_turn_only(ice_servers) else "all"
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

    try:
        while True:
            message = await websocket.receive()
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
                    await conn.send_text(
                        {
                            "type": "rtc.status",
                            "session_id": session_id,
                            "scope_type": "host",
                            "scope_id": host_id,
                            "protocol": HOST_CONTROL_PROTOCOL,
                            "protocol_version": HOST_CONTROL_VERSION,
                            "status": "disabled",
                        }
                    )
                    continue
                sdp = _valid_rtc_sdp(obj.get("sdp"))
                if sdp is None:
                    continue
                daemon = broker.get_daemon_for_host(host_id)
                if daemon is None:
                    await conn.send_text(
                        {
                            "type": "rtc.status",
                            "session_id": session_id,
                            "scope_type": "host",
                            "scope_id": host_id,
                            "protocol": HOST_CONTROL_PROTOCOL,
                            "protocol_version": HOST_CONTROL_VERSION,
                            "status": "unavailable",
                        }
                    )
                    continue
                registered = await broker.register_rtc_session(
                    session_id,
                    conn,
                    daemon=daemon,
                    scope_type="host",
                    scope_id=host_id,
                    protocol=HOST_CONTROL_PROTOCOL,
                    protocol_version=HOST_CONTROL_VERSION,
                )
                if not registered:
                    await conn.send_text(
                        {
                            "type": "rtc.status",
                            "session_id": session_id,
                            "scope_type": "host",
                            "scope_id": host_id,
                            "protocol": HOST_CONTROL_PROTOCOL,
                            "protocol_version": HOST_CONTROL_VERSION,
                            "status": "failed",
                        }
                    )
                    continue
                binding = await broker.rtc_session_for(session_id, browser=conn)
                if binding is None:
                    continue
                try:
                    await daemon.send_text(
                        _signal_payload(
                            "rtc.offer",
                            binding,
                            sdp=sdp,
                            ice_servers=ice_servers,
                            ice_transport_policy=transport_policy,
                        )
                    )
                except Exception:
                    await broker.unregister_rtc_session(session_id, conn)
                    await conn.send_text(_signal_payload("rtc.status", binding, status="unavailable"))

            elif frame_type == "rtc.candidate":
                candidate = _valid_rtc_candidate(obj.get("candidate"))
                binding = await broker.rtc_session_for(session_id, browser=conn)
                if candidate is None or binding is None:
                    continue
                try:
                    await binding.daemon.send_text(
                        _signal_payload("rtc.candidate", binding, candidate=candidate)
                    )
                except Exception:
                    pass

            elif frame_type == "rtc.close":
                binding = await broker.rtc_session_for(session_id, browser=conn)
                if binding is None:
                    continue
                await broker.unregister_rtc_session(session_id, conn)
                try:
                    await binding.daemon.send_text(_signal_payload("rtc.close", binding))
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # noqa: BLE001
        log.exception("host signaling websocket crashed: %s", exc)
    finally:
        bindings = await broker.unregister_rtc_sessions_for(conn)
        for binding in bindings:
            try:
                await binding.daemon.send_text(_signal_payload("rtc.close", binding))
            except Exception:
                pass

