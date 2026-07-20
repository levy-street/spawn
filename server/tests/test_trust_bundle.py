"""The server stores the operator's sealed trust bundle without being able to read it."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.anyio


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup",
        json={"email": email, "password": "correcthorse"},
    )
    assert response.status_code == 200
    body = response.json()
    return body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"}


async def test_absent_bundle_is_not_an_error(client):
    """An account that has never bootstrapped is a normal state, not a failure."""

    _, auth = await _signup(client, "nobundle@example.com")
    response = await client.get("/api/trust/bundle", headers=auth)
    assert response.status_code == 200
    assert response.json() is None


async def test_bundle_round_trips_opaquely(client):
    _, auth = await _signup(client, "bundle@example.com")
    sealed = "c2VhbGVkLWJ5dGVz"

    created = await client.put("/api/trust/bundle", json={"sealed": sealed}, headers=auth)
    assert created.status_code == 200, created.text
    assert created.json()["revision"] == 1

    fetched = await client.get("/api/trust/bundle", headers=auth)
    # Stored and returned byte-for-byte: the server never interprets it.
    assert fetched.json()["sealed"] == sealed
    assert fetched.json()["revision"] == 1


async def test_replacing_requires_the_revision_it_was_read_at(client):
    """A stale device must not silently drop host keys another device added."""

    _, auth = await _signup(client, "cas@example.com")
    await client.put("/api/trust/bundle", json={"sealed": "aaaa"}, headers=auth)

    blind = await client.put("/api/trust/bundle", json={"sealed": "bbbb"}, headers=auth)
    assert blind.status_code == 409

    stale = await client.put(
        "/api/trust/bundle", json={"sealed": "bbbb", "expected_revision": 99}, headers=auth
    )
    assert stale.status_code == 409

    fresh = await client.put(
        "/api/trust/bundle", json={"sealed": "bbbb", "expected_revision": 1}, headers=auth
    )
    assert fresh.status_code == 200
    assert fresh.json()["revision"] == 2
    assert (await client.get("/api/trust/bundle", headers=auth)).json()["sealed"] == "bbbb"


async def test_two_devices_racing_do_not_clobber_each_other(client):
    """Both read revision 1; only one may win, and the loser is told."""

    _, auth = await _signup(client, "race@example.com")
    await client.put("/api/trust/bundle", json={"sealed": "base"}, headers=auth)

    first = await client.put(
        "/api/trust/bundle", json={"sealed": "device-one", "expected_revision": 1}, headers=auth
    )
    second = await client.put(
        "/api/trust/bundle", json={"sealed": "device-two", "expected_revision": 1}, headers=auth
    )
    assert first.status_code == 200
    assert second.status_code == 409
    assert (await client.get("/api/trust/bundle", headers=auth)).json()["sealed"] == "device-one"


async def test_creating_with_a_revision_is_refused(client):
    """Claiming to replace something that does not exist is a client bug."""

    _, auth = await _signup(client, "phantom@example.com")
    response = await client.put(
        "/api/trust/bundle", json={"sealed": "aaaa", "expected_revision": 1}, headers=auth
    )
    assert response.status_code == 409


async def test_oversized_bundle_is_refused(client):
    _, auth = await _signup(client, "huge@example.com")
    response = await client.put(
        "/api/trust/bundle", json={"sealed": "a" * (256 * 1024 + 1)}, headers=auth
    )
    assert response.status_code == 413


async def test_bundles_are_per_account(client):
    """One operator's bundle must never be served to another."""

    _, first = await _signup(client, "owner-a@example.com")
    _, second = await _signup(client, "owner-b@example.com")
    await client.put("/api/trust/bundle", json={"sealed": "secret-a"}, headers=first)

    assert (await client.get("/api/trust/bundle", headers=second)).json() is None
    await client.put("/api/trust/bundle", json={"sealed": "secret-b"}, headers=second)
    assert (await client.get("/api/trust/bundle", headers=first)).json()["sealed"] == "secret-a"


async def test_bundle_requires_authentication(client):
    assert (await client.get("/api/trust/bundle")).status_code == 401
    assert (await client.put("/api/trust/bundle", json={"sealed": "a"})).status_code == 401


async def test_passkeys_round_trip_and_are_idempotent(client):
    _, auth = await _signup(client, "passkeys@example.com")

    created = await client.post(
        "/api/trust/passkeys", json={"credential_id": "AQIDBA", "label": "laptop"}, headers=auth
    )
    assert created.status_code == 200, created.text

    # Re-registering the same credential is not an error.
    again = await client.post(
        "/api/trust/passkeys", json={"credential_id": "AQIDBA", "label": "laptop"}, headers=auth
    )
    assert again.status_code == 200
    assert again.json()["id"] == created.json()["id"]

    listed = await client.get("/api/trust/passkeys", headers=auth)
    assert [row["credential_id"] for row in listed.json()] == ["AQIDBA"]

    deleted = await client.delete(f"/api/trust/passkeys/{created.json()['id']}", headers=auth)
    assert deleted.status_code == 204
    assert (await client.get("/api/trust/passkeys", headers=auth)).json() == []


async def test_passkeys_are_per_account(client):
    """Another account's passkey must be neither listed nor deletable."""

    _, first = await _signup(client, "keys-a@example.com")
    _, second = await _signup(client, "keys-b@example.com")
    created = await client.post(
        "/api/trust/passkeys", json={"credential_id": "AQIDBA"}, headers=first
    )
    passkey_id = created.json()["id"]

    assert (await client.get("/api/trust/passkeys", headers=second)).json() == []
    assert (await client.delete(f"/api/trust/passkeys/{passkey_id}", headers=second)).status_code == 404
    assert len((await client.get("/api/trust/passkeys", headers=first)).json()) == 1


async def test_the_same_credential_id_may_belong_to_two_accounts(client):
    """Uniqueness is per account: credential IDs are not globally owned."""

    _, first = await _signup(client, "shared-a@example.com")
    _, second = await _signup(client, "shared-b@example.com")
    assert (
        await client.post("/api/trust/passkeys", json={"credential_id": "AQIDBA"}, headers=first)
    ).status_code == 200
    assert (
        await client.post("/api/trust/passkeys", json={"credential_id": "AQIDBA"}, headers=second)
    ).status_code == 200
