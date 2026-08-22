"""Canonical contract for the root-key introduction (SPAWN-ROOT-INTRO-V1).

The firsthand delivery channel for `pk_R` (docs/TRUST_DEVICE_MESH.md §4.1
provenance rule): a device that knows the account root's public key FIRSTHAND
— it minted it, or unsealed it from the passkey bundle — publishes a signed
statement introducing that key to the account's other devices, exactly as host
keys ride the R7 broadcast gossip. A pinned device must never anchor a root it
only knows from the server's `is_root` row (a server-claimed root that gets
anchored is a forged-anchor path, a P2 violation), so this statement is what
lets pinned devices run the root anchor sweep for hosts a passkey-holding
device never pinned.

The server stores and serves these rows but is NOT their authority: recipients
only honor an introduction whose INTRODUCER key they learned firsthand
(ceremony-pinned peer-key store) and re-verify the signature against that
firsthand copy. The verification here is hygiene only — it keeps rows that
could never verify for anyone out of the store. One row per introducer; a
republish with a successor root REPLACES that introducer's row (rotation),
and consumers accept a successor only when the old key's revocation is
corroborated (roster + permanent tombstone, mirroring hardening B2).

Domain-separated from every endorsement and host-introduction statement; a
signature is never replayable across protocols. Web ⟷ server byte identity is
pinned by a shared test vector on both sides.
"""

from __future__ import annotations

import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

from .browser_registration import decode_ed25519_signature
from .host_identity import decode_ed25519_public_key

ROOT_INTRO_MAGIC = b"SPAWN-ROOT-INTRO-V1"
ROOT_INTRO_VERSION = 1


def _canonical_uuid_bytes(value: str, field: str) -> bytes:
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{field} must be a UUID") from exc
    if value != str(parsed):
        raise HTTPException(status_code=422, detail=f"{field} must be a canonical lowercase UUID")
    return parsed.bytes


def encode_root_intro_transcript(
    account_id: str,
    introducer_public_key: bytes,
    root_public_key: bytes,
) -> bytes:
    """Byte-for-byte identical to the browser encoder (root-introduction.ts)."""

    for name, key in (("introducer", introducer_public_key), ("root", root_public_key)):
        if len(key) != 32:
            raise HTTPException(status_code=422, detail=f"invalid {name} public key")
    if introducer_public_key == root_public_key:
        # The root never introduces itself; a self-introduction is the vacuous
        # server-claim shape this channel exists to replace.
        raise HTTPException(status_code=422, detail="a key may not introduce itself as the root")
    return b"".join(
        (
            ROOT_INTRO_MAGIC,
            bytes([ROOT_INTRO_VERSION]),
            _canonical_uuid_bytes(account_id, "account id"),
            introducer_public_key,
            root_public_key,
        )
    )


def verify_root_intro_proof(
    *,
    account_id: str,
    introducer_public_key_wire: str,
    root_public_key_wire: str,
    signature_wire: str,
) -> None:
    """Hygiene verification against the CLAIMED introducer key.

    Recipients repeat this against the firsthand key they hold; a row passing
    here but signed by a key nobody learned firsthand is inert everywhere.
    """

    introducer_public_key = decode_ed25519_public_key(introducer_public_key_wire)
    root_public_key = decode_ed25519_public_key(root_public_key_wire)
    signature = decode_ed25519_signature(signature_wire)
    transcript = encode_root_intro_transcript(
        account_id,
        introducer_public_key,
        root_public_key,
    )
    try:
        Ed25519PublicKey.from_public_bytes(introducer_public_key).verify(signature, transcript)
    except InvalidSignature as exc:
        raise HTTPException(status_code=422, detail="root introduction is invalid") from exc
