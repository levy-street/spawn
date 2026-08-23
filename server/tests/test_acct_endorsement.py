"""Unit tests for the account-scoped endorsement primitive.

Stage 1 of the device trust mesh: the signed artifact only, not yet wired into a
route. The digest vector is shared with daemon/src/acct_endorsement.rs and
web/src/lib/acct-endorsement-transcript.ts -- a drift here silently breaks
endorsement across runtimes.
"""

from __future__ import annotations

import base64
import hashlib

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import HTTPException

from spawn_server.acct_endorsement import (
    ACCT_ENDORSEMENT_MAGIC,
    encode_acct_endorsement_transcript,
    verify_acct_endorsement_proof,
)

# Same endorser/endorsed seeds as the Rust and web vectors (12 and 13).
VECTOR_ACCOUNT = "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f"
VECTOR_DEVICE = "11111111-2222-4333-8444-555555555555"
VECTOR_SHA256 = "7HXf12SEyR3WDpy4EeHKVQCsffmdTnMgMVPbq9jgnq8"


def _key(seed: int) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(bytes([seed]) * 32)


def _wire(private: Ed25519PrivateKey) -> str:
    return base64.urlsafe_b64encode(private.public_key().public_bytes_raw()).rstrip(b"=").decode()


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def test_magic_is_the_account_tag():
    assert ACCT_ENDORSEMENT_MAGIC == b"SPAWN-ACCT-ENDORSE-V1"


def test_transcript_matches_the_shared_vector():
    endorser, endorsed = _key(12), _key(13)
    transcript = encode_acct_endorsement_transcript(
        VECTOR_ACCOUNT,
        endorser.public_key().public_bytes_raw(),
        endorsed.public_key().public_bytes_raw(),
        VECTOR_DEVICE,
    )
    assert len(transcript) == 118
    assert _b64u(hashlib.sha256(transcript).digest()) == VECTOR_SHA256


def test_a_valid_signature_verifies():
    endorser, endorsed = _key(12), _key(13)
    transcript = encode_acct_endorsement_transcript(
        VECTOR_ACCOUNT,
        endorser.public_key().public_bytes_raw(),
        endorsed.public_key().public_bytes_raw(),
        VECTOR_DEVICE,
    )
    signature = _b64u(endorser.sign(transcript))
    # Must not raise.
    verify_acct_endorsement_proof(
        account_id=VECTOR_ACCOUNT,
        endorser_public_key_wire=_wire(endorser),
        endorsed_public_key_wire=_wire(endorsed),
        endorsed_device_id=VECTOR_DEVICE,
        signature_wire=signature,
    )


def test_rejects_self_endorsement():
    device = _key(12)
    with pytest.raises(HTTPException):
        verify_acct_endorsement_proof(
            account_id=VECTOR_ACCOUNT,
            endorser_public_key_wire=_wire(device),
            endorsed_public_key_wire=_wire(device),
            endorsed_device_id=VECTOR_DEVICE,
            signature_wire=_b64u(bytes(64)),
        )


@pytest.mark.parametrize(
    "mutate",
    [
        {"account_id": "00000000-0000-4000-8000-000000000000"},
        {"endorsed_device_id": "22222222-3333-4444-8555-666666666666"},
    ],
)
def test_rebinding_any_field_fails_verification(mutate):
    # A signature captured for one (account, device) must not verify for another
    # -- the server cannot relay a real edge under a different scope.
    endorser, endorsed = _key(12), _key(13)
    signed = encode_acct_endorsement_transcript(
        VECTOR_ACCOUNT,
        endorser.public_key().public_bytes_raw(),
        endorsed.public_key().public_bytes_raw(),
        VECTOR_DEVICE,
    )
    signature = _b64u(endorser.sign(signed))
    kwargs = {
        "account_id": VECTOR_ACCOUNT,
        "endorser_public_key_wire": _wire(endorser),
        "endorsed_public_key_wire": _wire(endorsed),
        "endorsed_device_id": VECTOR_DEVICE,
        "signature_wire": signature,
        **mutate,
    }
    with pytest.raises(HTTPException):
        verify_acct_endorsement_proof(**kwargs)


def test_rejects_non_canonical_account_id():
    endorser, endorsed = _key(12), _key(13)
    with pytest.raises(HTTPException):
        encode_acct_endorsement_transcript(
            "NOT-A-UUID",
            endorser.public_key().public_bytes_raw(),
            endorsed.public_key().public_bytes_raw(),
            VECTOR_DEVICE,
        )
