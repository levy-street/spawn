"""Canonical daemon proof-of-possession contract for one host-pair ceremony."""

from __future__ import annotations

import base64
import binascii

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

from .browser_registration import decode_ed25519_signature
from .host_identity import decode_ed25519_public_key
from .host_pair_approval import APPROVAL_NONCE_BYTES, decode_approval_nonce

HOST_PAIR_POSSESSION_MAGIC = b"SPAWN-HOST-PAIR-POSSESSION-V1"
HOST_PAIR_POSSESSION_VERSION = 1
DEVICE_CODE_BYTES = 32
DEVICE_CODE_B64URL_LENGTH = 43


def decode_device_code(encoded: str) -> bytes:
    """Decode one exact canonical fixed-width unpadded base64url device code."""

    if len(encoded) != DEVICE_CODE_B64URL_LENGTH or "=" in encoded:
        raise HTTPException(status_code=422, detail="invalid device code")
    try:
        raw = base64.b64decode(encoded + "=", altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(status_code=422, detail="invalid device code") from exc
    canonical = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    if len(raw) != DEVICE_CODE_BYTES or canonical != encoded:
        raise HTTPException(status_code=422, detail="invalid device code")
    return raw


def encode_host_pair_possession_transcript(
    device_code: bytes,
    approval_nonce: bytes,
    host_public_key: bytes,
) -> bytes:
    """Encode the fixed-width v1 host possession transcript."""

    if len(device_code) != DEVICE_CODE_BYTES:
        raise ValueError("device code must contain exactly 32 bytes")
    if len(approval_nonce) != APPROVAL_NONCE_BYTES:
        raise ValueError("approval nonce must contain exactly 32 bytes")
    if len(host_public_key) != 32:
        raise ValueError("host public key must contain exactly 32 bytes")
    return (
        HOST_PAIR_POSSESSION_MAGIC
        + bytes([HOST_PAIR_POSSESSION_VERSION])
        + device_code
        + approval_nonce
        + host_public_key
    )


def verify_host_pair_possession_proof(
    *,
    device_code_wire: str,
    approval_nonce_wire: str,
    host_public_key_wire: str,
    signature_wire: str,
) -> None:
    """Verify strict wire values and host-key possession for one ceremony."""

    device_code = decode_device_code(device_code_wire)
    approval_nonce = decode_approval_nonce(approval_nonce_wire)
    host_public_key = decode_ed25519_public_key(host_public_key_wire)
    signature = decode_ed25519_signature(signature_wire)
    transcript = encode_host_pair_possession_transcript(
        device_code,
        approval_nonce,
        host_public_key,
    )
    try:
        Ed25519PublicKey.from_public_bytes(host_public_key).verify(signature, transcript)
    except InvalidSignature as exc:
        raise HTTPException(status_code=422, detail="host possession proof is invalid") from exc
