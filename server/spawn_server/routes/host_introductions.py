"""The durable host-introduction store (mesh R7, continuous gossip).

An untrusted mailbox between an account's devices: a device that verified a
host key out of band publishes a signed vouch here; the account's other devices
poll it and honor rows whose publisher key they hold FIRSTHAND (learned in a
ceremony), re-verifying every signature against that firsthand copy. Nothing
the server stores or serves can create trust — the hygiene verification at
insert only keeps rows that could never verify for anyone out of the store,
and the revoked-publisher filter on GET is the fail-closed direction the
server is trusted for (it can always deny; it must never grant).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..host_introduction import verify_host_intro_broadcast_proof
from ..models import BrowserDevice, HostIntroduction, User

router = APIRouter(prefix="/api/trust/host-introductions", tags=["trust"])

# Hosts × devices stays small for real accounts; the cap is a flood stop.
MAX_INTRODUCTIONS_PER_ACCOUNT = 512


@router.post("", response_model=schemas.HostIntroductionOut)
async def publish_host_introduction(
    body: schemas.HostIntroductionPublish,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.HostIntroductionOut:
    publisher = await session.get(BrowserDevice, body.publisher_device_id)
    if publisher is None or publisher.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="publisher device not found")
    if publisher.revoked_at is not None:
        raise HTTPException(status_code=409, detail="revoked devices cannot introduce hosts")
    if publisher.is_root:
        # The root never runs a browser and never verifies a host out of band.
        raise HTTPException(status_code=422, detail="the account root cannot introduce hosts")

    verify_host_intro_broadcast_proof(
        account_id=user.id,
        publisher_public_key_wire=publisher.public_key,
        host_public_key_wire=body.host_public_key,
        signature_wire=body.signature,
    )

    existing = (
        await session.execute(
            select(HostIntroduction).where(
                HostIntroduction.publisher_device_id == publisher.id,
                HostIntroduction.host_public_key == body.host_public_key,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        # Idempotent republish (the reconcile sweep re-walks its pins).
        return _to_out(existing, publisher.public_key)

    count = (
        await session.execute(
            select(func.count())
            .select_from(HostIntroduction)
            .where(HostIntroduction.owner_user_id == user.id)
        )
    ).scalar_one()
    if count >= MAX_INTRODUCTIONS_PER_ACCOUNT:
        raise HTTPException(status_code=409, detail="too many host introductions")

    row = HostIntroduction(
        id=str(uuid.uuid4()),
        owner_user_id=user.id,
        publisher_device_id=publisher.id,
        host_id=body.host_id,
        host_name=body.host_name,
        host_public_key=body.host_public_key,
        signature=body.signature,
        created_at=datetime.now(UTC),
    )
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        # A concurrent sweep republished the same (publisher, host key) row.
        await session.rollback()
        winner = (
            await session.execute(
                select(HostIntroduction).where(
                    HostIntroduction.publisher_device_id == publisher.id,
                    HostIntroduction.host_public_key == body.host_public_key,
                )
            )
        ).scalar_one_or_none()
        if winner is None:
            raise HTTPException(
                status_code=409, detail="host introduction did not commit"
            ) from None
        return _to_out(winner, publisher.public_key)
    return _to_out(row, publisher.public_key)


@router.get("", response_model=list[schemas.HostIntroductionOut])
async def list_host_introductions(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.HostIntroductionOut]:
    """Every live introduction for this account. Rows whose publisher is revoked
    are withheld (fail-closed): a removed device's vouches must stop spreading,
    and recipients additionally drop its key from their own firsthand memory."""

    rows = (
        await session.execute(
            select(HostIntroduction, BrowserDevice.public_key)
            .join(BrowserDevice, BrowserDevice.id == HostIntroduction.publisher_device_id)
            .where(
                HostIntroduction.owner_user_id == user.id,
                BrowserDevice.revoked_at.is_(None),
            )
            .order_by(HostIntroduction.created_at)
        )
    ).all()
    return [_to_out(row, publisher_key) for row, publisher_key in rows]


def _to_out(row: HostIntroduction, publisher_public_key: str) -> schemas.HostIntroductionOut:
    return schemas.HostIntroductionOut(
        id=row.id,
        publisher_device_id=row.publisher_device_id,
        publisher_public_key=publisher_public_key,
        host_id=row.host_id,
        host_name=row.host_name,
        host_public_key=row.host_public_key,
        signature=row.signature,
        created_at=row.created_at,
    )
