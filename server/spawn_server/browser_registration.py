"""Canonical proof-of-possession contract for account-bound browser identities."""

from __future__ import annotations

import base64
import binascii
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

from .host_identity import decode_ed25519_public_key

BROWSER_REGISTRATION_MAGIC = b"SPAWN-BROWSER-REGISTER-V1"
BROWSER_REGISTRATION_VERSION = 1
ED25519_SIGNATURE_BYTES = 64
ED25519_SIGNATURE_B64URL_LENGTH = 86


def encode_browser_registration_transcript(user_id: str, public_key: bytes) -> bytes:
    """Encode the fixed-width v1 transcript bound to one authenticated UUID and key."""

    try:
        parsed_user_id = uuid.UUID(user_id)
    except (ValueError, AttributeError) as exc:
        raise ValueError("user id must be a UUID") from exc
    if user_id != str(parsed_user_id):
        raise ValueError("user id must be a canonical lowercase UUID")
    if len(public_key) != 32:
        raise ValueError("public key must contain exactly 32 bytes")
    return (
        BROWSER_REGISTRATION_MAGIC
        + bytes([BROWSER_REGISTRATION_VERSION])
        + parsed_user_id.bytes
        + public_key
    )


def decode_ed25519_signature(encoded: str) -> bytes:
    """Decode an exact canonical fixed-width unpadded base64url Ed25519 signature."""

    if len(encoded) != ED25519_SIGNATURE_B64URL_LENGTH or "=" in encoded:
        raise HTTPException(status_code=422, detail="invalid Ed25519 signature")
    try:
        raw = base64.b64decode(encoded + "==", altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="invalid Ed25519 signature") from exc
    canonical = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    if len(raw) != ED25519_SIGNATURE_BYTES or canonical != encoded:
        raise HTTPException(status_code=422, detail="invalid Ed25519 signature")
    return raw


def verify_browser_registration_proof(
    *, user_id: str, public_key_wire: str, signature_wire: str
) -> None:
    """Verify strict key/signature wire forms and possession of the corresponding key."""

    public_key = decode_ed25519_public_key(public_key_wire)
    signature = decode_ed25519_signature(signature_wire)
    transcript = encode_browser_registration_transcript(user_id, public_key)
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, transcript)
    except InvalidSignature as exc:
        raise HTTPException(
            status_code=422, detail="browser registration proof is invalid"
        ) from exc
