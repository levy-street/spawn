"""Server-side throttling for legacy/REST input."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from spawn_server.ws.activity import should_record_agent_input


def test_input_activity_is_throttled_per_agent():
    now = datetime(2026, 1, 1, tzinfo=UTC)
    assert should_record_agent_input("one", now)
    assert not should_record_agent_input("one", now + timedelta(milliseconds=999))
    assert should_record_agent_input("one", now + timedelta(seconds=1))
    assert should_record_agent_input("two", now)
