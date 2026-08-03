"""`/ws/daemon` endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import and_, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from .. import auth as auth_mod
from ..db import get_sessionmaker
from ..limits import MAX_SAFE_FENCING_GENERATION
from ..models import Agent, BrowserDevice, Host, HostBrowserPin
from ..redis import agent_event_channel, get_backend
from .broker import DaemonConn, RtcSessionBinding, get_broker
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
    encode_host_owner_revocation,
    encode_host_presence_owner,
    host_pending_presence_key,
    host_presence_key,
    host_signal_channel,
    receive_with_signal_pump,
    valid_rtc_binding_nonce,
    wait_for_signal_pump,
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
log = logging.getLogger("spawn.ws.daemon")
HOST_ACTIVATION_DEADLINE_SECONDS = 30
HOST_EXTERNAL_EFFECT_TIMEOUT_SECONDS = 2.0
HOST_OWNERSHIP_TRANSACTION_TIMEOUT_SECONDS = 10.0
DAEMON_WS_PROTOCOL = "spawn.control.v2"
WS_CLOSE_PROTOCOL_REQUIRED = 4003
WS_CLOSE_CONTENT_FORBIDDEN = 4002


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

    async with _bounded_host_ownership_session() as session:
        host = await session.get(Host, host_id)
        authorized = host is not None and host.owner_user_id == user_id
    if not authorized:
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
    await _configure_activation_timeouts(session)
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
    await _configure_activation_timeouts(session)
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
    await _configure_activation_timeouts(session)
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
    await _configure_activation_timeouts(session)
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
        await session.execute(text("SET LOCAL lock_timeout = '2s'"))
        await session.execute(text("SET LOCAL statement_timeout = '5s'"))
        await session.execute(text("SET LOCAL idle_in_transaction_session_timeout = '5s'"))


@asynccontextmanager
async def _bounded_host_ownership_session() -> AsyncIterator[AsyncSession]:
    """Bound the complete DB-only ownership transaction, including cleanup."""
    async with asyncio.timeout(HOST_OWNERSHIP_TRANSACTION_TIMEOUT_SECONDS):
        async with get_sessionmaker()() as session:
            yield session


async def _attempt_host_activation(
    host_id: str,
    connection_id: str,
    generation: int,
    registration: dict[str, object],
    _previous_value: bytes | None,
    value: bytes,
) -> None:
    active = await get_backend().get_ephemeral(host_presence_key(host_id))
    if active is not None:
        active_owner = decode_host_presence_owner(active)
        if active_owner is None or (
            active_owner.generation >= generation and active != value
        ):
            return
    async with _bounded_host_ownership_session() as session:
        if not await _prepare_host_activation(
            session, host_id, connection_id, generation, registration
        ):
            await session.rollback()
            return
        await session.commit()
    # Redis is deliberately outside the Host row-lock transaction. The DB is
    # authoritative during this short bridge; reconciliation repairs an
    # acknowledged or ambiguous CAS from fresh durable state.
    await get_backend().activate_ephemeral_if_newer(
        host_pending_presence_key(host_id),
        value,
        host_presence_key(host_id),
        generation=generation,
        ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
    )


async def _reconcile_host_activation(
    host_id: str,
    connection_id: str,
    generation: int,
    previous_owner: HostPresenceOwner | None,
    value: bytes,
) -> bool:
    """Resolve an ambiguous promotion from fresh durable and cache state."""
    previous_value = None if previous_owner is None else encode_host_presence_owner(previous_owner)
    async with _bounded_host_ownership_session() as session:
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
        if current == value and await backend.host_owner_is_current(
            active_key,
            pending_key,
            value,
            generation=generation,
        ):
            await backend.delete_ephemeral_if(pending_key, value)
            return True
        await backend.set_ephemeral_if_newer(
            pending_key,
            value,
            generation=generation,
            ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
        )
        await backend.activate_ephemeral_if_newer(
            pending_key,
            value,
            active_key,
            generation=generation,
            ttl_seconds=HOST_DAEMON_PRESENCE_TTL_SECONDS,
        )
        return await backend.host_owner_is_current(
            active_key,
            pending_key,
            value,
            generation=generation,
        )

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
        async with _bounded_host_ownership_session() as session:
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
        async with _bounded_host_ownership_session() as session:
            await _configure_activation_timeouts(session)
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
    async with _bounded_host_ownership_session() as session:
        await _configure_activation_timeouts(session)
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
    await _configure_activation_timeouts(session)
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
    await _configure_activation_timeouts(session)
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
    """Bind daemon signaling to its registered session, endpoint and scope."""
    scope_type = binding.scope_type
    if obj.get("session_id") != binding.session_id:
        return False
    if obj.get("binding_nonce") != binding.nonce:
        return False
    expected = {
        "scope_type": scope_type,
        "scope_id": binding.scope_id,
        "protocol": binding.protocol,
        "protocol_version": binding.protocol_version,
    }
    for key, value in expected.items():
        if obj.get(key) != value:
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
    generation = conn.host_generation
    if generation is None:
        return False
    return await get_backend().publish_if_host_owner(
        host_presence_key(conn.host_id),
        host_pending_presence_key(conn.host_id),
        owner,
        generation=generation,
        channel=agent_event_channel(agent_id),
        payload=json.dumps(payload, separators=(",", ":")).encode(),
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


async def _validate_durable_host_owner(conn: DaemonConn) -> bool:
    """Perform the bounded owner transaction without external awaits."""
    async with _bounded_host_ownership_session() as session:
        valid = await _lock_durable_host_owner(session, conn)
        await session.rollback()
        return valid


def _agent_owner_exists(conn: DaemonConn) -> Any:
    generation = conn.host_generation
    return (
        select(Host.id)
        .where(
            Host.id == conn.host_id,
            Host.daemon_connection_id == conn.id,
            Host.daemon_generation == generation,
        )
        .exists()
    )


async def _redis_owner_is_current(conn: DaemonConn) -> bool:
    expected = _host_presence_value(conn)
    generation = conn.host_generation
    return expected is not None and generation is not None and (
        await get_backend().host_owner_is_current(
            host_presence_key(conn.host_id),
            host_pending_presence_key(conn.host_id),
            expected,
            generation=generation,
        )
    )


def _live_browser_pin_filters(host_id: str, endorser: Any) -> tuple[Any, ...]:
    """Conditions selecting the pins a daemon should still trust.

    A pin is live only when the endorsed device is not revoked and, if the pin
    was created by endorsement, the endorser device still exists and is itself
    not revoked. Revoking a device therefore also revokes everything it
    endorsed -- otherwise a stolen device would keep granting access after it
    was revoked. A directly approved pin carries no endorser and is unaffected.

    `endorser` is an ``aliased(BrowserDevice)`` outer-joined on
    ``endorser.id == HostBrowserPin.endorser_device_id``; requiring
    ``endorser.id`` to be non-null is what distinguishes "endorser exists and is
    live" from "endorser row is missing" (both leave ``revoked_at`` null).
    """

    return (
        HostBrowserPin.host_id == host_id,
        BrowserDevice.revoked_at.is_(None),
        or_(
            HostBrowserPin.endorser_device_id.is_(None),
            and_(endorser.id.isnot(None), endorser.revoked_at.is_(None)),
        ),
    )


async def _live_browser_pins(host_id: str) -> list[dict[str, object]]:
    """Full pin records, so a daemon can adopt endorsed devices it has not met.

    Carries the endorsement signature and the endorser's public key. The daemon
    re-verifies that signature against the browser keys it already pins, so
    nothing here is taken on trust -- a record without a verifiable endorsement
    is ignored rather than adopted. A pin endorsed by a now-revoked device is
    excluded entirely (see ``_live_browser_pin_filters``).
    """

    async with _bounded_host_ownership_session() as session:
        endorser = aliased(BrowserDevice)
        rows = await session.execute(
            select(
                HostBrowserPin.browser_device_id,
                HostBrowserPin.browser_key_algorithm,
                HostBrowserPin.browser_public_key,
                HostBrowserPin.browser_key_fingerprint,
                HostBrowserPin.endorsement_signature,
                endorser.public_key.label("endorser_public_key"),
            )
            .join(BrowserDevice, BrowserDevice.id == HostBrowserPin.browser_device_id)
            .outerjoin(endorser, endorser.id == HostBrowserPin.endorser_device_id)
            .where(*_live_browser_pin_filters(host_id, endorser))
            .order_by(HostBrowserPin.browser_device_id)
        )
        return [
            {
                "browser_device_id": row.browser_device_id,
                "browser_key_algorithm": row.browser_key_algorithm,
                "browser_public_key": row.browser_public_key,
                "browser_key_fingerprint": row.browser_key_fingerprint,
                "endorsement_signature": row.endorsement_signature,
                "endorser_public_key": row.endorser_public_key,
            }
            for row in rows
        ]


async def _live_browser_device_ids(host_id: str) -> list[str]:
    """Browser devices currently pinned to this host whose pins are still live.

    Deliberately excludes revoked devices rather than reporting state per pin:
    the daemon uses this only to drop pins, so a device missing for any reason
    is the safe outcome. Applies the same endorser-revocation filter as
    ``_live_browser_pins`` so a pin endorsed by a now-revoked device is dropped
    too.
    """

    async with _bounded_host_ownership_session() as session:
        endorser = aliased(BrowserDevice)
        rows = await session.execute(
            select(HostBrowserPin.browser_device_id)
            .join(BrowserDevice, BrowserDevice.id == HostBrowserPin.browser_device_id)
            .outerjoin(endorser, endorser.id == HostBrowserPin.endorser_device_id)
            .where(*_live_browser_pin_filters(host_id, endorser))
        )
        return sorted(row[0] for row in rows)


async def _bounded_send_text(target: Any, payload: dict[str, object]) -> None:
    await asyncio.wait_for(target.send_text(payload), timeout=HOST_EXTERNAL_EFFECT_TIMEOUT_SECONDS)


async def _route_rtc_payload_if_owner(
    conn: DaemonConn,
    binding: RtcSessionBinding,
    payload: dict[str, object],
) -> bool:
    if not isinstance(binding.browser, RedisBrowserConn):
        return False
    if not await _validate_durable_host_owner(conn):
        return False
    if not await _redis_owner_is_current(conn):
        return False
    try:
        await _bounded_send_text(binding.browser, payload)
    except Exception:
        return False
    return True


async def _revoke_host_rtc_sessions(conn: DaemonConn) -> None:
    broker = get_broker()
    bindings = await broker.rtc_sessions_for_daemon(conn)
    try:
        current = await asyncio.wait_for(
            get_backend().get_ephemeral(host_presence_key(conn.host_id)),
            timeout=HOST_EXTERNAL_EFFECT_TIMEOUT_SECONDS,
        )
        replacement = decode_host_presence_owner(current)
    except Exception:
        replacement = None
    for binding in bindings:
        if binding.scope_type != "host":
            continue
        unavailable = {
            "type": "rtc.status",
            "session_id": binding.session_id,
            "scope_type": "host",
            "scope_id": binding.scope_id,
            "protocol": binding.protocol,
            "protocol_version": binding.protocol_version,
            "binding_nonce": binding.nonce,
            "status": "unavailable",
        }
        try:
            if (
                isinstance(binding.browser, RedisBrowserConn)
                and replacement is not None
                and replacement.daemon_connection_id != conn.id
            ):
                await asyncio.wait_for(
                    binding.browser.send_owner_revocation(unavailable, replacement),
                    timeout=HOST_EXTERNAL_EFFECT_TIMEOUT_SECONDS,
                )
            else:
                await _bounded_send_text(binding.browser, unavailable)
        except Exception:
            pass
        await broker.unregister_rtc_session(binding.session_id, binding.browser)
        try:
            await _bounded_send_text(
                conn,
                {
                    "type": "rtc.close",
                    "session_id": binding.session_id,
                    "scope_type": "host",
                    "scope_id": binding.scope_id,
                    "protocol": binding.protocol,
                    "protocol_version": binding.protocol_version,
                    "binding_nonce": binding.nonce,
                },
            )
        except Exception:
            pass


async def _fence_superseded_daemon(conn: DaemonConn) -> None:
    # Close first: RTC notifications are best-effort and may each consume
    # their bounded dispatch timeout, but fencing the daemon socket must be
    # prompt regardless of browser/Redis health.
    if not conn.superseded_close_started:
        conn.superseded_close_started = True
        try:
            await asyncio.wait_for(
                conn.websocket.close(code=4000, reason="superseded"),
                timeout=1.0,
            )
        except Exception:
            conn.superseded_close_started = False
    if conn.rtc_revocation_started:
        return
    conn.rtc_revocation_started = True
    try:
        await _revoke_host_rtc_sessions(conn)
    except Exception:
        log.warning("failed to revoke superseded host RTC sessions")


async def _expire_host_rtc_binding(
    binding: RtcSessionBinding,
    daemon: DaemonConn,
) -> None:
    await asyncio.sleep(HOST_RTC_SESSION_TTL_SECONDS)
    if not await _validate_durable_host_owner(daemon) or not await _redis_owner_is_current(daemon):
        await _fence_superseded_daemon(daemon)
        return
    if not await get_broker().expire_rtc_session(binding.session_id, binding):
        return
    try:
        await _bounded_send_text(
            daemon,
            {
                "type": "rtc.close",
                "session_id": binding.session_id,
                "scope_type": "host",
                "scope_id": binding.scope_id,
                "protocol": binding.protocol,
                "protocol_version": binding.protocol_version,
                "binding_nonce": binding.nonce,
            },
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
    if envelope.daemon_connection_id != conn.id or envelope.daemon_generation != generation:
        return True
    if not await _validate_durable_host_owner(conn) or not await _redis_owner_is_current(conn):
        await _fence_superseded_daemon(conn)
        return False
    signal = envelope.signal
    agent_id = signal.get("agent_id")
    if isinstance(agent_id, str):
        session_id = _valid_rtc_session_id(signal.get("session_id"))
        if session_id is None:
            return True
        frame_type = signal.get("type")
        binding_nonce = signal.get("binding_nonce")
        binding = await broker.rtc_session_for(session_id, daemon=conn)
        if (
            binding is None
            or binding.scope_type != "agent"
            or binding.scope_id != agent_id
            or binding.protocol != "spawn.pty"
            or binding.protocol_version != 2
            or binding.browser.route_id != envelope.browser_channel
            or binding_nonce != binding.nonce
            or signal.get("binding_generation") != binding.daemon_generation
            or signal.get("scope_type") != binding.scope_type
            or signal.get("scope_id") != binding.scope_id
            or signal.get("protocol") != binding.protocol
            or signal.get("protocol_version") != binding.protocol_version
        ):
            # Browser teardown retires before dispatch so a reused session id
            # can never be mistaken for the binding being closed. The exact
            # tombstone lets the daemon receive that delayed close; its own
            # nonce CAS then ignores it if a replacement already exists.
            if (
                frame_type == "rtc.close"
                and isinstance(binding_nonce, str)
                and signal.get("binding_generation") == generation
                and await broker.rtc_binding_identity_is_retired(
                    session_id, conn, binding_nonce
                )
            ):
                await _bounded_send_text(conn, signal)
            return True
        if frame_type == "rtc.offer":
            try:
                if binding.signed_signal:
                    if not signed_mode_selected(signal):
                        return True
                    reject_raw_sdp_in_signed_mode(signal)
                    validate_signed_rtc_relay_envelope(
                        signal[SIGNED_ENVELOPE_FIELD],
                        expected_type="rtc.offer",
                        expected_session_id=binding.session_id,
                        expected_scope_type=binding.scope_type,
                        expected_scope_id=binding.scope_id,
                        expected_protocol=binding.protocol,
                        expected_protocol_version=binding.protocol_version,
                    )
                elif signed_mode_selected(signal) or _valid_rtc_sdp(signal.get("sdp")) is None:
                    return True
            except SignedRtcRelayError:
                return True
        elif frame_type == "rtc.candidate":
            if _valid_rtc_candidate(signal.get("candidate")) is None:
                return True
        elif frame_type == "rtc.close":
            await broker.unregister_rtc_session(session_id, binding.browser)
        else:
            return True
        await _bounded_send_text(conn, signal)
        return True
    if not _host_rtc_metadata_matches(signal, conn.host_id):
        return True
    session_id = _valid_rtc_session_id(signal.get("session_id"))
    if session_id is None:
        return True
    frame_type = signal.get("type")
    if frame_type == "rtc.offer":
        signed_signal = signed_mode_selected(signal)
        try:
            if signed_signal:
                reject_raw_sdp_in_signed_mode(signal)
                validate_signed_rtc_relay_envelope(
                    signal[SIGNED_ENVELOPE_FIELD],
                    expected_type="rtc.offer",
                    expected_session_id=session_id,
                    expected_scope_type="host",
                    expected_scope_id=conn.host_id,
                    expected_protocol=HOST_CONTROL_PROTOCOL,
                    expected_protocol_version=HOST_CONTROL_VERSION,
                )
            elif _valid_rtc_sdp(signal.get("sdp")) is None:
                return True
        except SignedRtcRelayError:
            return True
        binding_nonce = signal.get("binding_nonce")
        if not valid_rtc_binding_nonce(binding_nonce):
            return True
        remote_browser = RedisBrowserConn(
            user_id=conn.user_id,
            host_id=conn.host_id,
            channel=envelope.browser_channel,
            daemon_connection_id=conn.id,
            daemon_generation=generation,
            binding_nonce=binding_nonce,
        )
        registered = await broker.register_rtc_session(
            session_id,
            remote_browser,
            daemon=conn,
            scope_type="host",
            scope_id=conn.host_id,
            protocol=HOST_CONTROL_PROTOCOL,
            protocol_version=HOST_CONTROL_VERSION,
            binding_nonce=binding_nonce,
            signed_signal=signed_signal,
            ttl_seconds=HOST_RTC_SESSION_TTL_SECONDS,
        )
        if not registered:
            try:
                await _bounded_send_text(
                    remote_browser,
                    {
                        "type": "rtc.status",
                        "session_id": session_id,
                        "scope_type": "host",
                        "scope_id": conn.host_id,
                        "protocol": HOST_CONTROL_PROTOCOL,
                        "protocol_version": HOST_CONTROL_VERSION,
                        "binding_nonce": binding_nonce,
                        "status": "failed",
                    },
                )
            except Exception:
                await _fence_superseded_daemon(conn)
                return False
            return True
        binding = await broker.rtc_session_for(session_id, daemon=conn)
        if binding is None:
            return True
        expiry_task = asyncio.create_task(_expire_host_rtc_binding(binding, conn))
        expiry_tasks.add(expiry_task)
        expiry_task.add_done_callback(expiry_tasks.discard)
        if not await _redis_owner_is_current(conn):
            await broker.unregister_rtc_session(session_id, remote_browser)
            await _fence_superseded_daemon(conn)
            return False
        await _bounded_send_text(conn, signal)
        return True

    binding = await broker.rtc_session_for(session_id, daemon=conn)
    if (
        binding is None
        or binding.scope_type != "host"
        or binding.scope_id != conn.host_id
        or binding.browser.route_id != envelope.browser_channel
        or signal.get("binding_nonce") != binding.nonce
    ):
        return True
    if not await _redis_owner_is_current(conn):
        await _fence_superseded_daemon(conn)
        return False
    if frame_type == "rtc.candidate":
        if _valid_rtc_candidate(signal.get("candidate")) is not None:
            await _bounded_send_text(conn, signal)
    elif frame_type == "rtc.close":
        await broker.unregister_rtc_session(session_id, binding.browser)
        await _bounded_send_text(conn, signal)
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
                # Finish the bounded DB decision and generation-token dispatch
                # before allowing daemon shutdown to abandon this signal.
                await processing
                raise
            if not keep_pumping:
                return


@router.websocket("/ws/daemon")
async def daemon_ws(websocket: WebSocket, token: str | None = Query(default=None)) -> None:
    offered = websocket.scope.get("subprotocols") or []
    if DAEMON_WS_PROTOCOL not in offered:
        await websocket.accept()
        await websocket.send_json(
            {"type": "protocol.required", "protocol": DAEMON_WS_PROTOCOL, "version": 2}
        )
        await websocket.close(code=WS_CLOSE_PROTOCOL_REQUIRED, reason="protocol upgrade required")
        return
    await websocket.accept(subprotocol=DAEMON_WS_PROTOCOL)
    host = await _resolve_daemon_host(websocket, token)
    if host is None:
        return

    broker = get_broker()
    conn = DaemonConn(host_id=host.id, user_id=host.owner_user_id, websocket=websocket)
    log.info("daemon pending host=%s user=%s", host.id, host.owner_user_id)

    signal_ready = asyncio.Event()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task = asyncio.create_task(_pump_host_rtc_signals(conn, signal_ready, expiry_tasks))

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
                log.warning("content-bearing binary frame on daemon control socket; closing")
                await websocket.close(
                    code=WS_CLOSE_CONTENT_FORBIDDEN,
                    reason="binary terminal frames are retired",
                )
                break

            elif data_text is not None:
                if len(data_text.encode("utf-8")) > MAX_RTC_ROUTING_FRAME_BYTES:
                    await websocket.close(code=1009, reason="signaling frame too large")
                    break
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
                    async with _bounded_host_ownership_session() as session:
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
                        async with _bounded_host_ownership_session() as session:
                            await _clear_host_generation_reservation(
                                session, host.id, conn.id, generation
                            )
                        await _fence_superseded_daemon(conn)
                        break

                    value = _host_presence_value(conn)
                    assert value is not None
                    async with _bounded_host_ownership_session() as session:
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
                    valid_existing: list[str] = []
                    durable_owner = False
                    async with _bounded_host_ownership_session() as session:
                        durable_owner = await _lock_durable_host_owner(session, conn)
                        if durable_owner:
                            for aid in existing:
                                if not isinstance(aid, str):
                                    continue
                                agent = await session.get(Agent, aid)
                                if agent is not None and agent.host_id == host.id:
                                    valid_existing.append(aid)
                        await session.rollback()

                    registration_accepted = False
                    if durable_owner and await _redis_owner_is_current(conn):
                        acceptance = await broker.accept_daemon_owner(conn, generation)
                        registration_accepted = bool(acceptance)
                        for aid in valid_existing if registration_accepted else ():
                            if not await broker.attach_agent_to_daemon(
                                aid,
                                conn,
                                expected_host_generation=generation,
                            ):
                                registration_accepted = False
                                break
                        registration_accepted = (
                            registration_accepted and await _redis_owner_is_current(conn)
                        )
                    if registration_accepted and previous_owner is not None:
                        revocation = HostOwnerRevocation(
                            revoked_connection_id=previous_owner.daemon_connection_id,
                            replacement_connection_id=conn.id,
                        )
                        registration_accepted = await get_backend().publish_if_host_owner(
                            host_presence_key(conn.host_id),
                            host_pending_presence_key(conn.host_id),
                            value,
                            generation=generation,
                            channel=host_signal_channel(conn.host_id),
                            payload=encode_host_owner_revocation(revocation),
                        )
                    if registration_accepted:
                        # The exact Redis decision is the generation-bearing
                        # dispatch point; the bounded socket send holds no DB
                        # or broker lock.
                        registration_accepted = await _redis_owner_is_current(conn)
                    if registration_accepted:
                        # Carry the authoritative live pin set on every
                        # registration. A daemon otherwise learns its browser
                        # pins exactly once, at pairing, and never hears about
                        # a revocation — so a revoked browser would keep
                        # working against it indefinitely. Reconciling here is
                        # self-healing: a daemon that was offline or attached
                        # to another worker when the revocation happened still
                        # converges on its next connect.
                        await _bounded_send_text(
                            conn,
                            {
                                "type": "registered",
                                "host_id": host.id,
                                "account_id": host.owner_user_id,
                                "browser_device_ids": await _live_browser_device_ids(host.id),
                                "browser_pins": await _live_browser_pins(host.id),
                            },
                        )
                        registered = True
                    if not registration_accepted:
                        async with _bounded_host_ownership_session() as session:
                            await _mark_host_offline_if_owner(session, host.id, conn.id, generation)
                        await _fence_superseded_daemon(conn)
                        break

                elif ftype == "host.tools.check_result":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        if not await broker.resolve_tool_check(
                            request_id,
                            obj,
                            daemon=conn,
                            expected_host_generation=conn.host_generation,
                        ):
                            await _fence_superseded_daemon(conn)
                            break

                elif ftype == "host.pong":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        if not await broker.resolve_host_pong(
                            request_id,
                            obj,
                            daemon=conn,
                            expected_host_generation=conn.host_generation,
                        ):
                            await _fence_superseded_daemon(conn)
                            break

                elif ftype == "host.tools.install_result":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        if not await broker.resolve_tool_install(
                            request_id,
                            obj,
                            daemon=conn,
                            expected_host_generation=conn.host_generation,
                        ):
                            await _fence_superseded_daemon(conn)
                            break

                elif ftype == "host.heartbeat":
                    generation = conn.host_generation
                    if generation is None:
                        await _fence_superseded_daemon(conn)
                        break
                    async with _bounded_host_ownership_session() as session:
                        touched = await _touch_host(session, host.id, conn.id, generation)
                    if not touched or not await _refresh_host_signal_presence(conn):
                        await _fence_superseded_daemon(conn)
                        break
                    await _bounded_send_text(conn, {"type": "host.heartbeat"})

                elif ftype == "agent.started":
                    aid = obj.get("agent_id")
                    if aid:
                        generation = conn.host_generation
                        if generation is None:
                            await _fence_superseded_daemon(conn)
                            break
                        durable_owner = False
                        started = False
                        rejected_owner = False
                        async with _bounded_host_ownership_session() as session:
                            durable_owner = await _lock_durable_host_owner(session, conn)
                            agent = await session.get(Agent, aid) if durable_owner else None
                            if agent is not None and agent.host_id == host.id:
                                result = await session.execute(
                                    update(Agent)
                                    .where(
                                        Agent.id == aid,
                                        Agent.host_id == host.id,
                                        _agent_owner_exists(conn),
                                    )
                                    .values(status="running")
                                    .execution_options(synchronize_session=False)
                                )
                                started = result.rowcount == 1
                                rejected_owner = not started
                                if started:
                                    await session.commit()
                                else:
                                    await session.rollback()
                            else:
                                await session.rollback()
                        if not durable_owner:
                            await _fence_superseded_daemon(conn)
                            break
                        if rejected_owner:
                            await _fence_superseded_daemon(conn)
                            break
                        if started:
                            attached = await broker.attach_agent_to_daemon(
                                aid,
                                conn,
                                expected_host_generation=generation,
                            )
                            published = attached and await _publish_agent_event_if_owner(
                                conn,
                                aid,
                                {"type": "agent.status", "status": "running"},
                            )
                            if not published:
                                await _fence_superseded_daemon(conn)
                                break

                elif ftype == "agent.activity":
                    # Content-free output-activity ping (trust Phase 2). The
                    # daemon already classified meaningful output and throttled
                    # it, so the server just stamps — it never sees the bytes.
                    aid = obj.get("agent_id")
                    if aid:
                        now = _utcnow()
                        durable_owner = False
                        rejected_owner = False
                        async with _bounded_host_ownership_session() as session:
                            durable_owner = await _lock_durable_host_owner(session, conn)
                            agent = await session.get(Agent, aid) if durable_owner else None
                            if agent is not None and agent.host_id == host.id:
                                generation = conn.host_generation
                                if generation is None:
                                    await session.rollback()
                                else:
                                    result = await session.execute(
                                        update(Agent)
                                        .where(
                                            Agent.id == aid,
                                            Agent.host_id == host.id,
                                            _agent_owner_exists(conn),
                                        )
                                        .values(last_output_at=now)
                                        .execution_options(synchronize_session=False)
                                    )
                                    if result.rowcount == 1:
                                        await _touch_host(session, host.id, conn.id, generation)
                                    else:
                                        rejected_owner = True
                                        await session.rollback()
                            else:
                                await session.rollback()
                        if not durable_owner:
                            await _fence_superseded_daemon(conn)
                            break
                        if rejected_owner:
                            await _fence_superseded_daemon(conn)
                            break

                elif ftype == "agent.input_activity":
                    # `spawn.pty` input bypasses the server on v2. The daemon
                    # throttles this content-free signal so the activity badge
                    # remains accurate without revealing input bytes.
                    aid = obj.get("agent_id")
                    if aid:
                        now = _utcnow()
                        durable_owner = False
                        rejected_owner = False
                        async with _bounded_host_ownership_session() as session:
                            durable_owner = await _lock_durable_host_owner(session, conn)
                            agent = await session.get(Agent, aid) if durable_owner else None
                            if agent is not None and agent.host_id == host.id:
                                generation = conn.host_generation
                                if generation is None:
                                    await session.rollback()
                                else:
                                    result = await session.execute(
                                        update(Agent)
                                        .where(
                                            Agent.id == aid,
                                            Agent.host_id == host.id,
                                            _agent_owner_exists(conn),
                                        )
                                        .values(last_input_at=now)
                                        .execution_options(synchronize_session=False)
                                    )
                                    if result.rowcount == 1:
                                        await _touch_host(session, host.id, conn.id, generation)
                                    else:
                                        rejected_owner = True
                                        await session.rollback()
                            else:
                                await session.rollback()
                        if not durable_owner:
                            await _fence_superseded_daemon(conn)
                            break
                        if rejected_owner:
                            await _fence_superseded_daemon(conn)
                            break

                elif ftype == "agent.exit":
                    aid = obj.get("agent_id")
                    code = obj.get("exit_code")
                    sig = obj.get("signal")
                    if aid:
                        durable_owner = False
                        exited = False
                        rejected_owner = False
                        async with _bounded_host_ownership_session() as session:
                            durable_owner = await _lock_durable_host_owner(session, conn)
                            agent = await session.get(Agent, aid) if durable_owner else None
                            if agent is not None and agent.host_id == host.id:
                                result = await session.execute(
                                    update(Agent)
                                    .where(
                                        Agent.id == aid,
                                        Agent.host_id == host.id,
                                        _agent_owner_exists(conn),
                                    )
                                    .values(
                                        status="killed" if sig else "exited",
                                        exit_code=code,
                                        exited_at=_utcnow(),
                                    )
                                    .execution_options(synchronize_session=False)
                                )
                                exited = result.rowcount == 1
                                rejected_owner = not exited
                                if exited:
                                    await session.commit()
                                else:
                                    await session.rollback()
                            else:
                                await session.rollback()
                        if not durable_owner:
                            await _fence_superseded_daemon(conn)
                            break
                        if rejected_owner:
                            await _fence_superseded_daemon(conn)
                            break
                        published = not exited or await _publish_agent_event_if_owner(
                            conn,
                            aid,
                            {
                                "type": "agent.exit",
                                "exit_code": code,
                                "signal": sig,
                            },
                        )
                        detached = await broker.detach_agent(
                            aid,
                            expected_daemon=conn,
                            expected_host_generation=conn.host_generation,
                        )
                        if exited and (not published or not detached):
                            await _fence_superseded_daemon(conn)
                            break

                elif ftype == "agent.uploaded":
                    log.warning("retired server-visible agent upload acknowledgement; closing")
                    await websocket.close(
                        code=WS_CLOSE_CONTENT_FORBIDDEN,
                        reason="agent upload acknowledgements belong on spawn.ctl",
                    )
                    break

                elif ftype == "rtc.answer":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    if session_id:
                        binding = await broker.rtc_session_for(session_id, daemon=conn)
                        if binding is None or not _rtc_frame_matches_binding(obj, binding):
                            log.warning("rtc answer did not match its registered session")
                            continue
                        try:
                            if binding.signed_signal:
                                if not signed_mode_selected(obj):
                                    continue
                                reject_raw_sdp_in_signed_mode(obj)
                                signed_envelope = validate_signed_rtc_relay_envelope(
                                    obj[SIGNED_ENVELOPE_FIELD],
                                    expected_type="rtc.answer",
                                    expected_session_id=binding.session_id,
                                    expected_scope_type=binding.scope_type,
                                    expected_scope_id=binding.scope_id,
                                    expected_protocol=binding.protocol,
                                    expected_protocol_version=binding.protocol_version,
                                ).wire
                                sdp = None
                            else:
                                if signed_mode_selected(obj):
                                    continue
                                signed_envelope = None
                                sdp = _valid_rtc_sdp(obj.get("sdp"))
                                if sdp is None:
                                    continue
                        except SignedRtcRelayError:
                            continue
                        payload: dict[str, object] = {
                            "type": "rtc.answer",
                            "session_id": session_id,
                            "binding_nonce": binding.nonce,
                            "binding_generation": binding.daemon_generation,
                        }
                        if binding.signed_signal:
                            assert signed_envelope is not None
                            payload[SIGNED_ENVELOPE_FIELD] = signed_envelope
                        else:
                            assert sdp is not None
                            payload["sdp"] = sdp
                        if binding.scope_type == "agent":
                            payload["agent_id"] = binding.scope_id
                        payload.update(
                            {
                                "scope_type": binding.scope_type,
                                "scope_id": binding.scope_id,
                                "protocol": binding.protocol,
                                "protocol_version": binding.protocol_version,
                            }
                        )
                        if not await _route_rtc_payload_if_owner(conn, binding, payload):
                            await _fence_superseded_daemon(conn)
                            break

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
                            "binding_nonce": binding.nonce,
                            "binding_generation": binding.daemon_generation,
                            "candidate": candidate,
                        }
                        if binding.scope_type == "agent":
                            payload["agent_id"] = binding.scope_id
                        payload.update(
                            {
                                "scope_type": binding.scope_type,
                                "scope_id": binding.scope_id,
                                "protocol": binding.protocol,
                                "protocol_version": binding.protocol_version,
                            }
                        )
                        if not await _route_rtc_payload_if_owner(conn, binding, payload):
                            await _fence_superseded_daemon(conn)
                            break

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
                        mark_connected = (
                            binding.scope_type == "host" and status_value == "connected"
                        )
                        payload = {
                            "type": "rtc.status",
                            "session_id": session_id,
                            "binding_nonce": binding.nonce,
                            "binding_generation": binding.daemon_generation,
                            "status": status_value,
                        }
                        if binding.scope_type == "agent":
                            payload["agent_id"] = binding.scope_id
                            message = obj.get("message")
                            if isinstance(message, str):
                                payload["message"] = message
                        payload.update(
                            {
                                "scope_type": binding.scope_type,
                                "scope_id": binding.scope_id,
                                "protocol": binding.protocol,
                                "protocol_version": binding.protocol_version,
                            }
                        )
                        if not await _route_rtc_payload_if_owner(conn, binding, payload):
                            await _fence_superseded_daemon(conn)
                            break
                        if (
                            mark_connected
                            and await broker.mark_rtc_session_connected(session_id, binding) is None
                        ):
                            continue

                elif ftype == "error":
                    if obj.get("code") == "upload_failed":
                        log.warning("retired server-visible agent upload error; closing")
                        await websocket.close(
                            code=WS_CLOSE_CONTENT_FORBIDDEN,
                            reason="agent upload errors belong on spawn.ctl",
                        )
                        break
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
        await _fence_superseded_daemon(conn)
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
            async with _bounded_host_ownership_session() as session:
                await _clear_host_generation_reservation(
                    session, host.id, conn.id, conn.host_generation
                )
            async with _bounded_host_ownership_session() as session:
                await _mark_host_offline_if_owner(session, host.id, conn.id, conn.host_generation)
        log.info("daemon disconnected host=%s", host.id)


async def push_browser_pins(host_id: str) -> bool:
    """Tell a connected daemon its browser pin set changed.

    Best effort by design. Reconciliation at registration is the guarantee; this
    only removes the wait, so a daemon that is offline or attached to another
    worker still converges on its next connect rather than missing the change.
    """

    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        return False
    async with _bounded_host_ownership_session() as session:
        host = await session.get(Host, host_id)
        if host is None:
            return False
        owner_user_id = host.owner_user_id
    try:
        await _bounded_send_text(
            daemon,
            {
                "type": "host.browser_pins",
                "account_id": owner_user_id,
                "browser_device_ids": await _live_browser_device_ids(host_id),
                "browser_pins": await _live_browser_pins(host_id),
            },
        )
    except Exception:
        log.warning("could not push browser pins to daemon host=%s", host_id)
        return False
    return True
