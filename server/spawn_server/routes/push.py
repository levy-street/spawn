"""`/api/notifications/devices` — where to reach an account's app installs.

Registration is idempotent on the token, because the app re-registers on every
launch: the push service reissues tokens on reinstall, restore and some OS
upgrades, and an app that only registered once would go quiet without ever
noticing. Re-registering an existing token refreshes it, revives it if the
service had previously reported it dead, and moves it if it now belongs to a
different account.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import PushDevice, User

router = APIRouter(prefix="/api/notifications", tags=["notifications"])
DISABLED_PUSH_RETENTION = timedelta(days=90)


def _utcnow() -> datetime:
    return datetime.now(UTC)


@router.post(
    "/devices",
    response_model=schemas.PushDeviceOut,
    status_code=status.HTTP_200_OK,
)
async def register_push_device(
    body: schemas.PushDeviceRegisterRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.PushDeviceOut:
    now = _utcnow()
    await session.execute(
        delete(PushDevice).where(
            PushDevice.disabled_at.is_not(None),
            PushDevice.disabled_at < now - DISABLED_PUSH_RETENTION,
        )
    )
    existing = (
        await session.execute(select(PushDevice).where(PushDevice.token == body.token))
    ).scalar_one_or_none()

    if existing is None:
        device = PushDevice(
            user_id=user.id,
            token=body.token,
            platform=body.platform,
            label=body.label,
            browser_device_id=body.browser_device_id,
            created_at=now,
            last_seen_at=now,
        )
        session.add(device)
    else:
        # A token that reappears under another account has moved handsets or
        # hands; reassigning it is what stops the previous owner's alerts from
        # continuing to arrive on a phone that is no longer theirs.
        device = existing
        device.user_id = user.id
        device.platform = body.platform
        device.label = body.label
        device.browser_device_id = body.browser_device_id
        device.last_seen_at = now
        device.disabled_at = None

    await session.commit()
    await session.refresh(device)
    return schemas.PushDeviceOut.model_validate(device)


@router.delete("/devices/{token}", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_push_device(
    token: str,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> Response:
    """Stop pushing to one install — sign-out, or notifications switched off.

    Deleting only ever touches the caller's own row, and says nothing about
    whether the token existed: a 204 either way, so this cannot be used to test
    whether some other account owns a given token.
    """
    device = (
        await session.execute(
            select(PushDevice).where(
                PushDevice.token == token,
                PushDevice.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if device is not None:
        await session.delete(device)
        await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
