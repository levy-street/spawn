"""Cross-runtime host-pair browser approval proof vectors."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from spawn_server.host_pair_approval import (
    decode_approval_nonce,
    encode_host_pair_approval_transcript,
    verify_host_pair_approval_proof,
)

VECTORS = json.loads(
    (Path(__file__).parents[2] / "proto" / "host-pair-approval-v1-vectors.json").read_text()
)


def _raw(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=")


def test_shared_host_pair_vectors_pin_bytes_signature_and_all_mutations():
    positive = VECTORS["positive"]
    transcript = encode_host_pair_approval_transcript(
        positive["user_id"],
        _raw(positive["approval_nonce"]),
        _raw(positive["host_public_key"]),
        _raw(positive["browser_public_key"]),
    )
    assert transcript.hex() == positive["transcript_hex"]
    assert hashlib.sha256(transcript).hexdigest() == positive["transcript_sha256"]
    verify_host_pair_approval_proof(
        user_id=positive["user_id"],
        approval_nonce_wire=positive["approval_nonce"],
        host_public_key_wire=positive["host_public_key"],
        browser_public_key_wire=positive["browser_public_key"],
        signature_wire=positive["signature"],
    )

    for field, value in VECTORS["mutations"].items():
        changed = {**positive, field: value}
        with pytest.raises(HTTPException, match="proof is invalid"):
            verify_host_pair_approval_proof(
                user_id=changed["user_id"],
                approval_nonce_wire=changed["approval_nonce"],
                host_public_key_wire=changed["host_public_key"],
                browser_public_key_wire=changed["browser_public_key"],
                signature_wire=changed["signature"],
            )


def test_shared_host_pair_malformed_nonce_wires_are_rejected():
    for nonce in VECTORS["malformed_nonces"]:
        with pytest.raises(HTTPException, match="invalid approval nonce"):
            decode_approval_nonce(nonce)
