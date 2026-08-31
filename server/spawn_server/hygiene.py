"""Bounded opportunistic cleanup for short-lived coordination state."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import DeviceCode, DevicePairing, Host, HostIntroduction

DEVICE_CODE_RETENTION = timedelta(days=7)
DEVICE_PAIRING_RETENTION = timedelta(days=1)
DEAD_HOST_INTRODUCTION_RETENTION = timedelta(days=30)
TERMINAL_DEVICE_CODE_STATUSES = ("expired", "denied", "pin_conflict", "pin_limit")


@dataclass(frozen=True)
class HygieneSweepResult:
    device_codes: int
    device_pairings: int
    host_introductions: int


async def sweep_expired_state(
    session: AsyncSession, *, now: datetime | None = None
) -> HygieneSweepResult:
    """Delete safely-terminal rows after a generous diagnostic retention window.

    This deliberately uses existing timestamps and relationships only. It needs
    no background scheduler and no schema migration; ordinary host inventory
    reads provide the opportunistic trigger.
    """

    now = now or datetime.now(UTC)
    device_codes = await session.execute(
        delete(DeviceCode).where(
            DeviceCode.status.in_(TERMINAL_DEVICE_CODE_STATUSES),
            DeviceCode.expires_at <= now - DEVICE_CODE_RETENTION,
        )
    )
    device_pairings = await session.execute(
        delete(DevicePairing).where(
            DevicePairing.expires_at <= now - DEVICE_PAIRING_RETENTION,
        )
    )

    matching_host = exists(
        select(Host.id).where(
            Host.owner_user_id == HostIntroduction.owner_user_id,
            Host.host_public_key == HostIntroduction.host_public_key,
        )
    )
    host_introductions = await session.execute(
        delete(HostIntroduction).where(
            HostIntroduction.created_at <= now - DEAD_HOST_INTRODUCTION_RETENTION,
            ~matching_host,
        )
    )
    result = HygieneSweepResult(
        device_codes=device_codes.rowcount or 0,
        device_pairings=device_pairings.rowcount or 0,
        host_introductions=host_introductions.rowcount or 0,
    )
    if result.device_codes or result.device_pairings or result.host_introductions:
        await session.commit()
    return result
