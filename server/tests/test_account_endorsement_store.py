"""Account-scoped endorsement store (device mesh stage 3a).

The server persists directed endorsement edges (endorser device -> endorsed
device, NO host) and serves them so a device can assemble a carried chain. It
verifies each signature only to keep malformed rows out; it is not the authority
(the daemon re-verifies). See docs/TRUST_DEVICE_MESH.md §3.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server.acct_endorsement import encode_acct_endorsement_transcript
from spawn_server.db import get_sessionmaker

pytestmark = pytest.mark.anyio

ENDPOINT = "/api/trust/account-endorsements"


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup", json={"email": email, "password": "correcthorse"}
    )
    assert response.status_code == 200
    body = response.json()
    return body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"}


def _wire(key: Ed25519PrivateKey) -> str:
    return base64.urlsafe_b64encode(key.public_key().public_bytes_raw()).rstrip(b"=").decode()


async def _add_device(user_id: str) -> tuple[str, Ed25519PrivateKey]:
    from spawn_server.models import BrowserDevice

    key = Ed25519PrivateKey.generate()
    async with get_sessionmaker()() as session:
        device = BrowserDevice(
            owner_user_id=user_id, key_algorithm="ed25519", public_key=_wire(key)
        )
        session.add(device)
        await session.flush()
        device_id = device.id
        await session.commit()
    return device_id, key


async def _revoke_device(device_id: str) -> None:
    from spawn_server.models import BrowserDevice

    async with get_sessionmaker()() as session:
        device = await session.get(BrowserDevice, device_id)
        device.revoked_at = datetime.now(UTC)
        await session.commit()


def _sign(
    account_id: str,
    endorser_key: Ed25519PrivateKey,
    endorsed_key: Ed25519PrivateKey,
    endorsed_device_id: str,
) -> str:
    transcript = encode_acct_endorsement_transcript(
        account_id,
        endorser_key.public_key().public_bytes_raw(),
        endorsed_key.public_key().public_bytes_raw(),
        endorsed_device_id,
    )
    return base64.urlsafe_b64encode(endorser_key.sign(transcript)).rstrip(b"=").decode()


async def test_a_device_can_account_endorse_another(client):
    user_id, auth = await _signup(client, "acct-endorse@example.com")
    endorser_id, endorser_key = await _add_device(user_id)
    endorsed_id, endorsed_key = await _add_device(user_id)
    signature = _sign(user_id, endorser_key, endorsed_key, endorsed_id)

    created = await client.post(
        ENDPOINT,
        json={
            "endorser_device_id": endorser_id,
            "endorsed_device_id": endorsed_id,
            "signature": signature,
        },
        headers=auth,
    )
    assert created.status_code == 200, created.text
    out = created.json()
    assert out["endorser_device_id"] == endorser_id
    assert out["endorsed_device_id"] == endorsed_id

    listed = await client.get(ENDPOINT, headers=auth)
    assert listed.status_code == 200
    records = listed.json()
    assert len(records) == 1
    record = records[0]
    assert record["endorser_device_id"] == endorser_id
    assert record["endorsed_device_id"] == endorsed_id
    assert record["endorser_public_key"] == _wire(endorser_key)
    assert record["endorsed_public_key"] == _wire(endorsed_key)
    # The signature is served verbatim for the consumer to re-verify.
    assert record["signature"] == signature


async def test_recording_the_same_edge_is_idempotent(client):
    user_id, auth = await _signup(client, "acct-idem@example.com")
    endorser_id, endorser_key = await _add_device(user_id)
    endorsed_id, endorsed_key = await _add_device(user_id)
    signature = _sign(user_id, endorser_key, endorsed_key, endorsed_id)
    body = {
        "endorser_device_id": endorser_id,
        "endorsed_device_id": endorsed_id,
        "signature": signature,
    }

    first = await client.post(ENDPOINT, json=body, headers=auth)
    second = await client.post(ENDPOINT, json=body, headers=auth)
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["id"] == second.json()["id"]

    listed = await client.get(ENDPOINT, headers=auth)
    assert len(listed.json()) == 1


async def test_a_bad_signature_is_rejected(client):
    user_id, auth = await _signup(client, "acct-badsig@example.com")
    endorser_id, _ = await _add_device(user_id)
    endorsed_id, endorsed_key = await _add_device(user_id)
    # Signed by the wrong key (the endorsed device) — right length, won't verify.
    forged = _sign(user_id, endorsed_key, endorsed_key, endorsed_id)

    response = await client.post(
        ENDPOINT,
        json={
            "endorser_device_id": endorser_id,
            "endorsed_device_id": endorsed_id,
            "signature": forged,
        },
        headers=auth,
    )
    assert response.status_code == 422, response.text
    assert (await client.get(ENDPOINT, headers=auth)).json() == []


async def test_self_endorsement_is_rejected(client):
    user_id, auth = await _signup(client, "acct-self@example.com")
    device_id, _ = await _add_device(user_id)
    response = await client.post(
        ENDPOINT,
        json={
            "endorser_device_id": device_id,
            "endorsed_device_id": device_id,
            "signature": "A" * 86,
        },
        headers=auth,
    )
    assert response.status_code == 422


async def test_endorsing_a_foreign_device_is_not_found(client):
    user_id, auth = await _signup(client, "acct-owner@example.com")
    other_id, _ = await _signup(client, "acct-other@example.com")
    endorser_id, endorser_key = await _add_device(user_id)
    foreign_id, foreign_key = await _add_device(other_id)
    signature = _sign(user_id, endorser_key, foreign_key, foreign_id)

    response = await client.post(
        ENDPOINT,
        json={
            "endorser_device_id": endorser_id,
            "endorsed_device_id": foreign_id,
            "signature": signature,
        },
        headers=auth,
    )
    assert response.status_code == 404


async def test_edges_touching_a_revoked_device_are_omitted_and_blocked(client):
    user_id, auth = await _signup(client, "acct-revoke@example.com")
    endorser_id, endorser_key = await _add_device(user_id)
    endorsed_id, endorsed_key = await _add_device(user_id)
    signature = _sign(user_id, endorser_key, endorsed_key, endorsed_id)
    body = {
        "endorser_device_id": endorser_id,
        "endorsed_device_id": endorsed_id,
        "signature": signature,
    }
    assert (await client.post(ENDPOINT, json=body, headers=auth)).status_code == 200
    assert len((await client.get(ENDPOINT, headers=auth)).json()) == 1

    await _revoke_device(endorsed_id)

    # The existing edge is no longer served (the daemon would reject a chain
    # through a revoked key anyway) ...
    assert (await client.get(ENDPOINT, headers=auth)).json() == []
    # ... and a fresh endorsement of a revoked device is refused outright.
    assert (await client.post(ENDPOINT, json=body, headers=auth)).status_code == 409


async def test_the_list_is_account_scoped(client):
    user_id, auth = await _signup(client, "acct-scope-a@example.com")
    _, other_auth = await _signup(client, "acct-scope-b@example.com")
    endorser_id, endorser_key = await _add_device(user_id)
    endorsed_id, endorsed_key = await _add_device(user_id)
    signature = _sign(user_id, endorser_key, endorsed_key, endorsed_id)
    await client.post(
        ENDPOINT,
        json={
            "endorser_device_id": endorser_id,
            "endorsed_device_id": endorsed_id,
            "signature": signature,
        },
        headers=auth,
    )
    # A different account sees none of it.
    assert (await client.get(ENDPOINT, headers=other_auth)).json() == []
