"""Authenticated setup-routing claims for attended host possession."""

from __future__ import annotations

import base64
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, rate_limit, schemas
from ..db import get_session
from ..models import SetupClaim, User
from ..trust_events import pair_resolved_payload, publish_trust_event

router = APIRouter(prefix="/api/setup/claims", tags=["setup"])

SETUP_CLAIM_TTL_SECONDS = 30 * 60
SETUP_CLAIM_RETENTION = timedelta(hours=24)


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def valid_setup_token(value: str) -> bool:
    if len(value) != 43:
        return False
    try:
        decoded = base64.b64decode(value + "=", altchars=b"-_", validate=True)
    except (ValueError, TypeError):
        return False
    canonical = base64.urlsafe_b64encode(decoded).rstrip(b"=").decode("ascii")
    return len(decoded) == 32 and canonical == value


def _to_out(claim: SetupClaim) -> schemas.SetupClaimOut:
    return schemas.SetupClaimOut(
        status=claim.status,
        approval_ref=claim.approval_ref,
        host_name=claim.host_name,
        os=claim.os,
        host_key_fingerprint=claim.host_key_fingerprint,
        host_id=claim.host_id,
        error=claim.error,
        expires_at=_aware(claim.expires_at),
    )


@router.post(
    "", response_model=schemas.SetupClaimCreateResponse, status_code=status.HTTP_201_CREATED
)
async def create_setup_claim(
    _body: schemas.EmptyRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.SetupClaimCreateResponse:
    await rate_limit.enforce_identifier(f"user:{user.id}", rate_limit.SETUP_CLAIM)
    now = _utcnow()
    await session.execute(
        delete(SetupClaim).where(SetupClaim.created_at < now - SETUP_CLAIM_RETENTION)
    )

    claim = SetupClaim(
        user_id=user.id,
        token=secrets.token_urlsafe(32),
        status="pending",
        created_at=now,
        expires_at=now + timedelta(seconds=SETUP_CLAIM_TTL_SECONDS),
    )
    session.add(claim)
    await session.commit()
    return schemas.SetupClaimCreateResponse(
        token=claim.token,
        expires_in=SETUP_CLAIM_TTL_SECONDS,
        expires_at=claim.expires_at,
    )


@router.get("/{token}", response_model=schemas.SetupClaimOut)
async def get_setup_claim(
    token: str,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.SetupClaimOut:
    if not valid_setup_token(token):
        raise HTTPException(status_code=404, detail="setup claim not found")
    claim = (
        await session.execute(
            select(SetupClaim).where(SetupClaim.token == token, SetupClaim.user_id == user.id)
        )
    ).scalar_one_or_none()
    if claim is None:
        raise HTTPException(status_code=404, detail="setup claim not found")

    publish = False
    if claim.status in {"pending", "ready"} and _aware(claim.expires_at) <= _utcnow():
        publish = claim.status == "ready" and claim.approval_ref is not None
        claim.status = "failed"
        claim.error = "expired"
        claim.resolved_at = _utcnow()
        await session.commit()
    if publish:
        assert claim.approval_ref is not None
        await publish_trust_event(
            claim.user_id,
            pair_resolved_payload(claim.approval_ref, "expired", None),
        )
    return _to_out(claim)
