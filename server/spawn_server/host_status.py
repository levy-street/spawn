"""Derived host-presence state shared by every HTTP serialization surface."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Protocol

HOST_ONLINE_FRESHNESS = timedelta(seconds=90)


class HostPresenceLike(Protocol):
    status: str
    last_seen_at: datetime | None


class MutableHostPresenceLike(HostPresenceLike, Protocol):
    last_disconnect_at: datetime | None
    last_disconnect_reason: str | None


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def derived_host_status(host: HostPresenceLike, now: datetime | None = None) -> str:
    """Return online only for a recently-seen row whose raw state is online."""

    if host.status != "online":
        return host.status
    observed_at = _aware(host.last_seen_at)
    current = _aware(now) if now is not None else datetime.now(UTC)
    if observed_at is None or observed_at < current - HOST_ONLINE_FRESHNESS:
        return "offline"
    return "online"


def stamp_stale_disconnect(host: MutableHostPresenceLike, now: datetime | None = None) -> bool:
    """Opportunistically persist a stale derived-offline transition.

    Returns whether the ORM object was changed so a route can commit once for
    a whole response surface.
    """

    if derived_host_status(host, now) != "offline":
        return False
    if host.status != "online":
        return False
    if host.last_disconnect_reason == "stale" and host.last_disconnect_at is not None:
        return False
    timestamp = _aware(now) if now is not None else datetime.now(UTC)
    host.last_disconnect_at = timestamp
    host.last_disconnect_reason = "stale"
    return True
