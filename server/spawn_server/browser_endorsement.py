"""Canonical contract for one browser device endorsing another.

The server verifies endorsements only to keep malformed data out of the store.
It is not the authority here and must not be treated as one: the daemon
re-verifies every endorsement against the browser keys it already pins, because
a server that could mint endorsements could admit its own device to a host.
"""

from __future__ import annotations

import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

from .browser_registration import decode_ed25519_signature
from .host_identity import decode_ed25519_public_key

BROWSER_ENDORSEMENT_MAGIC = b"SPAWN-BROWSER-ENDORSE-V1"
BROWSER_ENDORSEMENT_VERSION = 1


def _canonical_uuid_bytes(value: str, field: str) -> bytes:
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{field} must be a UUID") from exc
    if value != str(parsed):
        raise HTTPException(
            status_code=422, detail=f"{field} must be a canonical lowercase UUID"
        )
    return parsed.bytes


def encode_browser_endorsement_transcript(
    user_id: str,
    host_public_key: bytes,
    endorser_public_key: bytes,
    endorsed_public_key: bytes,
    endorsed_device_id: str,
) -> bytes:
    """Byte-for-byte identical to the daemon and browser encoders."""

    for name, key in (
        ("host", host_public_key),
        ("endorser", endorser_public_key),
        ("endorsed", endorsed_public_key),
    ):
        if len(key) != 32:
            raise HTTPException(status_code=422, detail=f"invalid {name} public key")
    return b"".join(
        (
            BROWSER_ENDORSEMENT_MAGIC,
            bytes([BROWSER_ENDORSEMENT_VERSION]),
            _canonical_uuid_bytes(user_id, "account id"),
            host_public_key,
            endorser_public_key,
            endorsed_public_key,
            _canonical_uuid_bytes(endorsed_device_id, "endorsed device id"),
        )
    )


def verify_browser_endorsement_proof(
    *,
    user_id: str,
    host_public_key_wire: str,
    endorser_public_key_wire: str,
    endorsed_public_key_wire: str,
    endorsed_device_id: str,
    signature_wire: str,
) -> None:
    """Verify strict wire values and the endorser's signature."""

    host_public_key = decode_ed25519_public_key(host_public_key_wire)
    endorser_public_key = decode_ed25519_public_key(endorser_public_key_wire)
    endorsed_public_key = decode_ed25519_public_key(endorsed_public_key_wire)
    if endorser_public_key == endorsed_public_key:
        # A device admitting itself would defeat the point of endorsement.
        raise HTTPException(status_code=422, detail="a device may not endorse itself")

    signature = decode_ed25519_signature(signature_wire)
    transcript = encode_browser_endorsement_transcript(
        user_id,
        host_public_key,
        endorser_public_key,
        endorsed_public_key,
        endorsed_device_id,
    )
    try:
        Ed25519PublicKey.from_public_bytes(endorser_public_key).verify(signature, transcript)
    except InvalidSignature as exc:
        raise HTTPException(status_code=422, detail="browser endorsement is invalid") from exc
