"""Small shared reliability helpers for the WebSocket endpoints."""

from __future__ import annotations

import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from ..config import Settings

WS_KEEPALIVE_SECONDS = 25.0
RTC_CONFIG_REQUEST_MIN_INTERVAL_SECONDS = 5.0
ERROR_FRAME_MIN_INTERVAL_SECONDS = 1.0

_query_token_warning_emitted = False


def warn_query_token_once(log: logging.Logger) -> None:
    """Warn once when the legacy ``?token=`` WebSocket credential is used.

    The fallback stays until supported mobile releases all send an
    ``Authorization`` header. Once no supported client predates that release,
    remove both the fallback and this process-level warning.
    """

    global _query_token_warning_emitted
    if _query_token_warning_emitted:
        return
    _query_token_warning_emitted = True
    log.warning("deprecated websocket ?token= credential used; use Authorization header")


def rtc_config_refresh_seconds(settings: Settings) -> float:
    return min(settings.turn_ttl_seconds / 2, 3600.0)


@dataclass
class FrameRateLimiter:
    interval_seconds: float
    _last_sent_at: float = float("-inf")

    def allow(self, *, now: float | None = None) -> bool:
        timestamp = time.monotonic() if now is None else now
        if timestamp - self._last_sent_at < self.interval_seconds:
            return False
        self._last_sent_at = timestamp
        return True


class ErrorFrameSender:
    """Send at most one boundary-validation error per second per socket."""

    def __init__(self, send: Callable[[dict[str, object]], Awaitable[None]]) -> None:
        self._send = send
        self._rate = FrameRateLimiter(ERROR_FRAME_MIN_INTERVAL_SECONDS)

    async def send(self, code: str, frame_type: object) -> None:
        if not self._rate.allow():
            return
        await self._send(
            {
                "type": "error",
                "code": code,
                "frame_type": frame_type if isinstance(frame_type, str) else None,
            }
        )
