"""Browser-to-browser add-device SAS ceremony relay (device mesh stage 3b).

The server is a dumb relay: it carries the committed-ephemeral SAS moves between
two of the account's browsers and enforces move ordering, but never computes the
number. These tests drive a full ceremony and confirm the relayed values let both
sides derive the same SAS, plus the ordering / set-once / ownership guards.
"""

from __future__ import annotations

import base64
import hashlib
import os

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server.db import get_sessionmaker

pytestmark = pytest.mark.anyio

PAIRING = "/api/trust/pairing"


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup", json={"email": email, "password": "correcthorse"}
    )
    assert response.status_code == 200
    body = response.json()
    return body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"}


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _wire(key: Ed25519PrivateKey) -> str:
    return _b64u(key.public_key().public_bytes_raw())


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


# Mirrors daemon/src/sas.rs and web/src/lib/sas.ts (asserted here so the relay
# test also cross-checks the SAS derivation the browsers will run).
def _commit(key: bytes, nonce: bytes) -> bytes:
    return hashlib.sha256(b"SPAWN-SAS-COMMIT-V1" + key + nonce).digest()


def _sas(host_key: bytes, browser_key: bytes, host_nonce: bytes, browser_nonce: bytes) -> str:
    digest = hashlib.sha256(
        b"SPAWN-SAS-V1" + host_key + browser_key + host_nonce + browser_nonce
    ).digest()
    n = int.from_bytes(digest[:4], "big") % 1_000_000
    s = f"{n:06d}"
    return f"{s[:3]} {s[3:]}"


async def test_full_ceremony_lets_both_sides_derive_the_same_sas(client):
    user_id, auth = await _signup(client, "pair-happy@example.com")
    initiator_id, initiator_key = await _add_device(user_id)
    joiner_id, joiner_key = await _add_device(user_id)

    k_i = initiator_key.public_key().public_bytes_raw()
    k_j = joiner_key.public_key().public_bytes_raw()
    n_i, n_j = os.urandom(32), os.urandom(32)

    # Move 1 — initiator commits to N_I (does not send it yet).
    started = await client.post(
        PAIRING,
        json={
            "initiator_device_id": initiator_id,
            "joiner_device_id": joiner_id,
            "initiator_public_key": _b64u(k_i),
            "initiator_commit": _b64u(_commit(k_i, n_i)),
        },
        headers=auth,
    )
    assert started.status_code == 200, started.text
    pairing_id = started.json()["id"]

    # The joiner discovers the invitation by polling for its device id.
    discovered = await client.get(PAIRING, params={"device_id": joiner_id}, headers=auth)
    assert discovered.status_code == 200
    invite = discovered.json()[0]
    assert invite["id"] == pairing_id
    assert invite["initiator_public_key"] == _b64u(k_i)
    assert invite["joiner_nonce"] is None  # nothing revealed yet

    # Move 2 — joiner contributes K_J and N_J.
    contributed = await client.post(
        f"{PAIRING}/{pairing_id}/contribute",
        json={"joiner_public_key": _b64u(k_j), "joiner_nonce": _b64u(n_j)},
        headers=auth,
    )
    assert contributed.status_code == 200, contributed.text
    assert contributed.json()["initiator_nonce"] is None  # still not revealed

    # Move 3 — initiator opens its commitment.
    revealed = await client.post(
        f"{PAIRING}/{pairing_id}/reveal",
        json={"initiator_nonce": _b64u(n_i)},
        headers=auth,
    )
    assert revealed.status_code == 200, revealed.text
    state = revealed.json()

    # The joiner re-fetches and verifies the commitment opens to the revealed N_I.
    joiner_view = (await client.get(PAIRING, params={"device_id": joiner_id}, headers=auth)).json()[
        0
    ]
    opened_nonce = base64.urlsafe_b64decode(joiner_view["initiator_nonce"] + "=")
    assert _commit(k_i, opened_nonce) == _commit(k_i, n_i)  # commitment opens

    # Both sides now hold K_I, K_J, N_I, N_J and derive the identical number.
    initiator_sas = _sas(k_i, k_j, n_i, n_j)
    joiner_sas = _sas(
        base64.urlsafe_b64decode(joiner_view["initiator_public_key"] + "="),
        k_j,
        opened_nonce,
        base64.urlsafe_b64decode(joiner_view["joiner_nonce"] + "="),
    )
    assert initiator_sas == joiner_sas
    assert state["joiner_public_key"] == _b64u(k_j)


async def test_reveal_before_contribute_is_rejected(client):
    user_id, auth = await _signup(client, "pair-order@example.com")
    initiator_id, initiator_key = await _add_device(user_id)
    joiner_id, _ = await _add_device(user_id)
    k_i = initiator_key.public_key().public_bytes_raw()
    n_i = os.urandom(32)
    started = await client.post(
        PAIRING,
        json={
            "initiator_device_id": initiator_id,
            "joiner_device_id": joiner_id,
            "initiator_public_key": _b64u(k_i),
            "initiator_commit": _b64u(_commit(k_i, n_i)),
        },
        headers=auth,
    )
    pairing_id = started.json()["id"]
    # Opening before the joiner has contributed would let a relay learn N_I early.
    early = await client.post(
        f"{PAIRING}/{pairing_id}/reveal", json={"initiator_nonce": _b64u(n_i)}, headers=auth
    )
    assert early.status_code == 409


async def _start(client, auth, initiator_id, initiator_key, joiner_id):
    k_i = initiator_key.public_key().public_bytes_raw()
    n_i = os.urandom(32)
    started = await client.post(
        PAIRING,
        json={
            "initiator_device_id": initiator_id,
            "joiner_device_id": joiner_id,
            "initiator_public_key": _b64u(k_i),
            "initiator_commit": _b64u(_commit(k_i, n_i)),
        },
        headers=auth,
    )
    return started.json()["id"], n_i


async def test_contribute_and_reveal_are_set_once(client):
    user_id, auth = await _signup(client, "pair-setonce@example.com")
    initiator_id, initiator_key = await _add_device(user_id)
    joiner_id, joiner_key = await _add_device(user_id)
    pairing_id, n_i = await _start(client, auth, initiator_id, initiator_key, joiner_id)
    k_j = joiner_key.public_key().public_bytes_raw()

    body = {"joiner_public_key": _b64u(k_j), "joiner_nonce": _b64u(os.urandom(32))}
    assert (
        await client.post(f"{PAIRING}/{pairing_id}/contribute", json=body, headers=auth)
    ).status_code == 200
    # A second contribution would let a relay swap N_J after seeing N_I.
    assert (
        await client.post(f"{PAIRING}/{pairing_id}/contribute", json=body, headers=auth)
    ).status_code == 409

    reveal = {"initiator_nonce": _b64u(n_i)}
    assert (
        await client.post(f"{PAIRING}/{pairing_id}/reveal", json=reveal, headers=auth)
    ).status_code == 200
    assert (
        await client.post(f"{PAIRING}/{pairing_id}/reveal", json=reveal, headers=auth)
    ).status_code == 409


async def test_self_pairing_is_rejected(client):
    user_id, auth = await _signup(client, "pair-self@example.com")
    device_id, key = await _add_device(user_id)
    k = key.public_key().public_bytes_raw()
    response = await client.post(
        PAIRING,
        json={
            "initiator_device_id": device_id,
            "joiner_device_id": device_id,
            "initiator_public_key": _b64u(k),
            "initiator_commit": _b64u(_commit(k, os.urandom(32))),
        },
        headers=auth,
    )
    assert response.status_code == 422


async def test_pairing_a_foreign_device_is_not_found(client):
    user_id, auth = await _signup(client, "pair-owner@example.com")
    other_id, _ = await _signup(client, "pair-other@example.com")
    initiator_id, initiator_key = await _add_device(user_id)
    foreign_id, _ = await _add_device(other_id)
    k_i = initiator_key.public_key().public_bytes_raw()
    response = await client.post(
        PAIRING,
        json={
            "initiator_device_id": initiator_id,
            "joiner_device_id": foreign_id,
            "initiator_public_key": _b64u(k_i),
            "initiator_commit": _b64u(_commit(k_i, os.urandom(32))),
        },
        headers=auth,
    )
    assert response.status_code == 404


async def test_cancel_removes_the_pairing(client):
    user_id, auth = await _signup(client, "pair-cancel@example.com")
    initiator_id, initiator_key = await _add_device(user_id)
    joiner_id, _ = await _add_device(user_id)
    pairing_id, _ = await _start(client, auth, initiator_id, initiator_key, joiner_id)

    assert (await client.delete(f"{PAIRING}/{pairing_id}", headers=auth)).status_code == 200
    assert (await client.get(PAIRING, params={"device_id": joiner_id}, headers=auth)).json() == []
    # A second cancel is a 404 (already gone).
    assert (await client.delete(f"{PAIRING}/{pairing_id}", headers=auth)).status_code == 404


async def test_pairing_list_is_account_scoped(client):
    user_id, auth = await _signup(client, "pair-scope-a@example.com")
    _, other_auth = await _signup(client, "pair-scope-b@example.com")
    initiator_id, initiator_key = await _add_device(user_id)
    joiner_id, _ = await _add_device(user_id)
    await _start(client, auth, initiator_id, initiator_key, joiner_id)
    # Another account querying the same device id sees nothing.
    scoped = await client.get(PAIRING, params={"device_id": joiner_id}, headers=other_auth)
    assert scoped.json() == []
