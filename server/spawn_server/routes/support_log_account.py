"""The owner's stored support statement and collection history."""

from __future__ import annotations

import asyncio
import math
from datetime import UTC, timedelta
from weakref import WeakValueDictionary

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import ClientDisconnect

from .. import auth, data_events, schemas, support_consent
from ..db import get_session, get_sessionmaker
from ..models import BrowserDevice, Host, SupportLogConsent, User, _utcnow
from ..models import SupportLogCollection as Collection
from ..schemas import SupportLogError
from ..support_consent import ConsentError, ConsentReason
from ..support_log_files import finish_job
from .support_log import bounded_body

router = APIRouter(prefix="/api/support-log", tags=["support-log"])
MAX_STATEMENT_BYTES = 64 * 1024
# Only overlapping requests share a lock. The single server worker is the only
# statement writer. The locks carry no timestamps or history across requests.
_write_locks: WeakValueDictionary[str, asyncio.Lock] = WeakValueDictionary()
_publish_tasks: set[asyncio.Task[None]] = set()


async def account_state(owner: str, db: AsyncSession):
    consent = SupportLogConsent
    stored = (
        await db.execute(
            select(
                consent.enabled,
                consent.issued_at_ms,
                consent.signed_device_id.label("signer_device_id"),
                BrowserDevice.label.label("signer_device_name"),
                support_consent.sharing_on(owner).label("sharing_on"),
            )
            .outerjoin(
                BrowserDevice,
                and_(
                    BrowserDevice.id == consent.signer_device_id,
                    BrowserDevice.owner_user_id == owner,
                    BrowserDevice.public_key == consent.signer_public_key,
                ),
            )
            .where(consent.owner_user_id == owner)
        )
    ).one_or_none()
    statement = None
    sharing = "off"
    if stored is not None:
        statement = schemas.StoredSupportStatement.model_validate(stored, from_attributes=True)
        if stored.enabled:
            sharing = "on" if stored.sharing_on else "off_signer_removed"
    try:
        next_time = support_consent.next_timestamp(statement.issued_at_ms if statement else None)
    except ConsentError as exc:
        next_time = {"code": exc.reason}

    hosts = await db.execute(
        select(Host.id, Host.name, Host.support_log_capable.label("capable"), Host.last_seen_at)
        .where(Host.owner_user_id == owner)
        .order_by(Host.name, Host.id)
    )
    now = _utcnow()
    records = await db.execute(
        select(
            Collection.id,
            Collection.host_id,
            Collection.host_name,
            Collection.state,
            Collection.decline_code,
            Collection.reason,
            Collection.requested_at,
            Collection.completed_at,
            Collection.size_bytes,
            Collection.expires_at,
            Collection.deleted_at,
        )
        .where(
            Collection.owner_user_id == owner,
            Collection.requested_at.between(now - timedelta(days=365), now),
        )
        .order_by(Collection.requested_at.desc(), Collection.id)
        .limit(100)
    )
    collections = []
    for row in records.mappings():
        record = dict(row)
        if record["state"] != "declined":
            del record["decline_code"]
        collections.append(record)
    return dict(
        statement=statement,
        sharing=sharing,
        next_issued_at_ms=next_time,
        hosts=[dict(row) for row in hosts.mappings()],
        collections=collections,
        retention_days=7,
    )


@router.get("", response_model=schemas.SupportLogAccountOut, response_model_exclude_unset=True)
async def get_support_log(
    user: User = Depends(auth.current_user), db: AsyncSession = Depends(get_session)
):
    async with db:
        return await account_state(user.id, db)


async def read_statement(request: Request):
    try:
        raw = bytes(await bounded_body(request, MAX_STATEMENT_BYTES))
    except ClientDisconnect:
        raise HTTPException(422, {"code": ConsentReason.INVALID_ENVELOPE}) from None
    except HTTPException as exc:
        if exc.status_code == 413:
            raise HTTPException(413, {"code": "body_too_large"}) from None
        if exc.status_code == 408:
            raise HTTPException(408, {"code": "receive_timeout"}) from None
        raise HTTPException(422, {"code": ConsentReason.INVALID_ENVELOPE}) from None
    try:
        body = schemas.SupportLogConsentIn.model_validate(support_consent.strict_json(raw))
    except (ValueError, RecursionError):
        raise HTTPException(422, {"code": ConsentReason.INVALID_ENVELOPE}) from None
    return raw, body


async def verify_repeated_off(owner, raw):
    # Idempotence skips the write, but a malformed or foreign signature must
    # never get a successful response, even when the stored choice is off.
    statement = await asyncio.to_thread(support_consent.verify_statement, raw)
    if statement["issued_at_ms"] > support_consent.now_ms() + support_consent.FUTURE_MS:
        raise ConsentError(ConsentReason.FUTURE_TIMESTAMP)
    async with get_sessionmaker()() as db:
        device = (
            await db.execute(
                select(BrowserDevice.public_key, BrowserDevice.revoked_at).where(
                    BrowserDevice.id == statement["signer_device_id"],
                    BrowserDevice.owner_user_id == owner,
                )
            )
        ).one_or_none()
    if device is None:
        raise ConsentError(ConsentReason.SIGNER_UNTRUSTED)
    if device.revoked_at is not None:
        raise ConsentError(ConsentReason.SIGNER_REMOVED)
    if device.public_key != statement["signer_public_key"]:
        raise ConsentError(ConsentReason.SIGNER_KEY_MISMATCH)


_REFUSAL_STATUS = {
    ConsentReason.STALE_STATEMENT: 409,
    ConsentReason.INVALID_SIGNATURE: 400,
    ConsentReason.SIGNER_UNTRUSTED: 403,
    ConsentReason.SIGNER_REMOVED: 403,
    ConsentReason.SIGNER_KEY_MISMATCH: 403,
    ConsentReason.ACCOUNT_MISMATCH: 403,
    ConsentReason.INVALID_ENVELOPE: 422,
    ConsentReason.FUTURE_TIMESTAMP: 422,
    ConsentReason.TIMESTAMP_OVERFLOW: 422,
}


async def store_and_notify(
    owner: str, raw: bytes, enabled: bool, wake: asyncio.Event, origin: str | None
) -> None:
    consent = SupportLogConsent
    async with get_sessionmaker()() as db:
        current = (
            await db.execute(
                select(consent.enabled, consent.updated_at, consent.issued_at_ms).where(
                    consent.owner_user_id == owner
                )
            )
        ).one_or_none()

    # The released daemon stops sharing until restart after 30 writes in ten
    # minutes. A minute since the last stored change allows at most ten ons
    # and ten offs per ten minutes. A withdrawal never has a cooldown.
    if enabled and current is not None:
        updated = current.updated_at
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=UTC)
        remaining = (updated + timedelta(seconds=60) - _utcnow()).total_seconds()
        if remaining > 0:
            raise HTTPException(
                429, {"code": "rate_limited", "retry_after_seconds": math.ceil(remaining)}
            )
    try:
        if current is not None and not current.enabled and not enabled:
            await verify_repeated_off(owner, raw)
            return
        # Withdrawal marks collected rows in this commit. The orphan sweep
        # removes their files, so the account route needs no store handle.
        await support_consent.store_statement(owner, raw)
    except ConsentError as exc:
        detail = {"code": exc.reason}
        if exc.reason == ConsentReason.STALE_STATEMENT:
            detail["issued_at_ms"] = current.issued_at_ms
        raise HTTPException(_REFUSAL_STATUS[exc.reason], detail) from None
    wake.set()
    task = asyncio.create_task(
        data_events.publish_data_changed(owner, data_events.SUPPORT_LOG_RESOURCE, origin=origin)
    )
    _publish_tasks.add(task)
    task.add_done_callback(_publish_tasks.discard)


@router.put(
    "/consent",
    response_model=schemas.SupportLogAccountOut,
    response_model_exclude_unset=True,
    responses={
        400: {"model": SupportLogError[schemas.InvalidConsentSignature]},
        401: {"model": SupportLogError[str]},
        403: {"model": SupportLogError[schemas.ConsentSignerRefusal]},
        408: {"model": SupportLogError[schemas.ConsentReceiveTimeout]},
        409: {"model": SupportLogError[schemas.StaleConsent]},
        413: {"model": SupportLogError[schemas.ConsentBodyTooLarge]},
        422: {"model": SupportLogError[schemas.InvalidConsentStatement]},
        429: {"model": SupportLogError[schemas.ConsentCooldown]},
    },
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "application/json": {"schema": schemas.SupportLogConsentIn.model_json_schema()},
            },
        }
    },
)
async def put_support_consent(
    request: Request,
    user: User = Depends(auth.current_user),
    db: AsyncSession = Depends(get_session),
):
    owner = user.id
    await db.close()  # Release the authentication connection before waiting for a body or writer.
    raw, body = await read_statement(request)
    if body.account_id != owner:
        raise HTTPException(403, {"code": ConsentReason.ACCOUNT_MISMATCH})
    wake = request.app.state.support_log_pump.wake
    origin = data_events._bounded(request.headers.get("x-spawn-client"))
    async with _write_locks.setdefault(owner, asyncio.Lock()):
        # Defer request cancellation until a committed write has scheduled its notification.
        await finish_job(store_and_notify(owner, raw, body.enabled, wake, origin))
    async with db:
        return await account_state(owner, db)
