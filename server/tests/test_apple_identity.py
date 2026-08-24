"""Sign in with Apple: client-secret minting and identity-token verification."""

from __future__ import annotations

import time

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)

from spawn_server import apple_identity
from spawn_server.apple_identity import (
    APPLE_ISSUER,
    AppleIdentityError,
    apple_audiences,
    apple_client_secret,
    apple_is_configured,
    reset_apple_caches,
    verify_apple_identity_token,
)
from spawn_server.config import Settings

WEB_CLIENT = "dev.spawnd.web"
NATIVE_CLIENT = "dev.spawnd"


def bare_settings(**overrides) -> Settings:
    """Settings built from the arguments alone.

    `_env_file=None` matters: a developer with real Apple values in their local
    `.env` would otherwise find "unconfigured" tests reading as configured, and
    the failure would point at this module rather than at their own machine.
    """
    return Settings(_env_file=None, **overrides)


def _p8() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()
    ).decode("ascii")


@pytest.fixture(autouse=True)
def clean_caches():
    reset_apple_caches()
    yield
    reset_apple_caches()


@pytest.fixture
def settings() -> Settings:
    return bare_settings(
        apple_team_id="TEAM123456",
        apple_key_id="KEY1234567",
        apple_private_key=_p8(),
        apple_client_id=WEB_CLIENT,
        apple_native_client_id=NATIVE_CLIENT,
    )


@pytest.fixture
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _jwks_transport(signing_key, kid: str = "test-kid") -> httpx.MockTransport:
    numbers = signing_key.public_key().public_numbers()

    def to_b64(value: int) -> str:
        import base64

        raw = value.to_bytes((value.bit_length() + 7) // 8, "big")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    body = {
        "keys": [
            {
                "kty": "RSA",
                "kid": kid,
                "use": "sig",
                "alg": "RS256",
                "n": to_b64(numbers.n),
                "e": to_b64(numbers.e),
            }
        ]
    }
    return httpx.MockTransport(lambda _request: httpx.Response(200, json=body))


def _id_token(signing_key, *, kid: str = "test-kid", **claims) -> str:
    payload = {
        "iss": APPLE_ISSUER,
        "aud": WEB_CLIENT,
        "sub": "001234.abcdef.0000",
        "iat": int(time.time()),
        "exp": int(time.time()) + 600,
        "email": "operator@example.com",
        "email_verified": "true",
    }
    payload.update(claims)
    return jwt.encode(payload, signing_key, algorithm="RS256", headers={"kid": kid})


class TestClientSecret:
    def test_unconfigured_provider_is_simply_off(self):
        assert apple_is_configured(bare_settings()) is False
        with pytest.raises(AppleIdentityError):
            apple_client_secret(bare_settings())

    def test_mints_a_secret_apple_would_accept(self, settings):
        secret = apple_client_secret(settings)
        header = jwt.get_unverified_header(secret)
        claims = jwt.decode(secret, options={"verify_signature": False}, audience=APPLE_ISSUER)

        assert header["alg"] == "ES256"
        assert header["kid"] == settings.apple_key_id
        assert claims["iss"] == settings.apple_team_id
        assert claims["sub"] == WEB_CLIENT
        assert claims["aud"] == APPLE_ISSUER
        # Apple's own ceiling is six months; anything past it is rejected outright.
        assert claims["exp"] - claims["iat"] <= 15_777_000

    def test_reuses_a_live_secret_rather_than_resigning_per_request(self, settings):
        assert apple_client_secret(settings) == apple_client_secret(settings)

    def test_a_changed_key_invalidates_the_cached_secret(self, settings):
        first = apple_client_secret(settings)
        rotated = settings.model_copy(update={"apple_private_key": _p8()})
        assert apple_client_secret(rotated) != first

    def test_a_key_flattened_by_a_secret_store_still_loads(self, settings):
        # Some secret stores hand back the PEM with its newlines escaped.
        flattened = settings.model_copy(
            update={"apple_private_key": settings.apple_private_key.replace("\n", "\\n")}
        )
        assert apple_client_secret(flattened)

    def test_an_unusable_key_disables_the_provider_instead_of_raising_later(self, settings):
        broken = settings.model_copy(update={"apple_private_key": "not a key"})
        with pytest.raises(AppleIdentityError):
            apple_client_secret(broken)


class TestIdentityToken:
    async def test_accepts_a_token_addressed_to_the_web_client(self, settings, signing_key):
        async with httpx.AsyncClient(transport=_jwks_transport(signing_key)) as client:
            identity = await verify_apple_identity_token(
                _id_token(signing_key), settings=settings, client=client
            )
        assert identity.subject == "001234.abcdef.0000"
        assert identity.email == "operator@example.com"
        assert identity.email_verified is True

    async def test_accepts_the_native_audience_too(self, settings, signing_key):
        """The app authorizes under the bundle id, not the web Services ID.

        Checking only the web client is the classic way native sign-in breaks.
        """
        token = _id_token(signing_key, aud=NATIVE_CLIENT)
        async with httpx.AsyncClient(transport=_jwks_transport(signing_key)) as client:
            identity = await verify_apple_identity_token(
                token, settings=settings, client=client
            )
        assert identity.subject == "001234.abcdef.0000"

    async def test_rejects_a_token_minted_for_another_app(self, settings, signing_key):
        token = _id_token(signing_key, aud="com.someone.else")
        async with httpx.AsyncClient(transport=_jwks_transport(signing_key)) as client:
            with pytest.raises(AppleIdentityError):
                await verify_apple_identity_token(token, settings=settings, client=client)

    async def test_rejects_a_token_from_another_issuer(self, settings, signing_key):
        token = _id_token(signing_key, iss="https://accounts.google.com")
        async with httpx.AsyncClient(transport=_jwks_transport(signing_key)) as client:
            with pytest.raises(AppleIdentityError):
                await verify_apple_identity_token(token, settings=settings, client=client)

    async def test_rejects_an_expired_token(self, settings, signing_key):
        token = _id_token(signing_key, exp=int(time.time()) - 60)
        async with httpx.AsyncClient(transport=_jwks_transport(signing_key)) as client:
            with pytest.raises(AppleIdentityError):
                await verify_apple_identity_token(token, settings=settings, client=client)

    async def test_rejects_a_token_signed_by_the_wrong_key(self, settings, signing_key):
        impostor = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        token = _id_token(impostor)
        async with httpx.AsyncClient(transport=_jwks_transport(signing_key)) as client:
            with pytest.raises(AppleIdentityError):
                await verify_apple_identity_token(token, settings=settings, client=client)

    async def test_rejects_an_unsigned_token(self, settings, signing_key):
        """`alg: none` must not be a way past the signature check."""
        token = jwt.encode(
            {"iss": APPLE_ISSUER, "aud": WEB_CLIENT, "sub": "x", "exp": int(time.time()) + 60},
            key="",
            algorithm="none",
            headers={"kid": "test-kid"},
        )
        async with httpx.AsyncClient(transport=_jwks_transport(signing_key)) as client:
            with pytest.raises(AppleIdentityError):
                await verify_apple_identity_token(token, settings=settings, client=client)

    async def test_a_returning_user_arrives_without_an_email(self, settings, signing_key):
        """Apple sends the email only on the first authorization, never again.

        Treating that as a failure is what makes this provider work exactly
        once per user, so the absence has to survive verification intact.
        """
        token = _id_token(signing_key, email=None, email_verified=None)
        async with httpx.AsyncClient(transport=_jwks_transport(signing_key)) as client:
            identity = await verify_apple_identity_token(
                token, settings=settings, client=client
            )
        assert identity.subject == "001234.abcdef.0000"
        assert identity.email == ""
        assert identity.email_verified is False

    async def test_reads_email_verified_sent_as_a_bool(self, settings, signing_key):
        token = _id_token(signing_key, email_verified=True)
        async with httpx.AsyncClient(transport=_jwks_transport(signing_key)) as client:
            identity = await verify_apple_identity_token(
                token, settings=settings, client=client
            )
        assert identity.email_verified is True

    async def test_an_unknown_key_id_forces_one_refetch_then_gives_up(
        self, settings, signing_key
    ):
        calls = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(200, json={"keys": []})

        token = _id_token(signing_key)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(AppleIdentityError):
                await verify_apple_identity_token(token, settings=settings, client=client)
        # Apple rotates without warning, so a miss is worth exactly one retry.
        assert calls == 2

    def test_audiences_dedupe_when_both_ids_match(self):
        shared = bare_settings(apple_client_id="dev.spawnd", apple_native_client_id="dev.spawnd")
        assert apple_audiences(shared) == ("dev.spawnd",)

    def test_native_audience_defaults_away_when_unset(self):
        only_web = bare_settings(apple_client_id=WEB_CLIENT)
        assert apple_audiences(only_web) == (WEB_CLIENT,)


def test_module_exposes_apple_endpoints():
    assert apple_identity.APPLE_TOKEN_ENDPOINT.startswith(APPLE_ISSUER)
