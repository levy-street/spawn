"""Cross-runtime tests for the daemon host-key possession transcript."""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from spawn_server.host_identity import decode_ed25519_public_key
from spawn_server.host_pair_approval import decode_approval_nonce
from spawn_server.host_pair_possession import (
    decode_device_code,
    encode_host_pair_possession_transcript,
    verify_host_pair_possession_proof,
)

_VECTORS = json.loads(
    (Path(__file__).parents[2] / "proto" / "host-pair-possession-v1-vectors.json").read_text()
)


def test_server_verifies_exact_rust_produced_possession_vector() -> None:
    assert _VECTORS["producer"] == "spawnd Rust ed25519-dalek 2.2"
    positive = _VECTORS["positive"]
    transcript = encode_host_pair_possession_transcript(
        decode_device_code(positive["device_code"]),
        decode_approval_nonce(positive["approval_nonce"]),
        decode_ed25519_public_key(positive["host_public_key"]),
    )
    assert transcript.hex() == positive["transcript_hex"]
    assert hashlib.sha256(transcript).hexdigest() == positive["transcript_sha256"]
    verify_host_pair_possession_proof(
        device_code_wire=positive["device_code"],
        approval_nonce_wire=positive["approval_nonce"],
        host_public_key_wire=positive["host_public_key"],
        signature_wire=positive["signature"],
    )


def test_rust_signature_rejects_noncanonical_standard_base64_wire() -> None:
    positive = _VECTORS["positive"]
    standard_base64 = positive["signature"].replace("-", "+").replace("_", "/")
    assert standard_base64 != positive["signature"]
    with pytest.raises(HTTPException, match="invalid Ed25519 signature"):
        verify_host_pair_possession_proof(
            device_code_wire=positive["device_code"],
            approval_nonce_wire=positive["approval_nonce"],
            host_public_key_wire=positive["host_public_key"],
            signature_wire=standard_base64,
        )


@pytest.mark.parametrize("field", ["device_code", "approval_nonce", "host_public_key"])
def test_rust_signature_rejects_every_ceremony_binding_mutation(field: str) -> None:
    positive = _VECTORS["positive"]
    changed = dict(positive)
    if field == "host_public_key":
        changed[field] = "PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw"
    else:
        replacement = bytearray(
            decode_device_code(positive["device_code"])
            if field == "device_code"
            else decode_approval_nonce(positive["approval_nonce"])
        )
        replacement[0] ^= 1
        changed[field] = base64.urlsafe_b64encode(replacement).rstrip(b"=").decode("ascii")
    with pytest.raises(HTTPException, match="host possession proof is invalid"):
        verify_host_pair_possession_proof(
            device_code_wire=changed["device_code"],
            approval_nonce_wire=changed["approval_nonce"],
            host_public_key_wire=changed["host_public_key"],
            signature_wire=positive["signature"],
        )


@pytest.mark.parametrize(
    "device_code",
    [
        pytest.param("A" * 42, id="wrong-length"),
        pytest.param("A" * 43 + "=", id="padded"),
        pytest.param("!" * 43, id="non-base64url"),
        pytest.param("A" * (16 * 1024 * 1024), id="oversized"),
    ],
)
def test_device_code_decoder_rejects_malformed_or_oversized_wire(device_code: str) -> None:
    with pytest.raises(HTTPException, match="invalid device code"):
        decode_device_code(device_code)
