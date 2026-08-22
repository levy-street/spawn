"""The durable root-introduction store (mesh §4.1 provenance channel).

An untrusted mailbox between an account's devices for the ROOT public key: a
device that learned `pk_R` firsthand — at mint or from the unsealed passkey
bundle — publishes a signed introduction here; the account's other devices
poll it and honor rows whose INTRODUCER key they hold FIRSTHAND (learned in a
ceremony), re-verifying every signature against that firsthand copy. This is
what lets a PINNED device anchor the root on its hosts when the passkey lives
on an unpinned device: the pinned device must never anchor a key it only knows
from the server's `is_root` row (that would hand a hostile server a
forged-anchor path — P2), so the key must arrive over this signed channel.

One row per introducer; republishing with a successor key (root rotation)
replaces the introducer's own row. Nothing the server stores or serves can
create trust — the hygiene verification at insert only keeps rows that could
never verify for anyone out of the store, and the revoked-introducer filter on
GET is the fail-closed direction the server is trusted for (it can always
deny; it must never grant).
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
from ..models import BrowserDevice, RootIntroduction, User
from ..root_introduction import verify_root_intro_proof

router = APIRouter(prefix="/api/trust/root-introductions", tags=["trust"])

# One row per introducer keeps this naturally tiny; the cap is a flood stop.
MAX_ROOT_INTRODUCTIONS_PER_ACCOUNT = 256


@router.post("", response_model=schemas.RootIntroductionOut)
async def publish_root_introduction(
    body: schemas.RootIntroductionPublish,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.RootIntroductionOut:
    introducer = await session.get(BrowserDevice, body.introducer_device_id)
    if introducer is None or introducer.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="introducer device not found")
    if introducer.revoked_at is not None:
        raise HTTPException(status_code=409, detail="revoked devices cannot introduce the root")
    if introducer.is_root:
        # The root introducing itself is exactly the server-claim shape this
        # channel exists to replace.
        raise HTTPException(status_code=422, detail="the account root cannot introduce itself")

    verify_root_intro_proof(
        account_id=user.id,
        introducer_public_key_wire=introducer.public_key,
        root_public_key_wire=body.root_public_key,
        signature_wire=body.signature,
    )

    now = datetime.now(UTC)
    existing = (
        await session.execute(
            select(RootIntroduction).where(
                RootIntroduction.introducer_device_id == introducer.id
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        if existing.root_public_key == body.root_public_key:
            # Idempotent republish (the reconcile sweep re-walks its state).
            return _to_out(existing, introducer.public_key)
        # ROTATION: this introducer now vouches a successor key. Replacing its
        # own row is the introducer speaking for itself; consumers still gate
        # acceptance of a successor on corroborated revocation of the old key.
        existing.root_public_key = body.root_public_key
        existing.signature = body.signature
        existing.updated_at = now
        out = _to_out(existing, introducer.public_key)
        await session.commit()
        return out

    count = (
        await session.execute(
            select(func.count())
            .select_from(RootIntroduction)
            .where(RootIntroduction.owner_user_id == user.id)
        )
    ).scalar_one()
    if count >= MAX_ROOT_INTRODUCTIONS_PER_ACCOUNT:
        raise HTTPException(status_code=409, detail="too many root introductions")

    row = RootIntroduction(
        id=str(uuid.uuid4()),
        owner_user_id=user.id,
        introducer_device_id=introducer.id,
        root_public_key=body.root_public_key,
        signature=body.signature,
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        # A concurrent publish from the same introducer won the race.
        await session.rollback()
        winner = (
            await session.execute(
                select(RootIntroduction).where(
                    RootIntroduction.introducer_device_id == introducer.id
                )
            )
        ).scalar_one_or_none()
        if winner is None:
            raise HTTPException(
                status_code=409, detail="root introduction did not commit"
            ) from None
        return _to_out(winner, introducer.public_key)
    return _to_out(row, introducer.public_key)


@router.get("", response_model=list[schemas.RootIntroductionOut])
async def list_root_introductions(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.RootIntroductionOut]:
    """Every live root introduction for this account. Rows whose introducer is
    revoked are withheld (fail-closed): a removed device's vouches must stop
    spreading, and recipients additionally drop its key from their own
    firsthand memory."""

    rows = (
        await session.execute(
            select(RootIntroduction, BrowserDevice.public_key)
            .join(BrowserDevice, BrowserDevice.id == RootIntroduction.introducer_device_id)
            .where(
                RootIntroduction.owner_user_id == user.id,
                BrowserDevice.revoked_at.is_(None),
            )
            .order_by(RootIntroduction.created_at)
        )
    ).all()
    return [_to_out(row, introducer_key) for row, introducer_key in rows]


def _to_out(row: RootIntroduction, introducer_public_key: str) -> schemas.RootIntroductionOut:
    return schemas.RootIntroductionOut(
        id=row.id,
        introducer_device_id=row.introducer_device_id,
        introducer_public_key=introducer_public_key,
        root_public_key=row.root_public_key,
        signature=row.signature,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )
