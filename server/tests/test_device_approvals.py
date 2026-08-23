"""A device knocking, and what the knock is and is not allowed to do.

The point of this resource is discoverability, not authority: it tells the
account's other devices that somebody is waiting so they can offer the
endorsement ceremony instead of hiding it. Every test here is about keeping
that line — the row grants nothing, and the pin still comes from a signature
made on a device the host already trusts.
"""

from __future__ import annotations

import base64

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server.browser_registration import encode_browser_registration_transcript

pytestmark = pytest.mark.anyio


def _wire(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup",
        json={"email": email, "password": "device-approval-test-password"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    return body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"}


async def _register_device(client, user_id: str, headers: dict[str, str], label: str) -> dict:
    key = Ed25519PrivateKey.generate()
    public_key = key.public_key().public_bytes_raw()
    response = await client.post(
        "/api/browser-devices/register",
        json={
            "key_algorithm": "ed25519",
            "public_key": _wire(public_key),
            "signature": _wire(key.sign(encode_browser_registration_transcript(user_id, public_key))),
            "label": label,
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_knock_is_listed_for_the_account_and_carries_the_real_fingerprint(client):
    user_id, headers = await _signup(client, "knock@example.com")
    device = await _register_device(client, user_id, headers, "iPhone")

    created = await client.post(
        "/api/trust/device-approvals",
        json={"browser_device_id": device["id"]},
        headers=headers,
    )
    assert created.status_code == 200, created.text
    assert created.json()["status"] == "pending"
    # Derived from the stored key, so the approving screen and the asking screen
    # are comparing the same value.
    assert created.json()["fingerprint"] == device["fingerprint"]

    listed = await client.get("/api/trust/device-approvals", headers=headers)
    assert [row["id"] for row in listed.json()] == [created.json()["id"]]
    assert listed.json()[0]["label"] == "iPhone"


async def test_asking_twice_refreshes_one_knock_rather_than_stacking_prompts(client):
    user_id, headers = await _signup(client, "twice@example.com")
    device = await _register_device(client, user_id, headers, "iPhone")

    first = await client.post(
        "/api/trust/device-approvals",
        json={"browser_device_id": device["id"]},
        headers=headers,
    )
    second = await client.post(
        "/api/trust/device-approvals",
        json={"browser_device_id": device["id"]},
        headers=headers,
    )
    assert first.json()["id"] == second.json()["id"]
    assert second.json()["expires_at"] >= first.json()["expires_at"]

    listed = await client.get("/api/trust/device-approvals", headers=headers)
    assert len(listed.json()) == 1


async def test_a_knock_never_reaches_another_account(client):
    user_id, headers = await _signup(client, "mine@example.com")
    device = await _register_device(client, user_id, headers, "iPhone")
    await client.post(
        "/api/trust/device-approvals",
        json={"browser_device_id": device["id"]},
        headers=headers,
    )

    _, stranger = await _signup(client, "stranger@example.com")
    assert (await client.get("/api/trust/device-approvals", headers=stranger)).json() == []
    # And a stranger cannot raise one on a device they do not own.
    forged = await client.post(
        "/api/trust/device-approvals",
        json={"browser_device_id": device["id"]},
        headers=stranger,
    )
    assert forged.status_code == 404


async def test_denying_closes_the_knock_without_revoking_the_device(client):
    user_id, headers = await _signup(client, "deny@example.com")
    device = await _register_device(client, user_id, headers, "iPhone")
    created = await client.post(
        "/api/trust/device-approvals",
        json={"browser_device_id": device["id"]},
        headers=headers,
    )

    denied = await client.post(
        f"/api/trust/device-approvals/{created.json()['id']}/deny", headers=headers
    )
    assert denied.status_code == 200, denied.text
    assert denied.json()["status"] == "denied"
    assert (await client.get("/api/trust/device-approvals", headers=headers)).json() == []

    # Denial is about this request only: the identity is still registered, and
    # the device may ask again.
    listing = await client.get("/api/browser-devices", headers=headers)
    assert [row["id"] for row in listing.json() if row["revoked_at"] is None] == [device["id"]]
    again = await client.post(
        "/api/trust/device-approvals",
        json={"browser_device_id": device["id"]},
        headers=headers,
    )
    assert again.status_code == 200
    assert again.json()["id"] != created.json()["id"]


async def test_a_knock_alone_admits_nothing(client):
    """The row is a notification. Nothing about it creates a host pin."""

    user_id, headers = await _signup(client, "noauthority@example.com")
    device = await _register_device(client, user_id, headers, "iPhone")
    await client.post(
        "/api/trust/device-approvals",
        json={"browser_device_id": device["id"]},
        headers=headers,
    )

    hosts = await client.get("/api/hosts", headers=headers)
    for host in hosts.json():
        pins = await client.get(f"/api/trust/hosts/{host['id']}/pins", headers=headers)
        assert device["id"] not in pins.json()
