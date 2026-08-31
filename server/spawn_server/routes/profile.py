"""`/api/profile` — who you are, and what your legion has done.

One request backs the whole profile dialog: identity, the fleet as it stands
right now, and the daily record behind it. It is a read of rows the server
already keeps (`hosts`, `sessions`) plus the `legion_days` rollup, and it
computes nothing that would need a second round trip to make sense of.

The day series is returned *sparse* — only days something happened — together
with the window and the server's idea of today. Densifying that into a calendar
is the client's job, which keeps the payload small and, more usefully, keeps
one authority on what "today" is: a browser in UTC+13 must colour the same
squares the streak counter did.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..host_status import derived_host_status, stamp_stale_disconnect
from ..legion import HISTORY_DAYS, TOP_AGENTS, parse_agents, streaks, utc_day
from ..models import Host, LegionDay, Session, User

router = APIRouter(prefix="/api/profile", tags=["profile"])


@router.get("", response_model=schemas.ProfileOut)
async def get_profile(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.ProfileOut:
    today = utc_day()
    window_start = (datetime.now(UTC) - timedelta(days=HISTORY_DAYS - 1)).date().isoformat()

    hosts = list(
        (
            await session.execute(
                select(Host)
                .where(Host.owner_user_id == user.id)
                .order_by(Host.created_at.asc())
            )
        )
        .scalars()
        .all()
    )
    # One grouped count rather than a query per host: a fleet is small, but
    # this endpoint is opened from a menu and should never be N+1.
    counts = dict(
        (
            await session.execute(
                select(Session.host_id, func.count(Session.id))
                .where(Session.owner_user_id == user.id)
                .group_by(Session.host_id)
            )
        ).all()
    )
    live_sessions = (
        await session.execute(
            select(func.count(Session.id)).where(
                Session.owner_user_id == user.id,
                Session.status.in_(("starting", "running")),
            )
        )
    ).scalar_one()

    # Every recorded day, not just the window: totals, streaks and records are
    # lifetime figures, and only the series itself is trimmed for the calendar.
    all_days = list(
        (
            await session.execute(
                select(LegionDay)
                .where(LegionDay.owner_user_id == user.id)
                .order_by(LegionDay.day.asc())
            )
        )
        .scalars()
        .all()
    )

    agent_tally: dict[str, int] = {}
    for row in all_days:
        for name, count in parse_agents(row.agents).items():
            agent_tally[name] = agent_tally.get(name, 0) + count

    current_streak, longest_streak = streaks([row.day for row in all_days], today)
    now = datetime.now(UTC)
    stale_changed = False
    for host in hosts:
        stale_changed = stamp_stale_disconnect(host, now) or stale_changed
    if stale_changed:
        await session.commit()
    online = [host for host in hosts if derived_host_status(host, now) == "online"]

    totals = schemas.LegionTotalsOut(
        hosts=len(hosts),
        hosts_online=len(online),
        # Summed only over hosts that reported a spec. A fleet with one silent
        # daemon under-counts, which is honest; guessing a core count is not.
        cores=sum(host.cpu_cores or 0 for host in hosts),
        memory_bytes=sum(host.memory_bytes or 0 for host in hosts),
        sessions_live=int(live_sessions),
        sessions_started=sum(row.sessions_started for row in all_days),
        session_seconds=sum(row.session_seconds for row in all_days),
        active_days=len(all_days),
        current_streak=current_streak,
        longest_streak=longest_streak,
        peak_hosts_online=max((row.peak_hosts_online for row in all_days), default=len(online)),
        peak_sessions=max((row.peak_sessions for row in all_days), default=int(live_sessions)),
        first_day=all_days[0].day if all_days else None,
    )

    return schemas.ProfileOut(
        id=user.id,
        email=user.email,
        created_at=user.created_at,
        email_verified_at=user.email_verified_at,
        is_admin=user.is_admin,
        totals=totals,
        agents=[
            schemas.LegionAgentOut(command=name, count=count)
            for name, count in sorted(
                agent_tally.items(),
                # Count first, then name, so equal tallies keep a stable order
                # across requests instead of shuffling in the UI.
                key=lambda item: (-item[1], item[0]),
            )[:TOP_AGENTS]
        ],
        days=[
            schemas.LegionDayOut(
                day=row.day,
                sessions_started=row.sessions_started,
                session_seconds=row.session_seconds,
                peak_sessions=row.peak_sessions,
                peak_hosts_online=row.peak_hosts_online,
            )
            for row in all_days
            if row.day >= window_start
        ],
        hosts=[
            schemas.LegionHostOut(
                id=host.id,
                name=host.name,
                os=host.os,
                status=derived_host_status(host, now),
                cpu_cores=host.cpu_cores,
                memory_bytes=host.memory_bytes,
                gpu=host.gpu,
                session_count=int(counts.get(host.id, 0)),
                created_at=host.created_at,
                last_seen_at=host.last_seen_at,
            )
            for host in hosts
        ],
        history_days=HISTORY_DAYS,
        today=today,
    )
