"""Lightweight activity classification helpers for browser/daemon streams."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta

OUTPUT_TOUCH_INTERVAL = timedelta(seconds=2)
INPUT_TOUCH_INTERVAL = timedelta(seconds=1)
INPUT_ECHO_SUPPRESS_WINDOW = timedelta(milliseconds=750)
REDRAW_SUPPRESS_WINDOW = timedelta(milliseconds=1500)
MIN_MEANINGFUL_OUTPUT_CHARS = 3

_OSC_RE = re.compile(r"\x1b\].*?(?:\x07|\x1b\\)")
_CSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_CHARSET_RE = re.compile(r"\x1b[()][A-Za-z0-9]")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_TMUX_STATUS_CLOCK_RE = re.compile(
    r"(?:\[spawn-[^\r\n]*?)?(?:\"[^\r\n\"]+\"\s+)?\d{2}:\d{2}\s+\d{2}-[A-Za-z]{3}-\d{2}"
)
_TMUX_STATUS_FRAGMENT_RE = re.compile(r"\[spawn-[^\r\n]*")
_WHITESPACE_RE = re.compile(r"\s+")

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


def output_payload_is_meaningful(payload: bytes) -> bool:
    text = payload.decode("utf-8", errors="ignore")
    text = _OSC_RE.sub("", text)
    text = _CSI_RE.sub("", text)
    text = _CHARSET_RE.sub("", text)
    text = _TMUX_STATUS_CLOCK_RE.sub("", text)
    text = _TMUX_STATUS_FRAGMENT_RE.sub("", text)
    text = _CONTROL_RE.sub("", text)
    normalized = _WHITESPACE_RE.sub("", text)
    return len(normalized) >= MIN_MEANINGFUL_OUTPUT_CHARS


def should_record_agent_output(agent_id: str, now: datetime, payload: bytes | None = None) -> bool:
    if payload is not None and not output_payload_is_meaningful(payload):
        return False

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
