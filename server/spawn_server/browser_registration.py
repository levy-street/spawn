"""Canonical proof-of-possession contract for account-bound browser identities."""

from __future__ import annotations

import base64
import binascii
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException

from .host_identity import decode_ed25519_public_key

BROWSER_REGISTRATION_MAGIC = b"SPAWN-BROWSER-REGISTER-V2"
BROWSER_REGISTRATION_VERSION = 2
# V2 flags byte, bit 0: the key holder's own claim to be the account ROOT
# (pk_R) rather than an ordinary browser device. Root-hood is load-bearing
# server-side (the R9 per-host endorsement exemption and the pin-liveness
# ratchet), so it must be attested inside the signed transcript, never taken
# from a mutable request field alone. All other bits are zero in V2.
BROWSER_REGISTRATION_FLAG_ROOT = 0x01
ED25519_SIGNATURE_BYTES = 64
ED25519_SIGNATURE_B64URL_LENGTH = 86


class BrowserRegistrationRefusal(HTTPException):
    """Registration refusal with a stable machine-readable reason code."""

    def __init__(self, *, status_code: int, detail: str, code: str) -> None:
        super().__init__(status_code=status_code, detail=detail)
        self.code = code


def encode_browser_registration_transcript(
    user_id: str, public_key: bytes, *, is_root: bool
) -> bytes:
    """Encode the fixed-width v2 transcript: one authenticated UUID, one key,
    and the root/device flag the signature must attest."""

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
        + bytes([BROWSER_REGISTRATION_FLAG_ROOT if is_root else 0])
        + public_key
    )


def decode_ed25519_signature(encoded: str) -> bytes:
    """Decode an exact canonical fixed-width unpadded base64url Ed25519 signature."""

    if len(encoded) != ED25519_SIGNATURE_B64URL_LENGTH or "=" in encoded:
        raise BrowserRegistrationRefusal(
            status_code=422,
            detail="invalid Ed25519 signature",
            code="registration_proof_invalid",
        )
    try:
        raw = base64.b64decode(encoded + "==", altchars=b"-_", validate=True)
    except (ValueError, binascii.Error) as exc:
        raise BrowserRegistrationRefusal(
            status_code=422,
            detail="invalid Ed25519 signature",
            code="registration_proof_invalid",
        ) from exc
    canonical = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    if len(raw) != ED25519_SIGNATURE_BYTES or canonical != encoded:
        raise BrowserRegistrationRefusal(
            status_code=422,
            detail="invalid Ed25519 signature",
            code="registration_proof_invalid",
        )
    return raw


def verify_browser_registration_proof(
    *, user_id: str, public_key_wire: str, signature_wire: str, is_root: bool
) -> None:
    """Verify strict key/signature wire forms and possession of the corresponding key.

    ``is_root`` is the caller's CLAIM (the request field). Because the flag is
    bound inside the signed transcript, a claim the proof does not carry — a
    root registration with an unflagged proof, or an ordinary registration with
    a root-flagged proof — fails signature verification here and is refused.
    """

    public_key = decode_ed25519_public_key(public_key_wire)
    signature = decode_ed25519_signature(signature_wire)
    transcript = encode_browser_registration_transcript(user_id, public_key, is_root=is_root)
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature, transcript)
    except InvalidSignature as exc:
        raise BrowserRegistrationRefusal(
            status_code=422,
            detail="browser registration proof is invalid",
            code="registration_proof_invalid",
        ) from exc
