"""`/ws/daemon` endpoint."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status
from sqlalchemy import select, text, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from .. import auth as auth_mod
from .. import host_capacity, legion, release
from ..config import get_settings
from ..data_events import publish_data_changed
from ..db import get_sessionmaker
from ..limits import MAX_SAFE_FENCING_GENERATION
from ..models import BrowserDevice, Host, HostBrowserPin, RevokedBrowserKey, Session
from ..pin_liveness import live_browser_device_id_set
from ..push import send_alert_push
from ..redis import get_backend, session_event_channel, user_alert_channel
from ..trust_events import pin_undelivered_payload, publish_trust_event
from .alerts import (
    ALERT_QUIET_SECONDS,
    QuietWatch,
    agent_awaiting_input_payload,
    agent_finished_payload,
    is_agent_finish,
    is_shell_command,
    session_died_payload,
)
from .broker import DaemonConn, RtcSessionBinding, get_broker
from .close_codes import (
    WS_CLOSE_CONSISTENCY,
    WS_CLOSE_CONTENT_FORBIDDEN,
    WS_CLOSE_PROTOCOL_REQUIRED,
    WS_CLOSE_SERVER_RESTART,
    WS_CLOSE_SUBSCRIPTION_LOST,
    WS_CLOSE_SUPERSEDED,
)
from .host_signal import (
    HOST_CONTROL_PROTOCOL,
    HOST_CONTROL_VERSION,
    HOST_DAEMON_PRESENCE_TTL_SECONDS,
    HOST_RTC_SESSION_TTL_SECONDS,
    HOST_RTC_STATUS_ALLOWLIST,
    RTC_BINDING_ORPHAN_GRACE_SECONDS,
    HostOwnerRevocation,
    HostPresenceOwner,
    HostSignalEnvelope,
    RedisBrowserConn,
    SubscriptionLostError,
    decode_browser_pins_changed,
    decode_host_owner_revocation,
    decode_host_presence_owner,
    decode_host_signal,
    encode_browser_pins_changed,
    encode_host_owner_revocation,
    encode_host_presence_owner,
    host_pending_presence_key,
    host_presence_key,
    host_signal_channel,
    receive_with_signal_pump,
    valid_rtc_binding_nonce,
    wait_for_signal_pump,
)
from .reliability import ErrorFrameSender, warn_query_token_once
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
DAEMON_WS_PROTOCOL = "spawn.control.v3"
DURABLE_OWNERSHIP_CACHE_SECONDS = 10.0
DAEMON_REGISTRATION_CONCURRENCY = 32
_registration_admission_limit: int | None = None
_registration_admission: asyncio.Semaphore | None = None
_registration_admission_loop: asyncio.AbstractEventLoop | None = None


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware_utc(value: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; comparing those to an aware `now`
    raises. Mirrors `_aware` in `routes/sessions.py`."""
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


async def _record_auth_rejection(host_id: str | None) -> None:
    if host_id is None:
        return
    async with _bounded_host_ownership_session() as session:
        host = await session.get(Host, host_id)
        if host is None:
            return
        if host.daemon_connection_id is None:
            host.status = "offline"
        host.last_disconnect_at = _utcnow()
        host.last_disconnect_reason = "auth_rejected"
        await session.commit()


def _identifiable_host_id(payload: dict[str, object] | None) -> str | None:
    if payload is None:
        return None
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub.startswith("host:"):
        return None
    host_id = sub.split(":", 1)[1]
    return host_id if host_id else None


async def _reject_daemon_auth(
    websocket: WebSocket,
    reason: str,
    payload: dict[str, object] | None = None,
) -> None:
    await _record_auth_rejection(_identifiable_host_id(payload))
    await websocket.close(code=status.WS_1008_POLICY_VIOLATION, reason=reason)


async def _resolve_daemon_host(
    websocket: WebSocket, query_token: str | None
) -> tuple[Host, dict[str, Any]] | None:
    """Resolve the Host bound to the daemon JWT, or close the WS and return None."""
    raw: str | None = None
    auth = websocket.headers.get("authorization")
    if auth:
        parts = auth.split(None, 1)
        if len(parts) == 2 and parts[0].lower() == "bearer":
            raw = parts[1].strip()
    if raw is None and query_token:
        warn_query_token_once(log)
        raw = query_token
    if raw is None:
        await _reject_daemon_auth(websocket, "token_invalid")
        return None

    try:
        settings = auth_mod.get_settings()
        payload = jwt.decode(raw, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError:
        try:
            expired = jwt.decode(
                raw,
                settings.jwt_secret,
                algorithms=[settings.jwt_algorithm],
                options={"verify_exp": False},
            )
        except jwt.PyJWTError:
            expired = None
        await _reject_daemon_auth(websocket, "token_expired", expired)
        return None
    except jwt.PyJWTError:
        await _reject_daemon_auth(websocket, "token_invalid")
        return None
    if payload.get("kind") != auth_mod.KIND_DAEMON:
        await _reject_daemon_auth(websocket, "token_invalid", payload)
        return None
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub.startswith("host:"):
        await _reject_daemon_auth(websocket, "token_invalid", payload)
        return None
    host_id = sub.split(":", 1)[1]
    user_id = payload.get("user_id")

    async with _bounded_host_ownership_session() as session:
        host = await session.get(Host, host_id)
        authorized = host is not None and host.owner_user_id == user_id
    if not authorized:
        await _reject_daemon_auth(websocket, "token_revoked", payload)
        return None
    assert host is not None
    return host, payload


def _daemon_token_needs_rotation(payload: dict[str, Any]) -> bool:
    expires = payload.get("exp")
    if isinstance(expires, bool) or not isinstance(expires, (int, float)):
        return True
    return datetime.fromtimestamp(expires, UTC) - _utcnow() < timedelta(days=30)


def _registration_semaphore() -> asyncio.Semaphore:
    global _registration_admission, _registration_admission_limit, _registration_admission_loop
    limit = get_settings().daemon_registration_concurrency
    loop = asyncio.get_running_loop()
    if (
        _registration_admission is None
        or _registration_admission_limit != limit
        or _registration_admission_loop is not loop
    ):
        _registration_admission = asyncio.Semaphore(limit)
        _registration_admission_limit = limit
        _registration_admission_loop = loop
    return _registration_admission


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
    current = await session.get(Host, host_id, with_for_update=True)
    if current is None:
        return False
    daemon_tree = release.valid_daemon_tree(registration.get("daemon_tree"))
    self_update_raw = registration.get("self_update")
    blocked_raw = registration.get("self_update_blocked")
    self_update_blocked = (
        blocked_raw.strip()
        if isinstance(blocked_raw, str) and 0 < len(blocked_raw.strip()) <= 64
        else None
    )
    values: dict[str, object] = {
        "daemon_connection_id": connection_id,
        "daemon_generation": generation,
        "daemon_pending_connection_id": None,
        "daemon_pending_generation": None,
        "status": "online",
        "last_seen_at": _utcnow(),
        # These describe the daemon that is registering now. An old daemon
        # omits them and must become unsupported, rather than retaining the
        # capabilities of a newer binary that previously occupied the row.
        "daemon_tree": daemon_tree,
        "self_update": self_update_raw if isinstance(self_update_raw, bool) else False,
        "self_update_blocked": self_update_blocked,
        # Describes this exact binary pair, so omission by an older or repaired
        # daemon clears a stale mismatch rather than inheriting it.
        "worker_mismatch": registration.get("worker_mismatch") is True,
    }
    if current.daemon_connection_id is not None and current.daemon_connection_id != connection_id:
        values["last_disconnect_at"] = _utcnow()
        values["last_disconnect_reason"] = "superseded"
    if current.update_state == "updating":
        if daemon_tree is not None and daemon_tree == current.update_tree:
            values.update(
                update_state=None,
                update_tree=None,
                update_error=None,
                update_requested_at=None,
            )
        else:
            values.update(
                update_state="failed",
                update_error="restarted on the previous binary",
            )
    for field in ("os", "arch", "version"):
        value = registration.get(field)
        if isinstance(value, str) and value:
            values[field] = value
    # What the machine is, validated field by field (host_capacity). Written
    # here rather than on the heartbeat because none of it changes while a
    # daemon runs, and a daemon that reports none of it leaves the columns
    # exactly as they were.
    values.update(host_capacity.spec_values(registration.get("spec")))
    # Ratchet, never lower: once a chain-capable daemon has registered, the
    # legacy per-host endorsement path stays retired for this host (mesh R9)
    # even if an older build reconnects later.
    if registration.get("supports_account_chains") is True:
        values["supports_account_chains"] = True
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


async def _auto_update_after_registration(conn: DaemonConn) -> None:
    manifest = release.read_prebuilt_manifest()
    if manifest is None:
        return

    payload: dict[str, Any] | None = None
    async with _bounded_host_ownership_session() as session:
        host = await session.get(Host, conn.host_id)
        if host is None:
            return
        repair = host.worker_mismatch
        if not repair and not get_settings().daemon_auto_update:
            return
        if not repair and release.host_update_state(host, manifest).state != "available":
            return
        payload = release.mark_update_requested(host, manifest)
        if payload is None:
            return
        await session.commit()

    if await get_broker().request_daemon_update(conn, payload):
        return
    async with _bounded_host_ownership_session() as session:
        result = await session.execute(
            update(Host)
            .where(
                Host.id == conn.host_id,
                Host.daemon_connection_id == conn.id,
                Host.daemon_generation == conn.host_generation,
                Host.update_state == "updating",
                Host.update_tree == manifest.tree,
            )
            .values(
                update_state="failed",
                update_error="update request could not be delivered",
            )
        )
        if result.rowcount == 1:
            await session.commit()
        else:
            await session.rollback()


def _short_update_result_string(value: object, *, limit: int) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if value and len(value) <= limit else None


async def _handle_daemon_update_result(conn: DaemonConn, payload: dict[str, object]) -> bool | None:
    request_id = _short_update_result_string(payload.get("request_id"), limit=128)
    ok = payload.get("ok")
    tree = release.valid_daemon_tree(payload.get("tree"))
    if request_id is None or not isinstance(ok, bool) or tree is None:
        log.warning("daemon sent invalid update result host=%s", conn.host_id)
        return None
    if ok:
        log.info("daemon update applied host=%s tree=%s request=%s", conn.host_id, tree, request_id)
        return True

    stage = _short_update_result_string(payload.get("stage"), limit=64)
    if stage not in {"download", "verify", "swap", "exec", "precondition", "health"}:
        stage = None
    error = _short_update_result_string(payload.get("error"), limit=256)
    async with _bounded_host_ownership_session() as session:
        result = await session.execute(
            update(Host)
            .where(
                Host.id == conn.host_id,
                Host.daemon_connection_id == conn.id,
                Host.daemon_generation == conn.host_generation,
            )
            .values(
                update_state="failed",
                update_error=release.humanize_update_result_error(stage, error),
            )
        )
        if result.rowcount != 1:
            await session.rollback()
            return False
        await session.commit()
    log.warning(
        "daemon update failed host=%s tree=%s stage=%s error=%s request=%s",
        conn.host_id,
        tree,
        stage,
        error,
        request_id,
    )
    return True


async def _handle_pin_adoption_result(
    conn: DaemonConn,
    payload: dict[str, object],
    *,
    failed: bool,
) -> bool | None:
    allowed = (
        {"type", "browser_device_id", "reason"}
        if failed
        else {
            "type",
            "browser_device_id",
        }
    )
    if set(payload) != allowed:
        return None
    browser_device_id = payload.get("browser_device_id")
    if not isinstance(browser_device_id, str) or len(browser_device_id) > 64:
        return None
    try:
        if str(uuid.UUID(browser_device_id)) != browser_device_id:
            return None
    except ValueError:
        return None
    reason = payload.get("reason") if failed else None
    if failed and reason not in {"pin_limit", "invalid_chain", "other"}:
        return None

    known = False
    async with _bounded_host_ownership_session() as session:
        pin = await session.get(HostBrowserPin, (conn.host_id, browser_device_id))
        if pin is not None:
            known = True
            if failed:
                pin.delivered_at = None
                pin.undelivered_reason = str(reason)
            else:
                pin.delivered_at = _utcnow()
                pin.undelivered_reason = None
            await session.commit()
    # An unknown device id carries no authority and produces no observable
    # account event. This also makes a late nack after revocation harmless.
    if known and failed:
        await publish_trust_event(
            conn.user_id,
            pin_undelivered_payload(conn.host_id, browser_device_id, str(reason)),
        )
    return True


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
        if active_owner is None or (active_owner.generation >= generation and active != value):
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
    session: AsyncSession,
    host_id: str,
    connection_id: str,
    generation: int,
    capacity: dict[str, object] | None = None,
) -> bool:
    await _configure_activation_timeouts(session)
    result = await session.execute(
        update(Host)
        .where(
            Host.id == host_id,
            Host.daemon_connection_id == connection_id,
            Host.daemon_generation == generation,
        )
        # The keepalive is already a write on this row, so the two meter
        # readings ride it for free rather than earning a statement of
        # their own.
        .values(last_seen_at=_utcnow(), **(capacity or {}))
    )
    if result.rowcount != 1:
        await session.rollback()
        return False
    await session.commit()
    return True


async def _mark_host_offline_if_owner(
    session: AsyncSession,
    host_id: str,
    connection_id: str,
    generation: int,
    *,
    reason: str = "socket_closed",
) -> bool:
    await _configure_activation_timeouts(session)
    result = await session.execute(
        update(Host)
        .where(
            Host.id == host_id,
            Host.daemon_connection_id == connection_id,
            Host.daemon_generation == generation,
        )
        .values(
            status="offline",
            last_seen_at=_utcnow(),
            daemon_connection_id=None,
            last_disconnect_at=_utcnow(),
            last_disconnect_reason=reason,
        )
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
    if not isinstance(candidate, str) or len(candidate) > 1024:
        return None
    sanitized: dict[str, object] = {"candidate": candidate}
    # `null` is how both peers say "this optional field has no value", and it
    # is not the same as a field of the wrong type. webrtc-rs serializes every
    # member of RTCIceCandidateInit whether or not it is set, so every single
    # candidate the daemon sends carries `"usernameFragment": null`; browsers
    # do the same for `sdpMid` on a candidate that belongs to no m-line.
    # Treating that as a malformed frame refused every ICE candidate the daemon
    # ever sent — the browser received none of them, sent no connectivity
    # checks, and the host-control DataChannel never opened, which is a folder
    # picker that never fills and a file explorer that never loads. Absent and
    # null mean the same thing here; a wrong type is still refused.
    for field, limit in {"sdpMid": 64, "usernameFragment": 256}.items():
        item = value.get(field)
        if field in value and item is not None:
            if not isinstance(item, str) or len(item) > limit:
                return None
            sanitized[field] = item
    line_index = value.get("sdpMLineIndex")
    if "sdpMLineIndex" in value and line_index is not None:
        if (
            not isinstance(line_index, int)
            or isinstance(line_index, bool)
            or not 0 <= line_index <= 65535
        ):
            return None
        sanitized["sdpMLineIndex"] = line_index
    return sanitized


def _valid_rtc_sdp(value: object) -> str | None:
    if not isinstance(value, str) or not value or len(value) > 1024 * 1024:
        return None
    return value


def _rtc_frame_matches_binding(obj: dict, binding: RtcSessionBinding) -> bool:
    """Bind daemon signaling to its registered session, endpoint and scope."""
    if obj.get("session_id") != binding.session_id:
        return False
    if obj.get("binding_nonce") != binding.nonce:
        return False
    expected = {
        "scope_type": binding.scope_type,
        "scope_id": binding.scope_id,
        "protocol": binding.protocol,
        "protocol_version": binding.protocol_version,
    }
    for key, value in expected.items():
        if obj.get(key) != value:
            return False
    return True


def _host_rtc_metadata_matches(obj: dict, host_id: str) -> bool:
    return (
        obj.get("scope_type") == "host"
        and obj.get("scope_id") == host_id
        and obj.get("protocol") == HOST_CONTROL_PROTOCOL
        and obj.get("protocol_version") == HOST_CONTROL_VERSION
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
        conn.durable_owner_valid_until = 0.0
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
        conn.durable_owner_valid_until = 0.0
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
        conn.durable_owner_valid_until = 0.0
        return False
    if await _is_durable_host_owner(conn.host_id, conn.id, conn.host_generation):
        return True
    await get_backend().delete_ephemeral_if(key, value)
    conn.durable_owner_valid_until = 0.0
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


async def _has_newer_daemon_owner(conn: DaemonConn) -> bool:
    """Return whether a distinct, higher generation really superseded this socket."""

    generation = conn.host_generation
    if generation is None:
        return False
    async with _bounded_host_ownership_session() as session:
        row = (
            await session.execute(
                select(
                    Host.daemon_connection_id,
                    Host.daemon_generation,
                    Host.daemon_pending_connection_id,
                    Host.daemon_pending_generation,
                ).where(Host.id == conn.host_id)
            )
        ).one_or_none()
    if row is not None:
        for connection_id, candidate_generation in (row[:2], row[2:]):
            if (
                connection_id is not None
                and connection_id != conn.id
                and candidate_generation is not None
                and int(candidate_generation) > generation
            ):
                return True
    for key in (
        host_presence_key(conn.host_id),
        host_pending_presence_key(conn.host_id),
    ):
        owner = decode_host_presence_owner(await get_backend().get_ephemeral(key))
        if owner is not None and owner.generation > generation:
            return True
    return False


async def _publish_channel_if_owner(
    conn: DaemonConn, channel: str, payload: dict[str, object]
) -> bool:
    owner = _host_presence_value(conn)
    if owner is None:
        return False
    generation = conn.host_generation
    if generation is None:
        return False
    try:
        published = await get_backend().publish_if_host_owner(
            host_presence_key(conn.host_id),
            host_pending_presence_key(conn.host_id),
            owner,
            generation=generation,
            channel=channel,
            payload=json.dumps(payload, separators=(",", ":")).encode(),
        )
    except Exception:
        conn.durable_owner_valid_until = 0.0
        raise
    if not published:
        conn.durable_owner_valid_until = 0.0
    return published


async def _publish_session_event_if_owner(
    conn: DaemonConn, session_id: str, payload: dict[str, object]
) -> bool:
    return await _publish_channel_if_owner(conn, session_event_channel(session_id), payload)


async def _publish_awaiting_input(conn: DaemonConn, session_id: str) -> None:
    """A session has produced no output for `ALERT_QUIET_SECONDS`.

    The state is re-read rather than carried on the timer: half a minute is
    long enough for the agent to have exited, been restarted, or handed the
    foreground back to the shell, and each of those already has its own event.
    Only a session still running something that is not a shell is genuinely
    sitting there waiting for its owner.
    """
    sm = get_sessionmaker()
    async with sm() as session:
        row = await session.get(Session, session_id)
        if row is None or row.host_id != conn.host_id or row.status != "running":
            return
        command = row.foreground_command
        owner_user_id = row.owner_user_id
        last_output = _aware_utc(row.last_output_at)
        last_input = _aware_utc(row.last_input_at)
    if command is None or is_shell_command(command):
        return
    # The timer says "nothing arrived for a while"; these say "and what came
    # before it was the agent finishing a turn". Without them a reconnect, or
    # a user who typed and walked away, both read as the agent waiting.
    if last_output is None:
        return
    if last_input is not None and last_input > last_output:
        # The user spoke last. Whatever this session is doing, it is not
        # waiting on them — the same call the status dot makes ("input_sent"
        # in `routes/sessions.py`).
        return
    # A hair under the window: the timer's delay and this threshold are the
    # same number, so a few milliseconds of ordering slop between the write and
    # the timer would otherwise reject an alert that is genuinely due — and a
    # rejected alert is silence, which is the failure this whole check exists
    # to avoid overcorrecting into.
    if _utcnow() - last_output < timedelta(seconds=ALERT_QUIET_SECONDS * 0.9):
        return
    await _publish_user_alert(
        conn, owner_user_id, agent_awaiting_input_payload(session_id, command)
    )


async def _publish_user_alert(
    conn: DaemonConn, owner_user_id: str, payload: dict[str, object]
) -> None:
    """Fan an attention event out to every browser this owner has open.

    Fenced like every other publish from this socket, so a superseded daemon
    cannot alert on a host it no longer owns. Unlike the lifecycle publishes,
    a failure here is not a fencing signal the caller must act on: an alert is
    a courtesy, and losing one must never tear down a healthy daemon link.
    """
    try:
        await _publish_channel_if_owner(conn, user_alert_channel(owner_user_id), payload)
    except Exception as e:  # noqa: BLE001
        log.warning("alert publish failed: %s", e)
    _schedule_alert_push(owner_user_id, payload)


#: Strong references to in-flight push tasks. Without this the event loop holds
#: only a weak one and a task can be collected mid-send.
_push_tasks: set[asyncio.Task[None]] = set()


def _schedule_alert_push(owner_user_id: str, payload: dict[str, object]) -> None:
    """Send the same alert to the account's phones and browsers, off this
    socket's hot path.

    Deliberately fire-and-forget. The socket publish above has to stay quick —
    it sits in the daemon's read loop — and a push round-trip to an external
    service is neither quick nor reliable enough to put there. Nothing waits on
    the result, and `send_alert_push` is written not to raise.
    """
    try:
        task = asyncio.create_task(_deliver_alert_push(owner_user_id, payload))
    except RuntimeError:
        # No running loop (shutdown). Losing a courtesy alert is the right
        # outcome; raising into a teardown path is not.
        return
    _push_tasks.add(task)
    task.add_done_callback(_push_tasks.discard)


async def _deliver_alert_push(owner_user_id: str, payload: dict[str, object]) -> None:
    try:
        sm = get_sessionmaker()
        async with sm() as session:
            await send_alert_push(session=session, user_id=owner_user_id, payload=payload)
    except Exception as e:  # noqa: BLE001
        log.warning("alert push failed: %s", e)


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
    """Read durable ownership at most once per ten seconds, without a row lock."""

    now = time.monotonic()
    if conn.durable_owner_valid_until > now:
        return True
    generation = conn.host_generation
    if generation is None:
        return False
    valid = await _is_durable_host_owner(conn.host_id, conn.id, generation)
    if valid:
        conn.durable_owner_valid_until = now + DURABLE_OWNERSHIP_CACHE_SECONDS
    else:
        conn.durable_owner_valid_until = 0.0
    return valid


def _session_owner_exists(conn: DaemonConn) -> Any:
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
    try:
        current = (
            expected is not None
            and generation is not None
            and await get_backend().host_owner_is_current(
                host_presence_key(conn.host_id),
                host_pending_presence_key(conn.host_id),
                expected,
                generation=generation,
            )
        )
    except Exception:
        conn.durable_owner_valid_until = 0.0
        raise
    if not current:
        conn.durable_owner_valid_until = 0.0
    return current


async def _live_browser_device_id_set(session: AsyncSession, host_id: str) -> set[str]:
    """Device IDs whose pin on this host is *transitively* live.

    Thin alias over the shared authority in ``spawn_server.pin_liveness`` —
    the same computation now also filters the ``/api/trust/hosts/{id}/pins``
    routes, so what the UI reports as trusted and what the daemon adopts can
    never fork. See that module for the full semantics (fixpoint, fail-closed
    dangling endorsers, and the root-anchor ratchet exception).
    """

    return await live_browser_device_id_set(session, host_id)


async def _live_browser_pins(host_id: str) -> list[dict[str, object]]:
    """Full pin records, so a daemon can adopt endorsed devices it has not met.

    Carries the endorsement signature and the endorser's public key. The daemon
    re-verifies that signature against the browser keys it already pins, so
    nothing here is taken on trust -- a record without a verifiable endorsement
    is ignored rather than adopted. Only transitively-live pins are returned (see
    ``_live_browser_device_id_set``).
    """

    async with _bounded_host_ownership_session() as session:
        live_ids = await _live_browser_device_id_set(session, host_id)
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
            .outerjoin(endorser, endorser.id == HostBrowserPin.endorser_device_id)
            .where(HostBrowserPin.host_id == host_id)
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
            if row.browser_device_id in live_ids
        ]


async def _live_browser_device_ids(host_id: str) -> list[str]:
    """Browser devices whose pin on this host is transitively live.

    Deliberately excludes revoked devices (and any device whose endorsement chain
    is no longer rooted in a live, directly-approved pin) rather than reporting
    state per pin: the daemon uses this only to drop pins, so a device missing for
    any reason is the safe outcome.
    """

    async with _bounded_host_ownership_session() as session:
        return sorted(await _live_browser_device_id_set(session, host_id))


async def _revoked_browser_keys(account_id: str) -> list[str]:
    """Public keys of the account's revoked browser devices — the deny-list a
    host subtracts from acceptance (device mesh §3). Account-scoped, not
    host-scoped: a revoked device must be denied even where it would connect via
    a chain to another host's anchor. Add-only in FACT, not just in effect
    (R10): the union of currently-revoked roster rows and the permanent
    ``revoked_browser_keys`` tombstones, which "Clear history" never deletes —
    a daemon replaces its deny-list wholesale on every push, so computing from
    prunable rows alone would silently un-revoke a pruned key and re-admit a
    stolen device via its cached endorsement chain. The roster arm is kept as
    belt-and-braces for any stamp that has not (yet) been mirrored. The daemon
    can only reject with this list, never admit."""

    async with _bounded_host_ownership_session() as session:
        rows = await session.execute(
            select(BrowserDevice.public_key)
            .where(
                BrowserDevice.owner_user_id == account_id,
                BrowserDevice.revoked_at.is_not(None),
            )
            .union(
                select(RevokedBrowserKey.public_key).where(
                    RevokedBrowserKey.owner_user_id == account_id
                )
            )
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
    try:
        durable_owner = await _validate_durable_host_owner(conn)
    except (TimeoutError, SQLAlchemyError) as exc:
        log.warning(
            "dropping RTC relay frame after transient ownership DB failure host=%s: %s",
            conn.host_id,
            type(exc).__name__,
        )
        return True
    if not durable_owner:
        return False
    if not await _redis_owner_is_current(conn):
        return False
    try:
        owner_generation = conn.host_generation
        if owner_generation is None:
            return False
        await asyncio.wait_for(
            binding.browser._send_text_as_owner(
                payload,
                HostPresenceOwner(conn.id, owner_generation),
            ),
            timeout=HOST_EXTERNAL_EFFECT_TIMEOUT_SECONDS,
        )
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
        conn.superseded_by_newer = True
        try:
            await asyncio.wait_for(
                conn.websocket.close(code=WS_CLOSE_SUPERSEDED, reason="superseded"),
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


async def _close_daemon_consistency_failure(conn: DaemonConn) -> None:
    """Close a socket whose DB/Redis/send ownership checks did not agree."""

    if conn.superseded_close_started:
        return
    conn.superseded_close_started = True
    try:
        await asyncio.wait_for(
            conn.websocket.close(
                code=WS_CLOSE_CONSISTENCY,
                reason="fencing consistency failure",
            ),
            timeout=1.0,
        )
    except Exception:
        conn.superseded_close_started = False


async def _close_real_supersession(conn: DaemonConn) -> None:
    await _fence_superseded_daemon(conn)


async def _close_host_signal_ownership_loss(conn: DaemonConn) -> None:
    """Distinguish an activated successor from an indeterminate fence failure.

    A signal can arrive after another worker promoted a newer host generation
    but before this worker consumes the explicit revocation event.  Treating
    that exact state as a generic consistency failure stops the signal pump
    without revoking its established RTC bindings, so the following revocation
    event can no longer clean them up.  The active Redis lease is the observable
    proof that a newer generation really won; a pending-only claimant or a
    missing/malformed lease still fails closed as a consistency error.
    """

    generation = conn.host_generation
    replacement: HostPresenceOwner | None = None
    try:
        replacement = decode_host_presence_owner(
            await get_backend().get_ephemeral(host_presence_key(conn.host_id))
        )
    except Exception:
        pass
    if (
        generation is not None
        and replacement is not None
        and replacement.daemon_connection_id != conn.id
        and replacement.generation > generation
    ):
        await _close_real_supersession(conn)
        return
    await _close_daemon_consistency_failure(conn)


async def _expire_host_rtc_binding(
    binding: RtcSessionBinding,
    daemon: DaemonConn,
) -> None:
    await asyncio.sleep(HOST_RTC_SESSION_TTL_SECONDS)
    if not await _validate_durable_host_owner(daemon) or not await _redis_owner_is_current(daemon):
        await _close_daemon_consistency_failure(daemon)
        return
    if not await get_broker().expire_rtc_session(binding.session_id, binding):
        return
    try:
        if isinstance(binding.browser, RedisBrowserConn):
            generation = daemon.host_generation
            if generation is not None:
                await asyncio.wait_for(
                    binding.browser._send_text_as_owner(
                        {
                            "type": "rtc.status",
                            "session_id": binding.session_id,
                            "scope_type": binding.scope_type,
                            "scope_id": binding.scope_id,
                            "protocol": binding.protocol,
                            "protocol_version": binding.protocol_version,
                            "binding_nonce": binding.nonce,
                            "binding_generation": binding.daemon_generation,
                            "status": "expired",
                        },
                        HostPresenceOwner(daemon.id, generation),
                    ),
                    timeout=HOST_EXTERNAL_EFFECT_TIMEOUT_SECONDS,
                )
        else:
            await _bounded_send_text(
                binding.browser,
                {
                    "type": "rtc.status",
                    "session_id": binding.session_id,
                    "scope_type": binding.scope_type,
                    "scope_id": binding.scope_id,
                    "protocol": binding.protocol,
                    "protocol_version": binding.protocol_version,
                    "binding_nonce": binding.nonce,
                    "binding_generation": binding.daemon_generation,
                    "status": "expired",
                },
            )
    except Exception:
        pass
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
    try:
        durable_owner = await _validate_durable_host_owner(conn)
    except (TimeoutError, SQLAlchemyError) as exc:
        log.warning(
            "dropping RTC relay frame after transient ownership DB failure host=%s: %s",
            conn.host_id,
            type(exc).__name__,
        )
        return True
    if not durable_owner or not await _redis_owner_is_current(conn):
        await _close_host_signal_ownership_loss(conn)
        return False
    signal = envelope.signal
    scope_id = signal.get("scope_id")
    if signal.get("scope_type") == "session" and isinstance(scope_id, str):
        session_id = _valid_rtc_session_id(signal.get("session_id"))
        if session_id is None:
            return True
        frame_type = signal.get("type")
        binding_nonce = signal.get("binding_nonce")
        binding = await broker.rtc_session_for(session_id, daemon=conn)
        if (
            binding is None
            or binding.scope_type != "session"
            or binding.scope_id != scope_id
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
                and await broker.rtc_binding_identity_is_retired(session_id, conn, binding_nonce)
            ):
                await _bounded_send_text(conn, signal)
            return True
        if frame_type == "rtc.offer":
            # Redis->daemon hop: carried_endorsements pass through here without
            # re-running sanitize_carried_endorsements — the field was sanitized
            # once at the authenticated browser ingress before dispatch, this
            # hop only ever forwards what that ingress published, and the
            # daemon independently caps the list at 64 edges and re-verifies
            # every signature before trusting any of it (mesh P2/P5).
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
        # Redis->daemon hop: as on the agent path above, carried_endorsements
        # are forwarded without re-running sanitize — the browser ingress
        # sanitized before dispatch, and the daemon re-caps and re-verifies.
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
        if signal.get("ice_restart") is True:
            existing_binding = await broker.rtc_session_for(session_id, daemon=conn)
            if not (
                existing_binding is not None
                and existing_binding.scope_type == "host"
                and existing_binding.scope_id == conn.host_id
                and existing_binding.browser.route_id == envelope.browser_channel
                and existing_binding.nonce == binding_nonce
                and existing_binding.signed_signal == signed_signal
                and signal.get("binding_generation") == existing_binding.daemon_generation
            ):
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
                            "binding_generation": signal.get("binding_generation"),
                            "status": "unavailable",
                        },
                    )
                except Exception:
                    pass
                return True
            await _bounded_send_text(conn, signal)
            return True
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
                await _close_daemon_consistency_failure(conn)
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
            await _close_host_signal_ownership_loss(conn)
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
        await _close_host_signal_ownership_loss(conn)
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
            if decode_browser_pins_changed(raw):
                # Another worker recorded a pin change (typically a
                # revocation) but does not hold this daemon's socket. Rebuild
                # the authoritative set here and deliver it now instead of
                # waiting for the daemon's next reconnect.
                try:
                    frame = await _browser_pins_frame(conn.host_id)
                    if frame is not None:
                        await _bounded_send_text(conn, frame)
                except Exception:
                    log.warning(
                        "could not relay browser pin change to daemon host=%s", conn.host_id
                    )
                continue
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
                        await _close_real_supersession(conn)
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


_LIVE_BINDING_FIELDS = frozenset(
    {
        "session_id",
        "binding_nonce",
        "binding_generation",
        "scope_type",
        "scope_id",
        "protocol",
        "protocol_version",
    }
)


def _validated_live_bindings(value: object) -> list[dict[str, object]]:
    if value is None:
        return []
    if not isinstance(value, list):
        log.warning("daemon register live_bindings is not a list; ignoring")
        return []
    if len(value) > 256:
        log.warning("daemon register live_bindings exceeds 256; truncating")
    valid: list[dict[str, object]] = []
    for index, item in enumerate(value[:256]):
        if not isinstance(item, dict) or set(item) != _LIVE_BINDING_FIELDS:
            log.warning("ignoring invalid live_bindings entry index=%d", index)
            continue
        session_id = _valid_rtc_session_id(item.get("session_id"))
        nonce = item.get("binding_nonce")
        generation = item.get("binding_generation")
        scope_type = item.get("scope_type")
        scope_id = item.get("scope_id")
        protocol = item.get("protocol")
        protocol_version = item.get("protocol_version")
        topology_valid = (scope_type, protocol, protocol_version) == (
            "session",
            "spawn.pty",
            2,
        ) or (scope_type, protocol, protocol_version) == (
            "host",
            HOST_CONTROL_PROTOCOL,
            HOST_CONTROL_VERSION,
        )
        if not (
            session_id is not None
            and valid_rtc_binding_nonce(nonce)
            and isinstance(generation, int)
            and not isinstance(generation, bool)
            and 1 <= generation <= MAX_SAFE_FENCING_GENERATION
            and isinstance(scope_id, str)
            and 0 < len(scope_id) <= 128
            and topology_valid
        ):
            log.warning("ignoring invalid live_bindings entry index=%d", index)
            continue
        valid.append(
            {
                "session_id": session_id,
                "binding_nonce": nonce,
                "binding_generation": generation,
                "scope_type": scope_type,
                "scope_id": scope_id,
                "protocol": protocol,
                "protocol_version": protocol_version,
            }
        )
    return valid


def _rtc_binding_frame(
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


async def _send_server_binding_status(
    binding: RtcSessionBinding,
    status_value: str,
    *,
    owner: DaemonConn | None = None,
) -> None:
    payload = _rtc_binding_frame(binding, "rtc.status", status=status_value)
    try:
        if isinstance(binding.browser, RedisBrowserConn):
            dispatch_owner = None
            if owner is not None and owner.host_generation is not None:
                dispatch_owner = HostPresenceOwner(owner.id, owner.host_generation)
            await binding.browser.send_server_status(
                payload,
                dispatch_owner=dispatch_owner,
            )
        else:
            await _bounded_send_text(binding.browser, payload)
    except Exception:
        log.warning(
            "could not publish rtc.status=%s session=%s",
            status_value,
            binding.session_id,
        )


async def _reconcile_live_bindings(
    conn: DaemonConn,
    live_bindings: list[dict[str, object]],
) -> None:
    broker = get_broker()
    rebound, absent, unknown = await broker.reconcile_daemon_live_bindings(conn, live_bindings)
    for binding in rebound:
        await _send_server_binding_status(binding, "rebound", owner=conn)
    for binding in absent:
        await _send_server_binding_status(binding, "unavailable", owner=conn)
        await broker.unregister_rtc_session(binding.session_id, binding.browser)
        await _bounded_send_text(conn, _rtc_binding_frame(binding, "rtc.close"))
    for item in unknown:
        await _bounded_send_text(conn, {"type": "rtc.close", **item})


_daemon_orphan_expiry_tasks: set[asyncio.Task[None]] = set()


def _schedule_daemon_orphan_expiry(binding: RtcSessionBinding) -> None:
    async def expire() -> None:
        deadline = binding.daemon_orphaned_until
        if deadline is None:
            return
        await asyncio.sleep(max(0.0, deadline - time.monotonic()))
        expired = await get_broker().expire_rtc_orphan(
            binding.session_id,
            binding.nonce,
            binding.daemon_generation,
            side="daemon",
        )
        if expired is not None:
            await _send_server_binding_status(expired, "unavailable")

    task = asyncio.create_task(expire())
    _daemon_orphan_expiry_tasks.add(task)
    task.add_done_callback(_daemon_orphan_expiry_tasks.discard)


@router.websocket("/ws/daemon")
async def daemon_ws(websocket: WebSocket, token: str | None = Query(default=None)) -> None:
    offered = websocket.scope.get("subprotocols") or []
    if DAEMON_WS_PROTOCOL not in offered:
        await websocket.accept()
        await websocket.send_json(
            {"type": "protocol.required", "protocol": DAEMON_WS_PROTOCOL, "version": 3}
        )
        await websocket.close(code=WS_CLOSE_PROTOCOL_REQUIRED, reason="protocol upgrade required")
        return
    await websocket.accept(subprotocol=DAEMON_WS_PROTOCOL)
    principal = await _resolve_daemon_host(websocket, token)
    if principal is None:
        return
    host, daemon_token_payload = principal

    broker = get_broker()
    conn = DaemonConn(host_id=host.id, user_id=host.owner_user_id, websocket=websocket)
    errors = ErrorFrameSender(conn.send_text)
    log.info("daemon pending host=%s user=%s", host.id, host.owner_user_id)

    signal_ready = asyncio.Event()
    expiry_tasks: set[asyncio.Task[None]] = set()
    signal_task = asyncio.create_task(_pump_host_rtc_signals(conn, signal_ready, expiry_tasks))
    # "The agent stopped talking" has no write to hang off, so it is a timer
    # per session, rearmed by every activity ping and owned by this connection.
    quiet_watch = QuietWatch(lambda sid: _publish_awaiting_input(conn, sid))

    registered = False
    registration_permit: asyncio.Semaphore | None = None
    disconnect_reason = "socket_closed"

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
                    await errors.send("invalid_frame", None)
                    continue
                if not isinstance(obj, dict):
                    log.warning("daemon sent non-object JSON text frame")
                    await errors.send("invalid_frame", None)
                    continue
                ftype = obj.get("type")
                if not isinstance(ftype, str):
                    await errors.send("invalid_frame", ftype)
                    continue

                if not registered and ftype != "register":
                    log.warning("pending daemon sent frame before register type=%s", ftype)
                    await errors.send("invalid_frame", ftype)
                    continue
                if (
                    registered
                    and ftype not in ("register", "host.heartbeat")
                    and not await _daemon_can_mutate(conn)
                ):
                    if await _has_newer_daemon_owner(conn):
                        await _close_real_supersession(conn)
                    else:
                        await _close_daemon_consistency_failure(conn)
                    break

                if ftype == "register":
                    if registered:
                        log.warning("daemon repeated register host=%s", host.id)
                        await errors.send("invalid_frame", ftype)
                        continue
                    if any(
                        field in obj and not isinstance(obj.get(field), bool)
                        for field in (
                            "keeps_peers_across_reconnect",
                            "session_ice_policy",
                            "worker_mismatch",
                        )
                    ):
                        await errors.send("invalid_frame", ftype)
                        continue
                    registration_permit = _registration_semaphore()
                    await registration_permit.acquire()
                    conn.keeps_peers_across_reconnect = (
                        obj.get("keeps_peers_across_reconnect") is True
                    )
                    conn.session_ice_policy = obj.get("session_ice_policy") is True
                    live_bindings = _validated_live_bindings(obj.get("live_bindings"))
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
                            await _close_daemon_consistency_failure(conn)
                            break
                    conn.host_generation = generation
                    claimed, _ = await _claim_host_signal_presence(conn)
                    if not claimed:
                        async with _bounded_host_ownership_session() as session:
                            await _clear_host_generation_reservation(
                                session, host.id, conn.id, generation
                            )
                        await _close_daemon_consistency_failure(conn)
                        break

                    value = _host_presence_value(conn)
                    assert value is not None
                    async with _bounded_host_ownership_session() as session:
                        predecessor = await _host_activation_predecessor(
                            session, host.id, conn.id, generation
                        )
                    if predecessor is False:
                        await _close_daemon_consistency_failure(conn)
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
                        if await _has_newer_daemon_owner(conn):
                            await _close_real_supersession(conn)
                        else:
                            await _close_daemon_consistency_failure(conn)
                        break
                    existing = obj.get("existing_sessions") or []
                    valid_existing: list[str] = []
                    durable_owner = False
                    async with _bounded_host_ownership_session() as session:
                        durable_owner = await _lock_durable_host_owner(session, conn)
                        if durable_owner:
                            for sid in existing:
                                if not isinstance(sid, str):
                                    continue
                                session_row = await session.get(Session, sid)
                                if session_row is not None and session_row.host_id == host.id:
                                    valid_existing.append(sid)
                        await session.rollback()

                    registration_accepted = False
                    if durable_owner and await _redis_owner_is_current(conn):
                        acceptance = await broker.accept_daemon_owner(conn, generation)
                        registration_accepted = bool(acceptance)
                        for sid in valid_existing if registration_accepted else ():
                            if not await broker.attach_session_to_daemon(
                                sid,
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
                        # Admission bounds the ownership transaction only;
                        # socket sends, live-binding reconciliation, and the
                        # update check must not occupy a database admission slot.
                        registration_permit.release()
                        registration_permit = None
                        # Carry the authoritative live pin set on every
                        # registration. A daemon otherwise learns its browser
                        # pins exactly once, at pairing, and never hears about
                        # a revocation — so a revoked browser would keep
                        # working against it indefinitely. Reconciling here is
                        # self-healing: a daemon that was offline or attached
                        # to another worker when the revocation happened still
                        # converges on its next connect.
                        registered_payload = {
                            "type": "registered",
                            "host_id": host.id,
                            "account_id": host.owner_user_id,
                            "browser_device_ids": await _live_browser_device_ids(host.id),
                            "browser_pins": await _live_browser_pins(host.id),
                            "revoked_browser_keys": await _revoked_browser_keys(host.owner_user_id),
                        }
                        if _daemon_token_needs_rotation(daemon_token_payload):
                            registered_payload["access_token"] = auth_mod.issue_daemon_token(
                                host.id, host.owner_user_id
                            )
                        await _bounded_send_text(conn, registered_payload)
                        registered = True
                        await publish_data_changed(host.owner_user_id, "hosts", host.id)
                        conn.durable_owner_valid_until = (
                            time.monotonic() + DURABLE_OWNERSHIP_CACHE_SECONDS
                        )
                        if conn.keeps_peers_across_reconnect:
                            await _reconcile_live_bindings(conn, live_bindings)
                        await _auto_update_after_registration(conn)
                    if not registration_accepted:
                        async with _bounded_host_ownership_session() as session:
                            await _mark_host_offline_if_owner(session, host.id, conn.id, generation)
                        await _close_daemon_consistency_failure(conn)
                        break
                elif ftype == "host.agents.check_result":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        if not await broker.resolve_agent_check(
                            request_id,
                            obj,
                            daemon=conn,
                            expected_host_generation=conn.host_generation,
                        ):
                            await _close_daemon_consistency_failure(conn)
                            break
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "daemon.update_result":
                    handled = await _handle_daemon_update_result(conn, obj)
                    if handled is False:
                        await _close_daemon_consistency_failure(conn)
                        break
                    if handled is None:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "host.pin_adopt_failed":
                    handled = await _handle_pin_adoption_result(conn, obj, failed=True)
                    if handled is None:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "host.pin_adopted":
                    handled = await _handle_pin_adoption_result(conn, obj, failed=False)
                    if handled is None:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "host.pong":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        if not await broker.resolve_host_pong(
                            request_id,
                            obj,
                            daemon=conn,
                            expected_host_generation=conn.host_generation,
                        ):
                            await _close_daemon_consistency_failure(conn)
                            break
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "host.agents.install_result":
                    request_id = obj.get("request_id")
                    if isinstance(request_id, str):
                        if not await broker.resolve_agent_install(
                            request_id,
                            obj,
                            daemon=conn,
                            expected_host_generation=conn.host_generation,
                        ):
                            await _close_daemon_consistency_failure(conn)
                            break
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "host.heartbeat":
                    generation = conn.host_generation
                    if generation is None:
                        await _close_daemon_consistency_failure(conn)
                        break
                    capacity = host_capacity.bucket_values(obj)
                    async with _bounded_host_ownership_session() as session:
                        touched = await _touch_host(session, host.id, conn.id, generation, capacity)
                    if touched:
                        conn.durable_owner_valid_until = (
                            time.monotonic() + DURABLE_OWNERSHIP_CACHE_SECONDS
                        )
                    if not touched or not await _refresh_host_signal_presence(conn):
                        await _close_daemon_consistency_failure(conn)
                        break
                    await _bounded_send_text(conn, {"type": "host.heartbeat"})

                elif ftype == "session.started":
                    sid = _valid_rtc_session_id(obj.get("session_id"))
                    if sid is not None:
                        generation = conn.host_generation
                        if generation is None:
                            await _close_daemon_consistency_failure(conn)
                            break
                        durable_owner = False
                        started = False
                        rejected_owner = False
                        started_owner_id: str | None = None
                        async with _bounded_host_ownership_session() as session:
                            durable_owner = await _lock_durable_host_owner(session, conn)
                            session_row = await session.get(Session, sid) if durable_owner else None
                            if session_row is not None and session_row.host_id == host.id:
                                started_owner_id = session_row.owner_user_id
                                result = await session.execute(
                                    update(Session)
                                    .where(
                                        Session.id == sid,
                                        Session.host_id == host.id,
                                        _session_owner_exists(conn),
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
                            await _close_daemon_consistency_failure(conn)
                            break
                        if rejected_owner:
                            await _close_daemon_consistency_failure(conn)
                            break
                        if started:
                            attached = await broker.attach_session_to_daemon(
                                sid,
                                conn,
                                expected_host_generation=generation,
                            )
                            published = attached and await _publish_session_event_if_owner(
                                conn,
                                sid,
                                {"type": "session.status", "status": "running"},
                            )
                            if not published:
                                await _close_daemon_consistency_failure(conn)
                                break
                            # The per-session event above reaches only panes
                            # already open on this session; the account-wide
                            # frame is what flips the list everywhere else.
                            if started_owner_id is not None:
                                await publish_data_changed(started_owner_id, "sessions", sid)
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "session.activity":
                    # Content-free output-activity ping (trust Phase 2). The
                    # daemon already classified meaningful output and throttled
                    # it, so the server just stamps — it never sees the bytes.
                    sid = _valid_rtc_session_id(obj.get("session_id"))
                    if sid is not None:
                        now = _utcnow()
                        durable_owner = False
                        rejected_owner = False
                        async with _bounded_host_ownership_session() as session:
                            durable_owner = await _lock_durable_host_owner(session, conn)
                            session_row = await session.get(Session, sid) if durable_owner else None
                            if session_row is not None and session_row.host_id == host.id:
                                generation = conn.host_generation
                                if generation is None:
                                    await session.rollback()
                                else:
                                    result = await session.execute(
                                        update(Session)
                                        .where(
                                            Session.id == sid,
                                            Session.host_id == host.id,
                                            _session_owner_exists(conn),
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
                            await _close_daemon_consistency_failure(conn)
                            break
                        if rejected_owner:
                            await _close_daemon_consistency_failure(conn)
                            break
                        quiet_watch.touch(sid)
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "session.input_activity":
                    # `spawn.pty` input bypasses the server. The daemon
                    # throttles this content-free signal so the activity badge
                    # remains accurate without revealing input bytes.
                    sid = _valid_rtc_session_id(obj.get("session_id"))
                    if sid is not None:
                        now = _utcnow()
                        durable_owner = False
                        rejected_owner = False
                        async with _bounded_host_ownership_session() as session:
                            durable_owner = await _lock_durable_host_owner(session, conn)
                            session_row = await session.get(Session, sid) if durable_owner else None
                            if session_row is not None and session_row.host_id == host.id:
                                generation = conn.host_generation
                                if generation is None:
                                    await session.rollback()
                                else:
                                    result = await session.execute(
                                        update(Session)
                                        .where(
                                            Session.id == sid,
                                            Session.host_id == host.id,
                                            _session_owner_exists(conn),
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
                            await _close_daemon_consistency_failure(conn)
                            break
                        if rejected_owner:
                            await _close_daemon_consistency_failure(conn)
                            break
                        # Cancelled, not rearmed: input means the *user* spoke
                        # last, so the agent owes them a reply. Its reply is
                        # what starts a turn, and the end of that reply is what
                        # this feature is about.
                        quiet_watch.cancel(sid)
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "session.foreground":
                    # The one deliberate, documented exception to content-free
                    # activity: a process basename (nothing else) so the UI
                    # can label panes. Re-derive the basename and truncate
                    # server-side rather than trusting the daemon's framing.
                    sid = _valid_rtc_session_id(obj.get("session_id"))
                    command = obj.get("command")
                    if sid is not None and (command is None or isinstance(command, str)):
                        basename: str | None = None
                        if isinstance(command, str):
                            basename = (
                                command.strip().replace("\\", "/").rsplit("/", 1)[-1][:64] or None
                            )
                        durable_owner = False
                        rejected_owner = False
                        # Captured before the write: this is the whole reason
                        # detection lives here rather than in the browser. The
                        # previous foreground is in hand exactly once, and only
                        # at this point.
                        finished_alert: dict[str, object] | None = None
                        summoned_agent: str | None = None
                        async with _bounded_host_ownership_session() as session:
                            durable_owner = await _lock_durable_host_owner(session, conn)
                            session_row = await session.get(Session, sid) if durable_owner else None
                            if session_row is not None and session_row.host_id == host.id:
                                previous_command = session_row.foreground_command
                                session_status = session_row.status
                                alert_owner_id = session_row.owner_user_id
                                result = await session.execute(
                                    update(Session)
                                    .where(
                                        Session.id == sid,
                                        Session.host_id == host.id,
                                        _session_owner_exists(conn),
                                    )
                                    .values(foreground_command=basename)
                                    .execution_options(synchronize_session=False)
                                )
                                if result.rowcount == 1:
                                    await session.commit()
                                    # One tally per arrival at the front, not
                                    # per report: the daemon only sends this
                                    # frame on change, and a shell coming back
                                    # to the foreground is not an agent run.
                                    if basename and not is_shell_command(basename):
                                        summoned_agent = basename
                                    if is_agent_finish(previous_command, basename, session_status):
                                        finished_alert = agent_finished_payload(
                                            sid, previous_command or ""
                                        )
                                else:
                                    rejected_owner = True
                                    await session.rollback()
                            else:
                                await session.rollback()
                        if not durable_owner:
                            await _close_daemon_consistency_failure(conn)
                            break
                        if rejected_owner:
                            await _close_daemon_consistency_failure(conn)
                            break
                        if summoned_agent is not None:
                            await legion.record_agent(alert_owner_id, summoned_agent)
                        if basename is None or is_shell_command(basename):
                            # Back at a prompt: there is nothing left to go
                            # quiet, and `agent.finished` already covers this.
                            quiet_watch.cancel(sid)
                        # An agent *taking* the foreground deliberately does
                        # not start the clock. Only output does. A worker
                        # re-reports its foreground on every reconnect, so
                        # arming here raised an "is waiting for you" for a
                        # session that had done nothing at all.
                        if finished_alert is not None:
                            await _publish_user_alert(conn, alert_owner_id, finished_alert)
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "session.exit":
                    sid = _valid_rtc_session_id(obj.get("session_id"))
                    code = obj.get("exit_code")
                    sig = obj.get("signal")
                    exit_shape_valid = (
                        code is None or isinstance(code, int) and not isinstance(code, bool)
                    ) and (sig is None or isinstance(sig, str))
                    if sid is not None and exit_shape_valid:
                        durable_owner = False
                        exited = False
                        rejected_owner = False
                        died_alert: dict[str, object] | None = None
                        ran_seconds = 0
                        async with _bounded_host_ownership_session() as session:
                            durable_owner = await _lock_durable_host_owner(session, conn)
                            session_row = await session.get(Session, sid) if durable_owner else None
                            if session_row is not None and session_row.host_id == host.id:
                                # Read before the write, which nulls it. This
                                # is what lets the alert name the agent that
                                # went down with the session.
                                dying_command = session_row.foreground_command
                                alert_owner_id = session_row.owner_user_id
                                # How long this circle stayed open. Read here
                                # for the same reason: after the update the row
                                # is still present, but this is the one place
                                # both ends of the interval are certainly in
                                # hand and certainly this daemon's to report.
                                started = session_row.started_at
                                if started is not None:
                                    if started.tzinfo is None:
                                        started = started.replace(tzinfo=UTC)
                                    ran_seconds = max(0, int((_utcnow() - started).total_seconds()))
                                result = await session.execute(
                                    update(Session)
                                    .where(
                                        Session.id == sid,
                                        Session.host_id == host.id,
                                        _session_owner_exists(conn),
                                    )
                                    .values(
                                        status="killed" if sig else "exited",
                                        exit_code=code,
                                        exited_at=_utcnow(),
                                        foreground_command=None,
                                    )
                                    .execution_options(synchronize_session=False)
                                )
                                exited = result.rowcount == 1
                                rejected_owner = not exited
                                if exited:
                                    await session.commit()
                                    # Exactly one alert for this transition:
                                    # the same update nulls foreground_command,
                                    # so `is_agent_finish` sees a status that
                                    # has left "running" and stays silent.
                                    died_alert = session_died_payload(
                                        sid,
                                        dying_command,
                                        exit_code=code if isinstance(code, int) else None,
                                        signal=sig if isinstance(sig, str) else None,
                                    )
                                else:
                                    await session.rollback()
                            else:
                                await session.rollback()
                        if not durable_owner:
                            await _close_daemon_consistency_failure(conn)
                            break
                        if rejected_owner:
                            await _close_daemon_consistency_failure(conn)
                            break
                        published = not exited or await _publish_session_event_if_owner(
                            conn,
                            sid,
                            {
                                "type": "session.exit",
                                "exit_code": code,
                                "signal": sig,
                            },
                        )
                        if exited:
                            await legion.record_session_seconds(alert_owner_id, ran_seconds)
                        quiet_watch.cancel(sid)
                        if died_alert is not None:
                            await _publish_user_alert(conn, alert_owner_id, died_alert)
                        if exited:
                            # The alert above is a courtesy some accounts mute;
                            # the data frame is what removes the pane from
                            # every other open client either way.
                            await publish_data_changed(alert_owner_id, "sessions", sid)
                        detached = await broker.detach_session(
                            sid,
                            expected_daemon=conn,
                            expected_host_generation=conn.host_generation,
                        )
                        if exited and (not published or not detached):
                            await _close_daemon_consistency_failure(conn)
                            break
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "agent.uploaded":
                    log.warning("retired server-visible agent upload acknowledgement; closing")
                    await websocket.close(
                        code=WS_CLOSE_CONTENT_FORBIDDEN,
                        reason="agent upload acknowledgements belong on spawn.ctl",
                    )
                    break

                elif ftype == "rtc.answer":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    if session_id is not None:
                        binding = await broker.rtc_session_for(session_id, daemon=conn)
                        if binding is None or not _rtc_frame_matches_binding(obj, binding):
                            log.warning("rtc answer did not match its registered session")
                            await errors.send("invalid_frame", ftype)
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
                                    await errors.send("invalid_frame", ftype)
                                    continue
                        except SignedRtcRelayError:
                            await errors.send("invalid_frame", ftype)
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
                        payload.update(
                            {
                                "scope_type": binding.scope_type,
                                "scope_id": binding.scope_id,
                                "protocol": binding.protocol,
                                "protocol_version": binding.protocol_version,
                            }
                        )
                        if not await _route_rtc_payload_if_owner(conn, binding, payload):
                            await _close_daemon_consistency_failure(conn)
                            break
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "rtc.candidate":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    candidate = _valid_rtc_candidate(obj.get("candidate"))
                    if session_id is not None and candidate is not None:
                        binding = await broker.rtc_session_for(session_id, daemon=conn)
                        if binding is None or not _rtc_frame_matches_binding(obj, binding):
                            log.warning("rtc candidate did not match its registered session")
                            await errors.send("invalid_frame", ftype)
                            continue
                        payload = {
                            "type": "rtc.candidate",
                            "session_id": session_id,
                            "binding_nonce": binding.nonce,
                            "binding_generation": binding.daemon_generation,
                            "candidate": candidate,
                        }
                        payload.update(
                            {
                                "scope_type": binding.scope_type,
                                "scope_id": binding.scope_id,
                                "protocol": binding.protocol,
                                "protocol_version": binding.protocol_version,
                            }
                        )
                        if not await _route_rtc_payload_if_owner(conn, binding, payload):
                            await _close_daemon_consistency_failure(conn)
                            break
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "rtc.status":
                    session_id = _valid_rtc_session_id(obj.get("session_id"))
                    status_value = obj.get("status")
                    if session_id and isinstance(status_value, str) and len(status_value) <= 64:
                        binding = await broker.rtc_session_for(session_id, daemon=conn)
                        if binding is None or not _rtc_frame_matches_binding(obj, binding):
                            log.warning("rtc status did not match its registered session")
                            await errors.send("invalid_frame", ftype)
                            continue
                        if (
                            binding.scope_type == "host"
                            and status_value not in HOST_RTC_STATUS_ALLOWLIST
                        ):
                            log.warning("daemon sent non-allowlisted host rtc status")
                            await errors.send("invalid_frame", ftype)
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
                        message = obj.get("message")
                        if isinstance(message, str):
                            payload["message"] = message[:256]
                        payload.update(
                            {
                                "scope_type": binding.scope_type,
                                "scope_id": binding.scope_id,
                                "protocol": binding.protocol,
                                "protocol_version": binding.protocol_version,
                            }
                        )
                        if not await _route_rtc_payload_if_owner(conn, binding, payload):
                            await _close_daemon_consistency_failure(conn)
                            break
                        if (
                            mark_connected
                            and await broker.mark_rtc_session_connected(session_id, binding) is None
                        ):
                            continue
                    else:
                        await errors.send("invalid_frame", ftype)

                elif ftype == "error":
                    if not isinstance(obj.get("code"), str):
                        await errors.send("invalid_frame", ftype)
                    elif obj.get("code") == "upload_failed":
                        log.warning("retired server-visible agent upload error; closing")
                        await websocket.close(
                            code=WS_CLOSE_CONTENT_FORBIDDEN,
                            reason="agent upload errors belong on spawn.ctl",
                        )
                        break
                    log.warning(
                        "daemon error host=%s session=%s code=%s msg=%s",
                        host.id,
                        obj.get("session_id"),
                        obj.get("code"),
                        (
                            obj.get("message")[:256]
                            if isinstance(obj.get("message"), str)
                            else obj.get("message")
                        ),
                    )
                else:
                    log.warning("daemon sent unknown frame type=%s", ftype)
                    await errors.send("unknown_frame", ftype)
    except SubscriptionLostError:
        if not conn.superseded_close_started:
            await websocket.close(
                code=WS_CLOSE_SUBSCRIPTION_LOST,
                reason="subscription lost",
            )
    except WebSocketDisconnect as exc:
        if exc.code == 4008 or "keepalive" in (exc.reason or "").lower():
            disconnect_reason = "keepalive_timeout"
    except asyncio.CancelledError:
        await websocket.close(code=WS_CLOSE_SERVER_RESTART, reason="server restart")
        raise
    except Exception as e:  # noqa: BLE001
        log.exception("daemon ws crashed: %s", e)
        await _close_daemon_consistency_failure(conn)
    finally:
        if registration_permit is not None:
            registration_permit.release()
            registration_permit = None
        preserve_rtc = (
            registered and conn.keeps_peers_across_reconnect and not conn.superseded_by_newer
        )
        if preserve_rtc:
            orphaned = await broker.orphan_rtc_sessions_for_daemon(
                conn,
                grace_seconds=RTC_BINDING_ORPHAN_GRACE_SECONDS,
            )
            for binding in orphaned:
                await _send_server_binding_status(binding, "signalling_lost")
                _schedule_daemon_orphan_expiry(binding)
        else:
            await _revoke_host_rtc_sessions(conn)
        pending_expiry_tasks = list(expiry_tasks)
        for task in pending_expiry_tasks:
            task.cancel()
        if pending_expiry_tasks:
            await asyncio.gather(*pending_expiry_tasks, return_exceptions=True)
        await quiet_watch.shutdown()
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
        await broker.unregister_daemon(conn, preserve_rtc=preserve_rtc)
        if conn.host_generation is not None:
            async with _bounded_host_ownership_session() as session:
                await _clear_host_generation_reservation(
                    session, host.id, conn.id, conn.host_generation
                )
            async with _bounded_host_ownership_session() as session:
                marked_offline = await _mark_host_offline_if_owner(
                    session,
                    host.id,
                    conn.id,
                    conn.host_generation,
                    reason=disconnect_reason,
                )
            if marked_offline:
                await publish_data_changed(host.owner_user_id, "hosts", host.id)
        log.info("daemon disconnected host=%s", host.id)


async def _browser_pins_frame(host_id: str) -> dict[str, Any] | None:
    """The authoritative full-set frame; removal is implicit in replacement.

    `browser_device_ids` and `browser_pins` are always built together: the
    daemon treats an absent id list as "server cannot report" and prunes
    nothing, so a frame carrying pins without ids silently disables
    revocation.
    """

    async with _bounded_host_ownership_session() as session:
        host = await session.get(Host, host_id)
        if host is None:
            return None
        owner_user_id = host.owner_user_id
    return {
        "type": "host.browser_pins",
        "account_id": owner_user_id,
        "browser_device_ids": await _live_browser_device_ids(host_id),
        "browser_pins": await _live_browser_pins(host_id),
        "revoked_browser_keys": await _revoked_browser_keys(owner_user_id),
    }


async def push_browser_pins(host_id: str) -> bool:
    """Tell a connected daemon its browser pin set changed.

    Best effort by design. Reconciliation at registration is the guarantee;
    this only removes the wait. When another worker holds the daemon's socket,
    the change is relayed over the host's cross-worker signal channel so a
    revocation lands promptly regardless of which worker served the request —
    a revocation that waited for the daemon's next reconnect could take days.
    """

    daemon = get_broker().get_daemon_for_host(host_id)
    if daemon is None:
        try:
            await get_backend().publish_channel(
                host_signal_channel(host_id), encode_browser_pins_changed()
            )
        except Exception:
            log.warning("could not relay browser pin change host=%s", host_id)
            return False
        return True
    frame = await _browser_pins_frame(host_id)
    if frame is None:
        return False
    try:
        await _bounded_send_text(daemon, frame)
    except Exception:
        log.warning("could not push browser pins to daemon host=%s", host_id)
        return False
    return True
