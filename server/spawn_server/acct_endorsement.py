"""Canonical contract for one device account-endorsing another.

The successor to :mod:`spawn_server.browser_endorsement`: that binds an
endorsement to one host's key; this binds it to the *account*, so a single
signed edge is carried by the device and presented to every host
(docs/TRUST_DEVICE_MESH.md §3). As with the per-host version the server verifies
endorsements only to keep malformed data out of the store -- it is not the
authority. The daemon re-verifies every endorsement against the keys it already
trusts, because a server that could mint endorsements could admit its own device.
"""

from __future__ import annotations

import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

from .browser_registration import decode_ed25519_signature
from .host_identity import decode_ed25519_public_key

ACCT_ENDORSEMENT_MAGIC = b"SPAWN-ACCT-ENDORSE-V1"
ACCT_ENDORSEMENT_VERSION = 1


def _canonical_uuid_bytes(value: str, field: str) -> bytes:
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{field} must be a UUID") from exc
    if value != str(parsed):
        raise HTTPException(status_code=422, detail=f"{field} must be a canonical lowercase UUID")
    return parsed.bytes


def encode_acct_endorsement_transcript(
    account_id: str,
    endorser_public_key: bytes,
    endorsed_public_key: bytes,
    endorsed_device_id: str,
) -> bytes:
    """Byte-for-byte identical to the daemon and browser encoders."""

    for name, key in (
        ("endorser", endorser_public_key),
        ("endorsed", endorsed_public_key),
    ):
        if len(key) != 32:
            raise HTTPException(status_code=422, detail=f"invalid {name} public key")
    return b"".join(
        (
            ACCT_ENDORSEMENT_MAGIC,
            bytes([ACCT_ENDORSEMENT_VERSION]),
            _canonical_uuid_bytes(account_id, "account id"),
            endorser_public_key,
            endorsed_public_key,
            _canonical_uuid_bytes(endorsed_device_id, "endorsed device id"),
        )
    )


def verify_acct_endorsement_proof(
    *,
    account_id: str,
    endorser_public_key_wire: str,
    endorsed_public_key_wire: str,
    endorsed_device_id: str,
    signature_wire: str,
) -> None:
    """Verify strict wire values and the endorser's signature.

    There is no host parameter: the endorsement is valid for the whole account.
    """

    endorser_public_key = decode_ed25519_public_key(endorser_public_key_wire)
    endorsed_public_key = decode_ed25519_public_key(endorsed_public_key_wire)
    if endorser_public_key == endorsed_public_key:
        # A device admitting itself would defeat the point of endorsement.
        raise HTTPException(status_code=422, detail="a device may not endorse itself")

    signature = decode_ed25519_signature(signature_wire)
    transcript = encode_acct_endorsement_transcript(
        account_id,
        endorser_public_key,
        endorsed_public_key,
        endorsed_device_id,
    )
    try:
        Ed25519PublicKey.from_public_bytes(endorser_public_key).verify(signature, transcript)
    except InvalidSignature as exc:
        raise HTTPException(status_code=422, detail="account endorsement is invalid") from exc
