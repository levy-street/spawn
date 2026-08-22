"""The server stores the operator's sealed trust bundle without being able to read it."""

from __future__ import annotations

import pytest

from spawn_server.db import get_sessionmaker

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


# ---------- browser endorsement ----------


def _endorsement_signature(
    *, user_id: str, host_public_key: str, endorser_private, endorsed_public_key: str,
    endorsed_device_id: str,
) -> str:
    import base64

    from spawn_server.browser_endorsement import encode_browser_endorsement_transcript
    from spawn_server.host_identity import decode_ed25519_public_key

    transcript = encode_browser_endorsement_transcript(
        user_id,
        decode_ed25519_public_key(host_public_key),
        endorser_private.public_key().public_bytes_raw(),
        decode_ed25519_public_key(endorsed_public_key),
        endorsed_device_id,
    )
    return base64.urlsafe_b64encode(endorser_private.sign(transcript)).rstrip(b"=").decode()


async def _endorsement_fixture(client, email: str):
    """A host with one pinned browser, plus a second unpinned browser."""

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from spawn_server.host_identity import ed25519_key_fingerprint
    from spawn_server.models import BrowserDevice, Host, HostBrowserPin

    user_id, auth = await _signup(client, email)
    endorser_key = Ed25519PrivateKey.generate()
    endorsed_key = Ed25519PrivateKey.generate()
    host_key = Ed25519PrivateKey.generate()

    def wire(key) -> str:
        import base64

        return (
            base64.urlsafe_b64encode(key.public_key().public_bytes_raw()).rstrip(b"=").decode()
        )

    async with get_sessionmaker()() as session:
        host = Host(
            name="endorse-box",
            owner_user_id=user_id,
            host_key_algorithm="ed25519",
            host_public_key=wire(host_key),
        )
        session.add(host)
        endorser = BrowserDevice(
            owner_user_id=user_id, key_algorithm="ed25519", public_key=wire(endorser_key)
        )
        endorsed = BrowserDevice(
            owner_user_id=user_id, key_algorithm="ed25519", public_key=wire(endorsed_key)
        )
        session.add_all([endorser, endorsed])
        await session.flush()
        session.add(
            HostBrowserPin(
                host_id=host.id,
                browser_device_id=endorser.id,
                browser_key_algorithm="ed25519",
                browser_public_key=endorser.public_key,
                browser_key_fingerprint=ed25519_key_fingerprint(endorser.public_key),
            )
        )
        await session.commit()
        ids = (host.id, wire(host_key), endorser.id, endorsed.id, wire(endorsed_key))
    return user_id, auth, endorser_key, endorsed_key, ids


async def test_a_pinned_browser_can_endorse_another(client):
    user_id, auth, endorser_key, _, ids = await _endorsement_fixture(client, "endorse@example.com")
    host_id, host_pub, endorser_id, endorsed_id, endorsed_pub = ids

    signature = _endorsement_signature(
        user_id=user_id,
        host_public_key=host_pub,
        endorser_private=endorser_key,
        endorsed_public_key=endorsed_pub,
        endorsed_device_id=endorsed_id,
    )
    response = await client.post(
        "/api/trust/endorsements",
        json={
            "host_id": host_id,
            "endorser_device_id": endorser_id,
            "endorsed_device_id": endorsed_id,
            "signature": signature,
        },
        headers=auth,
    )
    assert response.status_code == 200, response.text
    assert response.json()["endorsed_device_id"] == endorsed_id

    # Retrying is idempotent, since a dropped response is normal.
    again = await client.post(
        "/api/trust/endorsements",
        json={
            "host_id": host_id,
            "endorser_device_id": endorser_id,
            "endorsed_device_id": endorsed_id,
            "signature": signature,
        },
        headers=auth,
    )
    assert again.status_code == 200


async def test_an_unpinned_browser_cannot_endorse(client):
    """Authority must come from a device the host already trusts."""

    user_id, auth, _, endorsed_key, ids = await _endorsement_fixture(
        client, "unpinned-endorser@example.com"
    )
    host_id, host_pub, _, endorsed_id, endorsed_pub = ids

    # The endorsed (unpinned) device tries to admit itself via a third device.
    signature = _endorsement_signature(
        user_id=user_id,
        host_public_key=host_pub,
        endorser_private=endorsed_key,
        endorsed_public_key=endorsed_pub,
        endorsed_device_id=endorsed_id,
    )
    response = await client.post(
        "/api/trust/endorsements",
        json={
            "host_id": host_id,
            "endorser_device_id": endorsed_id,
            "endorsed_device_id": endorsed_id,
            "signature": signature,
        },
        headers=auth,
    )
    assert response.status_code in (409, 422)


async def test_a_forged_endorsement_is_refused(client):
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    user_id, auth, _, _, ids = await _endorsement_fixture(client, "forged@example.com")
    host_id, host_pub, endorser_id, endorsed_id, endorsed_pub = ids

    signature = _endorsement_signature(
        user_id=user_id,
        host_public_key=host_pub,
        endorser_private=Ed25519PrivateKey.generate(),
        endorsed_public_key=endorsed_pub,
        endorsed_device_id=endorsed_id,
    )
    response = await client.post(
        "/api/trust/endorsements",
        json={
            "host_id": host_id,
            "endorser_device_id": endorser_id,
            "endorsed_device_id": endorsed_id,
            "signature": signature,
        },
        headers=auth,
    )
    assert response.status_code == 422


async def test_endorsing_for_another_account_host_is_refused(client):
    user_id, auth, endorser_key, _, ids = await _endorsement_fixture(
        client, "cross-account@example.com"
    )
    _, other_auth = await _signup(client, "outsider@example.com")
    host_id, host_pub, endorser_id, endorsed_id, endorsed_pub = ids

    signature = _endorsement_signature(
        user_id=user_id,
        host_public_key=host_pub,
        endorser_private=endorser_key,
        endorsed_public_key=endorsed_pub,
        endorsed_device_id=endorsed_id,
    )
    response = await client.post(
        "/api/trust/endorsements",
        json={
            "host_id": host_id,
            "endorser_device_id": endorser_id,
            "endorsed_device_id": endorsed_id,
            "signature": signature,
        },
        headers=other_auth,
    )
    assert response.status_code == 404


def test_endorsement_transcript_matches_the_daemon_and_browser_bytes():
    """All three encoders must agree, or endorsements fail across runtimes.

    Vector produced by daemon/src/browser_endorsement.rs and asserted again in
    web/src/lib/browser-endorsement-transcript.test.ts. A divergence would be
    silent: each runtime would still agree with itself.
    """

    import base64
    import hashlib

    from spawn_server.browser_endorsement import encode_browser_endorsement_transcript
    from spawn_server.host_identity import decode_ed25519_public_key

    transcript = encode_browser_endorsement_transcript(
        "9f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f",
        decode_ed25519_public_key("Zr5-Myx6RTMyvZ0Kf32wVfXF7xoGraZtmLOftoEMRzo"),
        decode_ed25519_public_key("C1E62bSSQBXKCQLtB5BE06xdvsIwbwaUjBDajrbjny0"),
        decode_ed25519_public_key("kaKKC3Q4FZOk2UaVeSCJJq_IrYLIg5t2RDWbnrqaSzo"),
        "11111111-2222-4333-8444-555555555555",
    )
    digest = base64.urlsafe_b64encode(hashlib.sha256(transcript).digest()).rstrip(b"=").decode()
    assert digest == "zWI0kvAu5asJ4YKWiXSmlbSZM2u8_z7DOiVQ6vE220Y"


async def test_endorsed_device_can_fetch_its_introductions(client):
    """The delivery leg: the endorsed device gets what it needs to verify.

    The record must carry the host key and endorser key, since the endorsed
    browser re-encodes the transcript from them and checks the signature
    locally. Endorsements naming other devices must never appear.
    """

    user_id, auth, endorser_key, _, ids = await _endorsement_fixture(
        client, "introductions@example.com"
    )
    host_id, host_pub, endorser_id, endorsed_id, endorsed_pub = ids

    signature = _endorsement_signature(
        user_id=user_id,
        host_public_key=host_pub,
        endorser_private=endorser_key,
        endorsed_public_key=endorsed_pub,
        endorsed_device_id=endorsed_id,
    )
    created = await client.post(
        "/api/trust/endorsements",
        json={
            "host_id": host_id,
            "endorser_device_id": endorser_id,
            "endorsed_device_id": endorsed_id,
            "signature": signature,
        },
        headers=auth,
    )
    assert created.status_code == 200, created.text

    listed = await client.get(
        f"/api/trust/endorsements?endorsed_device_id={endorsed_id}", headers=auth
    )
    assert listed.status_code == 200, listed.text
    records = listed.json()
    assert len(records) == 1
    record = records[0]
    assert record["host_id"] == host_id
    assert record["host_public_key"] == host_pub
    assert record["endorser_device_id"] == endorser_id
    assert record["signature"] == signature

    # The ENDORSER has no introduction of its own (it was pinned directly).
    endorser_view = await client.get(
        f"/api/trust/endorsements?endorsed_device_id={endorser_id}", headers=auth
    )
    assert endorser_view.status_code == 200
    assert endorser_view.json() == []

    # Another account cannot read this account's introductions.
    other = await client.post(
        "/api/auth/signup",
        json={"email": "introductions-other@example.com", "password": "other-password"},
    )
    other_auth = {"Authorization": f"Bearer {other.json()['access_token']}"}
    cross = await client.get(
        f"/api/trust/endorsements?endorsed_device_id={endorsed_id}", headers=other_auth
    )
    assert cross.status_code == 200
    assert cross.json() == []


async def test_revoked_endorser_introductions_are_not_offered(client):
    """A severed endorsement must not be offered as an introduction either."""

    from datetime import UTC, datetime

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import BrowserDevice

    user_id, auth, endorser_key, _, ids = await _endorsement_fixture(
        client, "revoked-introductions@example.com"
    )
    host_id, host_pub, endorser_id, endorsed_id, endorsed_pub = ids

    created = await client.post(
        "/api/trust/endorsements",
        json={
            "host_id": host_id,
            "endorser_device_id": endorser_id,
            "endorsed_device_id": endorsed_id,
            "signature": _endorsement_signature(
                user_id=user_id,
                host_public_key=host_pub,
                endorser_private=endorser_key,
                endorsed_public_key=endorsed_pub,
                endorsed_device_id=endorsed_id,
            ),
        },
        headers=auth,
    )
    assert created.status_code == 200

    async with get_sessionmaker()() as session:
        endorser = await session.get(BrowserDevice, endorser_id)
        assert endorser is not None
        endorser.revoked_at = datetime.now(UTC)
        await session.commit()

    listed = await client.get(
        f"/api/trust/endorsements?endorsed_device_id={endorsed_id}", headers=auth
    )
    assert listed.status_code == 200
    assert listed.json() == []


async def test_bundle_delete_abandons_it_idempotently(client):
    """Removing the last passkey abandons the bundle; deleting twice is fine."""

    _, auth = await _signup(client, "bundle-delete@example.com")
    sealed = "c2VhbGVkLWJ5dGVz"
    put = await client.put("/api/trust/bundle", json={"sealed": sealed}, headers=auth)
    assert put.status_code == 200

    deleted = await client.delete("/api/trust/bundle", headers=auth)
    assert deleted.status_code == 204
    assert (await client.get("/api/trust/bundle", headers=auth)).json() is None
    # Idempotent: no bundle is the normal pre-bootstrap state.
    assert (await client.delete("/api/trust/bundle", headers=auth)).status_code == 204

    # A fresh bundle can be sealed again afterward (revision restarts server-side).
    fresh = await client.put("/api/trust/bundle", json={"sealed": sealed}, headers=auth)
    assert fresh.status_code == 200
    assert fresh.json()["revision"] == 1


async def test_bundle_delete_is_account_scoped(client):
    _, auth_a = await _signup(client, "bundle-del-a@example.com")
    _, auth_b = await _signup(client, "bundle-del-b@example.com")
    sealed = "c2VhbGVkLWJ5dGVz"
    assert (
        await client.put("/api/trust/bundle", json={"sealed": sealed}, headers=auth_a)
    ).status_code == 200

    assert (await client.delete("/api/trust/bundle", headers=auth_b)).status_code == 204
    kept = await client.get("/api/trust/bundle", headers=auth_a)
    assert kept.json() is not None


# ---------------------------------------------------------------------------
# Pin-route liveness (P-C4): /pins and /pin-details serve the daemon's answer
# ---------------------------------------------------------------------------


async def _pin_liveness_fixture(client, email: str):
    """A host pinned by device X (direct) plus a revoked co-pin and a root pin.

    Returns enough handles to arrange the field-bug shape: the R5 sole-trust
    warning reads these routes, so a revoked device or a revoked root that
    still shows up as a pin suppresses the warning exactly when it matters.
    """

    import base64

    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    from spawn_server.host_identity import ed25519_key_fingerprint
    from spawn_server.models import BrowserDevice, Host, HostBrowserPin

    user_id, auth = await _signup(client, email)

    def wire(key) -> str:
        return (
            base64.urlsafe_b64encode(key.public_key().public_bytes_raw()).rstrip(b"=").decode()
        )

    async with get_sessionmaker()() as session:
        host = Host(
            name="liveness-box",
            owner_user_id=user_id,
            host_key_algorithm="ed25519",
            host_public_key=wire(Ed25519PrivateKey.generate()),
        )
        session.add(host)
        x = BrowserDevice(
            owner_user_id=user_id,
            key_algorithm="ed25519",
            public_key=wire(Ed25519PrivateKey.generate()),
        )
        root = BrowserDevice(
            owner_user_id=user_id,
            key_algorithm="ed25519",
            public_key=wire(Ed25519PrivateKey.generate()),
            is_root=True,
        )
        session.add_all([x, root])
        await session.flush()
        for device, endorser_id in ((x, None), (root, x.id)):
            session.add(
                HostBrowserPin(
                    host_id=host.id,
                    browser_device_id=device.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=device.public_key,
                    browser_key_fingerprint=ed25519_key_fingerprint(device.public_key),
                    endorser_device_id=endorser_id,
                )
            )
        await session.commit()
        ids = (host.id, x.id, root.id)
    return user_id, auth, ids


async def _revoke_device(device_id: str) -> None:
    from datetime import UTC, datetime

    from spawn_server.models import BrowserDevice

    async with get_sessionmaker()() as session:
        device = await session.get(BrowserDevice, device_id)
        device.revoked_at = datetime.now(UTC)
        await session.commit()


async def test_pins_routes_serve_transitively_live_pins_only(client):
    """A revoked ROOT pin must vanish from both routes (the field-bug shape).

    With X live and the root revoked, the host is sole-trust on X: the raw
    rows would report two pins and silence the R5 warning for removing X."""

    _, auth, (host_id, x_id, root_id) = await _pin_liveness_fixture(
        client, "pin-liveness-root@example.com"
    )

    both = await client.get(f"/api/trust/hosts/{host_id}/pins", headers=auth)
    assert both.status_code == 200
    assert sorted(both.json()) == sorted([x_id, root_id])

    await _revoke_device(root_id)
    pins = await client.get(f"/api/trust/hosts/{host_id}/pins", headers=auth)
    assert pins.json() == [x_id]
    details = await client.get(f"/api/trust/hosts/{host_id}/pin-details", headers=auth)
    assert [row["device_id"] for row in details.json()] == [x_id]


async def test_pins_routes_drop_a_revoked_direct_pin(client):
    """A revoked co-pin device disappears; its endorsement subtree dies with it —
    except the root-anchor ratchet, which outlives its endorser by design."""

    _, auth, (host_id, x_id, root_id) = await _pin_liveness_fixture(
        client, "pin-liveness-direct@example.com"
    )

    await _revoke_device(x_id)
    pins = await client.get(f"/api/trust/hosts/{host_id}/pins", headers=auth)
    # X's own pin is gone. The ROOT pin it endorsed survives (mesh §3 ratchet):
    # anchoring on R exists precisely to outlive any single device's fate.
    assert pins.json() == [root_id]
    details = await client.get(f"/api/trust/hosts/{host_id}/pin-details", headers=auth)
    assert [row["device_id"] for row in details.json()] == [root_id]


async def test_pins_routes_match_the_daemon_computation(client):
    """The routes and the daemon share one helper; a fork here would let the UI
    and admission disagree about who is trusted."""

    from spawn_server.pin_liveness import live_browser_device_id_set

    _, auth, (host_id, x_id, root_id) = await _pin_liveness_fixture(
        client, "pin-liveness-shared@example.com"
    )
    await _revoke_device(root_id)
    async with get_sessionmaker()() as session:
        expected = sorted(await live_browser_device_id_set(session, host_id))
    pins = await client.get(f"/api/trust/hosts/{host_id}/pins", headers=auth)
    assert pins.json() == expected == [x_id]
