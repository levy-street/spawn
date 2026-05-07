"""Device-code OAuth-style flow for daemon (`spawnd`) onboarding."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..config import get_settings
from ..db import get_session
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
    expires_at = _utcnow() + timedelta(seconds=DEVICE_CODE_TTL_SECONDS)

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
        status="pending",
        expires_at=expires_at,
    )
    session.add(dc)
    await session.commit()

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
    dc = (
        await session.execute(select(DeviceCode).where(DeviceCode.device_code == body.device_code))
    ).scalar_one_or_none()
    if dc is None:
        return {"error": "expired_token"}

    now = _utcnow()
    last = _aware(dc.last_polled_at)
    dc.last_polled_at = now
    expires = _aware(dc.expires_at)

    if expires is not None and expires <= now:
        dc.status = "expired"
        await session.commit()
        return {"error": "expired_token"}

    if last is not None and (now - last).total_seconds() < (POLL_INTERVAL_SECONDS - 1):
        await session.commit()
        return {"error": "slow_down"}

    if dc.status == "denied":
        await session.commit()
        return {"error": "denied"}

    if dc.status != "approved" or dc.user_id is None:
        await session.commit()
        return {"error": "authorization_pending"}

    # Approved → create the host and issue a daemon token. One-shot: mark consumed.
    host = Host(
        owner_user_id=dc.user_id,
        name=dc.host_name or "host",
        os=dc.os,
        arch=dc.arch,
        version=dc.version,
        status="offline",
    )
    session.add(host)
    await session.flush()
    token = auth.issue_daemon_token(host.id, dc.user_id)
    dc.status = "consumed"
    await session.commit()
    return {"access_token": token, "host_id": host.id}


@router.post("/approve", response_model=schemas.DeviceApproveResponse)
async def device_approve(
    body: schemas.DeviceApproveRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.DeviceApproveResponse:
    code = body.user_code.strip().upper()
    dc = (
        await session.execute(select(DeviceCode).where(DeviceCode.user_code == code))
    ).scalar_one_or_none()
    if dc is None:
        raise HTTPException(status_code=404, detail="unknown user code")
    expires = _aware(dc.expires_at)
    if expires is not None and expires <= _utcnow():
        raise HTTPException(status_code=400, detail="user code expired")
    if dc.status not in ("pending",):
        raise HTTPException(status_code=400, detail=f"user code is {dc.status}")
    dc.status = "approved"
    dc.user_id = user.id
    await session.commit()
    return schemas.DeviceApproveResponse(host_name=dc.host_name or "host")
