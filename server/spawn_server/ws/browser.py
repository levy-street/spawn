"""`/ws/browser?agent_id=<uuid>` endpoint."""

from __future__ import annotations

import asyncio
import base64
import json
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from .. import auth as auth_mod
from .. import transcript
from ..agent_control import (
    MAX_UPLOAD_CLIENT_ID_LENGTH,
    UploadValidationError,
    decode_upload,
    upload_paste_prefix,
)
from ..config import get_settings
from ..db import get_sessionmaker
from ..models import Agent, User
from ..redis import get_backend
from .activity import (
    REDRAW_SUPPRESS_WINDOW,
    should_record_agent_input,
    suppress_agent_output_activity,
    utcnow,
)
from .broker import BrowserConn, BrowserDisplayState, get_broker
from .frames import KIND_INPUT, encode_binary_frame

router = APIRouter()
log = logging.getLogger("spawn.ws.browser")
TERMINAL_SCROLLBACK_LINES = 100_000
DAEMON_SNAPSHOT_LINES = 10_000
INITIAL_SNAPSHOT_TIMEOUT = 5.0


async def _touch_agent_input(agent_id: str) -> None:
    now = utcnow()
    if not should_record_agent_input(agent_id, now):
        return
    sm = get_sessionmaker()
    async with sm() as session:
        agent = await session.get(Agent, agent_id)
        if agent is None:
            return
        agent.last_input_at = now
        await session.commit()


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


def _prefer_transcript_history(argv: list[str]) -> bool:
    # Raw PTY transcripts are chronological, but replaying full-screen TUIs
    # can preserve alternate-screen repaint noise. Keep using tmux's rendered
    # pane snapshot until we have a proper terminal recording renderer that can
    # materialize clean scrollback independently.
    return False


def _display_control_payload(state: BrowserDisplayState) -> dict[str, object]:
    return {
        "type": "display.control",
        "owner": state.owner,
        "cols": state.cols,
        "rows": state.rows,
        "viewers": state.viewers,
    }


def _rtc_config_payload() -> dict[str, object]:
    settings = get_settings()
    return {
        "type": "rtc.config",
        "enabled": settings.webrtc_enabled,
        "ice_servers": settings.webrtc_ice_server_list,
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


async def _broadcast_display_control(agent_id: str) -> None:
    broker = get_broker()
    failed: list[BrowserConn] = []
    for conn, state in await broker.display_states_for_agent(agent_id):
        try:
            await conn.send_text(_display_control_payload(state))
        except Exception as e:
            log.warning("display control broadcast failed: %s", e)
            failed.append(conn)
    if not failed:
        return

    failed_ids = {conn.id for conn in failed}
    for conn in failed:
        await broker.detach_browser(conn)

    for conn, state in await broker.display_states_for_agent(agent_id):
        if conn.id in failed_ids:
            continue
        try:
            await conn.send_text(_display_control_payload(state))
        except Exception as e:
            log.warning("display control rebroadcast failed: %s", e)


async def _send_initial_history(
    conn: BrowserConn,
    *,
    agent_id: str,
    host_id: str,
    agent_argv: list[str],
    initial_cols: int | None,
    initial_rows: int | None,
    resize_before_snapshot: bool,
) -> None:
    broker = get_broker()
    daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(host_id)
    if daemon is not None and not _prefer_transcript_history(agent_argv):
        try:
            if resize_before_snapshot and initial_cols is not None and initial_rows is not None:
                await daemon.send_text(
                    {
                        "type": "agent.resize",
                        "agent_id": agent_id,
                        "cols": initial_cols,
                        "rows": initial_rows,
                    }
                )
            snapshot = await broker.request_snapshot(
                agent_id, daemon, lines=DAEMON_SNAPSHOT_LINES, timeout=INITIAL_SNAPSHOT_TIMEOUT
            )
            if snapshot:
                await conn.send_text({"type": "history", "bytes_b64": snapshot})
                return
        except Exception as e:
            log.warning("tmux snapshot request failed: %s", e)

    history = await transcript.read(agent_id)
    await conn.send_text(
        {"type": "history", "bytes_b64": base64.b64encode(history).decode("ascii")}
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
    cols: int | None = Query(default=None),
    rows: int | None = Query(default=None),
) -> None:
    await websocket.accept(subprotocol="spawn.v1")
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
    initial_cols = _clamp_initial_size(cols, 20, 400)
    initial_rows = _clamp_initial_size(rows, 5, 200)
    display_state = await broker.attach_browser(conn, cols=initial_cols, rows=initial_rows)
    log.info(
        "browser attached agent=%s user=%s owner=%s viewers=%s",
        agent_id,
        user.id,
        display_state.owner,
        display_state.viewers,
    )

    # Tell the browser which terminal geometry it should render before replaying
    # history. Followers must adopt the controller geometry instead of fitting
    # their own viewport and racing the shared PTY size.
    try:
        await _broadcast_display_control(agent_id)
        await conn.send_text(_rtc_config_payload())
        await _send_initial_history(
            conn,
            agent_id=agent_id,
            host_id=host_id,
            agent_argv=agent_argv,
            initial_cols=display_state.cols if display_state.cols is not None else initial_cols,
            initial_rows=display_state.rows if display_state.rows is not None else initial_rows,
            resize_before_snapshot=display_state.owner,
        )
        await conn.send_text({"type": "agent.status", "status": agent_status})
    except Exception as e:
        log.warning("history send failed: %s", e)

    # Background task: pubsub subscribe → live PTY bytes → this browser.
    # This is how cross-worker delivery works (the daemon WS publishes to
    # Redis, regardless of which worker the browser landed on). It also
    # carries the local-worker case so we don't double-deliver.
    pump_ready = asyncio.Event()

    async def _pump_pubsub() -> None:
        try:
            async with get_backend().subscribe(agent_id) as stream:
                pump_ready.set()
                async for chunk in stream:
                    try:
                        await conn.send_bytes(chunk)
                    except Exception as e:
                        log.warning("pubsub forward to browser failed: %s", e)
                        return
        except Exception as e:  # noqa: BLE001
            log.warning("pubsub subscribe loop crashed: %s", e)
        finally:
            pump_ready.set()

    pump_task = asyncio.create_task(_pump_pubsub())
    try:
        await asyncio.wait_for(pump_ready.wait(), timeout=1.0)
    except TimeoutError:
        pass

    # The history payload is a rendered tmux snapshot, not a live terminal
    # attach state. Once the browser is subscribed to live bytes, force tmux
    # to repaint the current screen so xterm's current viewport is real tmux
    # output at the browser's measured size.
    await _request_agent_redraw(agent_id, host_id)

    try:
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                break
            data_text = msg.get("text")
            data_bytes = msg.get("bytes")

            if data_bytes is not None:
                # Wrap in 0x02 + agent_id and forward to owning daemon.
                daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(
                    host_id
                )
                if daemon is None:
                    log.warning("no daemon for agent=%s host=%s", agent_id, host_id)
                    continue
                try:
                    frame = encode_binary_frame(KIND_INPUT, agent_id, data_bytes)
                    await daemon.send_bytes(frame)
                    await _touch_agent_input(agent_id)
                except Exception as e:
                    log.warning("forward to daemon failed: %s", e)

            elif data_text is not None:
                try:
                    obj = json.loads(data_text)
                except json.JSONDecodeError:
                    continue
                ftype = obj.get("type")
                if ftype == "resize":
                    cols = _clamp_message_size(obj, "cols", 80, 20, 400)
                    rows = _clamp_message_size(obj, "rows", 24, 5, 200)
                    display_state = await broker.update_display_size(
                        conn,
                        cols=cols,
                        rows=rows,
                    )
                    if display_state is None:
                        continue
                    if display_state.changed:
                        daemon = broker.get_daemon_for_agent(
                            agent_id
                        ) or broker.get_daemon_for_host(host_id)
                        if daemon is not None:
                            try:
                                suppress_agent_output_activity(
                                    agent_id, duration=REDRAW_SUPPRESS_WINDOW
                                )
                                await daemon.send_text(
                                    {
                                        "type": "agent.resize",
                                        "agent_id": agent_id,
                                        "cols": cols,
                                        "rows": rows,
                                    }
                                )
                            except Exception as e:
                                log.warning("resize forward failed: %s", e)
                        await _broadcast_display_control(agent_id)
                elif ftype == "take_control":
                    cols = _clamp_message_size(obj, "cols", 80, 20, 400)
                    rows = _clamp_message_size(obj, "rows", 24, 5, 200)
                    display_state = await broker.take_display_control(
                        conn,
                        cols=cols,
                        rows=rows,
                    )
                    daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(
                        host_id
                    )
                    if daemon is not None:
                        try:
                            suppress_agent_output_activity(
                                agent_id, duration=REDRAW_SUPPRESS_WINDOW
                            )
                            await daemon.send_text(
                                {
                                    "type": "agent.resize",
                                    "agent_id": agent_id,
                                    "cols": display_state.cols,
                                    "rows": display_state.rows,
                                }
                            )
                        except Exception as e:
                            log.warning("take control resize forward failed: %s", e)
                    await _broadcast_display_control(agent_id)
                    await _request_agent_redraw(agent_id, host_id)
                elif ftype == "scroll":
                    raw_lines = int(obj.get("lines") or 0)
                    lines = max(-200, min(200, raw_lines))
                    if lines == 0:
                        continue
                    daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(
                        host_id
                    )
                    if daemon is not None:
                        try:
                            suppress_agent_output_activity(
                                agent_id, duration=REDRAW_SUPPRESS_WINDOW
                            )
                            await daemon.send_text(
                                {
                                    "type": "agent.scroll",
                                    "agent_id": agent_id,
                                    "lines": lines,
                                }
                            )
                        except Exception as e:
                            log.warning("scroll forward failed: %s", e)
                elif ftype == "snapshot":
                    raw_lines = int(obj.get("lines") or DAEMON_SNAPSHOT_LINES)
                    lines = max(100, min(DAEMON_SNAPSHOT_LINES, raw_lines))
                    plain = bool(obj.get("plain", False))
                    daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(
                        host_id
                    )
                    if daemon is None:
                        continue
                    try:
                        snapshot = await broker.request_snapshot(
                            agent_id,
                            daemon,
                            lines=lines,
                            plain=plain,
                            timeout=2.0,
                        )
                        if snapshot:
                            await conn.send_text(
                                {
                                    "type": "snapshot",
                                    "bytes_b64": snapshot,
                                    "plain": plain,
                                }
                            )
                    except Exception as e:
                        log.warning("snapshot forward failed: %s", e)
                elif ftype == "upload":
                    try:
                        name, mime_type, bytes_b64, destination = _decode_upload(obj)
                    except UploadValidationError as e:
                        await conn.send_text({"type": "upload.error", "message": str(e)})
                        continue
                    client_id = obj.get("client_id")
                    if isinstance(client_id, str):
                        client_id = client_id[:MAX_UPLOAD_CLIENT_ID_LENGTH]
                    else:
                        client_id = None

                    daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(
                        host_id
                    )
                    if daemon is None:
                        await conn.send_text(
                            {"type": "upload.error", "message": "No daemon is connected."}
                        )
                        continue
                    try:
                        await daemon.send_text(
                            {
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
                            }
                        )
                    except Exception as e:
                        log.warning("upload forward failed: %s", e)
                        await conn.send_text(
                            {
                                "type": "upload.error",
                                "message": "Upload could not reach the daemon.",
                            }
                        )
                elif ftype == "rtc.offer":
                    if not get_settings().webrtc_enabled:
                        await conn.send_text(
                            {
                                "type": "rtc.status",
                                "session_id": obj.get("session_id"),
                                "status": "disabled",
                                "message": "WebRTC direct terminal transport is disabled.",
                            }
                        )
                        continue
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    sdp = _valid_rtc_sdp(obj.get("sdp"))
                    if session_id is None or sdp is None:
                        continue
                    daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(
                        host_id
                    )
                    if daemon is None:
                        await conn.send_text(
                            {
                                "type": "rtc.status",
                                "session_id": session_id,
                                "status": "unavailable",
                                "message": "No daemon is connected.",
                            }
                        )
                        continue
                    await broker.register_rtc_session(session_id, conn)
                    try:
                        await daemon.send_text(
                            {
                                "type": "rtc.offer",
                                "session_id": session_id,
                                "agent_id": agent_id,
                                "sdp": sdp,
                                "ice_servers": get_settings().webrtc_ice_server_list,
                            }
                        )
                    except Exception as e:
                        log.warning("rtc offer forward failed: %s", e)
                        await broker.unregister_rtc_session(session_id, conn)
                        await conn.send_text(
                            {
                                "type": "rtc.status",
                                "session_id": session_id,
                                "status": "unavailable",
                                "message": "WebRTC signaling could not reach the daemon.",
                            }
                        )
                elif ftype == "rtc.candidate":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    candidate = _valid_rtc_candidate(obj.get("candidate"))
                    if session_id is None or candidate is None:
                        continue
                    daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(
                        host_id
                    )
                    if daemon is None:
                        continue
                    try:
                        await daemon.send_text(
                            {
                                "type": "rtc.candidate",
                                "session_id": session_id,
                                "agent_id": agent_id,
                                "candidate": candidate,
                            }
                        )
                    except Exception as e:
                        log.warning("rtc candidate forward failed: %s", e)
                elif ftype == "rtc.close":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    if session_id is None:
                        continue
                    await broker.unregister_rtc_session(session_id, conn)
                    daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(
                        host_id
                    )
                    if daemon is not None:
                        try:
                            await daemon.send_text(
                                {
                                    "type": "rtc.close",
                                    "session_id": session_id,
                                    "agent_id": agent_id,
                                }
                            )
                        except Exception as e:
                            log.warning("rtc close forward failed: %s", e)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("browser ws crashed: %s", e)
    finally:
        pump_task.cancel()
        try:
            await pump_task
        except (asyncio.CancelledError, Exception):
            pass
        session_ids = await broker.unregister_rtc_sessions_for(conn)
        daemon = broker.get_daemon_for_agent(agent_id) or broker.get_daemon_for_host(host_id)
        if daemon is not None:
            for session_id in session_ids:
                try:
                    await daemon.send_text(
                        {
                            "type": "rtc.close",
                            "session_id": session_id,
                            "agent_id": agent_id,
                        }
                    )
                except Exception:
                    pass
        await broker.detach_browser(conn)
        await _broadcast_display_control(agent_id)
        log.info("browser detached agent=%s user=%s", agent_id, user.id)


def _clamp_initial_size(value: int | None, minimum: int, maximum: int) -> int | None:
    if value is None:
        return None
    return max(minimum, min(maximum, int(value)))


def _clamp_message_size(
    obj: dict,
    key: str,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    try:
        value = int(obj.get(key) or default)
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


async def _request_agent_redraw(agent_id: str, host_id: str) -> None:
    daemon = get_broker().get_daemon_for_agent(agent_id) or get_broker().get_daemon_for_host(
        host_id
    )
    if daemon is None:
        return
    try:
        suppress_agent_output_activity(agent_id, duration=REDRAW_SUPPRESS_WINDOW)
        await daemon.send_text({"type": "agent.redraw", "agent_id": agent_id})
    except Exception as e:
        log.warning("redraw forward failed: %s", e)
