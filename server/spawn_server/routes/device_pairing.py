"""Browser-to-browser add-device SAS ceremony relay (device mesh §4, Appendix A).

Two of an account's browsers run a committed-ephemeral SAS so a human can admit a
new device with a single number-match. The server is a dumb relay: it stores and
forwards opaque base64url values and enforces move ordering — the initiator opens
its commitment only after the joiner has contributed, and every relayed value is
set-once — so an HONEST deployment cannot accidentally reorder the moves. The
ordering that actually defeats a MALICIOUS server is client-side (the initiator
commits to N_I and reveals it only after seeing N_J; the joiner verifies the
commitment opens), and the SAS number the two humans compare is the check. The
server never computes or verifies the number.

On a match both devices sign a MUTUAL account endorsement via
/api/trust/account-endorsements; that is a separate call, not part of this relay.
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import BrowserDevice, DevicePairing, User

router = APIRouter(prefix="/api/trust/pairing", tags=["trust"])

# Ceremonies are interactive and short-lived; a stale one is simply replaced.
PAIRING_TTL = timedelta(minutes=10)
MAX_ACTIVE_PAIRINGS = 16


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def _introductions(pairing: DevicePairing) -> list[schemas.DevicePairingIntroductionItem] | None:
    if pairing.introductions is None:
        return None
    try:
        return [
            schemas.DevicePairingIntroductionItem.model_validate(item)
            for item in json.loads(pairing.introductions)
        ]
    except Exception:
        # A row this endpoint validated on write cannot normally fail to parse;
        # if it somehow does, relay nothing rather than half a list.
        return None


def _state(pairing: DevicePairing) -> schemas.DevicePairingState:
    return schemas.DevicePairingState(
        id=pairing.id,
        initiator_device_id=pairing.initiator_device_id,
        joiner_device_id=pairing.joiner_device_id,
        initiator_public_key=pairing.initiator_public_key,
        initiator_commit=pairing.initiator_commit,
        joiner_public_key=pairing.joiner_public_key,
        joiner_nonce=pairing.joiner_nonce,
        initiator_nonce=pairing.initiator_nonce,
        introductions=_introductions(pairing),
        created_at=pairing.created_at,
        expires_at=pairing.expires_at,
    )


async def _live_pairing(session: AsyncSession, pairing_id: str, user_id: str) -> DevicePairing:
    pairing = await session.get(DevicePairing, pairing_id)
    if pairing is None or pairing.owner_user_id != user_id:
        raise HTTPException(status_code=404, detail="pairing not found")
    if _aware(pairing.expires_at) <= datetime.now(UTC):
        raise HTTPException(status_code=410, detail="pairing expired")
    return pairing


@router.post("", response_model=schemas.DevicePairingOut)
async def start_pairing(
    body: schemas.DevicePairingStart,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.DevicePairingOut:
    """Existing device opens a ceremony to admit `joiner_device_id`. It commits to
    its ephemeral nonce here; it reveals the nonce only after the joiner has
    contributed (POST .../reveal)."""

    user_id = user.id
    if body.initiator_device_id == body.joiner_device_id:
        raise HTTPException(status_code=422, detail="a device may not pair with itself")

    devices = {
        row.id: row
        for row in (
            await session.execute(
                select(BrowserDevice).where(
                    BrowserDevice.owner_user_id == user_id,
                    BrowserDevice.id.in_([body.initiator_device_id, body.joiner_device_id]),
                )
            )
        ).scalars()
    }
    initiator = devices.get(body.initiator_device_id)
    joiner = devices.get(body.joiner_device_id)
    if initiator is None or joiner is None:
        raise HTTPException(status_code=404, detail="browser device not found")
    for device in (initiator, joiner):
        if device.revoked_at is not None:
            raise HTTPException(status_code=409, detail="revoked devices cannot pair")
        if device.is_root:
            # The root never runs a browser↔browser SAS: it has no browser and
            # never connects. It endorses (R→d) via the passkey, not by pairing.
            raise HTTPException(status_code=422, detail="the account root cannot pair")

    now = datetime.now(UTC)
    active = (
        await session.execute(select(DevicePairing).where(DevicePairing.owner_user_id == user_id))
    ).scalars()
    live = [p for p in active if _aware(p.expires_at) > now]
    if len(live) >= MAX_ACTIVE_PAIRINGS:
        raise HTTPException(status_code=409, detail="too many active pairings")

    # Replace any prior ceremony for this exact ordered pair — a fresh start
    # supersedes a stale attempt rather than accumulating rows.
    await session.execute(
        delete(DevicePairing).where(
            DevicePairing.owner_user_id == user_id,
            DevicePairing.initiator_device_id == initiator.id,
            DevicePairing.joiner_device_id == joiner.id,
        )
    )

    pairing_id = str(uuid.uuid4())
    expires_at = now + PAIRING_TTL
    session.add(
        DevicePairing(
            id=pairing_id,
            owner_user_id=user_id,
            initiator_device_id=initiator.id,
            joiner_device_id=joiner.id,
            initiator_public_key=body.initiator_public_key,
            initiator_commit=body.initiator_commit,
            created_at=now,
            expires_at=expires_at,
        )
    )
    await session.commit()
    return schemas.DevicePairingOut(id=pairing_id, expires_at=expires_at)


@router.get("", response_model=list[schemas.DevicePairingState])
async def list_pairings(
    device_id: str = Query(min_length=36, max_length=36),
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.DevicePairingState]:
    """Live ceremonies involving `device_id` (as initiator or joiner), for the
    joiner to discover an invitation and for both sides to poll progress."""

    now = datetime.now(UTC)
    rows = (
        await session.execute(
            select(DevicePairing)
            .where(
                DevicePairing.owner_user_id == user.id,
                or_(
                    DevicePairing.initiator_device_id == device_id,
                    DevicePairing.joiner_device_id == device_id,
                ),
            )
            .order_by(DevicePairing.created_at)
        )
    ).scalars()
    return [_state(p) for p in rows if _aware(p.expires_at) > now]


@router.post("/{pairing_id}/contribute", response_model=schemas.DevicePairingState)
async def contribute(
    pairing_id: str,
    body: schemas.DevicePairingContribute,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.DevicePairingState:
    """Joiner sends its key K_J and fresh nonce N_J. Set-once: a second
    contribution would let a relay swap N_J after the initiator opens N_I."""

    pairing = await _live_pairing(session, pairing_id, user.id)
    if pairing.joiner_nonce is not None or pairing.joiner_public_key is not None:
        raise HTTPException(status_code=409, detail="joiner contribution already recorded")
    result = await session.execute(
        update(DevicePairing)
        .where(DevicePairing.id == pairing.id, DevicePairing.joiner_nonce.is_(None))
        .values(joiner_public_key=body.joiner_public_key, joiner_nonce=body.joiner_nonce)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        raise HTTPException(status_code=409, detail="joiner contribution already recorded")
    await session.commit()
    return _state(await _live_pairing(session, pairing_id, user.id))


@router.post("/{pairing_id}/reveal", response_model=schemas.DevicePairingState)
async def reveal(
    pairing_id: str,
    body: schemas.DevicePairingReveal,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.DevicePairingState:
    """Initiator opens its commitment by revealing N_I. Accepted only after the
    joiner has contributed (commit-reveal ordering) and set-once."""

    pairing = await _live_pairing(session, pairing_id, user.id)
    if pairing.joiner_nonce is None:
        raise HTTPException(status_code=409, detail="joiner has not contributed yet")
    if pairing.initiator_nonce is not None:
        raise HTTPException(status_code=409, detail="initiator nonce already revealed")
    result = await session.execute(
        update(DevicePairing)
        .where(
            DevicePairing.id == pairing.id,
            DevicePairing.joiner_nonce.is_not(None),
            DevicePairing.initiator_nonce.is_(None),
        )
        .values(initiator_nonce=body.initiator_nonce)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        raise HTTPException(status_code=409, detail="initiator nonce already revealed")
    await session.commit()
    return _state(await _live_pairing(session, pairing_id, user.id))


@router.post("/{pairing_id}/introductions", response_model=schemas.DevicePairingState)
async def post_introductions(
    pairing_id: str,
    body: schemas.DevicePairingIntroductions,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.DevicePairingState:
    """Initiator's host-key introductions (mesh R7), relayed to the joiner.

    Accepted only after the reveal — introductions ride a ceremony that has
    fully exchanged — and set-once, so a relay cannot swap the list after the
    joiner read it. The server checks shape only: each signature binds the
    account, the initiator key, the host key, and the JOINER key, and the joiner
    verifies it against the initiator key its own ceremony pinned — a forged or
    substituted entry verifies for no one, and a joiner-posted list fails that
    same check (only the initiator's key signs).
    """

    pairing = await _live_pairing(session, pairing_id, user.id)
    if pairing.initiator_nonce is None:
        raise HTTPException(status_code=409, detail="ceremony has not completed its reveal")
    if pairing.introductions is not None:
        raise HTTPException(status_code=409, detail="introductions already recorded")
    payload = json.dumps([item.model_dump() for item in body.introductions])
    result = await session.execute(
        update(DevicePairing)
        .where(DevicePairing.id == pairing.id, DevicePairing.introductions.is_(None))
        .values(introductions=payload)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        raise HTTPException(status_code=409, detail="introductions already recorded")
    await session.commit()
    pairing = await _live_pairing(session, pairing_id, user.id)
    # The raw UPDATE bypassed the identity map; re-read so the response carries
    # what the row now holds.
    await session.refresh(pairing)
    return _state(pairing)


@router.delete("/{pairing_id}")
async def cancel_pairing(
    pairing_id: str,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, bool]:
    """Either device may tear down a ceremony (declined match, wrong device)."""

    result = await session.execute(
        delete(DevicePairing).where(
            DevicePairing.id == pairing_id,
            DevicePairing.owner_user_id == user.id,
        )
    )
    await session.commit()
    if result.rowcount != 1:
        raise HTTPException(status_code=404, detail="pairing not found")
    return {"ok": True}
