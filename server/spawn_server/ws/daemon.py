"""`/ws/daemon` endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth as auth_mod
from .. import transcript
from ..db import get_sessionmaker
from ..limits import MAX_SAFE_FENCING_GENERATION
from ..models import Agent, Host
from ..redis import agent_event_channel, get_backend
from .broker import DaemonConn, RtcSessionBinding, UploadResolution, get_broker
from .frames import KIND_OUTPUT, decode_binary_frame
from .host_signal import (
    HOST_CONTROL_PROTOCOL,
    HOST_CONTROL_VERSION,
    HOST_DAEMON_PRESENCE_TTL_SECONDS,
    HOST_RTC_SESSION_TTL_SECONDS,
    HOST_RTC_STATUS_ALLOWLIST,
    HostOwnerRevocation,
    HostPresenceOwner,
    HostSignalEnvelope,
    RedisBrowserConn,
    decode_host_owner_revocation,
    decode_host_presence_owner,
    decode_host_signal,
    encode_host_presence_owner,
    host_pending_presence_key,
    host_presence_key,
    host_signal_channel,
    publish_host_owner_revocation,
    receive_with_signal_pump,
    wait_for_signal_pump,
)

router = APIRouter()
log = logging.getLogger("spawn.ws.daemon")
HOST_ACTIVATION_DEADLINE_SECONDS = 30


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
    return host


async def _allocate_host_generation(
    session: AsyncSession,
    host_id: str,
    connection_id: str,
    *,
    commit: bool = True,
) -> int | None:
    result = await session.execute(
        update(Host)
        .where(
            Host.id == host_id,
            Host.daemon_generation_counter < MAX_SAFE_FENCING_GENERATION,
        )
        .values(
            daemon_pending_connection_id=connection_id,
            daemon_pending_generation=Host.daemon_generation_counter + 1,
            daemon_generation_counter=Host.daemon_generation_counter + 1,
        )
        .returning(Host.daemon_pending_generation)
    )
    generation = result.scalar_one_or_none()
    if commit:
        await session.commit()
    return int(generation) if generation is not None else None


async def _clear_host_generation_reservation(
    session: AsyncSession, host_id: str, connection_id: str, generation: int
) -> bool:
    result = await session.execute(
        update(Host)
        .where(
            Host.id == host_id,
            Host.daemon_pending_connection_id == connection_id,
            Host.daemon_pending_generation == generation,
        )
        .values(daemon_pending_connection_id=None, daemon_pending_generation=None)
    )
    await session.commit()
    return result.rowcount == 1


async def _host_activation_predecessor(
    session: AsyncSession, host_id: str, connection_id: str, generation: int
) -> HostPresenceOwner | None | bool:
    row = (
        await session.execute(
            select(
                Host.daemon_connection_id,
                Host.daemon_generation,
                Host.daemon_pending_connection_id,
                Host.daemon_pending_generation,
            ).where(Host.id == host_id)
        )
    ).one_or_none()
    if row is None or row[2:] != (connection_id, generation):
        return False
    if row[0] is None:
        return None
    return HostPresenceOwner(row[0], int(row[1]))


async def _prepare_host_activation(
    session: AsyncSession,
    host_id: str,
    connection_id: str,
    generation: int,
    registration: dict[str, object],
) -> bool:
    values: dict[str, object] = {
        "daemon_connection_id": connection_id,
        "daemon_generation": generation,
        "daemon_pending_connection_id": None,
        "daemon_pending_generation": None,
        "status": "online",
        "last_seen_at": _utcnow(),
    }
    for field in ("os", "arch", "version"):
        value = registration.get(field)
        if isinstance(value, str) and value:
            values[field] = value
    result = await session.execute(
        update(Host)
        .where(
            Host.id == host_id,
            Host.daemon_pending_connection_id == connection_id,
            Host.daemon_pending_generation == generation,
        )
        .values(**values)
    )
    return result.rowcount == 1


async def _configure_activation_timeouts(session: AsyncSession) -> None:
    bind = session.get_bind()
    if bind.dialect.name == "postgresql":
        await session.execute(text("SET LOCAL lock_timeout = '10s'"))
        await session.execute(text("SET LOCAL statement_timeout = '20s'"))


async def _attempt_host_activation(
    host_id: str,
    connection_id: str,
    generation: int,
    registration: dict[str, object],
    previous_value: bytes | None,
    value: bytes,
) -> None:
    sm = get_sessionmaker()
    async with sm() as session:
        await _configure_activation_timeouts(session)
        if not await _prepare_host_activation(
            session, host_id, connection_id, generation, registration
        ):
            await session.rollback()
            return
        promoted = await get_backend().activate_ephemeral(
            host_pending_presence_key(host_id),
            value,
            host_presence_key(host_id),
            previous_value,
            value,
            ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
        )
        if not promoted:
            await session.rollback()
            return
        await session.commit()


async def _reconcile_host_activation(
    host_id: str,
    connection_id: str,
    generation: int,
    previous_owner: HostPresenceOwner | None,
    value: bytes,
) -> bool:
    """Resolve an ambiguous promotion from fresh durable and cache state."""
    previous_value = None if previous_owner is None else encode_host_presence_owner(previous_owner)
    sm = get_sessionmaker()
    async with sm() as session:
        await _configure_activation_timeouts(session)
        host = await session.get(Host, host_id)
        committed = host is not None and (
            host.daemon_connection_id == connection_id and host.daemon_generation == generation
        )
        predecessor_remains = host is not None and (
            (previous_owner is None and host.daemon_connection_id is None)
            or (
                previous_owner is not None
                and host.daemon_connection_id == previous_owner.daemon_connection_id
                and host.daemon_generation == previous_owner.generation
            )
        )

    backend = get_backend()
    active_key = host_presence_key(host_id)
    pending_key = host_pending_presence_key(host_id)
    current = await backend.get_ephemeral(active_key)
    if committed:
        if current != value:
            await backend.set_ephemeral_if_newer(
                pending_key,
                value,
                generation=generation,
                ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
            )
            await backend.activate_ephemeral(
                pending_key,
                value,
                active_key,
                current,
                value,
                ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
            )
        return await backend.get_ephemeral(active_key) == value

    if predecessor_remains:
        if current == value:
            await backend.restore_ephemeral_if(
                active_key,
                value,
                previous_value,
                ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
            )
        elif current is None and previous_value is not None:
            await backend.activate_ephemeral(
                pending_key,
                value,
                active_key,
                None,
                previous_value,
                ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
            )
        await backend.delete_ephemeral_if(pending_key, value)
        async with sm() as session:
            await _clear_host_generation_reservation(session, host_id, connection_id, generation)
    else:
        await backend.delete_ephemeral_if(pending_key, value)
    return False


async def _activate_host_with_reconciliation(
    host_id: str,
    connection_id: str,
    generation: int,
    registration: dict[str, object],
    previous_owner: HostPresenceOwner | None,
    value: bytes,
) -> bool:
    previous_value = None if previous_owner is None else encode_host_presence_owner(previous_owner)
    task = asyncio.create_task(
        _attempt_host_activation(
            host_id,
            connection_id,
            generation,
            registration,
            previous_value,
            value,
        )
    )
    cancelled: asyncio.CancelledError | None = None
    try:
        await asyncio.wait_for(asyncio.shield(task), timeout=HOST_ACTIVATION_DEADLINE_SECONDS)
    except asyncio.CancelledError as exc:
        cancelled = exc
        task.cancel()
    except Exception:
        task.cancel()

    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError as exc:
            if task.done() and not asyncio.current_task().cancelling():
                # The bounded attempt acknowledged our timeout cancellation;
                # this is not cancellation of the registration caller.
                break
            cancelled = cancelled or exc
            task.cancel()
        except Exception:
            break

    reconciliation = asyncio.create_task(
        _reconcile_host_activation(host_id, connection_id, generation, previous_owner, value)
    )
    while True:
        try:
            activated = await asyncio.shield(reconciliation)
            break
        except asyncio.CancelledError as exc:
            # Cleanup establishes a single exact DB/Redis outcome. Repeated
            # caller cancellation must not abandon it in the background.
            cancelled = cancelled or exc
    if cancelled is not None and not activated:
        raise cancelled
    return activated


async def _is_durable_host_owner(host_id: str, connection_id: str, generation: int) -> bool:
    async def query() -> bool:
        sm = get_sessionmaker()
        async with sm() as session:
            owner = await session.scalar(
                select(Host.id).where(
                    Host.id == host_id,
                    Host.daemon_connection_id == connection_id,
                    Host.daemon_generation == generation,
                )
            )
        return owner is not None

    # Signal-pump shutdown can arrive while this read is using the shared
    # SQLite test connection. Let the query unwind before propagating
    # cancellation; production databases benefit from the same clean release.
    task = asyncio.create_task(query())
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


async def _durable_pending_successor(
    host_id: str, connection_id: str, generation: int
) -> HostPresenceOwner | None | bool:
    sm = get_sessionmaker()
    async with sm() as session:
        row = (
            await session.execute(
                select(
                    Host.daemon_pending_connection_id,
                    Host.daemon_pending_generation,
                ).where(
                    Host.id == host_id,
                    Host.daemon_connection_id == connection_id,
                    Host.daemon_generation == generation,
                )
            )
        ).one_or_none()
    if row is None:
        return False
    if row[0] is None or row[1] is None:
        return None
    return HostPresenceOwner(row[0], int(row[1]))


async def _touch_host(
    session: AsyncSession, host_id: str, connection_id: str, generation: int
) -> bool:
    result = await session.execute(
        update(Host)
        .where(
            Host.id == host_id,
            Host.daemon_connection_id == connection_id,
            Host.daemon_generation == generation,
        )
        .values(last_seen_at=_utcnow())
    )
    if result.rowcount != 1:
        await session.rollback()
        return False
    await session.commit()
    return True


async def _mark_host_offline_if_owner(
    session: AsyncSession, host_id: str, connection_id: str, generation: int
) -> bool:
    result = await session.execute(
        update(Host)
        .where(
            Host.id == host_id,
            Host.daemon_connection_id == connection_id,
            Host.daemon_generation == generation,
        )
        .values(status="offline", last_seen_at=_utcnow(), daemon_connection_id=None)
    )
    await session.commit()
    return result.rowcount == 1


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


def _host_presence_value(conn: DaemonConn) -> bytes | None:
    if conn.host_generation is None:
        return None
    return encode_host_presence_owner(HostPresenceOwner(conn.id, conn.host_generation))


async def _claim_host_signal_presence(
    conn: DaemonConn,
) -> tuple[bool, HostPresenceOwner | None]:
    key = host_pending_presence_key(conn.host_id)
    value = _host_presence_value(conn)
    if value is None or conn.host_generation is None:
        return False, None
    claimed, previous = await get_backend().set_ephemeral_if_newer(
        key,
        value,
        generation=conn.host_generation,
        ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
    )
    if not claimed:
        return False, decode_host_presence_owner(previous)
    previous_owner = decode_host_presence_owner(previous)
    return True, previous_owner


async def _refresh_host_signal_presence(conn: DaemonConn) -> bool:
    key = host_presence_key(conn.host_id)
    value = _host_presence_value(conn)
    if value is None or conn.host_generation is None:
        return False
    # A superseded daemon on another worker must never steal routing ownership
    # back merely by sending a late heartbeat.
    if await get_backend().refresh_ephemeral_if(
        key,
        value,
        ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
    ):
        return True
    pending_successor = await _durable_pending_successor(
        conn.host_id, conn.id, conn.host_generation
    )
    if pending_successor is False:
        return False
    current_owner = decode_host_presence_owner(await get_backend().get_ephemeral(key))
    if pending_successor is not None and current_owner == pending_successor:
        # Promotion has won Redis's CAS but its database commit is not yet
        # visible. Keep the still-durable predecessor alive until the DB write
        # resolves; the following exact touch will serialize with that commit.
        return True
    reclaimed, _ = await get_backend().set_ephemeral_if_newer(
        key,
        value,
        generation=conn.host_generation,
        ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
    )
    if not reclaimed:
        return False
    if await _is_durable_host_owner(conn.host_id, conn.id, conn.host_generation):
        return True
    await get_backend().delete_ephemeral_if(key, value)
    return False


async def _owns_host_signal_presence(conn: DaemonConn) -> bool:
    value = _host_presence_value(conn)
    generation = conn.host_generation
    if value is None or generation is None:
        return False
    current_raw = await get_backend().get_ephemeral(host_presence_key(conn.host_id))
    if current_raw == value:
        return await _is_durable_host_owner(conn.host_id, conn.id, generation)
    pending_successor = await _durable_pending_successor(conn.host_id, conn.id, generation)
    return (
        isinstance(pending_successor, HostPresenceOwner)
        and decode_host_presence_owner(current_raw) == pending_successor
    )


async def _is_current_host_owner(conn: DaemonConn) -> bool:
    return await _owns_host_signal_presence(conn)


async def _daemon_can_mutate(conn: DaemonConn) -> bool:
    generation = conn.host_generation
    return (
        generation is not None
        and await get_broker().is_accepted_daemon_owner(conn, generation)
        and await _is_current_host_owner(conn)
    )


async def _publish_agent_event_if_owner(
    conn: DaemonConn, agent_id: str, payload: dict[str, object]
) -> bool:
    owner = _host_presence_value(conn)
    if owner is None:
        return False
    return await get_backend().publish_if_ephemeral(
        host_presence_key(conn.host_id),
        owner,
        agent_event_channel(agent_id),
        json.dumps(payload, separators=(",", ":")).encode(),
    )


async def _lock_durable_host_owner(session: AsyncSession, conn: DaemonConn) -> bool:
    generation = conn.host_generation
    if generation is None:
        return False
    await _configure_activation_timeouts(session)
    owner = await session.scalar(
        select(Host.id)
        .where(
            Host.id == conn.host_id,
            Host.daemon_connection_id == conn.id,
            Host.daemon_generation == generation,
        )
        .with_for_update()
    )
    return owner is not None


async def _revoke_host_rtc_sessions(conn: DaemonConn) -> None:
    broker = get_broker()
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
        await broker.unregister_rtc_session(binding.session_id, binding.browser)
        try:
            await conn.send_text(
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


async def _fence_superseded_daemon(conn: DaemonConn) -> None:
    await _revoke_host_rtc_sessions(conn)
    try:
        await conn.websocket.close(code=4000, reason="superseded")
    except Exception:
        pass


async def _expire_host_rtc_binding(
    binding: RtcSessionBinding,
    daemon: DaemonConn,
) -> None:
    await asyncio.sleep(HOST_RTC_SESSION_TTL_SECONDS)
    if not await get_broker().expire_rtc_session(binding.session_id, binding):
        return
    sm = get_sessionmaker()
    async with sm() as owner_session:
        if not await _lock_durable_host_owner(owner_session, daemon):
            await _fence_superseded_daemon(daemon)
            return
        if owner_session.get_bind().dialect.name == "sqlite":
            # SQLite's test-only FOR UPDATE is a no-op and the in-memory test
            # engine shares one connection. Do not leave that emulated
            # transaction open across the websocket send.
            await owner_session.commit()
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


async def _process_host_rtc_signal(
    conn: DaemonConn,
    envelope: object,
    expiry_tasks: set[asyncio.Task[None]],
) -> bool:
    broker = get_broker()
    if not isinstance(envelope, HostSignalEnvelope):
        return True
    generation = conn.host_generation
    if generation is None or not await broker.is_accepted_daemon_owner(conn, generation):
        return True

    sm = get_sessionmaker()
    async with sm() as owner_session:
        if not await _lock_durable_host_owner(owner_session, conn):
            await _fence_superseded_daemon(conn)
            return False
        if owner_session.get_bind().dialect.name == "sqlite":
            # Production PostgreSQL keeps the row lock through every effect;
            # SQLite cannot provide that guarantee and is used only by the
            # single-process unit suite.
            await owner_session.commit()
        if not await _owns_host_signal_presence(conn):
            await _fence_superseded_daemon(conn)
            return False
        signal = envelope.signal
        if not _host_rtc_metadata_matches(signal, conn.host_id):
            return True
        session_id = _valid_rtc_session_id(signal.get("session_id"))
        if session_id is None:
            return True
        frame_type = signal.get("type")
        if frame_type == "rtc.offer":
            if _valid_rtc_sdp(signal.get("sdp")) is None:
                return True
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
                return True
            binding = await broker.rtc_session_for(session_id, daemon=conn)
            if binding is None:
                return True
            expiry_task = asyncio.create_task(_expire_host_rtc_binding(binding, conn))
            expiry_tasks.add(expiry_task)
            expiry_task.add_done_callback(expiry_tasks.discard)
            await conn.send_text(signal)
            return True

        binding = await broker.rtc_session_for(session_id, daemon=conn)
        if (
            binding is None
            or binding.scope_type != "host"
            or binding.scope_id != conn.host_id
            or binding.browser.route_id != envelope.browser_channel
        ):
            return True
        if frame_type == "rtc.candidate":
            if _valid_rtc_candidate(signal.get("candidate")) is not None:
                await conn.send_text(signal)
        elif frame_type == "rtc.close":
            await broker.unregister_rtc_session(session_id, binding.browser)
            await conn.send_text(signal)
        return True


async def _pump_host_rtc_signals(
    conn: DaemonConn,
    ready: asyncio.Event,
    expiry_tasks: set[asyncio.Task[None]],
) -> None:
    broker = get_broker()
    async with get_backend().subscribe_channel(host_signal_channel(conn.host_id)) as stream:
        ready.set()
        async for raw in stream:
            revocation = decode_host_owner_revocation(raw)
            if revocation is not None:
                if (
                    revocation.revoked_connection_id == conn.id
                    and not await _owns_host_signal_presence(conn)
                ):
                    # A local acceptance already closed its predecessor while
                    # atomically removing its routes. Remote predecessors still
                    # need the distributed close, but the local one must not be
                    # closed a second time merely to stop this signal pump.
                    if broker.get_daemon_for_host(conn.host_id) is conn:
                        await _fence_superseded_daemon(conn)
                    return
                continue
            envelope = decode_host_signal(raw)
            if envelope is None or envelope.daemon_connection_id != conn.id:
                continue
            processing = asyncio.create_task(_process_host_rtc_signal(conn, envelope, expiry_tasks))
            try:
                keep_pumping = await asyncio.shield(processing)
            except asyncio.CancelledError:
                # Do not interrupt a SELECT FOR UPDATE transaction halfway
                # through its exact-owner side effect. Finish its bounded DB
                # cleanup before allowing daemon shutdown to proceed.
                await processing
                raise
            if not keep_pumping:
                return


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
    log.info("daemon pending host=%s user=%s", host.id, host.owner_user_id)

    signal_ready = asyncio.Event()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task = asyncio.create_task(_pump_host_rtc_signals(conn, signal_ready, expiry_tasks))

    sm = get_sessionmaker()
    registered = False

    try:
        await wait_for_signal_pump(signal_task, signal_ready)
        while True:
            msg = await receive_with_signal_pump(websocket, signal_task)
            if msg["type"] == "websocket.disconnect":
                break

            data_text = msg.get("text")
            data_bytes = msg.get("bytes")

            if data_bytes is not None:
                if not registered:
                    log.warning("pending daemon sent binary frame before register")
                    continue
                try:
                    frame = decode_binary_frame(data_bytes)
                except ValueError as e:
                    log.warning("bad binary frame from daemon: %s", e)
                    continue
                if frame.kind != KIND_OUTPUT:
                    log.warning("daemon sent non-output binary frame kind=%s", frame.kind)
                    continue

                # Activity is no longer derived from these bytes — the daemon
                # classifies output locally and emits a content-free
                # `agent.activity` frame (trust Phase 2), handled below. This
                # path stays only to persist/relay until the DataChannel owns
                # history (Phase 2 step 3), at which point it is deleted.

                generation = conn.host_generation
                if generation is None:
                    await _fence_superseded_daemon(conn)
                    break
                stale = False
                async with sm() as owner_session:
                    if not await _lock_durable_host_owner(owner_session, conn):
                        stale = True
                    else:
                        agent = await owner_session.get(Agent, frame.agent_id)
                        if agent is None or agent.host_id != host.id:
                            stale = True
                        else:
                            if (
                                frame.agent_id not in conn.agent_ids
                                and not await broker.attach_agent_to_daemon(
                                    frame.agent_id,
                                    conn,
                                    expected_host_generation=generation,
                                )
                            ):
                                stale = True
                            else:
                                # The row lock orders transcript persistence before
                                # any replacement DB commit; Redis atomically checks
                                # the same generation before external publication.
                                await transcript.append(frame.agent_id, frame.payload)
                                published = await get_backend().publish_if_ephemeral(
                                    host_presence_key(host.id),
                                    _host_presence_value(conn) or b"",
                                    f"spawn:agent:{frame.agent_id}",
                                    frame.payload,
                                )
                                if not published:
                                    stale = True
                    await owner_session.rollback()
                if stale:
                    await _fence_superseded_daemon(conn)
                    break

            elif data_text is not None:
                try:
                    obj = json.loads(data_text)
                except json.JSONDecodeError:
                    log.warning("daemon sent non-JSON text frame")
                    continue
                if not isinstance(obj, dict):
                    log.warning("daemon sent non-object JSON text frame")
                    continue
                ftype = obj.get("type")

                if not registered and ftype != "register":
                    log.warning("pending daemon sent frame before register type=%s", ftype)
                    continue
                if (
                    registered
                    and ftype not in ("register", "host.heartbeat")
                    and not await _daemon_can_mutate(conn)
                ):
                    await _fence_superseded_daemon(conn)
                    break

                if ftype == "register":
                    if registered:
                        log.warning("daemon repeated register host=%s", host.id)
                        continue
                    # Reserve a durable generation without touching the active
                    # database or Redis owner. Only the later CAS promotion is
                    # visible to browsers and accepted daemon routing.
                    previous_owner: HostPresenceOwner | None = None
                    async with sm() as session:
                        generation = await _allocate_host_generation(
                            session,
                            host.id,
                            conn.id,
                        )
                        if generation is None:
                            await _fence_superseded_daemon(conn)
                            break
                    conn.host_generation = generation
                    claimed, _ = await _claim_host_signal_presence(conn)
                    if not claimed:
                        async with sm() as session:
                            await _clear_host_generation_reservation(
                                session, host.id, conn.id, generation
                            )
                        await _fence_superseded_daemon(conn)
                        break

                    value = _host_presence_value(conn)
                    assert value is not None
                    async with sm() as session:
                        predecessor = await _host_activation_predecessor(
                            session, host.id, conn.id, generation
                        )
                    if predecessor is False:
                        await _fence_superseded_daemon(conn)
                        break
                    previous_owner = predecessor
                    if not await _activate_host_with_reconciliation(
                        host.id,
                        conn.id,
                        generation,
                        obj,
                        previous_owner,
                        value,
                    ):
                        await _fence_superseded_daemon(conn)
                        break
                    existing = obj.get("existing_agents") or []
                    home_dir = obj.get("home_dir")
                    if isinstance(home_dir, str) and home_dir:
                        conn.home_dir = home_dir
                    registration_accepted = False
                    async with sm() as session:
                        if await _lock_durable_host_owner(
                            session, conn
                        ) and await _is_current_host_owner(conn):
                            acceptance = await broker.accept_daemon_owner(conn, generation)
                            registration_accepted = bool(acceptance)
                            # Resync only while the exact durable owner lock
                            # prevents another worker from committing a
                            # successor and invalidating these local routes.
                            for aid in existing if registration_accepted else ():
                                agent = await session.get(Agent, aid)
                                if (
                                    agent is not None
                                    and agent.host_id == host.id
                                    and not await broker.attach_agent_to_daemon(
                                        aid,
                                        conn,
                                        expected_host_generation=generation,
                                    )
                                ):
                                    registration_accepted = False
                                    break
                            if registration_accepted:
                                registered = True
                                if (
                                    previous_owner is not None
                                    and previous_owner.daemon_connection_id != conn.id
                                ):
                                    await publish_host_owner_revocation(
                                        conn.host_id,
                                        HostOwnerRevocation(
                                            revoked_connection_id=(
                                                previous_owner.daemon_connection_id
                                            ),
                                            replacement_connection_id=conn.id,
                                        ),
                                    )
                                await conn.send_text({"type": "registered", "host_id": host.id})
                        await session.rollback()
                    if not registration_accepted:
                        async with sm() as session:
                            await _mark_host_offline_if_owner(session, host.id, conn.id, generation)
                        await _fence_superseded_daemon(conn)
                        break

                elif ftype == "host.fs.list_result":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
                            await broker.resolve_dir_list(
                                request_id,
                                obj,
                                daemon=conn,
                                expected_host_generation=conn.host_generation,
                            )
                            await session.rollback()

                elif ftype in ("host.fs.read_result", "host.fs.op_result"):
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
                            await broker.resolve_fs_result(
                                request_id,
                                obj,
                                daemon=conn,
                                expected_host_generation=conn.host_generation,
                            )
                            await session.rollback()

                elif ftype == "host.tools.check_result":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
                            await broker.resolve_tool_check(
                                request_id,
                                obj,
                                daemon=conn,
                                expected_host_generation=conn.host_generation,
                            )
                            await session.rollback()

                elif ftype == "host.tools.install_result":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
                            await broker.resolve_tool_install(
                                request_id,
                                obj,
                                daemon=conn,
                                expected_host_generation=conn.host_generation,
                            )
                            await session.rollback()

                elif ftype == "host.heartbeat":
                    if not await _refresh_host_signal_presence(conn):
                        await _fence_superseded_daemon(conn)
                        break
                    generation = conn.host_generation
                    if generation is None:
                        await _fence_superseded_daemon(conn)
                        break
                    async with sm() as session:
                        if not await _touch_host(session, host.id, conn.id, generation):
                            await _fence_superseded_daemon(conn)
                            break
                    await conn.send_text({"type": "host.heartbeat"})

                elif ftype == "agent.started":
                    aid = obj.get("agent_id")
                    if aid:
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
                            agent = await session.get(Agent, aid)
                            if agent is not None and agent.host_id == host.id:
                                generation = conn.host_generation
                                if generation is None:
                                    break
                                if not await broker.attach_agent_to_daemon(
                                    aid,
                                    conn,
                                    expected_host_generation=generation,
                                ):
                                    break
                                async with broker.accepted_daemon_guard(
                                    conn, generation
                                ) as accepted:
                                    if not accepted or not await _is_current_host_owner(conn):
                                        break
                                    agent.status = "running"
                                    await session.commit()
                                    if not await _publish_agent_event_if_owner(
                                        conn,
                                        aid,
                                        {"type": "agent.status", "status": "running"},
                                    ):
                                        await _fence_superseded_daemon(conn)
                                        break

                elif ftype == "agent.activity":
                    # Content-free output-activity ping (trust Phase 2). The
                    # daemon already classified meaningful output and throttled
                    # it, so the server just stamps — it never sees the bytes.
                    aid = obj.get("agent_id")
                    if aid:
                        now = _utcnow()
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
                            agent = await session.get(Agent, aid)
                            if agent is not None and agent.host_id == host.id:
                                generation = conn.host_generation
                                if generation is None:
                                    break
                                async with broker.accepted_daemon_guard(
                                    conn, generation
                                ) as accepted:
                                    if not accepted or not await _is_current_host_owner(conn):
                                        break
                                    agent.last_output_at = now
                                    if not await _touch_host(session, host.id, conn.id, generation):
                                        break

                elif ftype == "agent.input_activity":
                    # `spawn.pty` input bypasses the server on v2. The daemon
                    # throttles this content-free signal so the activity badge
                    # remains accurate without revealing input bytes.
                    aid = obj.get("agent_id")
                    if aid:
                        now = _utcnow()
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
                            agent = await session.get(Agent, aid)
                            if agent is not None and agent.host_id == host.id:
                                generation = conn.host_generation
                                if generation is None:
                                    break
                                async with broker.accepted_daemon_guard(
                                    conn, generation
                                ) as accepted:
                                    if not accepted or not await _is_current_host_owner(conn):
                                        break
                                    agent.last_input_at = now
                                    if not await _touch_host(session, host.id, conn.id, generation):
                                        break

                elif ftype == "agent.exit":
                    aid = obj.get("agent_id")
                    code = obj.get("exit_code")
                    sig = obj.get("signal")
                    if aid:
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
                            agent = await session.get(Agent, aid)
                            if agent is not None and agent.host_id == host.id:
                                generation = conn.host_generation
                                if generation is None:
                                    break
                                async with broker.accepted_daemon_guard(
                                    conn, generation
                                ) as accepted:
                                    if not accepted or not await _is_current_host_owner(conn):
                                        break
                                    agent.status = "killed" if sig else "exited"
                                    agent.exit_code = code
                                    agent.exited_at = _utcnow()
                                    await session.commit()
                                    if not await _publish_agent_event_if_owner(
                                        conn,
                                        aid,
                                        {
                                            "type": "agent.exit",
                                            "exit_code": code,
                                            "signal": sig,
                                        },
                                    ):
                                        await _fence_superseded_daemon(conn)
                                        break
                        await broker.detach_agent(
                            aid,
                            expected_daemon=conn,
                            expected_host_generation=conn.host_generation,
                        )

                elif ftype == "agent.uploaded":
                    aid = obj.get("agent_id")
                    path = obj.get("path")
                    client_id = obj.get("client_id")
                    if aid and isinstance(path, str):
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
                            agent = await session.get(Agent, aid)
                            if agent is None or agent.host_id != host.id:
                                log.warning("upload ack for unknown agent=%s", aid)
                                continue
                            resolved = await broker.resolve_upload(
                                aid,
                                client_id if isinstance(client_id, str) else None,
                                {"agent_id": aid, "path": path, "client_id": client_id},
                                daemon=conn,
                                expected_host_generation=conn.host_generation,
                            )
                            if resolved is UploadResolution.STALE_OWNER:
                                break
                            if resolved is UploadResolution.NO_WAITER:
                                continue
                            payload: dict[str, object] = {
                                "type": "upload.saved",
                                "path": path,
                            }
                            if isinstance(client_id, str):
                                payload["client_id"] = client_id
                            if not await _publish_agent_event_if_owner(conn, aid, payload):
                                await _fence_superseded_daemon(conn)
                                break
                            await session.rollback()

                elif ftype == "agent.snapshot":
                    aid = obj.get("agent_id")
                    bytes_b64 = obj.get("bytes_b64")
                    if aid and isinstance(bytes_b64, str):
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
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
                                daemon=conn,
                                expected_host_generation=conn.host_generation,
                            )
                            await session.rollback()

                elif ftype == "rtc.answer":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    sdp = _valid_rtc_sdp(obj.get("sdp"))
                    if session_id and sdp:
                        binding = await broker.rtc_session_for(session_id, daemon=conn)
                        if binding is None or not _rtc_frame_matches_binding(obj, binding):
                            log.warning("rtc answer did not match its registered session")
                            continue
                        if binding.scope_type == "host" and not await _owns_host_signal_presence(
                            conn
                        ):
                            await _fence_superseded_daemon(conn)
                            break
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
                            if (
                                binding.scope_type == "host"
                                and not await _owns_host_signal_presence(conn)
                            ):
                                await _fence_superseded_daemon(conn)
                                break
                            async with sm() as owner_session:
                                if not await _lock_durable_host_owner(owner_session, conn):
                                    break
                                await binding.browser.send_text(payload)
                                await owner_session.rollback()
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
                        if binding.scope_type == "host" and not await _owns_host_signal_presence(
                            conn
                        ):
                            await _fence_superseded_daemon(conn)
                            break
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
                            if (
                                binding.scope_type == "host"
                                and not await _owns_host_signal_presence(conn)
                            ):
                                await _fence_superseded_daemon(conn)
                                break
                            async with sm() as owner_session:
                                if not await _lock_durable_host_owner(owner_session, conn):
                                    break
                                await binding.browser.send_text(payload)
                                await owner_session.rollback()
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
                        if binding.scope_type == "host" and not await _owns_host_signal_presence(
                            conn
                        ):
                            await _fence_superseded_daemon(conn)
                            break
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
                            if (
                                binding.scope_type == "host"
                                and not await _owns_host_signal_presence(conn)
                            ):
                                await _fence_superseded_daemon(conn)
                                break
                            async with sm() as owner_session:
                                if not await _lock_durable_host_owner(owner_session, conn):
                                    break
                                await binding.browser.send_text(payload)
                                await owner_session.rollback()
                        except Exception as e:
                            log.warning("rtc status route failed: %s", e)

                elif ftype == "error":
                    aid = obj.get("agent_id")
                    if obj.get("code") == "upload_failed" and aid:
                        async with sm() as session:
                            if not await _lock_durable_host_owner(session, conn):
                                break
                            rejected = await broker.reject_uploads_for_agent(
                                aid,
                                obj.get("message") or "Upload failed.",
                                daemon=conn,
                                expected_host_generation=conn.host_generation,
                            )
                            if not rejected:
                                break
                            if not await _publish_agent_event_if_owner(
                                conn,
                                aid,
                                {
                                    "type": "upload.error",
                                    "message": obj.get("message") or "Image upload failed.",
                                },
                            ):
                                await _fence_superseded_daemon(conn)
                                break
                            await session.rollback()
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
        await _revoke_host_rtc_sessions(conn)
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
        try:
            presence_value = _host_presence_value(conn)
            if presence_value is not None:
                await get_backend().delete_ephemeral_if(host_presence_key(host.id), presence_value)
                await get_backend().delete_ephemeral_if(
                    host_pending_presence_key(host.id), presence_value
                )
        except Exception:
            log.warning("failed to release distributed host signaling ownership")
        await broker.unregister_daemon(conn)
        if conn.host_generation is not None:
            async with sm() as session:
                await _clear_host_generation_reservation(
                    session, host.id, conn.id, conn.host_generation
                )
            async with sm() as session:
                await _mark_host_offline_if_owner(session, host.id, conn.id, conn.host_generation)
        log.info("daemon disconnected host=%s", host.id)
