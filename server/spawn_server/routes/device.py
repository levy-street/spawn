"""Device-code OAuth-style flow for daemon (`spawnd`) onboarding."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..config import get_settings
from ..db import get_session
from ..host_identity import host_key_fingerprint
from ..models import DeviceCode, Host, User

router = APIRouter(prefix="/api/auth/device", tags=["device"])

DEVICE_CODE_TTL_SECONDS = (
    30 * 60
)  # 30 minutes — comfortable for "see code, switch to phone, approve".
POLL_INTERVAL_SECONDS = 5
USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite drops tzinfo. Re-attach UTC if missing so comparisons work."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def _gen_user_code() -> str:
    a = "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(4))
    b = "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(4))
    return f"{a}-{b}"


def _gen_device_code() -> str:
    return secrets.token_urlsafe(32)


@router.post("/start", response_model=schemas.DeviceStartResponse)
async def device_start(
    body: schemas.DeviceStartRequest,
    session: AsyncSession = Depends(get_session),
) -> schemas.DeviceStartResponse:
    now = _utcnow()
    expires_at = now + timedelta(seconds=DEVICE_CODE_TTL_SECONDS)

    # Only one live approval ceremony may exist for a key. Stale rows can be
    # replaced; successful rows are deleted by poll, while the Host pin is the
    # durable identity authority.
    existing_key = (
        await session.execute(
            select(DeviceCode).where(
                DeviceCode.host_key_algorithm == body.host_key_algorithm,
                DeviceCode.host_public_key == body.host_public_key,
            )
        )
    ).scalar_one_or_none()
    if existing_key is not None:
        existing_expiry = _aware(existing_key.expires_at)
        if existing_key.status in {"pending", "approved", "consuming"} and (
            existing_expiry is None or existing_expiry > now
        ):
            raise HTTPException(status_code=409, detail="host key pairing already in progress")
        await session.delete(existing_key)
        await session.flush()

    # Retry user_code generation on rare collision.
    for _ in range(8):
        user_code = _gen_user_code()
        existing = (
            await session.execute(select(DeviceCode).where(DeviceCode.user_code == user_code))
        ).scalar_one_or_none()
        if existing is None:
            break
    else:
        raise HTTPException(status_code=500, detail="could not allocate user_code")

    dc = DeviceCode(
        device_code=_gen_device_code(),
        user_code=user_code,
        host_name=body.host_name,
        os=body.os,
        arch=body.arch,
        version=body.version,
        host_key_algorithm=body.host_key_algorithm,
        host_public_key=body.host_public_key,
        status="pending",
        expires_at=expires_at,
    )
    session.add(dc)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="host key pairing already in progress") from exc

    return schemas.DeviceStartResponse(
        device_code=dc.device_code,
        user_code=dc.user_code,
        verification_uri=f"{get_settings().public_url.rstrip('/')}/device",
        interval=POLL_INTERVAL_SECONDS,
        expires_in=DEVICE_CODE_TTL_SECONDS,
    )


@router.post("/poll")
async def device_poll(
    body: schemas.DevicePollRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    now = _utcnow()
    poll_cutoff = now - timedelta(seconds=POLL_INTERVAL_SECONDS - 1)

    # Claim first, before loading an ORM entity. On SQLite this write-first
    # transition serializes competing writers without read-to-write upgrade
    # deadlocks; on PostgreSQL the conditional UPDATE provides the same CAS.
    # RETURNING supplies the immutable ceremony snapshot without introducing a
    # tracked DeviceCode that an autoflush could later race against deletion.
    claim_result = await session.execute(
        update(DeviceCode)
        .where(
            DeviceCode.device_code == body.device_code,
            DeviceCode.status == "approved",
            DeviceCode.user_id.is_not(None),
            DeviceCode.host_key_algorithm == body.host_key_algorithm,
            DeviceCode.host_public_key == body.host_public_key,
            DeviceCode.expires_at > now,
            or_(
                DeviceCode.last_polled_at.is_(None),
                DeviceCode.last_polled_at <= poll_cutoff,
            ),
        )
        .values(status="consuming", last_polled_at=now)
        .returning(
            DeviceCode.user_id,
            DeviceCode.host_name,
            DeviceCode.os,
            DeviceCode.arch,
            DeviceCode.version,
        )
        .execution_options(synchronize_session=False)
    )
    claimed = claim_result.mappings().one_or_none()

    if claimed is None:
        # Release the write transaction before examining why the CAS lost. A
        # concurrent winner may already have deleted the row by the time this
        # fresh read begins, which is the stable one-shot expired response.
        await session.rollback()
        snapshot = (
            (
                await session.execute(
                    select(
                        DeviceCode.host_key_algorithm,
                        DeviceCode.host_public_key,
                        DeviceCode.status,
                        DeviceCode.user_id,
                        DeviceCode.expires_at,
                        DeviceCode.last_polled_at,
                    ).where(DeviceCode.device_code == body.device_code)
                )
            )
            .mappings()
            .one_or_none()
        )
        if snapshot is None:
            return {"error": "expired_token"}

        if (
            snapshot["host_key_algorithm"] is None
            or snapshot["host_public_key"] is None
            or snapshot["host_key_algorithm"] != body.host_key_algorithm
            or snapshot["host_public_key"] != body.host_public_key
        ):
            return {"error": "invalid_device_binding"}

        expires = _aware(snapshot["expires_at"])
        if expires is not None and expires <= now:
            await session.execute(
                update(DeviceCode)
                .where(
                    DeviceCode.device_code == body.device_code,
                    DeviceCode.expires_at <= now,
                )
                .values(status="expired", last_polled_at=now)
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return {"error": "expired_token"}

        # A claimed ceremony is already one-shot even while its winning
        # transaction is still creating the Host. Never expose that transient
        # state as pending or slow_down to a losing concurrent poll.
        if snapshot["status"] in {"consuming", "expired"}:
            await session.rollback()
            return {"error": "expired_token"}

        last = _aware(snapshot["last_polled_at"])
        if last is not None and (now - last).total_seconds() < (POLL_INTERVAL_SECONDS - 1):
            await session.execute(
                update(DeviceCode)
                .where(
                    DeviceCode.device_code == body.device_code,
                    DeviceCode.status != "consuming",
                )
                .values(last_polled_at=now)
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return {"error": "slow_down"}

        if snapshot["status"] == "denied":
            await session.execute(
                update(DeviceCode)
                .where(
                    DeviceCode.device_code == body.device_code,
                    DeviceCode.status == "denied",
                )
                .values(last_polled_at=now)
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return {"error": "denied"}

        if snapshot["status"] != "approved" or snapshot["user_id"] is None:
            await session.execute(
                update(DeviceCode)
                .where(
                    DeviceCode.device_code == body.device_code,
                    DeviceCode.status != "consuming",
                )
                .values(last_polled_at=now)
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return {"error": "authorization_pending"}

        # An eligible approved snapshot can reach this point only by losing the
        # claim to a concurrent consumer. Keep that loss one-shot and stable.
        await session.rollback()
        return {"error": "expired_token"}

    user_id = claimed["user_id"]
    assert user_id is not None

    host = (
        await session.execute(
            select(Host).where(
                Host.host_key_algorithm == body.host_key_algorithm,
                Host.host_public_key == body.host_public_key,
            )
        )
    ).scalar_one_or_none()
    if host is not None and host.owner_user_id != user_id:
        await session.execute(
            update(DeviceCode)
            .where(DeviceCode.device_code == body.device_code)
            .values(status="denied")
            .execution_options(synchronize_session=False)
        )
        await session.commit()
        return {"error": "key_conflict"}

    if host is None:
        host = Host(
            owner_user_id=user_id,
            name=claimed["host_name"] or "host",
            os=claimed["os"],
            arch=claimed["arch"],
            version=claimed["version"],
            host_key_algorithm=body.host_key_algorithm,
            host_public_key=body.host_public_key,
            status="offline",
        )
        session.add(host)
        await session.flush()
    else:
        # Re-login preserves both host identity and any user-assigned name.
        host.os = claimed["os"]
        host.arch = claimed["arch"]
        host.version = claimed["version"]

    token = auth.issue_daemon_token(host.id, user_id)
    fingerprint = host_key_fingerprint(body.host_key_algorithm, body.host_public_key)
    await session.execute(
        delete(DeviceCode)
        .where(
            DeviceCode.device_code == body.device_code,
            DeviceCode.status == "consuming",
        )
        .execution_options(synchronize_session=False)
    )
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return {"error": "key_conflict"}
    return {
        "access_token": token,
        "host_id": host.id,
        "host_key_algorithm": body.host_key_algorithm,
        "host_public_key": body.host_public_key,
        "host_key_fingerprint": fingerprint,
    }


def _approval_response(dc: DeviceCode) -> schemas.DeviceApproveResponse:
    if dc.host_key_algorithm is None or dc.host_public_key is None:
        raise HTTPException(status_code=400, detail="legacy device code must be restarted")
    return schemas.DeviceApproveResponse(
        host_name=dc.host_name or "host",
        host_key_algorithm=dc.host_key_algorithm,
        host_public_key=dc.host_public_key,
        host_key_fingerprint=host_key_fingerprint(dc.host_key_algorithm, dc.host_public_key),
    )


async def _pending_device_code(session: AsyncSession, user_code: str) -> DeviceCode:
    code = user_code.strip().upper()
    dc = (
        await session.execute(select(DeviceCode).where(DeviceCode.user_code == code))
    ).scalar_one_or_none()
    if dc is None:
        raise HTTPException(status_code=404, detail="unknown user code")
    expires = _aware(dc.expires_at)
    if expires is not None and expires <= _utcnow():
        raise HTTPException(status_code=400, detail="user code expired")
    if dc.status != "pending":
        raise HTTPException(status_code=400, detail=f"user code is {dc.status}")
    _approval_response(dc)
    return dc


@router.post("/pending", response_model=schemas.DevicePendingResponse)
async def device_pending(
    body: schemas.DevicePendingRequest,
    session: AsyncSession = Depends(get_session),
    _user: User = Depends(auth.current_user),
) -> schemas.DevicePendingResponse:
    """Inspect the server-derived identity before the user confirms approval."""

    dc = await _pending_device_code(session, body.user_code)
    return schemas.DevicePendingResponse(**_approval_response(dc).model_dump())


@router.post("/approve", response_model=schemas.DeviceApproveResponse)
async def device_approve(
    body: schemas.DeviceApproveRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.DeviceApproveResponse:
    dc = await _pending_device_code(session, body.user_code)
    assert dc.host_key_algorithm is not None
    assert dc.host_public_key is not None
    reviewed = _approval_response(dc)
    if (
        body.host_key_algorithm != reviewed.host_key_algorithm
        or body.host_public_key != reviewed.host_public_key
        or body.host_key_fingerprint != reviewed.host_key_fingerprint
    ):
        raise HTTPException(
            status_code=409,
            detail="host identity changed since review; review the device code again",
        )

    pinned_host = (
        await session.execute(
            select(Host).where(
                Host.host_key_algorithm == dc.host_key_algorithm,
                Host.host_public_key == dc.host_public_key,
            )
        )
    ).scalar_one_or_none()
    if pinned_host is not None and pinned_host.owner_user_id != user.id:
        await session.delete(dc)
        await session.commit()
        raise HTTPException(status_code=409, detail="host key is already paired")

    approved = await session.execute(
        update(DeviceCode)
        .where(
            DeviceCode.device_code == dc.device_code,
            DeviceCode.status == "pending",
            DeviceCode.user_id.is_(None),
            DeviceCode.host_key_algorithm == body.host_key_algorithm,
            DeviceCode.host_public_key == body.host_public_key,
        )
        .values(status="approved", user_id=user.id)
        .execution_options(synchronize_session=False)
    )
    if approved.rowcount != 1:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="host identity or approval state changed; review the device code again",
        )
    await session.commit()
    return reviewed
