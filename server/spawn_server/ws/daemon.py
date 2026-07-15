"""`/ws/daemon` endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth as auth_mod
from .. import transcript
from ..db import get_sessionmaker
from ..models import Agent, Host
from ..redis import get_backend
from .broker import DaemonConn, RtcSessionBinding, get_broker
from .frames import KIND_OUTPUT, decode_binary_frame
from .host_signal import (
    HOST_CONTROL_PROTOCOL,
    HOST_CONTROL_VERSION,
    HOST_DAEMON_PRESENCE_TTL_SECONDS,
    HOST_RTC_SESSION_TTL_SECONDS,
    HOST_RTC_STATUS_ALLOWLIST,
    RedisBrowserConn,
    decode_host_signal,
    host_presence_key,
    host_signal_channel,
    receive_with_signal_pump,
    wait_for_signal_pump,
)

router = APIRouter()
log = logging.getLogger("spawn.ws.daemon")


def _utcnow() -> datetime:
    return datetime.now(UTC)


async def _resolve_daemon_host(websocket: WebSocket, query_token: str | None) -> Host | None:
    """Resolve the Host bound to the daemon JWT, or close the WS and return None."""
    raw: str | None = None
    auth = websocket.headers.get("authorization")
    if auth:
        parts = auth.split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "bearer":
            raw = parts[1].strip()
    if raw is None and query_token:
        raw = query_token
    if raw is None:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="missing token")
        return None

    try:
        payload = auth_mod.decode_token(raw)
    except Exception:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad token")
        return None
    if payload.get("kind") != auth_mod.KIND_DAEMON:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="not a daemon token")
        return None
    sub = payload.get("sub", "")
    if not sub.startswith("host:"):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="bad subject")
        return None
    host_id = sub.split(":", 1)[1]
    user_id = payload.get("user_id")

    sm = get_sessionmaker()
    async with sm() as session:
        host = await session.get(Host, host_id)
        if host is None or host.owner_user_id != user_id:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason="host gone")
            return None
        host.status = "online"
        host.last_seen_at = _utcnow()
        await session.commit()
        await session.refresh(host)
    return host


async def _touch_host(session: AsyncSession, host: Host) -> None:
    host.last_seen_at = _utcnow()
    await session.commit()


def _valid_rtc_session_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 128:
        return None
    return value


def _valid_rtc_candidate(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    candidate = value.get("candidate")
    if not isinstance(candidate, str) or len(candidate) > 64 * 1024:
        return None
    return dict(value)


def _valid_rtc_sdp(value: object) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 1024 * 1024:
        return None
    return value


def _rtc_frame_matches_binding(obj: dict, binding: RtcSessionBinding) -> bool:
    """Bind daemon signaling to its registered session, endpoint and scope.

    Legacy agent daemons omit the generalized fields, so those fields remain
    optional only for agent sessions. Host sessions always require the full
    tuple; the signaling server never guesses host scope from an unbound frame.
    """
    scope_type = binding.scope_type
    if obj.get("session_id") != binding.session_id:
        return False
    expected = {
        "scope_type": scope_type,
        "scope_id": binding.scope_id,
        "protocol": binding.protocol,
        "protocol_version": binding.protocol_version,
    }
    for key, value in expected.items():
        actual = obj.get(key)
        if scope_type == "host" and actual != value:
            return False
        if scope_type == "agent" and actual is not None and actual != value:
            return False
    if scope_type == "agent" and obj.get("agent_id") != binding.scope_id:
        return False
    if scope_type == "host" and obj.get("agent_id") is not None:
        return False
    return True


def _host_rtc_metadata_matches(obj: dict, host_id: str) -> bool:
    return (
        obj.get("scope_type") == "host"
        and obj.get("scope_id") == host_id
        and obj.get("protocol") == HOST_CONTROL_PROTOCOL
        and obj.get("protocol_version") == HOST_CONTROL_VERSION
        and obj.get("agent_id") is None
    )


async def _refresh_host_signal_presence(conn: DaemonConn, *, claim: bool = False) -> bool:
    key = host_presence_key(conn.host_id)
    value = conn.id.encode("ascii")
    if claim:
        await get_backend().set_ephemeral(
            key,
            value,
            ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
        )
        return True
    # A superseded daemon on another worker must never steal routing ownership
    # back merely by sending a late heartbeat.
    return await get_backend().refresh_ephemeral_if(
        key,
        value,
        ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
    )


async def _expire_host_rtc_binding(
    binding: RtcSessionBinding,
    daemon: DaemonConn,
) -> None:
    await asyncio.sleep(HOST_RTC_SESSION_TTL_SECONDS)
    if not await get_broker().expire_rtc_session(binding.session_id, binding):
        return
    try:
        await daemon.send_text(
            {
                "type": "rtc.close",
                "session_id": binding.session_id,
                "scope_type": "host",
                "scope_id": binding.scope_id,
                "protocol": binding.protocol,
                "protocol_version": binding.protocol_version,
            }
        )
    except Exception:
        pass


async def _pump_host_rtc_signals(
    conn: DaemonConn,
    ready: asyncio.Event,
    expiry_tasks: set[asyncio.Task[None]],
) -> None:
    broker = get_broker()
    async with get_backend().subscribe_channel(host_signal_channel(conn.host_id)) as stream:
        ready.set()
        async for raw in stream:
            envelope = decode_host_signal(raw)
            if envelope is None or envelope.daemon_connection_id != conn.id:
                continue
            signal = envelope.signal
            if not _host_rtc_metadata_matches(signal, conn.host_id):
                continue
            session_id = _valid_rtc_session_id(signal.get("session_id"))
            if session_id is None:
                continue
            frame_type = signal.get("type")
            if frame_type == "rtc.offer":
                if _valid_rtc_sdp(signal.get("sdp")) is None:
                    continue
                remote_browser = RedisBrowserConn(
                    user_id=conn.user_id,
                    host_id=conn.host_id,
                    channel=envelope.browser_channel,
                )
                registered = await broker.register_rtc_session(
                    session_id,
                    remote_browser,
                    daemon=conn,
                    scope_type="host",
                    scope_id=conn.host_id,
                    protocol=HOST_CONTROL_PROTOCOL,
                    protocol_version=HOST_CONTROL_VERSION,
                    ttl_seconds=HOST_RTC_SESSION_TTL_SECONDS,
                )
                if not registered:
                    await remote_browser.send_text(
                        {
                            "type": "rtc.status",
                            "session_id": session_id,
                            "scope_type": "host",
                            "scope_id": conn.host_id,
                            "protocol": HOST_CONTROL_PROTOCOL,
                            "protocol_version": HOST_CONTROL_VERSION,
                            "status": "failed",
                        }
                    )
                    continue
                binding = await broker.rtc_session_for(session_id, daemon=conn)
                if binding is None:
                    continue
                expiry_task = asyncio.create_task(_expire_host_rtc_binding(binding, conn))
                expiry_tasks.add(expiry_task)
                expiry_task.add_done_callback(expiry_tasks.discard)
                await conn.send_text(signal)
                continue

            binding = await broker.rtc_session_for(session_id, daemon=conn)
            if (
                binding is None
                or binding.scope_type != "host"
                or binding.scope_id != conn.host_id
                or binding.browser.route_id != envelope.browser_channel
            ):
                continue
            if frame_type == "rtc.candidate":
                if _valid_rtc_candidate(signal.get("candidate")) is not None:
                    await conn.send_text(signal)
            elif frame_type == "rtc.close":
                await broker.unregister_rtc_session(session_id, binding.browser)
                await conn.send_text(signal)


@router.websocket("/ws/daemon")
async def daemon_ws(websocket: WebSocket, token: str | None = Query(default=None)) -> None:
    # Pre-accept-time auth check: we accept first because most clients can't read
    # close frames pre-handshake; but we only progress past handshake on success.
    await websocket.accept(subprotocol="spawn.v1")
    host = await _resolve_daemon_host(websocket, token)
    if host is None:
        return

    broker = get_broker()
    conn = DaemonConn(host_id=host.id, user_id=host.owner_user_id, websocket=websocket)
    await broker.register_daemon(conn)
    log.info("daemon connected host=%s user=%s", host.id, host.owner_user_id)

    signal_ready = asyncio.Event()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task = asyncio.create_task(_pump_host_rtc_signals(conn, signal_ready, expiry_tasks))

    sm = get_sessionmaker()

    try:
        await wait_for_signal_pump(signal_task, signal_ready)
        while True:
            msg = await receive_with_signal_pump(websocket, signal_task)
            if msg["type"] == "websocket.disconnect":
                break

            data_text = msg.get("text")
            data_bytes = msg.get("bytes")

            if data_bytes is not None:
                try:
                    frame = decode_binary_frame(data_bytes)
                except ValueError as e:
                    log.warning("bad binary frame from daemon: %s", e)
                    continue
                if frame.kind != KIND_OUTPUT:
                    log.warning("daemon sent non-output binary frame kind=%s", frame.kind)
                    continue

                # Authorize: agent must belong to this host. The broker's
                # attach map is the fast path; fall back to the DB only for
                # agents this connection hasn't streamed before (e.g. frames
                # arriving before the register/started bookkeeping settles).
                if frame.agent_id not in conn.agent_ids:
                    async with sm() as session:
                        agent = await session.get(Agent, frame.agent_id)
                        if agent is None or agent.host_id != host.id:
                            log.warning("daemon stream for unknown agent=%s", frame.agent_id)
                            continue
                    await broker.attach_agent_to_daemon(frame.agent_id, conn)

                # Activity is no longer derived from these bytes — the daemon
                # classifies output locally and emits a content-free
                # `agent.activity` frame (trust Phase 2), handled below. This
                # path stays only to persist/relay until the DataChannel owns
                # history (Phase 2 step 3), at which point it is deleted.

                # Persist to the agent's on-disk transcript first so a server
                # restart doesn't lose recent history. The file write is
                # synchronous I/O; keep it off the event loop.
                await transcript.append(frame.agent_id, frame.payload)
                # Fan-out via pubsub (single source of truth; works the same
                # in single-worker dev and multi-worker prod). Browsers
                # subscribe in `ws/browser.py`.
                await get_backend().publish(frame.agent_id, frame.payload)

            elif data_text is not None:
                try:
                    obj = json.loads(data_text)
                except json.JSONDecodeError:
                    log.warning("daemon sent non-JSON text frame")
                    continue
                ftype = obj.get("type")

                if ftype == "register":
                    # Claim distributed routing before publishing online state.
                    # That ordering ensures a superseded worker cannot race its
                    # disconnect cleanup after this registration commits.
                    await _refresh_host_signal_presence(conn, claim=True)
                    # Resync existing agents the daemon thinks it has.
                    existing = obj.get("existing_agents") or []
                    home_dir = obj.get("home_dir")
                    if isinstance(home_dir, str) and home_dir:
                        conn.home_dir = home_dir
                    async with sm() as session:
                        for aid in existing:
                            agent = await session.get(Agent, aid)
                            if agent is not None and agent.host_id == host.id:
                                await broker.attach_agent_to_daemon(aid, conn)
                        host_obj = await session.get(Host, host.id)
                        if host_obj is not None:
                            host_obj.os = obj.get("os") or host_obj.os
                            host_obj.arch = obj.get("arch") or host_obj.arch
                            host_obj.version = obj.get("version") or host_obj.version
                            host_obj.last_seen_at = _utcnow()
                            host_obj.status = "online"
                            await session.commit()
                    await conn.send_text({"type": "registered", "host_id": host.id})

                elif ftype == "host.fs.list_result":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        await broker.resolve_dir_list(request_id, obj)

                elif ftype in ("host.fs.read_result", "host.fs.op_result"):
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        await broker.resolve_fs_result(request_id, obj)

                elif ftype == "host.tools.check_result":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        await broker.resolve_tool_check(request_id, obj)

                elif ftype == "host.tools.install_result":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        await broker.resolve_tool_install(request_id, obj)

                elif ftype == "host.heartbeat":
                    if not await _refresh_host_signal_presence(conn):
                        await websocket.close(code=4000, reason="superseded")
                        break
                    async with sm() as session:
                        h = await session.get(Host, host.id)
                        if h is not None:
                            await _touch_host(session, h)
                    await conn.send_text({"type": "host.heartbeat"})

                elif ftype == "agent.started":
                    aid = obj.get("agent_id")
                    if aid:
                        async with sm() as session:
                            agent = await session.get(Agent, aid)
                            if agent is not None and agent.host_id == host.id:
                                agent.status = "running"
                                await session.commit()
                                await broker.attach_agent_to_daemon(aid, conn)
                                for b in broker.browsers_for(aid):
                                    try:
                                        await b.send_text(
                                            {"type": "agent.status", "status": "running"}
                                        )
                                    except Exception:
                                        pass

                elif ftype == "agent.activity":
                    # Content-free output-activity ping (trust Phase 2). The
                    # daemon already classified meaningful output and throttled
                    # it, so the server just stamps — it never sees the bytes.
                    aid = obj.get("agent_id")
                    if aid:
                        now = _utcnow()
                        async with sm() as session:
                            agent = await session.get(Agent, aid)
                            if agent is not None and agent.host_id == host.id:
                                agent.last_output_at = now
                                host_obj = await session.get(Host, host.id)
                                if host_obj is not None:
                                    host_obj.last_seen_at = now
                                await session.commit()

                elif ftype == "agent.input_activity":
                    # `spawn.pty` input bypasses the server on v2. The daemon
                    # throttles this content-free signal so the activity badge
                    # remains accurate without revealing input bytes.
                    aid = obj.get("agent_id")
                    if aid:
                        now = _utcnow()
                        async with sm() as session:
                            agent = await session.get(Agent, aid)
                            if agent is not None and agent.host_id == host.id:
                                agent.last_input_at = now
                                host_obj = await session.get(Host, host.id)
                                if host_obj is not None:
                                    host_obj.last_seen_at = now
                                await session.commit()

                elif ftype == "agent.exit":
                    aid = obj.get("agent_id")
                    code = obj.get("exit_code")
                    sig = obj.get("signal")
                    if aid:
                        async with sm() as session:
                            agent = await session.get(Agent, aid)
                            if agent is not None and agent.host_id == host.id:
                                agent.status = "killed" if sig else "exited"
                                agent.exit_code = code
                                agent.exited_at = _utcnow()
                                await session.commit()
                        for b in broker.browsers_for(aid):
                            try:
                                await b.send_text(
                                    {"type": "agent.exit", "exit_code": code, "signal": sig}
                                )
                            except Exception:
                                pass
                        await broker.detach_agent(aid)

                elif ftype == "agent.uploaded":
                    aid = obj.get("agent_id")
                    path = obj.get("path")
                    client_id = obj.get("client_id")
                    if aid and isinstance(path, str):
                        async with sm() as session:
                            agent = await session.get(Agent, aid)
                            if agent is None or agent.host_id != host.id:
                                log.warning("upload ack for unknown agent=%s", aid)
                                continue
                        await broker.resolve_upload(
                            aid,
                            client_id if isinstance(client_id, str) else None,
                            {"agent_id": aid, "path": path, "client_id": client_id},
                        )
                        for b in broker.browsers_for(aid):
                            try:
                                payload = {"type": "upload.saved", "path": path}
                                if isinstance(client_id, str):
                                    payload["client_id"] = client_id
                                await b.send_text(payload)
                            except Exception:
                                pass

                elif ftype == "agent.snapshot":
                    aid = obj.get("agent_id")
                    bytes_b64 = obj.get("bytes_b64")
                    if aid and isinstance(bytes_b64, str):
                        async with sm() as session:
                            agent = await session.get(Agent, aid)
                            if agent is None or agent.host_id != host.id:
                                log.warning("snapshot for unknown agent=%s", aid)
                                continue
                        await broker.resolve_snapshot(
                            aid,
                            {
                                "bytes_b64": bytes_b64,
                                "dc_offset": obj.get("dc_offset"),
                                "rtc_session_id": obj.get("rtc_session_id"),
                            },
                        )

                elif ftype == "rtc.answer":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    sdp = _valid_rtc_sdp(obj.get("sdp"))
                    if session_id and sdp:
                        binding = await broker.rtc_session_for(session_id, daemon=conn)
                        if binding is None or not _rtc_frame_matches_binding(obj, binding):
                            log.warning("rtc answer did not match its registered session")
                            continue
                        payload: dict[str, object] = {
                            "type": "rtc.answer",
                            "session_id": session_id,
                            "sdp": sdp,
                        }
                        if binding.scope_type == "agent":
                            payload["agent_id"] = binding.scope_id
                        else:
                            payload.update(
                                {
                                    "scope_type": binding.scope_type,
                                    "scope_id": binding.scope_id,
                                    "protocol": binding.protocol,
                                    "protocol_version": binding.protocol_version,
                                }
                            )
                        try:
                            await binding.browser.send_text(payload)
                        except Exception as e:
                            log.warning("rtc answer route failed: %s", e)

                elif ftype == "rtc.candidate":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    candidate = _valid_rtc_candidate(obj.get("candidate"))
                    if session_id and candidate is not None:
                        binding = await broker.rtc_session_for(session_id, daemon=conn)
                        if binding is None or not _rtc_frame_matches_binding(obj, binding):
                            log.warning("rtc candidate did not match its registered session")
                            continue
                        payload = {
                            "type": "rtc.candidate",
                            "session_id": session_id,
                            "candidate": candidate,
                        }
                        if binding.scope_type == "agent":
                            payload["agent_id"] = binding.scope_id
                        else:
                            payload.update(
                                {
                                    "scope_type": binding.scope_type,
                                    "scope_id": binding.scope_id,
                                    "protocol": binding.protocol,
                                    "protocol_version": binding.protocol_version,
                                }
                            )
                        try:
                            await binding.browser.send_text(payload)
                        except Exception as e:
                            log.warning("rtc candidate route failed: %s", e)

                elif ftype == "rtc.status":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    status_value = obj.get("status")
                    if session_id and isinstance(status_value, str) and len(status_value) <= 64:
                        binding = await broker.rtc_session_for(session_id, daemon=conn)
                        if binding is None or not _rtc_frame_matches_binding(obj, binding):
                            log.warning("rtc status did not match its registered session")
                            continue
                        if (
                            binding.scope_type == "host"
                            and status_value not in HOST_RTC_STATUS_ALLOWLIST
                        ):
                            log.warning("daemon sent non-allowlisted host rtc status")
                            continue
                        if binding.scope_type == "host" and status_value == "connected":
                            connected_binding = await broker.mark_rtc_session_connected(
                                session_id, binding
                            )
                            if connected_binding is None:
                                continue
                            binding = connected_binding
                        payload = {
                            "type": "rtc.status",
                            "session_id": session_id,
                            "status": status_value,
                        }
                        if binding.scope_type == "agent":
                            payload["agent_id"] = binding.scope_id
                            message = obj.get("message")
                            if isinstance(message, str):
                                payload["message"] = message
                        else:
                            payload.update(
                                {
                                    "scope_type": binding.scope_type,
                                    "scope_id": binding.scope_id,
                                    "protocol": binding.protocol,
                                    "protocol_version": binding.protocol_version,
                                }
                            )
                        try:
                            await binding.browser.send_text(payload)
                        except Exception as e:
                            log.warning("rtc status route failed: %s", e)

                elif ftype == "error":
                    aid = obj.get("agent_id")
                    if obj.get("code") == "upload_failed" and aid:
                        await broker.reject_uploads_for_agent(
                            aid,
                            obj.get("message") or "Upload failed.",
                        )
                        for b in broker.browsers_for(aid):
                            try:
                                await b.send_text(
                                    {
                                        "type": "upload.error",
                                        "message": obj.get("message") or "Image upload failed.",
                                    }
                                )
                            except Exception:
                                pass
                    log.warning(
                        "daemon error host=%s agent=%s code=%s msg=%s",
                        host.id,
                        obj.get("agent_id"),
                        obj.get("code"),
                        obj.get("message"),
                    )
                else:
                    log.warning("daemon sent unknown frame type=%s", ftype)
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        log.exception("daemon ws crashed: %s", e)
    finally:
        for binding in await broker.rtc_sessions_for_daemon(conn):
            if binding.scope_type != "host":
                continue
            try:
                await binding.browser.send_text(
                    {
                        "type": "rtc.status",
                        "session_id": binding.session_id,
                        "scope_type": "host",
                        "scope_id": binding.scope_id,
                        "protocol": binding.protocol,
                        "protocol_version": binding.protocol_version,
                        "status": "unavailable",
                    }
                )
            except Exception:
                pass
        pending_expiry_tasks = list(expiry_tasks)
        for task in pending_expiry_tasks:
            task.cancel()
        if pending_expiry_tasks:
            await asyncio.gather(*pending_expiry_tasks, return_exceptions=True)
        signal_task.cancel()
        try:
            await signal_task
        except (asyncio.CancelledError, Exception):
            pass
        released_signal_owner = False
        try:
            released_signal_owner = await get_backend().delete_ephemeral_if(
                host_presence_key(host.id), conn.id.encode("ascii")
            )
        except Exception:
            log.warning("failed to release distributed host signaling ownership")
        await broker.unregister_daemon(conn)
        if released_signal_owner:
            async with sm() as session:
                h = await session.get(Host, host.id)
                if h is not None:
                    h.status = "offline"
                    h.last_seen_at = _utcnow()
                    await session.commit()
        log.info("daemon disconnected host=%s", host.id)
