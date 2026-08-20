"""Browser identity proof vectors, account binding, races, and revocation tombstones."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import HTTPException

from spawn_server.browser_registration import (
    decode_ed25519_signature,
    encode_browser_registration_transcript,
    verify_browser_registration_proof,
)

VECTORS_PATH = (
    Path(__file__).resolve().parents[2]
    / "proto"
    / "browser-device-registration-v1-vectors.json"
)


def _wire(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _proof(user_id: str, private_key: Ed25519PrivateKey) -> dict[str, str]:
    public_key = private_key.public_key().public_bytes_raw()
    transcript = encode_browser_registration_transcript(user_id, public_key)
    return {
        "key_algorithm": "ed25519",
        "public_key": _wire(public_key),
        "signature": _wire(private_key.sign(transcript)),
    }


async def _signup(client, email: str) -> tuple[str, str]:
    response = await client.post(
        "/api/auth/signup",
        json={"email": email, "password": "browser-device-test-password"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    return body["user"]["id"], body["access_token"]


def test_shared_registration_vectors_pin_bytes_and_reject_mutations_and_malformed_wire():
    vectors = json.loads(VECTORS_PATH.read_text())
    positive = vectors["positive"]
    public_key = base64.urlsafe_b64decode(positive["public_key"] + "=")
    transcript = encode_browser_registration_transcript(positive["user_id"], public_key)
    assert transcript.hex() == positive["transcript_hex"]
    assert hashlib.sha256(transcript).hexdigest() == positive["transcript_sha256"]
    verify_browser_registration_proof(
        user_id=positive["user_id"],
        public_key_wire=positive["public_key"],
        signature_wire=positive["signature"],
    )

    for malformed in vectors["malformed_user_ids"]:
        with pytest.raises(ValueError, match="user id must be"):
            encode_browser_registration_transcript(malformed, public_key)

    with pytest.raises(HTTPException, match="proof is invalid"):
        verify_browser_registration_proof(
            user_id=vectors["mutations"]["user_id"],
            public_key_wire=positive["public_key"],
            signature_wire=positive["signature"],
        )
    with pytest.raises(HTTPException, match="proof is invalid"):
        verify_browser_registration_proof(
            user_id=positive["user_id"],
            public_key_wire=vectors["mutations"]["public_key"],
            signature_wire=positive["signature"],
        )
    with pytest.raises(HTTPException, match="proof is invalid"):
        verify_browser_registration_proof(
            user_id=positive["user_id"],
            public_key_wire=positive["public_key"],
            signature_wire=vectors["mutations"]["signature"],
        )

    for malformed in vectors["malformed_public_keys"]:
        with pytest.raises(HTTPException, match="invalid Ed25519 public key"):
            verify_browser_registration_proof(
                user_id=positive["user_id"],
                public_key_wire=malformed,
                signature_wire=positive["signature"],
            )
    for malformed in vectors["malformed_signatures"]:
        with pytest.raises(HTTPException, match="invalid Ed25519 signature"):
            decode_ed25519_signature(malformed)


async def test_registration_is_authenticated_idempotent_and_account_scoped(client):
    user_id, token = await _signup(client, "browser-one@example.com")
    key = Ed25519PrivateKey.generate()
    proof = _proof(user_id, key)
    headers = {"Authorization": f"Bearer {token}"}

    client.cookies.clear()
    anonymous = await client.post("/api/browser-devices/register", json=proof)
    assert anonymous.status_code == 401

    first = await client.post("/api/browser-devices/register", json=proof, headers=headers)
    assert first.status_code == 200, first.text
    repeated = await client.post("/api/browser-devices/register", json=proof, headers=headers)
    assert repeated.status_code == 200, repeated.text
    # Identical except last_seen_at, which each reconcile legitimately advances
    # (it is the Access screen's "Seen …" value).
    repeated_body, first_body = repeated.json(), first.json()
    assert repeated_body.pop("last_seen_at") >= first_body.pop("last_seen_at")
    assert repeated_body == first_body
    assert first.json()["public_key"] == proof["public_key"]
    assert first.json()["fingerprint"].startswith("SHA256:")
    assert first.json()["revoked_at"] is None

    second_id, second_token = await _signup(client, "browser-two@example.com")
    cross_account = await client.post(
        "/api/browser-devices/register",
        json=_proof(second_id, key),
        headers={"Authorization": f"Bearer {second_token}"},
    )
    assert cross_account.status_code == 409

    listing = await client.get("/api/browser-devices", headers=headers)
    assert listing.status_code == 200
    listed = listing.json()
    assert len(listed) == 1
    listed_body, first_again = listed[0], first.json()
    assert listed_body.pop("last_seen_at") >= first_again.pop("last_seen_at")
    assert listed_body == first_again
    other_listing = await client.get(
        "/api/browser-devices", headers={"Authorization": f"Bearer {second_token}"}
    )
    assert other_listing.json() == []


async def test_registration_rejects_wrong_account_proof_and_malformed_fixed_widths(client):
    user_id, token = await _signup(client, "proof-errors@example.com")
    _, other_token = await _signup(client, "proof-other@example.com")
    key = Ed25519PrivateKey.generate()
    headers = {"Authorization": f"Bearer {token}"}

    wrong_proof = _proof(user_id, key)
    wrong_account = await client.post(
        "/api/browser-devices/register",
        json=wrong_proof,
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert wrong_account.status_code == 422

    for field, value in [
        ("public_key", "A" * 16_777_216),
        ("signature", "A" * 16_777_216),
        ("public_key", wrong_proof["public_key"] + "="),
        ("signature", wrong_proof["signature"] + "="),
    ]:
        malformed = {**wrong_proof, field: value}
        response = await client.post(
            "/api/browser-devices/register", json=malformed, headers=headers
        )
        assert response.status_code == 422


async def test_revoke_requires_owned_id_and_expected_key_and_never_resurrects(client):
    user_id, token = await _signup(client, "revoke@example.com")
    key = Ed25519PrivateKey.generate()
    proof = _proof(user_id, key)
    headers = {"Authorization": f"Bearer {token}"}
    registered = await client.post(
        "/api/browser-devices/register", json=proof, headers=headers
    )
    device = registered.json()

    wrong_key = _proof(user_id, Ed25519PrivateKey.generate())["public_key"]
    stale = await client.post(
        f"/api/browser-devices/{device['id']}/revoke",
        json={"expected_public_key": wrong_key},
        headers=headers,
    )
    assert stale.status_code == 409

    other_id, other_token = await _signup(client, "revoke-other@example.com")
    not_owned = await client.post(
        f"/api/browser-devices/{device['id']}/revoke",
        json={"expected_public_key": proof["public_key"]},
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert not_owned.status_code == 404

    revoked = await client.post(
        f"/api/browser-devices/{device['id']}/revoke",
        json={"expected_public_key": proof["public_key"]},
        headers=headers,
    )
    assert revoked.status_code == 200
    assert revoked.json()["revoked_at"] is not None
    repeated = await client.post(
        f"/api/browser-devices/{device['id']}/revoke",
        json={"expected_public_key": proof["public_key"]},
        headers=headers,
    )
    assert repeated.status_code == 200
    assert repeated.json()["revoked_at"] == revoked.json()["revoked_at"]

    resurrect_same = await client.post(
        "/api/browser-devices/register", json=proof, headers=headers
    )
    assert resurrect_same.status_code == 409
    resurrect_other = await client.post(
        "/api/browser-devices/register",
        json=_proof(other_id, key),
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert resurrect_other.status_code == 409


async def test_concurrent_file_sqlite_registration_and_revocation_converge(file_sqlite_client):
    user_id, token = await _signup(file_sqlite_client, "concurrent-browser@example.com")
    proof = _proof(user_id, Ed25519PrivateKey.generate())
    headers = {"Authorization": f"Bearer {token}"}

    registrations = await asyncio.gather(
        *[
            file_sqlite_client.post(
                "/api/browser-devices/register", json=proof, headers=headers
            )
            for _ in range(12)
        ]
    )
    assert {response.status_code for response in registrations} == {200}
    ids = {response.json()["id"] for response in registrations}
    assert len(ids) == 1
    device_id = ids.pop()

    revocations = await asyncio.gather(
        *[
            file_sqlite_client.post(
                f"/api/browser-devices/{device_id}/revoke",
                json={"expected_public_key": proof["public_key"]},
                headers=headers,
            )
            for _ in range(12)
        ]
    )
    assert {response.status_code for response in revocations} == {200}
    assert len({response.json()["revoked_at"] for response in revocations}) == 1


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires opt-in PostgreSQL integration database",
)
async def test_concurrent_postgresql_registration_and_revocation_converge(client):
    user_id, token = await _signup(client, "concurrent-postgres-browser@example.com")
    proof = _proof(user_id, Ed25519PrivateKey.generate())
    headers = {"Authorization": f"Bearer {token}"}

    registrations = await asyncio.gather(
        *[
            client.post("/api/browser-devices/register", json=proof, headers=headers)
            for _ in range(12)
        ]
    )
    assert {response.status_code for response in registrations} == {200}
    ids = {response.json()["id"] for response in registrations}
    assert len(ids) == 1
    device_id = ids.pop()

    revocations = await asyncio.gather(
        *[
            client.post(
                f"/api/browser-devices/{device_id}/revoke",
                json={"expected_public_key": proof["public_key"]},
                headers=headers,
            )
            for _ in range(12)
        ]
    )
    assert {response.status_code for response in revocations} == {200}
    assert len({response.json()["revoked_at"] for response in revocations}) == 1


async def test_revoking_a_pinned_device_pushes_to_affected_hosts(client, monkeypatch):
    """Revocation must reach a live daemon, not wait for its next reconnect.

    Admitting a device already pushes to the host; revoking one must too, or a
    long-lived daemon keeps trusting the revoked device -- and everything it
    endorsed -- for as long as it stays connected.
    """

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import BrowserDevice, Host, HostBrowserPin

    user_id, token = await _signup(client, "revoke-push@example.com")
    headers = {"Authorization": f"Bearer {token}"}

    pushed: list[str] = []

    async def fake_push(host_id: str) -> bool:
        pushed.append(host_id)
        return True

    monkeypatch.setattr("spawn_server.routes.browser_devices.push_browser_pins", fake_push)

    endorser_pub = "E" * 43
    async with get_sessionmaker()() as session:
        host_a = Host(name="push-host-a", owner_user_id=user_id)
        host_b = Host(name="push-host-b", owner_user_id=user_id)
        session.add_all([host_a, host_b])
        endorser = BrowserDevice(
            owner_user_id=user_id, key_algorithm="ed25519", public_key=endorser_pub
        )
        endorsed = BrowserDevice(
            owner_user_id=user_id, key_algorithm="ed25519", public_key="D" * 43
        )
        session.add_all([endorser, endorsed])
        await session.flush()
        # host_a trusts the endorser directly; host_b trusts a device it
        # vouched for. Revoking the endorser changes both hosts' live sets.
        session.add_all(
            [
                HostBrowserPin(
                    host_id=host_a.id,
                    browser_device_id=endorser.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=endorser.public_key,
                    browser_key_fingerprint="SHA256:" + "e" * 16,
                ),
                HostBrowserPin(
                    host_id=host_b.id,
                    browser_device_id=endorsed.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=endorsed.public_key,
                    browser_key_fingerprint="SHA256:" + "d" * 16,
                    endorser_device_id=endorser.id,
                    endorsement_signature="s" * 86,
                ),
            ]
        )
        await session.commit()
        host_a_id, host_b_id, endorser_id = host_a.id, host_b.id, endorser.id

    response = await client.post(
        f"/api/browser-devices/{endorser_id}/revoke",
        json={"expected_public_key": endorser_pub},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["revoked_at"] is not None
    # Pushed to every host whose pin set the revocation changed: the one that
    # trusted the endorser directly and the one that trusted its endorsee.
    assert set(pushed) == {host_a_id, host_b_id}


async def test_prune_deletes_only_this_accounts_tombstones(client):
    user_id, token = await _signup(client, "prune@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    kept_proof = _proof(user_id, Ed25519PrivateKey.generate())
    kept = (
        await client.post("/api/browser-devices/register", json=kept_proof, headers=headers)
    ).json()
    dead_proof = _proof(user_id, Ed25519PrivateKey.generate())
    dead = (
        await client.post("/api/browser-devices/register", json=dead_proof, headers=headers)
    ).json()
    revoked = await client.post(
        f"/api/browser-devices/{dead['id']}/revoke",
        json={"expected_public_key": dead_proof["public_key"]},
        headers=headers,
    )
    assert revoked.status_code == 200

    # Another account's tombstone must survive this account's prune.
    other_id, other_token = await _signup(client, "prune-other@example.com")
    other_headers = {"Authorization": f"Bearer {other_token}"}
    other_proof = _proof(other_id, Ed25519PrivateKey.generate())
    other = (
        await client.post(
            "/api/browser-devices/register", json=other_proof, headers=other_headers
        )
    ).json()
    other_revoked = await client.post(
        f"/api/browser-devices/{other['id']}/revoke",
        json={"expected_public_key": other_proof["public_key"]},
        headers=other_headers,
    )
    assert other_revoked.status_code == 200

    pruned = await client.post("/api/browser-devices/prune", headers=headers)
    assert pruned.status_code == 200
    assert pruned.json() == {"pruned": 1}

    listing = (await client.get("/api/browser-devices", headers=headers)).json()
    assert [device["id"] for device in listing] == [kept["id"]]
    other_listing = (await client.get("/api/browser-devices", headers=other_headers)).json()
    assert [device["id"] for device in other_listing] == [other["id"]]
    assert other_listing[0]["revoked_at"] is not None

    # Idempotent: nothing left to prune.
    again = await client.post("/api/browser-devices/prune", headers=headers)
    assert again.status_code == 200
    assert again.json() == {"pruned": 0}
