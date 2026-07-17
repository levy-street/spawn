"""Validation and presentation helpers for pinned daemon host identities."""

from __future__ import annotations

import base64
import binascii
import hashlib

from fastapi import HTTPException

HOST_KEY_ALGORITHM = "ed25519"
ED25519_PUBLIC_KEY_BYTES = 32
ED25519_PUBLIC_KEY_B64URL_LENGTH = 43
FINGERPRINT_HASH_BYTES = 12

# RFC 8032 section 5.1.3 field and curve constants. Keeping this validation
# local avoids delegating acceptance to an OpenSSL/WebCrypto import path whose
# treatment of weak or mixed-torsion points may differ from the 01A contract.
_ED25519_FIELD = 2**255 - 19
_ED25519_D = (-121665 * pow(121666, _ED25519_FIELD - 2, _ED25519_FIELD)) % _ED25519_FIELD
_ED25519_SQRT_M1 = pow(2, (_ED25519_FIELD - 1) // 4, _ED25519_FIELD)


def _decode_strict_ed25519_point(raw: bytes) -> tuple[int, int]:
    """Decode one canonical RFC 8032 point and reject the small-order subgroup."""

    compressed = int.from_bytes(raw, "little")
    x_sign = compressed >> 255
    y = compressed & ((1 << 255) - 1)
    if y >= _ED25519_FIELD:
        raise ValueError("noncanonical Ed25519 point")

    y_squared = y * y % _ED25519_FIELD
    numerator = (y_squared - 1) % _ED25519_FIELD
    denominator = (_ED25519_D * y_squared + 1) % _ED25519_FIELD
    x_squared = numerator * pow(denominator, _ED25519_FIELD - 2, _ED25519_FIELD)
    x_squared %= _ED25519_FIELD
    x = pow(x_squared, (_ED25519_FIELD + 3) // 8, _ED25519_FIELD)
    if x * x % _ED25519_FIELD != x_squared:
        x = x * _ED25519_SQRT_M1 % _ED25519_FIELD
    if x * x % _ED25519_FIELD != x_squared:
        raise ValueError("off-curve Ed25519 point")
    if x == 0 and x_sign == 1:
        raise ValueError("noncanonical Ed25519 x sign")
    if x & 1 != x_sign:
        x = _ED25519_FIELD - x

    # A point is weak exactly when multiplying it by Ed25519's cofactor gives
    # the identity. Three complete Edwards doublings preserve valid
    # mixed-torsion points with a non-small-order component.
    for _ in range(3):
        x_squared = x * x % _ED25519_FIELD
        y_squared = y * y % _ED25519_FIELD
        product = _ED25519_D * x_squared * y_squared % _ED25519_FIELD
        x = (
            2
            * x
            * y
            * pow((1 + product) % _ED25519_FIELD, _ED25519_FIELD - 2, _ED25519_FIELD)
            % _ED25519_FIELD
        )
        y = (
            (y_squared + x_squared)
            * pow((1 - product) % _ED25519_FIELD, _ED25519_FIELD - 2, _ED25519_FIELD)
            % _ED25519_FIELD
        )
    if x == 0 and y == 1:
        raise ValueError("weak Ed25519 point")
    return x, y


def decode_host_public_key(algorithm: str, encoded: str) -> bytes:
    """Decode an exact canonical unpadded base64url Ed25519 public key."""

    if algorithm != HOST_KEY_ALGORITHM:
        raise HTTPException(status_code=422, detail="unsupported host key algorithm")
    if len(encoded) != ED25519_PUBLIC_KEY_B64URL_LENGTH or "=" in encoded:
        raise HTTPException(status_code=422, detail="invalid Ed25519 public key")
    try:
        raw = base64.b64decode(encoded + "=", altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="invalid Ed25519 public key") from exc
    canonical = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    if len(raw) != ED25519_PUBLIC_KEY_BYTES or canonical != encoded:
        raise HTTPException(status_code=422, detail="invalid Ed25519 public key")
    try:
        _decode_strict_ed25519_point(raw)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="invalid Ed25519 public key") from exc
    return raw


def host_key_fingerprint(algorithm: str, encoded: str) -> str:
    """Return the server-derived 96-bit short fingerprint shown at approval."""

    raw = decode_host_public_key(algorithm, encoded)
    digest = hashlib.sha256(raw).digest()[:FINGERPRINT_HASH_BYTES]
    short = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return f"SHA256:{short}"
