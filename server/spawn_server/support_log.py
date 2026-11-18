"""Collection records and conditional state transitions."""

from __future__ import annotations

from datetime import datetime, timedelta
from enum import StrEnum

from sqlalchemy import case, exists, func, or_, select, text, update
from sqlalchemy.orm import aliased

from .db import get_sessionmaker
from .models import Host, SupportLogCollection, User, _new_uuid, _utcnow
from .support_consent import enabled_statement_time, sharing_on


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


OPEN_STATES = ("requested", "dispatched")
HOST_INTERVAL = timedelta(minutes=5)
ACCOUNT_INTERVAL = timedelta(hours=24)
ACCOUNT_LIMIT = 10
DISPATCH_LIMIT = 2
body_readers: set[str] = set()


def occupied_dispatch_slots():
    row = aliased(SupportLogCollection)
    readers = tuple(body_readers)
    durable = select(func.count(row.id)).where(row.state == "dispatched")
    if readers:
        durable = durable.where(row.id.not_in(readers))
    return durable.scalar_subquery() + len(readers)


def clamp_window(seconds: int) -> int:
    return max(60, min(259200, seconds))


class RequestRefusal(StrEnum):
    SHARING_OFF = "Sharing is off for this account."
    FOREIGN_HOST = "No such host in this account."
    INCAPABLE = "This host has not declared support log capability."
    OPEN = "A request is already open for this host."
    HOST_INTERVAL = "A collection was dispatched to this host within five minutes."
    ACCOUNT_LIMIT = "The account has reached its daily request limit."
    CAPACITY = "Two collections are already dispatched."


class RequestRefused(ValueError):
    def __init__(self, reason: RequestRefusal):
        self.reason = reason
        super().__init__(reason.value)


def pacing_refusal(owner, host, now, *, exclude=None):
    """SQL used at admission and dispatch. Count every outcome in the rolling day."""
    other = aliased(SupportLogCollection)
    rows = select(other.id).correlate_except(other)
    account = rows.where(other.owner_user_id == owner)
    if exclude is not None:
        account = account.where(other.id != exclude)
    machine = account.where(other.host_id == host)
    return case(
        (machine.where(other.state.in_(OPEN_STATES)).exists(), RequestRefusal.OPEN.value),
        (
            machine.where(other.dispatched_at > now - HOST_INTERVAL).exists(),
            RequestRefusal.HOST_INTERVAL.value,
        ),
        (
            or_(
                account.where(other.requested_at > now - ACCOUNT_INTERVAL)
                .offset(ACCOUNT_LIMIT - 1)
                .limit(1)
                .exists(),
                account.where(other.dispatched_at > now - ACCOUNT_INTERVAL)
                .offset(ACCOUNT_LIMIT - 1)
                .limit(1)
                .exists(),
            ),
            RequestRefusal.ACCOUNT_LIMIT.value,
        ),
        (
            occupied_dispatch_slots() >= DISPATCH_LIMIT,
            RequestRefusal.CAPACITY.value,
        ),
    )


async def create_request(
    *,
    owner_user_id: str,
    host_id: str,
    reason: str,
    requested_by: str,
    window_seconds: int,
    now: datetime | None = None,
) -> str:
    """Insert a record. Operator admission and insertion share one writer transaction."""
    if not isinstance(reason, str) or not 1 <= len(reason) <= 200:
        raise ValueError("support reason must have 1 to 200 characters")
    if not isinstance(requested_by, str) or not requested_by:
        raise ValueError("requester is required")
    if type(window_seconds) is not int or clamp_window(window_seconds) != window_seconds:
        raise ValueError("invalid support window")
    record_id = _new_uuid()
    async with get_sessionmaker()() as session:
        # Separate operator processes must not both pass admission before
        # either inserts. Take the writer reservation before reading on SQLite.
        # On Postgres the account lock serializes creators across its hosts.
        if session.bind.dialect.name == "sqlite":
            await session.execute(text("BEGIN IMMEDIATE"))
        else:
            await session.execute(select(User.id).where(User.id == owner_user_id).with_for_update())
        now = now or _utcnow()
        refused = case(
            (~sharing_on(owner_user_id), RequestRefusal.SHARING_OFF.value),
            (~Host.support_log_capable, RequestRefusal.INCAPABLE.value),
            else_=pacing_refusal(owner_user_id, host_id, now),
        )
        host = (
            await session.execute(
                select(Host.name, refused.label("refusal"))
                .where(
                    Host.id == host_id,
                    Host.owner_user_id == owner_user_id,
                )
                .with_for_update(of=Host)
            )
        ).one_or_none()
        if host is None:
            raise RequestRefused(RequestRefusal.FOREIGN_HOST)
        if host.refusal is not None:
            raise RequestRefused(RequestRefusal(host.refusal))
        session.add(
            SupportLogCollection(
                id=record_id,
                owner_user_id=owner_user_id,
                host_id=host_id,
                host_name=host.name,
                state="requested",
                requested_at=now,
                reason=reason,
                requested_by=requested_by,
                window_seconds=window_seconds,
            )
        )
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
    conditions=(),
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
        *conditions,
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


async def mark_dispatched(
    record_id: str,
    *,
    now: datetime | None = None,
    connection_id: str | None = None,
    sent_ms: int | None = None,
) -> bool:
    now = now or _utcnow()
    row = SupportLogCollection
    conditions = ()
    if connection_id is not None:
        if sent_ms is None:
            return False
        conditions = (
            row.requested_at >= now - ACCOUNT_INTERVAL,
            exists().where(
                Host.id == row.host_id,
                Host.owner_user_id == row.owner_user_id,
                Host.daemon_connection_id == connection_id,
                Host.support_log_capable,
            ),
            enabled_statement_time(row.owner_user_id).scalar_subquery() == sent_ms,
            pacing_refusal(row.owner_user_id, row.host_id, now, exclude=row.id).is_(None),
        )
    return await transition(
        record_id,
        "requested",
        "dispatched",
        now=now,
        require_sharing=connection_id is None,
        conditions=conditions,
    )
