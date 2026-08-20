"""Server support for the Access screen (docs/TRUST_UX.md): last-seen stamping,
remover attribution, and host pin provenance details. All display data — none of
it participates in any trust decision."""

from __future__ import annotations

import base64

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server.browser_registration import encode_browser_registration_transcript
from spawn_server.db import get_sessionmaker

pytestmark = pytest.mark.anyio


def _wire(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "correcthorse"})
    b = r.json()
    return b["user"]["id"], {"Authorization": f"Bearer {b['access_token']}"}


async def _register(client, auth, user_id, key: Ed25519PrivateKey):
    pub = key.public_key().public_bytes_raw()
    return await client.post(
        "/api/browser-devices/register",
        json={
            "key_algorithm": "ed25519",
            "public_key": _wire(pub),
            "signature": _wire(key.sign(encode_browser_registration_transcript(user_id, pub))),
        },
        headers=auth,
    )


async def test_registration_reconcile_stamps_last_seen(client):
    user_id, auth = await _signup(client, "seen@example.com")
    key = Ed25519PrivateKey.generate()
    first = (await _register(client, auth, user_id, key)).json()
    assert first["last_seen_at"] is not None

    again = (await _register(client, auth, user_id, key)).json()
    assert again["id"] == first["id"]
    assert again["last_seen_at"] >= first["last_seen_at"]


async def test_revoke_records_the_asking_device(client):
    user_id, auth = await _signup(client, "remover@example.com")
    remover_key = Ed25519PrivateKey.generate()
    remover = (await _register(client, auth, user_id, remover_key)).json()
    victim_key = Ed25519PrivateKey.generate()
    victim = (await _register(client, auth, user_id, victim_key)).json()

    revoked = (
        await client.post(
            f"/api/browser-devices/{victim['id']}/revoke",
            json={
                "expected_public_key": victim["public_key"],
                "revoked_by_device_id": remover["id"],
            },
            headers=auth,
        )
    ).json()
    assert revoked["revoked_at"] is not None
    assert revoked["revoked_by_device_id"] == remover["id"]


async def test_revoke_ignores_foreign_or_bogus_remover(client):
    user_id, auth = await _signup(client, "remover2@example.com")
    _other_id, other_auth = await _signup(client, "remover2-other@example.com")
    foreign_key = Ed25519PrivateKey.generate()
    foreign = (
        await _register(client, other_auth, _other_id, foreign_key)
    ).json()

    victim_key = Ed25519PrivateKey.generate()
    victim = (await _register(client, auth, user_id, victim_key)).json()
    revoked = (
        await client.post(
            f"/api/browser-devices/{victim['id']}/revoke",
            json={
                "expected_public_key": victim["public_key"],
                "revoked_by_device_id": foreign["id"],
            },
            headers=auth,
        )
    ).json()
    # The revoke lands; the foreign attribution is silently dropped.
    assert revoked["revoked_at"] is not None
    assert revoked["revoked_by_device_id"] is None


async def test_pin_details_distinguish_direct_from_endorsed(client):
    from spawn_server.models import Host, HostBrowserPin

    user_id, auth = await _signup(client, "pindetails@example.com")
    direct_key = Ed25519PrivateKey.generate()
    direct = (await _register(client, auth, user_id, direct_key)).json()
    endorsed_key = Ed25519PrivateKey.generate()
    endorsed = (await _register(client, auth, user_id, endorsed_key)).json()

    async with get_sessionmaker()() as session:
        host = Host(name="pin-box", owner_user_id=user_id)
        session.add(host)
        await session.flush()
        session.add_all(
            [
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=direct["id"],
                    browser_key_algorithm="ed25519",
                    browser_public_key=direct["public_key"],
                    browser_key_fingerprint="SHA256:" + "a" * 16,
                ),
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=endorsed["id"],
                    browser_key_algorithm="ed25519",
                    browser_public_key=endorsed["public_key"],
                    browser_key_fingerprint="SHA256:" + "b" * 16,
                    endorser_device_id=direct["id"],
                    endorsement_signature="s" * 86,
                ),
            ]
        )
        await session.commit()
        host_id = host.id

    details = (
        await client.get(f"/api/trust/hosts/{host_id}/pin-details", headers=auth)
    ).json()
    by_device = {d["device_id"]: d for d in details}
    assert by_device[direct["id"]]["direct"] is True
    assert by_device[endorsed["id"]]["direct"] is False
    assert all("created_at" in d for d in details)
