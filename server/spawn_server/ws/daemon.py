"""`/ws/daemon` endpoint."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth as auth_mod
from .. import transcript
from ..db import get_sessionmaker
from ..models import Agent, Host
from .activity import should_record_agent_output
from .broker import DaemonConn, get_broker
from .frames import KIND_OUTPUT, decode_binary_frame

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

    sm = get_sessionmaker()

    try:
        while True:
            msg = await websocket.receive()
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

                # Authorize: agent must belong to this host.
                async with sm() as session:
                    agent = await session.get(Agent, frame.agent_id)
                    if agent is None or agent.host_id != host.id:
                        log.warning("daemon stream for unknown agent=%s", frame.agent_id)
                        continue
                    now = _utcnow()
                    if should_record_agent_output(str(frame.agent_id), now):
                        agent.last_output_at = now
                    host_obj = await session.get(Host, host.id)
                    if host_obj is not None:
                        host_obj.last_seen_at = now
                    await session.commit()

                # Persist to the agent's on-disk transcript first so a server
                # restart doesn't lose recent history.
                await transcript.append(frame.agent_id, frame.payload)
                # Fan-out via pubsub (single source of truth; works the same
                # in single-worker dev and multi-worker prod). Browsers
                # subscribe in `ws/browser.py`.
                from ..redis import get_backend

                await get_backend().publish(frame.agent_id, frame.payload)

            elif data_text is not None:
                try:
                    obj = json.loads(data_text)
                except json.JSONDecodeError:
                    log.warning("daemon sent non-JSON text frame")
                    continue
                ftype = obj.get("type")

                if ftype == "register":
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

                elif ftype == "host.heartbeat":
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
                        await broker.resolve_snapshot(aid, bytes_b64)

                elif ftype == "error":
                    aid = obj.get("agent_id")
                    if obj.get("code") == "upload_failed" and aid:
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
        await broker.unregister_daemon(conn)
        async with sm() as session:
            h = await session.get(Host, host.id)
            if h is not None:
                h.status = "offline"
                h.last_seen_at = _utcnow()
                await session.commit()
        log.info("daemon disconnected host=%s", host.id)
