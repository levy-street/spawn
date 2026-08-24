"""Signing for, and verification of, Sign in with Apple tokens.

Apple is the one provider that does not fit the shape the others share. It
issues no client secret — you sign one yourself with a key downloaded once from
the developer portal — and it publishes no userinfo endpoint, so the account's
identity has to be read out of the id_token rather than fetched afterwards.
Both halves live here so `auth_providers` keeps the shape of the common case.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm

from .config import Settings

APPLE_ISSUER = "https://appleid.apple.com"
APPLE_KEYS_URL = f"{APPLE_ISSUER}/auth/keys"
APPLE_AUTHORIZATION_ENDPOINT = f"{APPLE_ISSUER}/auth/authorize"
APPLE_TOKEN_ENDPOINT = f"{APPLE_ISSUER}/auth/token"

# Apple rotates its signing keys without warning, so the set is cached only
# briefly, and any unknown `kid` forces a refetch regardless of age.
_JWKS_TTL_SECONDS = 600


class AppleIdentityError(Exception):
    """The token could not be trusted, with a reason safe to log."""


@dataclass(frozen=True)
class AppleIdentity:
    subject: str
    email: str
    email_verified: bool


@dataclass
class _SecretCache:
    value: str
    expires_at: float
    fingerprint: tuple[str, str, str, str]


_secret_cache: _SecretCache | None = None
_jwks_cache: tuple[float, dict[str, Any]] | None = None


def apple_audiences(settings: Settings) -> tuple[str, ...]:
    """Every client id an Apple token may legitimately be addressed to.

    The website and the app are separate clients to Apple, and a token minted
    for one is simply not valid for the other, so both have to be named here or
    native sign-in fails audience validation against the web Services ID.
    """
    audiences = [settings.apple_client_id, settings.apple_native_client_id]
    return tuple(dict.fromkeys(a for a in audiences if a))


def apple_is_configured(settings: Settings) -> bool:
    return all(
        (
            settings.apple_team_id,
            settings.apple_key_id,
            settings.apple_private_key,
            settings.apple_client_id,
        )
    )


def _normalized_private_key(raw: str) -> str:
    """Accept the .p8 either as-is or with its newlines escaped.

    Most secret stores hand back exactly what you paste in; some flatten
    newlines to `\\n` on the way through. A PEM that lost its line breaks is
    rejected by `cryptography` with an error that says nothing useful, so
    normalize here instead of debugging it in production.
    """
    return raw.replace("\\n", "\n").strip()


def apple_client_secret(settings: Settings) -> str:
    """The ES256 JWT that stands in for a client secret, minted and cached."""
    global _secret_cache

    if not apple_is_configured(settings):
        raise AppleIdentityError("Sign in with Apple is not configured")

    team_id = str(settings.apple_team_id)
    key_id = str(settings.apple_key_id)
    client_id = str(settings.apple_client_id)
    private_key = _normalized_private_key(str(settings.apple_private_key))
    fingerprint = (team_id, key_id, client_id, private_key)

    now = time.time()
    cached = _secret_cache
    # Re-sign a minute early so a secret never expires mid-request.
    if cached and cached.fingerprint == fingerprint and cached.expires_at - 60 > now:
        return cached.value

    expires_at = now + settings.apple_client_secret_ttl_seconds
    try:
        secret = jwt.encode(
            {
                "iss": team_id,
                "iat": int(now),
                "exp": int(expires_at),
                "aud": APPLE_ISSUER,
                "sub": client_id,
            },
            private_key,
            algorithm="ES256",
            headers={"kid": key_id},
        )
    except Exception as e:  # noqa: BLE001 - surfaces as a configuration error
        raise AppleIdentityError("the Apple signing key could not be used") from e

    _secret_cache = _SecretCache(value=secret, expires_at=expires_at, fingerprint=fingerprint)
    return secret


async def _fetch_jwks(client: httpx.AsyncClient) -> dict[str, Any]:
    response = await client.get(APPLE_KEYS_URL)
    if response.status_code >= 400:
        raise AppleIdentityError("Apple's signing keys could not be fetched")
    body = response.json()
    if not isinstance(body, dict) or not isinstance(body.get("keys"), list):
        raise AppleIdentityError("Apple returned an unreadable key set")
    return body


async def _signing_key(kid: str, client: httpx.AsyncClient | None = None) -> Any:
    global _jwks_cache

    async def keys_for(force: bool) -> dict[str, Any]:
        global _jwks_cache
        cached = _jwks_cache
        if not force and cached and cached[0] > time.time():
            return cached[1]
        owned = client is None
        http = client or httpx.AsyncClient(timeout=10)
        try:
            body = await _fetch_jwks(http)
        finally:
            if owned:
                await http.aclose()
        _jwks_cache = (time.time() + _JWKS_TTL_SECONDS, body)
        return body

    for force in (False, True):
        body = await keys_for(force)
        for key in body["keys"]:
            if isinstance(key, dict) and key.get("kid") == kid:
                return RSAAlgorithm.from_jwk(key)
        # An unknown kid usually means Apple rotated; one forced refetch settles it.
    raise AppleIdentityError("Apple's signing key for this token was not found")


def _claimed_email(claims: dict[str, Any]) -> tuple[str, bool]:
    email = claims.get("email")
    if not isinstance(email, str) or "@" not in email:
        return "", False
    verified = claims.get("email_verified")
    # Apple has shipped this as both a bool and a string over the years.
    return email, verified is True or verified == "true"


async def verify_apple_identity_token(
    token: str,
    *,
    settings: Settings,
    client: httpx.AsyncClient | None = None,
) -> AppleIdentity:
    """Check an Apple id_token's signature, issuer and audience, and read it.

    The audience check is the one that matters: without it any Apple token from
    any app would sign somebody in here, which is the classic way this provider
    is broken.
    """
    audiences = apple_audiences(settings)
    if not audiences:
        raise AppleIdentityError("Sign in with Apple is not configured")

    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as e:
        raise AppleIdentityError("the Apple token could not be read") from e
    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise AppleIdentityError("the Apple token names no signing key")

    key = await _signing_key(kid, client)
    try:
        claims = jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=list(audiences),
            issuer=APPLE_ISSUER,
            options={"require": ["sub", "aud", "iss", "exp"]},
        )
    except jwt.PyJWTError as e:
        raise AppleIdentityError("the Apple token was rejected") from e

    subject = claims.get("sub")
    if not isinstance(subject, str) or not subject:
        raise AppleIdentityError("the Apple token carries no account id")

    email, verified = _claimed_email(claims)
    return AppleIdentity(subject=subject, email=email, email_verified=verified)


def reset_apple_caches() -> None:
    """Drop cached secrets and keys. Tests rely on this; nothing else should."""
    global _secret_cache, _jwks_cache
    _secret_cache = None
    _jwks_cache = None
