"""Canonical proof contract for browser-authorized host pairing."""

from __future__ import annotations

import base64
import binascii
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

from .browser_registration import decode_ed25519_signature
from .host_identity import decode_ed25519_public_key

HOST_PAIR_APPROVAL_MAGIC = b"SPAWN-HOST-PAIR-APPROVE-V1"
HOST_PAIR_APPROVAL_VERSION = 1
APPROVAL_NONCE_BYTES = 32
APPROVAL_NONCE_B64URL_LENGTH = 43


def decode_approval_nonce(encoded: str) -> bytes:
    """Decode one exact canonical fixed-width unpadded base64url nonce."""

    if len(encoded) != APPROVAL_NONCE_B64URL_LENGTH or "=" in encoded:
        raise HTTPException(status_code=422, detail="invalid approval nonce")
    try:
        raw = base64.b64decode(encoded + "=", altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="invalid approval nonce") from exc
    canonical = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    if len(raw) != APPROVAL_NONCE_BYTES or canonical != encoded:
        raise HTTPException(status_code=422, detail="invalid approval nonce")
    return raw


def encode_host_pair_approval_transcript(
    user_id: str,
    approval_nonce: bytes,
    host_public_key: bytes,
    browser_public_key: bytes,
) -> bytes:
    """Encode the fixed-width v1 host-pair approval transcript."""

    try:
        parsed_user_id = uuid.UUID(user_id)
    except (ValueError, AttributeError) as exc:
        raise ValueError("user id must be a UUID") from exc
    if user_id != str(parsed_user_id):
        raise ValueError("user id must be a canonical lowercase UUID")
    if len(approval_nonce) != APPROVAL_NONCE_BYTES:
        raise ValueError("approval nonce must contain exactly 32 bytes")
    if len(host_public_key) != 32 or len(browser_public_key) != 32:
        raise ValueError("host and browser public keys must contain exactly 32 bytes")
    return (
        HOST_PAIR_APPROVAL_MAGIC
        + bytes([HOST_PAIR_APPROVAL_VERSION])
        + parsed_user_id.bytes
        + approval_nonce
        + host_public_key
        + browser_public_key
    )


def verify_host_pair_approval_proof(
    *,
    user_id: str,
    approval_nonce_wire: str,
    host_public_key_wire: str,
    browser_public_key_wire: str,
    signature_wire: str,
) -> None:
    """Verify strict wire values and browser possession for one approval."""

    nonce = decode_approval_nonce(approval_nonce_wire)
    host_public_key = decode_ed25519_public_key(host_public_key_wire)
    browser_public_key = decode_ed25519_public_key(browser_public_key_wire)
    signature = decode_ed25519_signature(signature_wire)
    transcript = encode_host_pair_approval_transcript(
        user_id, nonce, host_public_key, browser_public_key
    )
    try:
        Ed25519PublicKey.from_public_bytes(browser_public_key).verify(signature, transcript)
    except InvalidSignature as exc:
        raise HTTPException(status_code=422, detail="host-pair approval proof is invalid") from exc
