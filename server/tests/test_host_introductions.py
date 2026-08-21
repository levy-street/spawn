"""The durable host-introduction store (mesh R7, continuous gossip).

The server is an untrusted mailbox with two fail-closed duties: hygiene-verify
the SPAWN-HOST-INTRO-BCAST-V1 signature against the publisher's registered key
(rows that could never verify for anyone stay out), and withhold rows from
revoked publishers on GET. Recipients re-verify everything against the
publisher key they learned firsthand — nothing here can create trust.
"""

from __future__ import annotations

import base64

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server.host_introduction import encode_host_intro_broadcast_transcript

pytestmark = pytest.mark.anyio

STORE = "/api/trust/host-introductions"


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _wire(key: Ed25519PrivateKey) -> str:
    return _b64u(key.public_key().public_bytes_raw())


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup", json={"email": email, "password": "correcthorse"}
    )
    assert response.status_code == 200
    body = response.json()
    return body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"}


async def _register_device(client, auth, user_id: str) -> tuple[str, Ed25519PrivateKey]:
    from spawn_server.browser_registration import encode_browser_registration_transcript

    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes_raw()
    registered = await client.post(
        "/api/browser-devices/register",
        json={
            "key_algorithm": "ed25519",
            "public_key": _b64u(public),
            "signature": _b64u(key.sign(encode_browser_registration_transcript(user_id, public))),
        },
        headers=auth,
    )
    assert registered.status_code == 200, registered.text
    return registered.json()["id"], key


def _publish_body(
    user_id: str,
    device_id: str,
    device_key: Ed25519PrivateKey,
    host_key: Ed25519PrivateKey,
    host_name: str = "minivac",
) -> dict[str, str]:
    host_public = host_key.public_key().public_bytes_raw()
    transcript = encode_host_intro_broadcast_transcript(
        user_id,
        device_key.public_key().public_bytes_raw(),
        host_public,
    )
    return {
        "publisher_device_id": device_id,
        "host_id": "0b6e6c64-0000-4000-8000-00000000000a",
        "host_name": host_name,
        "host_public_key": _b64u(host_public),
        "signature": _b64u(device_key.sign(transcript)),
    }


async def test_publish_verifies_signature_and_is_idempotent(client):
    user_id, auth = await _signup(client, "gossip-pub@example.com")
    device_id, device_key = await _register_device(client, auth, user_id)
    host_key = Ed25519PrivateKey.generate()

    body = _publish_body(user_id, device_id, device_key, host_key)
    first = await client.post(STORE, json=body, headers=auth)
    assert first.status_code == 200, first.text
    assert first.json()["publisher_public_key"] == _wire(device_key)

    # Idempotent republish (the reconcile sweep re-walks pins).
    second = await client.post(STORE, json=body, headers=auth)
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]

    listed = await client.get(STORE, headers=auth)
    assert listed.status_code == 200
    assert [row["id"] for row in listed.json()] == [first.json()["id"]]

    # A signature that does not verify under the publisher's REGISTERED key is
    # hygiene-refused: substituting the host key breaks the transcript.
    other_host = Ed25519PrivateKey.generate()
    tampered = {**body, "host_public_key": _wire(other_host)}
    refused = await client.post(STORE, json=tampered, headers=auth)
    assert refused.status_code == 422

    # A signature by a key that is not the registered one fails the same way.
    imposter = Ed25519PrivateKey.generate()
    forged = _publish_body(user_id, device_id, imposter, host_key)
    assert (await client.post(STORE, json=forged, headers=auth)).status_code == 422


async def test_publish_requires_your_own_live_device(client):
    user_id, auth = await _signup(client, "gossip-own@example.com")
    device_id, device_key = await _register_device(client, auth, user_id)
    host_key = Ed25519PrivateKey.generate()
    body = _publish_body(user_id, device_id, device_key, host_key)

    # Another account can neither publish under this device nor see the store.
    _, foreign_auth = await _signup(client, "gossip-foreign@example.com")
    assert (await client.post(STORE, json=body, headers=foreign_auth)).status_code == 404

    published = await client.post(STORE, json=body, headers=auth)
    assert published.status_code == 200
    assert (await client.get(STORE, headers=foreign_auth)).json() == []

    # A revoked publisher can no longer publish, and its existing rows are
    # withheld from GET (fail-closed): a removed device's vouches stop spreading.
    revoked = await client.post(
        f"/api/browser-devices/{device_id}/revoke",
        json={"expected_public_key": _wire(device_key)},
        headers=auth,
    )
    assert revoked.status_code == 200, revoked.text
    after = _publish_body(user_id, device_id, device_key, Ed25519PrivateKey.generate())
    assert (await client.post(STORE, json=after, headers=auth)).status_code == 409
    assert (await client.get(STORE, headers=auth)).json() == []


async def test_per_account_cap_refuses_floods(client, monkeypatch):
    from spawn_server.routes import host_introductions as store_routes

    monkeypatch.setattr(store_routes, "MAX_INTRODUCTIONS_PER_ACCOUNT", 2)
    user_id, auth = await _signup(client, "gossip-cap@example.com")
    device_id, device_key = await _register_device(client, auth, user_id)
    for _ in range(2):
        body = _publish_body(user_id, device_id, device_key, Ed25519PrivateKey.generate())
        assert (await client.post(STORE, json=body, headers=auth)).status_code == 200
    body = _publish_body(user_id, device_id, device_key, Ed25519PrivateKey.generate())
    assert (await client.post(STORE, json=body, headers=auth)).status_code == 409
