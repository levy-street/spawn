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
    return raw


def host_key_fingerprint(algorithm: str, encoded: str) -> str:
    """Return the server-derived 96-bit short fingerprint shown at approval."""

    raw = decode_host_public_key(algorithm, encoded)
    digest = hashlib.sha256(raw).digest()[:FINGERPRINT_HASH_BYTES]
    short = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return f"SHA256:{short}"
