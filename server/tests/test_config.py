"""Configuration boundaries added by the connection-reliability work."""

import pytest
from pydantic import ValidationError

from spawn_server.config import Settings


def test_daemon_registration_concurrency_is_overridable_and_bounded():
    assert Settings(_env_file=None).daemon_registration_concurrency == 32
    assert (
        Settings(_env_file=None, daemon_registration_concurrency=7).daemon_registration_concurrency
        == 7
    )
    with pytest.raises(ValidationError):
        Settings(_env_file=None, daemon_registration_concurrency=0)
