"""Server-side throttling for input paths whose bytes already cross the server.

Output classification and repaint suppression belong to the daemon: keeping
that state here would be inert for WebRTC and would encourage the server to
inspect terminal content again. WebRTC input is likewise signaled by a
daemon-throttled, content-free ``agent.input_activity`` frame.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

INPUT_TOUCH_INTERVAL = timedelta(seconds=1)
_last_input_touch_at: dict[str, datetime] = {}


def utcnow() -> datetime:
    return datetime.now(UTC)


def should_record_agent_input(agent_id: str, now: datetime) -> bool:
    previous = _last_input_touch_at.get(agent_id)
    if previous is not None and now - previous < INPUT_TOUCH_INTERVAL:
        return False
    _last_input_touch_at[agent_id] = now
    return True
