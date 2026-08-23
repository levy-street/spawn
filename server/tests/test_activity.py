from __future__ import annotations

from datetime import UTC, datetime, timedelta

from spawn_server.ws.activity import should_record_session_input


def test_input_touch_throttles_per_session():
    now = datetime(2026, 1, 1, tzinfo=UTC)

    assert should_record_session_input("one", now)
    assert not should_record_session_input("one", now + timedelta(milliseconds=999))
    assert should_record_session_input("one", now + timedelta(seconds=1))
    assert should_record_session_input("two", now)
