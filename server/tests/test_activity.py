"""Activity classification for daemon PTY output."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from spawn_server.ws.activity import output_payload_is_meaningful, should_record_agent_output


def test_tmux_status_only_output_is_not_activity():
    payload = (
        b"\x1b[?25l\x1b[30m\x1b[42m\x1b[38;1H"
        b'[spawn-bb10:node*        "minecraft-jepa-curios" 04:54 08-May-26'
        b"\x1b(B\x1b[m\x1b[?12l\x1b[?25h\x1b[35;3H"
    )

    assert not output_payload_is_meaningful(payload)
    assert not should_record_agent_output("status-only-agent", datetime(2026, 1, 1, tzinfo=UTC), payload)


def test_partial_tmux_status_output_is_not_activity():
    payload = b'           "minecraft-jepa-curios" 04:49 08-May-26\x1b(B\x1b[m'

    assert not output_payload_is_meaningful(payload)


def test_real_output_is_activity_and_still_throttled():
    now = datetime(2026, 1, 1, tzinfo=UTC)
    payload = b"\x1b[32m\xe2\x80\xa2\x1b(B\x1b[m Updated the running web process again.\r\n"

    assert output_payload_is_meaningful(payload)
    assert should_record_agent_output("real-output-agent", now, payload)
    assert not should_record_agent_output(
        "real-output-agent",
        now + timedelta(seconds=1),
        payload,
    )
    assert should_record_agent_output(
        "real-output-agent",
        now + timedelta(seconds=3),
        payload,
    )


def test_real_output_with_tmux_status_tail_is_activity():
    payload = (
        b"Working for 12s\r\n"
        b"\x1b[30m\x1b[42m\x1b[38;1H"
        b'[spawn-9150:node*        "spawn" 04:54 08-May-26'
        b"\x1b(B\x1b[m"
    )

    assert output_payload_is_meaningful(payload)
