"""Authenticated browser-device identity registration, listing, and revocation."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..browser_registration import verify_browser_registration_proof
from ..db import get_session
from ..host_identity import ed25519_key_fingerprint
from ..models import BrowserDevice, User

router = APIRouter(prefix="/api/browser-devices", tags=["browser-devices"])


def _to_out(device: BrowserDevice) -> schemas.BrowserDeviceOut:
    return schemas.BrowserDeviceOut(
        id=device.id,
        key_algorithm="ed25519",
        public_key=device.public_key,
        fingerprint=ed25519_key_fingerprint(device.public_key),
        label=device.label,
        created_at=device.created_at,
        revoked_at=device.revoked_at,
    )


def _registration_result(device: BrowserDevice, user_id: str) -> schemas.BrowserDeviceOut:
    if device.owner_user_id != user_id:
        raise HTTPException(status_code=409, detail="browser public key is unavailable")
    if device.revoked_at is not None:
        raise HTTPException(
            status_code=409,
            detail="revoked browser public keys cannot be registered again",
        )
    return _to_out(device)


@router.post("/register", response_model=schemas.BrowserDeviceOut)
async def register_browser_device(
    body: schemas.BrowserDeviceRegisterRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrowserDeviceOut:
    user_id = user.id
    verify_browser_registration_proof(
        user_id=user_id,
        public_key_wire=body.public_key,
        signature_wire=body.signature,
    )

    existing = (
        await session.execute(
            select(BrowserDevice)
            .where(
                BrowserDevice.key_algorithm == body.key_algorithm,
                BrowserDevice.public_key == body.public_key,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if existing is not None:
        return _registration_result(existing, user_id)

    device = BrowserDevice(
        id=str(uuid.uuid4()),
        owner_user_id=user_id,
        key_algorithm=body.key_algorithm,
        public_key=body.public_key,
        # Only on first registration. Re-registration returns the existing row,
        # so a name the operator chose is never overwritten by a later default.
        label=body.label,
    )
    session.add(device)
    try:
        await session.commit()
    except IntegrityError:
        # A concurrent tab may have inserted the globally unique key. Resolve
        # that winner after rollback; never update or resurrect it.
        await session.rollback()
        winner = (
            await session.execute(
                select(BrowserDevice).where(
                    BrowserDevice.key_algorithm == body.key_algorithm,
                    BrowserDevice.public_key == body.public_key,
                )
            )
        ).scalar_one_or_none()
        if winner is None:
            raise HTTPException(
                status_code=409, detail="browser public key is unavailable"
            ) from None
        return _registration_result(winner, user_id)
    await session.refresh(device)
    return _to_out(device)


@router.get("", response_model=list[schemas.BrowserDeviceOut])
async def list_browser_devices(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.BrowserDeviceOut]:
    devices = (
        (
            await session.execute(
                select(BrowserDevice)
                .where(BrowserDevice.owner_user_id == user.id)
                .order_by(BrowserDevice.created_at.desc(), BrowserDevice.id.desc())
            )
        )
        .scalars()
        .all()
    )
    return [_to_out(device) for device in devices]


@router.post("/{device_id}/revoke", response_model=schemas.BrowserDeviceOut)
async def revoke_browser_device(
    device_id: str,
    body: schemas.BrowserDeviceRevokeRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrowserDeviceOut:
    now = datetime.now(UTC)
    result = await session.execute(
        update(BrowserDevice)
        .where(
            BrowserDevice.id == device_id,
            BrowserDevice.owner_user_id == user.id,
            BrowserDevice.public_key == body.expected_public_key,
            BrowserDevice.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    await session.commit()

    device = (
        await session.execute(
            select(BrowserDevice).where(
                BrowserDevice.id == device_id, BrowserDevice.owner_user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if device is None:
        raise HTTPException(status_code=404, detail="browser device not found")
    if device.public_key != body.expected_public_key:
        raise HTTPException(
            status_code=409,
            detail="browser device changed; refresh before revoking",
        )
    if result.rowcount == 0 and device.revoked_at is None:
        # No matching update and no tombstone means the row changed outside
        # this immutable-key contract. Fail closed rather than claiming revoke.
        raise HTTPException(status_code=409, detail="browser device revocation did not commit")
    return _to_out(device)


@router.patch("/{device_id}", response_model=schemas.BrowserDeviceOut)
async def rename_browser_device(
    device_id: str,
    body: schemas.BrowserDeviceRenameRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrowserDeviceOut:
    """Rename a device for recognition. Changes no trust: the key is unchanged."""

    device = await session.get(BrowserDevice, device_id)
    if device is None or device.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="browser device not found")
    device.label = body.label
    label = body.label
    public_key = device.public_key
    created_at = device.created_at
    revoked_at = device.revoked_at
    await session.commit()
    return schemas.BrowserDeviceOut(
        id=device_id,
        key_algorithm="ed25519",
        public_key=public_key,
        fingerprint=ed25519_key_fingerprint(public_key),
        label=label,
        created_at=created_at,
        revoked_at=revoked_at,
    )
