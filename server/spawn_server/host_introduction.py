"""Canonical contract for the DURABLE (broadcast) host-key introduction.

The continuous leg of mesh R7 (docs/TRUST_DEVICE_MESH.md): a device that
verified a host key out of band publishes a signed statement vouching that key
to the whole account. The server stores and serves these rows but is NOT their
authority — recipients only honor an introduction whose publisher key they
learned firsthand (ceremony-pinned), and they re-verify the signature against
that firsthand key. The verification here is hygiene only: it keeps rows that
could never verify for anyone out of the store.

Domain-separated from the ceremony-scoped SPAWN-HOST-INTRO-V1 (which binds a
specific joiner) and from every endorsement statement; a signature is never
replayable across protocols.
"""

from __future__ import annotations

import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

from .browser_registration import decode_ed25519_signature
from .host_identity import decode_ed25519_public_key

HOST_INTRO_BCAST_MAGIC = b"SPAWN-HOST-INTRO-BCAST-V1"
HOST_INTRO_BCAST_VERSION = 1


def _canonical_uuid_bytes(value: str, field: str) -> bytes:
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{field} must be a UUID") from exc
    if value != str(parsed):
        raise HTTPException(status_code=422, detail=f"{field} must be a canonical lowercase UUID")
    return parsed.bytes


def encode_host_intro_broadcast_transcript(
    account_id: str,
    publisher_public_key: bytes,
    host_public_key: bytes,
) -> bytes:
    """Byte-for-byte identical to the browser encoder."""

    for name, key in (("publisher", publisher_public_key), ("host", host_public_key)):
        if len(key) != 32:
            raise HTTPException(status_code=422, detail=f"invalid {name} public key")
    return b"".join(
        (
            HOST_INTRO_BCAST_MAGIC,
            bytes([HOST_INTRO_BCAST_VERSION]),
            _canonical_uuid_bytes(account_id, "account id"),
            publisher_public_key,
            host_public_key,
        )
    )


def verify_host_intro_broadcast_proof(
    *,
    account_id: str,
    publisher_public_key_wire: str,
    host_public_key_wire: str,
    signature_wire: str,
) -> None:
    """Hygiene verification against the CLAIMED publisher key.

    Recipients repeat this against the firsthand key they hold; a row passing
    here but signed by a key nobody learned firsthand is inert everywhere.
    """

    publisher_public_key = decode_ed25519_public_key(publisher_public_key_wire)
    host_public_key = decode_ed25519_public_key(host_public_key_wire)
    signature = decode_ed25519_signature(signature_wire)
    transcript = encode_host_intro_broadcast_transcript(
        account_id,
        publisher_public_key,
        host_public_key,
    )
    try:
        Ed25519PublicKey.from_public_bytes(publisher_public_key).verify(signature, transcript)
    except InvalidSignature as exc:
        raise HTTPException(status_code=422, detail="host introduction is invalid") from exc
