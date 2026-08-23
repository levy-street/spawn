"""Startup refuses to serve on a signing key anyone can guess."""

from __future__ import annotations

import pytest

from spawn_server.config import (
    INSECURE_JWT_SECRETS,
    MIN_JWT_SECRET_BYTES,
    InsecureJwtSecretError,
    Settings,
    assert_jwt_secret_usable,
)


def _settings(**overrides) -> Settings:
    base = {"jwt_secret": "x" * MIN_JWT_SECRET_BYTES, "allow_insecure_jwt_secret": False}
    base.update(overrides)
    return Settings.model_construct(**base)


def test_a_long_random_secret_boots():
    assert_jwt_secret_usable(_settings(jwt_secret="q" * 64))


@pytest.mark.parametrize("secret", sorted(INSECURE_JWT_SECRETS))
def test_placeholders_shipped_in_this_repository_refuse_to_boot(secret):
    """Both are published, so both authenticate nothing."""

    with pytest.raises(InsecureJwtSecretError) as excinfo:
        assert_jwt_secret_usable(_settings(jwt_secret=secret))
    # The message has to tell an operator what to do at 3am.
    assert "SPAWN_JWT_SECRET" in str(excinfo.value)
    assert "secrets.token_urlsafe" in str(excinfo.value)


def test_the_field_default_is_one_of_the_rejected_placeholders():
    """Nothing may boot by omission — the guard's whole point."""

    assert Settings.model_fields["jwt_secret"].default in INSECURE_JWT_SECRETS


@pytest.mark.parametrize("secret", ["", "   ", "short", "x" * (MIN_JWT_SECRET_BYTES - 1)])
def test_empty_or_short_secrets_refuse_to_boot(secret):
    with pytest.raises(InsecureJwtSecretError):
        assert_jwt_secret_usable(_settings(jwt_secret=secret))


def test_exactly_the_minimum_length_is_accepted():
    assert_jwt_secret_usable(_settings(jwt_secret="x" * MIN_JWT_SECRET_BYTES))


def test_multibyte_secrets_are_measured_in_bytes_not_characters():
    """31 three-byte characters is 93 bytes of key, and fine."""

    assert_jwt_secret_usable(_settings(jwt_secret="✓" * (MIN_JWT_SECRET_BYTES - 1)))


def test_explicit_opt_in_is_the_only_way_past_the_gate():
    with pytest.raises(InsecureJwtSecretError):
        assert_jwt_secret_usable(_settings(jwt_secret="change-me-in-prod"))
    assert_jwt_secret_usable(
        _settings(jwt_secret="change-me-in-prod", allow_insecure_jwt_secret=True)
    )


async def test_the_app_lifespan_refuses_to_come_up(monkeypatch):
    """Not just a helper nobody calls — startup actually fails closed."""

    from spawn_server import main as main_mod
    from spawn_server.config import get_settings

    monkeypatch.setenv("SPAWN_JWT_SECRET", "change-me-in-prod")
    monkeypatch.delenv("SPAWN_ALLOW_INSECURE_JWT_SECRET", raising=False)
    get_settings.cache_clear()  # type: ignore[attr-defined]
    try:
        with pytest.raises(InsecureJwtSecretError):
            async with main_mod.lifespan(main_mod.app):
                pass
    finally:
        get_settings.cache_clear()  # type: ignore[attr-defined]
