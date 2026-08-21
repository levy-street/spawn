"""The legion: fleet rollups, and the durable daily record behind the profile.

Everything here is *accounting*, and accounting must never be able to break the
thing it is counting. Every recorder below opens its own short session, commits
itself, and swallows its own failures — a database hiccup while incrementing a
counter must not stop a session from starting. Callers get no exceptions and no
return value they have to check.

What is recorded is deliberately narrow, and is a strict subset of metadata the
server already holds: how many sessions were started, how long they ran, the
day's peak simultaneous session and online-host counts, and a tally of
foreground executable *basenames* — the same disclosed ``session.foreground``
vocabulary the pane labels use (docs/TRUST.md). No paths, no arguments, no
directories, no per-session rows that outlive the session.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from .db import get_sessionmaker
from .models import Host, LegionDay, Session

log = logging.getLogger("spawn.legion")

# How many distinct agent basenames one day's tally may hold. A host cycling
# through hundreds of binaries must not be able to grow the row without bound;
# past this, new names are dropped and the established ones keep counting.
MAX_AGENTS_PER_DAY = 24
# Longest basename kept, matching the daemon's own `session.foreground` cap.
MAX_AGENT_NAME = 64
# The profile's window. Long enough to show a habit, short enough that the
# response stays small and the heatmap stays readable at sidebar-ish widths.
HISTORY_DAYS = 120
# Agent tallies returned to the profile, most-used first.
TOP_AGENTS = 8


def utc_day(moment: datetime | None = None) -> str:
    """The UTC calendar day a rollup lands on, as ``YYYY-MM-DD``."""
    if moment is None:
        moment = datetime.now(UTC)
    elif moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC).date().isoformat()


def _utcnow() -> datetime:
    return datetime.now(UTC)


def parse_agents(raw: str | None) -> dict[str, int]:
    """The stored tally, or an empty one for anything unreadable.

    Stored JSON is server-written, but a corrupt or hand-edited row must
    degrade to "no agents recorded" rather than failing a profile request.
    """
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    tally: dict[str, int] = {}
    for name, count in parsed.items():
        if isinstance(name, str) and isinstance(count, int) and count > 0:
            tally[name[:MAX_AGENT_NAME]] = count
    return tally


def merge_agent(tally: dict[str, int], command: str) -> dict[str, int]:
    """Add one sighting, bounded. Known names always keep counting."""
    name = command.strip()[:MAX_AGENT_NAME]
    if not name:
        return tally
    if name not in tally and len(tally) >= MAX_AGENTS_PER_DAY:
        return tally
    tally[name] = tally.get(name, 0) + 1
    return tally


def streaks(days: list[str], today: str) -> tuple[int, int]:
    """``(current, longest)`` runs of consecutive recorded days.

    ``current`` counts back from today and tolerates today being empty — a
    streak should not read as broken at 00:01 UTC before the day's first
    session, only once a whole day has been missed.
    """
    recorded = sorted(set(days))
    if not recorded:
        return (0, 0)

    longest = 1
    run = 1
    for earlier, later in zip(recorded, recorded[1:], strict=False):
        if date.fromisoformat(later) - date.fromisoformat(earlier) == timedelta(days=1):
            run += 1
            longest = max(longest, run)
        else:
            run = 1

    present = set(recorded)
    cursor = date.fromisoformat(today)
    if today not in present:
        # Yesterday still counts as live; the day before does not.
        cursor -= timedelta(days=1)
        if cursor.isoformat() not in present:
            return (0, longest)
    current = 0
    while cursor.isoformat() in present:
        current += 1
        cursor -= timedelta(days=1)
    return (current, longest)


async def _day_row(session: AsyncSession, owner_user_id: str, day: str) -> LegionDay:
    row = await session.get(LegionDay, (owner_user_id, day))
    if row is not None:
        return row
    row = LegionDay(
        owner_user_id=owner_user_id,
        day=day,
        sessions_started=0,
        session_seconds=0,
        peak_sessions=0,
        peak_hosts_online=0,
        agents="{}",
        updated_at=_utcnow(),
    )
    session.add(row)
    await session.flush()
    return row


async def _record(owner_user_id: str, apply) -> None:
    """Run one rollup mutation in its own session, swallowing every failure.

    Two writers can race onto the same (owner, day) primary key; the loser sees
    an integrity error, and one retry against the now-existing row settles it.
    Beyond that the counter is simply lost, which is the correct trade for a
    statistic that must never be able to fail a request.
    """
    sm = get_sessionmaker()
    for attempt in (0, 1):
        try:
            async with sm() as session:
                row = await _day_row(session, owner_user_id, utc_day())
                apply(row)
                row.updated_at = _utcnow()
                await session.commit()
            return
        except SQLAlchemyError:
            if attempt == 0:
                continue
            log.debug("legion rollup dropped for user=%s", owner_user_id, exc_info=True)
        except Exception:  # pragma: no cover - defensive
            log.debug("legion rollup dropped for user=%s", owner_user_id, exc_info=True)
            return


async def record_session_started(owner_user_id: str) -> None:
    """One more session summoned today."""

    def apply(row: LegionDay) -> None:
        row.sessions_started += 1

    await _record(owner_user_id, apply)


async def record_session_seconds(owner_user_id: str, seconds: int) -> None:
    """Wall-clock a finished session ran for, floored at zero.

    Booked on the day the session *ended*, not the day it started: a rollup
    keyed on the end is the only one a single UPDATE can do correctly when a
    session spans midnight.
    """
    if seconds <= 0:
        return

    def apply(row: LegionDay) -> None:
        row.session_seconds += seconds

    await _record(owner_user_id, apply)


async def record_agent(owner_user_id: str, command: str) -> None:
    """One sighting of a foreground basename."""
    if not command.strip():
        return

    def apply(row: LegionDay) -> None:
        row.agents = json.dumps(merge_agent(parse_agents(row.agents), command))

    await _record(owner_user_id, apply)


async def record_peaks(
    owner_user_id: str, *, sessions: int | None = None, hosts_online: int | None = None
) -> None:
    """Raise today's high-water marks. Never lowers one."""
    if sessions is None and hosts_online is None:
        return

    def apply(row: LegionDay) -> None:
        if sessions is not None:
            row.peak_sessions = max(row.peak_sessions, sessions)
        if hosts_online is not None:
            row.peak_hosts_online = max(row.peak_hosts_online, hosts_online)

    await _record(owner_user_id, apply)


async def live_counts(session: AsyncSession, owner_user_id: str) -> tuple[int, int]:
    """``(live sessions, online hosts)`` right now, for the peak recorders."""
    sessions = (
        await session.execute(
            select(func.count(Session.id)).where(
                Session.owner_user_id == owner_user_id,
                Session.status.in_(("starting", "running")),
            )
        )
    ).scalar_one()
    hosts_online = (
        await session.execute(
            select(func.count(Host.id)).where(
                Host.owner_user_id == owner_user_id,
                Host.status == "online",
            )
        )
    ).scalar_one()
    return (int(sessions), int(hosts_online))
