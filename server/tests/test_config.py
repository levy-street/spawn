"""Configuration boundaries added by the connection-reliability work."""

import pytest
from pydantic import ValidationError

from spawn_server.config import (
    DEVELOPMENT_JWT_SECRET,
    PUBLISHED_JWT_SECRETS,
    InsecureConfigurationError,
    Settings,
    is_local_deployment,
)


def test_daemon_registration_concurrency_is_overridable_and_bounded():
    assert Settings(_env_file=None).daemon_registration_concurrency == 32
    assert (
        Settings(_env_file=None, daemon_registration_concurrency=7).daemon_registration_concurrency
        == 7
    )
    with pytest.raises(ValidationError):
        Settings(_env_file=None, daemon_registration_concurrency=0)


def _settings(**overrides):
    """Settings holding exactly the defaults a fresh checkout has.

    `_env_file=None` keeps a developer's own `.env` out of it, and the two
    values are passed explicitly because the ambient environment sets them —
    the test harness exports `SPAWN_JWT_SECRET`, so a `Settings()` built here
    is not the one a truncated production env file would produce.
    """
    return Settings(
        _env_file=None,
        **{"jwt_secret": DEVELOPMENT_JWT_SECRET, "email_backend": "console", **overrides},
    )


class TestLocalDeploymentDetection:
    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:8000",
            "http://127.0.0.1:8000",
            "http://[::1]:8000",
            "http://0.0.0.0:8000",
            "https://spawn.local",
            "http://dev.localhost:3000",
            # Testing the phone app means pointing the daemon at a LAN address.
            # That is still somebody's laptop.
            "http://192.168.1.24:8000",
            "http://10.0.0.7:8000",
            "http://172.16.4.4:8000",
            "http://169.254.10.1:8000",
            "",
        ],
    )
    def test_a_machine_only_its_owner_can_reach_is_local(self, url):
        assert is_local_deployment(url) is True

    @pytest.mark.parametrize(
        "url",
        [
            "https://spawnd.dev",
            "http://8.8.8.8",
            "https://api.example.com:8443",
            # No scheme: already broken elsewhere, but it must not read as
            # "no host, therefore a laptop" and slip past the guard.
            "spawnd.dev",
        ],
    )
    def test_anything_the_internet_can_reach_is_not(self, url):
        assert is_local_deployment(url) is False


class TestDevelopmentDefaultsInProduction:
    def test_a_laptop_keeps_every_default_it_has_today(self):
        """The guard must be invisible to anyone running `uv run` locally."""
        settings = _settings(public_url="http://localhost:8000")
        assert settings.jwt_secret == DEVELOPMENT_JWT_SECRET
        assert settings.email_backend == "console"

    @pytest.mark.parametrize("secret", sorted(PUBLISHED_JWT_SECRETS))
    def test_a_public_url_with_a_published_signing_key_refuses_to_start(self, secret):
        """Not just the `config.py` default.

        `.env.example` and `scripts/dev.sh` each carry their own placeholder,
        and copying one of those files into production and editing everything
        except that line is the likeliest way to arrive here.
        """
        with pytest.raises(InsecureConfigurationError) as raised:
            _settings(public_url="https://spawnd.dev", jwt_secret=secret, email_backend="smtp")
        message = str(raised.value)
        # The operator is told which variable to set, not handed a traceback
        # to interpret.
        assert "SPAWN_JWT_SECRET" in message
        assert "https://spawnd.dev" in message

    def test_the_placeholders_named_here_are_the_ones_the_repository_ships(self):
        """A placeholder renamed in `.env.example` or `dev.sh` and not here is
        a hole that nothing else would notice."""
        from pathlib import Path

        root = Path(__file__).resolve().parents[2]
        shipped = (root / ".env.example").read_text() + (root / "scripts" / "dev.sh").read_text()
        for secret in PUBLISHED_JWT_SECRETS - {DEVELOPMENT_JWT_SECRET}:
            assert secret in shipped, f"{secret!r} is no longer shipped; drop it from the set"

    def test_a_public_url_that_cannot_send_mail_refuses_to_start(self):
        with pytest.raises(InsecureConfigurationError) as raised:
            _settings(public_url="https://spawnd.dev", jwt_secret="a-real-random-secret")
        assert "SPAWN_EMAIL_BACKEND" in str(raised.value)

    def test_both_faults_are_reported_at_once(self):
        """One restart per problem is how an operator loses an afternoon."""
        with pytest.raises(InsecureConfigurationError) as raised:
            _settings(public_url="https://spawnd.dev")
        message = str(raised.value)
        assert "SPAWN_JWT_SECRET" in message
        assert "SPAWN_EMAIL_BACKEND" in message

    def test_a_properly_configured_public_deployment_starts(self):
        settings = _settings(
            public_url="https://spawnd.dev",
            jwt_secret="a-real-random-secret",
            email_backend="smtp",
        )
        assert settings.public_url == "https://spawnd.dev"

    def test_a_deployment_that_deliberately_sends_no_mail_is_allowed_to_say_so(self):
        """'disabled' is an operator's explicit decision; 'console' is a default
        nobody chose."""
        settings = _settings(
            public_url="https://spawnd.dev",
            jwt_secret="a-real-random-secret",
            email_backend="disabled",
        )
        assert settings.email_backend == "disabled"
