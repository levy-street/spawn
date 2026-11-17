"""Collection records and conditional state transitions. No dispatch caller yet."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from sqlalchemy import insert, literal, select, update

from .db import get_sessionmaker
from .models import Host, SupportLogCollection, _new_uuid, _utcnow
from .support_consent import sharing_on


class CollectionState(StrEnum):
    REQUESTED = "requested"
    DISPATCHED = "dispatched"
    COLLECTED = "collected"
    DECLINED = "declined"
    FAILED = "failed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"
    DELETED = "deleted"


TRANSITIONS = {
    "requested": {"dispatched", "expired", "cancelled"},
    "dispatched": {"collected", "declined", "failed", "cancelled"},
    "collected": {"deleted"},
}
DECLINE_CODES = {"not_consented", "signer_untrusted", "rate_limited", "no_log", "failed"}


async def create_request(
    *,
    owner_user_id: str,
    host_id: str,
    reason: str,
    requested_by: str,
    window_seconds: int,
    now: datetime | None = None,
) -> str:
    if not isinstance(reason, str) or not 1 <= len(reason) <= 200:
        raise ValueError("support reason must have 1 to 200 characters")
    if not isinstance(requested_by, str) or not requested_by:
        raise ValueError("requester is required")
    if type(window_seconds) is not int or not 60 <= window_seconds <= 259200:
        raise ValueError("invalid support window")
    record_id = _new_uuid()
    async with get_sessionmaker()() as session:
        stmt = (
            insert(SupportLogCollection)
            .from_select(
                [
                    "id",
                    "owner_user_id",
                    "host_id",
                    "host_name",
                    "state",
                    "reason",
                    "requested_by",
                    "window_seconds",
                    "requested_at",
                ],
                select(
                    literal(record_id),
                    Host.owner_user_id,
                    Host.id,
                    Host.name,
                    literal("requested"),
                    literal(reason),
                    literal(requested_by),
                    literal(window_seconds),
                    literal(now or _utcnow()),
                ).where(Host.id == host_id, Host.owner_user_id == owner_user_id),
            )
            .returning(SupportLogCollection.id)
        )
        if (await session.execute(stmt)).scalar_one_or_none() is None:
            raise ValueError("host unavailable")
        await session.commit()
    return record_id


async def get_collection(record_id: str) -> SupportLogCollection | None:
    async with get_sessionmaker()() as session:
        return await session.get(SupportLogCollection, record_id)


async def transition(
    record_id: str,
    current: str,
    target: str,
    *,
    now: datetime | None = None,
    require_sharing: bool = False,
    **metadata,
) -> bool:
    if target not in TRANSITIONS.get(current, set()):
        raise ValueError("invalid support collection transition")
    if target == "declined" and metadata.get("decline_code") not in DECLINE_CODES:
        raise ValueError("invalid support refusal")
    stamp = now or _utcnow()
    field = (
        "dispatched_at"
        if target == "dispatched"
        else ("deleted_at" if target == "deleted" else "completed_at")
    )
    stmt = update(SupportLogCollection).where(
        SupportLogCollection.id == record_id,
        SupportLogCollection.state == current,
    )
    if require_sharing:
        stmt = stmt.where(sharing_on(SupportLogCollection.owner_user_id))
    async with get_sessionmaker()() as session:
        changed = (
            await session.execute(
                stmt.values(
                    **metadata,
                    state=target,
                    **{field: stamp},
                ).returning(SupportLogCollection.id)
            )
        ).scalar_one_or_none()
        await session.commit()
    return changed is not None


async def mark_dispatched(record_id: str, *, now: datetime | None = None) -> bool:
    return await transition(record_id, "requested", "dispatched", now=now, require_sharing=True)
