"""Fixed-window request caps for the endpoints worth abusing.

Scoped deliberately narrowly: signup, login, password reset, verification
resend, and device pairing. These are the routes where an unlimited script
costs the operator something real — accounts, mail reputation, TURN relay
bandwidth — and the ones where a human is never fast enough to notice a cap.

Redis-backed so the limit is shared across workers, with a per-process
fallback: a limiter that fails open on a Redis blip is better than an auth
surface that fails closed for everyone.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

from fastapi import HTTPException, Request, status

from .config import get_settings

log = logging.getLogger(__name__)

# Per-process fallback: {key: (window_start, count)}
_local_counters: dict[str, tuple[int, int]] = {}


@dataclass(frozen=True)
class RateLimit:
    """`limit` requests per `window_seconds`, per client, per `name`."""

    name: str
    limit: int
    window_seconds: int


def client_key(request: Request) -> str:
    """Identify the caller.

    Behind the deployment's reverse proxy the socket peer is always the proxy,
    so the forwarded chain's first hop is used when present. It is
    client-controlled and therefore spoofable; that is acceptable for a
    throttle (worst case an attacker rotates their own bucket) and not
    acceptable for anything that grants access, which is why nothing else
    consults it.
    """

    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    return request.client.host if request.client else "unknown"


async def _hit_redis(key: str, window: int) -> int | None:
    try:
        from .redis import get_backend

        client = get_backend().client
        if client is None:
            # In-process pubsub mode (tests, single-node dev): no shared store.
            return None
        count = await client.incr(key)
        if count == 1:
            await client.expire(key, window)
        return int(count)
    except Exception as exc:  # pragma: no cover - depends on deployment
        log.debug("rate limit redis unavailable, using local counter: %s", exc)
        return None


def _hit_local(key: str, window: int) -> int:
    now = int(time.time())
    start = now - (now % window)
    previous_start, count = _local_counters.get(key, (start, 0))
    if previous_start != start:
        count = 0
    count += 1
    _local_counters[key] = (start, count)
    if len(_local_counters) > 10_000:
        # Unbounded growth is its own denial of service; drop the oldest
        # windows rather than hold every key an attacker can invent.
        for stale_key in [k for k, (s, _) in _local_counters.items() if s != start][:5_000]:
            _local_counters.pop(stale_key, None)
    return count


async def enforce(request: Request, rule: RateLimit) -> None:
    """Count this request against `rule`, raising 429 when over."""

    if not get_settings().rate_limit_enabled:
        return
    now = int(time.time())
    window_start = now - (now % rule.window_seconds)
    key = f"spawn:rl:{rule.name}:{client_key(request)}:{window_start}"

    count = await _hit_redis(key, rule.window_seconds)
    if count is None:
        count = _hit_local(key, rule.window_seconds)

    if count > rule.limit:
        retry_after = rule.window_seconds - (now - window_start)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="too many requests; slow down",
            headers={"Retry-After": str(max(1, retry_after))},
        )


def limiter(rule: RateLimit):
    """FastAPI dependency applying `rule`."""

    async def dependency(request: Request) -> None:
        await enforce(request, rule)

    return dependency


SIGNUP = RateLimit("signup", limit=5, window_seconds=3600)
LOGIN = RateLimit("login", limit=20, window_seconds=900)
PASSWORD_RESET = RateLimit("password_reset", limit=5, window_seconds=3600)
VERIFY_RESEND = RateLimit("verify_resend", limit=5, window_seconds=3600)
DEVICE_PAIRING = RateLimit("device_pairing", limit=30, window_seconds=3600)
