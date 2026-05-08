"""Lightweight activity classification helpers for browser/daemon streams."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

OUTPUT_TOUCH_INTERVAL = timedelta(seconds=2)
INPUT_TOUCH_INTERVAL = timedelta(seconds=1)
INPUT_ECHO_SUPPRESS_WINDOW = timedelta(milliseconds=750)
REDRAW_SUPPRESS_WINDOW = timedelta(milliseconds=1500)

_last_output_touch_at: dict[str, datetime] = {}
_last_input_touch_at: dict[str, datetime] = {}
_output_suppressed_until: dict[str, datetime] = {}


def utcnow() -> datetime:
    return datetime.now(UTC)


def suppress_agent_output_activity(
    agent_id: str,
    *,
    now: datetime | None = None,
    duration: timedelta = REDRAW_SUPPRESS_WINDOW,
) -> None:
    current = now or utcnow()
    until = current + duration
    previous = _output_suppressed_until.get(agent_id)
    if previous is None or previous < until:
        _output_suppressed_until[agent_id] = until


def should_record_agent_input(agent_id: str, now: datetime) -> bool:
    suppress_agent_output_activity(agent_id, now=now, duration=INPUT_ECHO_SUPPRESS_WINDOW)
    previous = _last_input_touch_at.get(agent_id)
    if previous is not None and now - previous < INPUT_TOUCH_INTERVAL:
        return False
    _last_input_touch_at[agent_id] = now
    return True


def should_record_agent_output(agent_id: str, now: datetime) -> bool:
    suppressed_until = _output_suppressed_until.get(agent_id)
    if suppressed_until is not None:
        if now < suppressed_until:
            return False
        _output_suppressed_until.pop(agent_id, None)

    previous = _last_output_touch_at.get(agent_id)
    if previous is not None and now - previous < OUTPUT_TOUCH_INTERVAL:
        return False
    _last_output_touch_at[agent_id] = now
    return True
