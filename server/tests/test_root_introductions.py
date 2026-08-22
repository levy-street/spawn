"""The durable root-introduction store (mesh §4.1 provenance channel).

The server is an untrusted mailbox with two fail-closed duties: hygiene-verify
the SPAWN-ROOT-INTRO-V1 signature against the introducer's registered key
(rows that could never verify for anyone stay out), and withhold rows from
revoked introducers on GET. Recipients re-verify everything against the
introducer key they learned firsthand — nothing here can create trust: a
hostile server that fabricates or replays rows moves no root anywhere.
"""

from __future__ import annotations

import base64
import hashlib
from datetime import UTC, datetime

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server.db import get_sessionmaker
from spawn_server.root_introduction import encode_root_intro_transcript

pytestmark = pytest.mark.anyio

STORE = "/api/trust/root-introductions"


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup", json={"email": email, "password": "correcthorse"}
    )
    assert response.status_code == 200
    body = response.json()
    return body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"}


async def _register_device(
    client, auth, user_id: str, *, is_root: bool = False
) -> tuple[str, Ed25519PrivateKey]:
    from spawn_server.browser_registration import encode_browser_registration_transcript

    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes_raw()
    registered = await client.post(
        "/api/browser-devices/register",
        json={
            "key_algorithm": "ed25519",
            "public_key": _b64u(public),
            "signature": _b64u(
                key.sign(encode_browser_registration_transcript(user_id, public, is_root=is_root))
            ),
            "is_root": is_root,
        },
        headers=auth,
    )
    assert registered.status_code == 200, registered.text
    return registered.json()["id"], key


def _intro_body(
    user_id: str,
    introducer_id: str,
    introducer_key: Ed25519PrivateKey,
    root_public: bytes,
) -> dict[str, str]:
    transcript = encode_root_intro_transcript(
        user_id, introducer_key.public_key().public_bytes_raw(), root_public
    )
    return {
        "introducer_device_id": introducer_id,
        "root_public_key": _b64u(root_public),
        "signature": _b64u(introducer_key.sign(transcript)),
    }


def test_transcript_vector_matches_the_browser_bytes():
    """Shared cross-runtime vector (also asserted in root-introduction.test.ts):
    a drift on either side silently forks the signed bytes."""

    transcript = encode_root_intro_transcript(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        bytes(range(1, 33)),
        bytes(range(101, 133)),
    )
    assert len(transcript) == 100
    assert (
        hashlib.sha256(transcript).hexdigest()
        == "e602f3e3b4671a7ff3559328b2aa4d68b6a19a0d8c16132c153520478ba4fe22"
    )


async def test_publish_and_list_round_trip(client):
    user_id, auth = await _signup(client, "root-intro@example.com")
    introducer_id, introducer_key = await _register_device(client, auth, user_id)
    root_public = Ed25519PrivateKey.generate().public_key().public_bytes_raw()

    body = _intro_body(user_id, introducer_id, introducer_key, root_public)
    published = await client.post(STORE, json=body, headers=auth)
    assert published.status_code == 200, published.text
    assert published.json()["root_public_key"] == _b64u(root_public)

    # Idempotent republish keeps one row.
    again = await client.post(STORE, json=body, headers=auth)
    assert again.status_code == 200
    assert again.json()["id"] == published.json()["id"]

    rows = (await client.get(STORE, headers=auth)).json()
    assert len(rows) == 1
    assert rows[0]["introducer_device_id"] == introducer_id
    assert rows[0]["signature"] == body["signature"]


async def test_rotation_replaces_the_introducer_own_row(client):
    """A successor root replaces the introducer's row — never adds a second.
    Acceptance of the successor stays gated client-side on corroborated
    revocation of the old key; the store just carries the newest statement."""

    user_id, auth = await _signup(client, "root-intro-rotate@example.com")
    introducer_id, introducer_key = await _register_device(client, auth, user_id)
    old_root = Ed25519PrivateKey.generate().public_key().public_bytes_raw()
    new_root = Ed25519PrivateKey.generate().public_key().public_bytes_raw()

    first = await client.post(
        STORE, json=_intro_body(user_id, introducer_id, introducer_key, old_root), headers=auth
    )
    assert first.status_code == 200
    second = await client.post(
        STORE, json=_intro_body(user_id, introducer_id, introducer_key, new_root), headers=auth
    )
    assert second.status_code == 200

    rows = (await client.get(STORE, headers=auth)).json()
    assert len(rows) == 1
    assert rows[0]["root_public_key"] == _b64u(new_root)
    assert rows[0]["id"] == first.json()["id"]


async def test_forged_signature_is_refused(client):
    user_id, auth = await _signup(client, "root-intro-forged@example.com")
    introducer_id, introducer_key = await _register_device(client, auth, user_id)
    root_public = Ed25519PrivateKey.generate().public_key().public_bytes_raw()

    body = _intro_body(user_id, introducer_id, introducer_key, root_public)
    body["signature"] = _b64u(bytes(64))
    refused = await client.post(STORE, json=body, headers=auth)
    assert refused.status_code == 422


async def test_a_substituted_root_key_kills_the_signature(client):
    """The transcript covers the root key: the server cannot swap in its own
    key and reuse a real introducer signature."""

    user_id, auth = await _signup(client, "root-intro-swap@example.com")
    introducer_id, introducer_key = await _register_device(client, auth, user_id)
    real_root = Ed25519PrivateKey.generate().public_key().public_bytes_raw()
    attacker_root = Ed25519PrivateKey.generate().public_key().public_bytes_raw()

    body = _intro_body(user_id, introducer_id, introducer_key, real_root)
    body["root_public_key"] = _b64u(attacker_root)
    refused = await client.post(STORE, json=body, headers=auth)
    assert refused.status_code == 422


async def test_the_root_cannot_introduce_itself(client):
    user_id, auth = await _signup(client, "root-intro-self@example.com")
    root_id, root_key = await _register_device(client, auth, user_id, is_root=True)
    other_root = Ed25519PrivateKey.generate().public_key().public_bytes_raw()

    refused = await client.post(
        STORE, json=_intro_body(user_id, root_id, root_key, other_root), headers=auth
    )
    assert refused.status_code == 422


async def test_a_key_may_not_introduce_itself_as_the_root(client):
    user_id, auth = await _signup(client, "root-intro-vacuous@example.com")
    introducer_id, introducer_key = await _register_device(client, auth, user_id)
    own_public = introducer_key.public_key().public_bytes_raw()

    transcript_refused = await client.post(
        STORE,
        json={
            "introducer_device_id": introducer_id,
            "root_public_key": _b64u(own_public),
            "signature": _b64u(bytes(64)),
        },
        headers=auth,
    )
    assert transcript_refused.status_code == 422


async def test_revoked_introducer_rows_are_withheld_and_refused(client):
    user_id, auth = await _signup(client, "root-intro-revoked@example.com")
    introducer_id, introducer_key = await _register_device(client, auth, user_id)
    root_public = Ed25519PrivateKey.generate().public_key().public_bytes_raw()

    body = _intro_body(user_id, introducer_id, introducer_key, root_public)
    assert (await client.post(STORE, json=body, headers=auth)).status_code == 200

    from spawn_server.models import BrowserDevice

    async with get_sessionmaker()() as session:
        device = await session.get(BrowserDevice, introducer_id)
        device.revoked_at = datetime.now(UTC)
        await session.commit()

    # Withheld from GET (fail-closed) …
    assert (await client.get(STORE, headers=auth)).json() == []
    # … and refused as a publisher.
    refused = await client.post(STORE, json=body, headers=auth)
    assert refused.status_code == 409


async def test_rows_are_per_account(client):
    user_a, auth_a = await _signup(client, "root-intro-a@example.com")
    introducer_id, introducer_key = await _register_device(client, auth_a, user_a)
    root_public = Ed25519PrivateKey.generate().public_key().public_bytes_raw()
    body = _intro_body(user_a, introducer_id, introducer_key, root_public)
    assert (await client.post(STORE, json=body, headers=auth_a)).status_code == 200

    _, auth_b = await _signup(client, "root-intro-b@example.com")
    assert (await client.get(STORE, headers=auth_b)).json() == []
    # And publishing against another account's device is not found.
    refused = await client.post(STORE, json=body, headers=auth_b)
    assert refused.status_code == 404
