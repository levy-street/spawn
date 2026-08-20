"""Account root as a server-side browser_device (device mesh stage 5b).

pk_R is stored as a browser_device marked is_root, reusing registration, the
endorsement store, and pin/anchor delivery. A root only ENDORSES (R→d) and
anchors; it never connects, is never endorsed, and never pairs.
"""

from __future__ import annotations

import base64
import hashlib
import os

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from spawn_server.acct_endorsement import encode_acct_endorsement_transcript
from spawn_server.browser_registration import encode_browser_registration_transcript
from spawn_server.db import get_sessionmaker

pytestmark = pytest.mark.anyio


def _wire(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "correcthorse"})
    b = r.json()
    return b["user"]["id"], {"Authorization": f"Bearer {b['access_token']}"}


async def _register(client, auth, user_id, key: Ed25519PrivateKey, *, is_root: bool = False):
    pub = key.public_key().public_bytes_raw()
    return await client.post(
        "/api/browser-devices/register",
        json={
            "key_algorithm": "ed25519",
            "public_key": _wire(pub),
            "signature": _wire(key.sign(encode_browser_registration_transcript(user_id, pub))),
            "is_root": is_root,
        },
        headers=auth,
    )


async def _add_device(user_id: str) -> tuple[str, Ed25519PrivateKey]:
    from spawn_server.models import BrowserDevice

    key = Ed25519PrivateKey.generate()
    async with get_sessionmaker()() as session:
        device = BrowserDevice(
            owner_user_id=user_id,
            key_algorithm="ed25519",
            public_key=_wire(key.public_key().public_bytes_raw()),
        )
        session.add(device)
        await session.flush()
        device_id = device.id
        await session.commit()
    return device_id, key


async def test_root_registers_and_is_marked(client):
    user_id, auth = await _signup(client, "root-reg@example.com")
    resp = await _register(client, auth, user_id, Ed25519PrivateKey.generate(), is_root=True)
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_root"] is True
    # A plain device registers with is_root false by default.
    plain = await _register(client, auth, user_id, Ed25519PrivateKey.generate())
    assert plain.json()["is_root"] is False


async def test_only_one_root_per_account(client):
    user_id, auth = await _signup(client, "root-dup@example.com")
    assert (
        await _register(client, auth, user_id, Ed25519PrivateKey.generate(), is_root=True)
    ).status_code == 200
    second = await _register(client, auth, user_id, Ed25519PrivateKey.generate(), is_root=True)
    assert second.status_code == 409


async def test_root_endorses_a_device(client):
    # R→d: the healing/recovery edge — the root vouches for a device's key.
    user_id, auth = await _signup(client, "root-endorse@example.com")
    root = Ed25519PrivateKey.generate()
    root_id = (await _register(client, auth, user_id, root, is_root=True)).json()["id"]
    device_id, device_key = await _add_device(user_id)

    transcript = encode_acct_endorsement_transcript(
        user_id,
        root.public_key().public_bytes_raw(),
        device_key.public_key().public_bytes_raw(),
        device_id,
    )
    resp = await client.post(
        "/api/trust/account-endorsements",
        json={
            "endorser_device_id": root_id,
            "endorsed_device_id": device_id,
            "signature": _wire(root.sign(transcript)),
        },
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    edges = (await client.get("/api/trust/account-endorsements", headers=auth)).json()
    assert any(
        e["endorser_device_id"] == root_id and e["endorsed_device_id"] == device_id for e in edges
    )


async def test_the_root_cannot_be_endorsed(client):
    user_id, auth = await _signup(client, "root-noendorse@example.com")
    root = Ed25519PrivateKey.generate()
    root_id = (await _register(client, auth, user_id, root, is_root=True)).json()["id"]
    device_id, device_key = await _add_device(user_id)

    transcript = encode_acct_endorsement_transcript(
        user_id,
        device_key.public_key().public_bytes_raw(),
        root.public_key().public_bytes_raw(),
        root_id,
    )
    resp = await client.post(
        "/api/trust/account-endorsements",
        json={
            "endorser_device_id": device_id,
            "endorsed_device_id": root_id,
            "signature": _wire(device_key.sign(transcript)),
        },
        headers=auth,
    )
    assert resp.status_code == 422


async def test_anchor_upgrade_pins_the_root_on_a_host(client):
    """The 5c anchor upgrade end-to-end over HTTP: an already-pinned device
    endorses the ROOT onto a host through the ordinary per-host endorsement
    route; the pin set delivered to the daemon then contains pk_R, and it stays
    live after the endorsing device is revoked (the ratchet)."""

    from spawn_server.browser_endorsement import encode_browser_endorsement_transcript
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, HostBrowserPin
    from spawn_server.ws.daemon import _live_browser_pins

    user_id, auth = await _signup(client, "root-anchor@example.com")
    device_key = Ed25519PrivateKey.generate()
    device_id = (await _register(client, auth, user_id, device_key)).json()["id"]
    root_key = Ed25519PrivateKey.generate()
    root_id = (await _register(client, auth, user_id, root_key, is_root=True)).json()["id"]

    host_key = Ed25519PrivateKey.generate()
    host_pub = _wire(host_key.public_key().public_bytes_raw())
    async with get_sessionmaker()() as session:
        host = Host(
            name="anchor-box",
            owner_user_id=user_id,
            host_key_algorithm="ed25519",
            host_public_key=host_pub,
        )
        session.add(host)
        await session.flush()
        # The endorsing device is directly pinned, as after a possess ceremony.
        session.add(
            HostBrowserPin(
                host_id=host.id,
                browser_device_id=device_id,
                browser_key_algorithm="ed25519",
                browser_public_key=_wire(device_key.public_key().public_bytes_raw()),
                browser_key_fingerprint="SHA256:" + "e" * 16,
            )
        )
        await session.commit()
        host_id = host.id

    transcript = encode_browser_endorsement_transcript(
        user_id,
        host_key.public_key().public_bytes_raw(),
        device_key.public_key().public_bytes_raw(),
        root_key.public_key().public_bytes_raw(),
        root_id,
    )
    resp = await client.post(
        "/api/trust/endorsements",
        json={
            "host_id": host_id,
            "endorser_device_id": device_id,
            "endorsed_device_id": root_id,
            "signature": _wire(device_key.sign(transcript)),
        },
        headers=auth,
    )
    assert resp.status_code == 200, resp.text

    pins = await _live_browser_pins(host_id)
    assert {row["browser_device_id"] for row in pins} == {device_id, root_id}

    # Revoke the endorsing device: the root's anchor pin must survive it.
    revoke = await client.post(
        f"/api/browser-devices/{device_id}/revoke",
        json={"expected_public_key": _wire(device_key.public_key().public_bytes_raw())},
        headers=auth,
    )
    assert revoke.status_code == 200, revoke.text
    pins = await _live_browser_pins(host_id)
    assert {row["browser_device_id"] for row in pins} == {root_id}


async def test_rename_preserves_is_root(client):
    user_id, auth = await _signup(client, "root-rename@example.com")
    root_id = (
        await _register(client, auth, user_id, Ed25519PrivateKey.generate(), is_root=True)
    ).json()["id"]
    resp = await client.patch(
        f"/api/browser-devices/{root_id}", json={"label": "Account root"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_root"] is True


async def test_the_root_cannot_pair(client):
    user_id, auth = await _signup(client, "root-nopair@example.com")
    root = Ed25519PrivateKey.generate()
    root_id = (await _register(client, auth, user_id, root, is_root=True)).json()["id"]
    device_id, device_key = await _add_device(user_id)

    device_pub = device_key.public_key().public_bytes_raw()
    nonce = os.urandom(32)
    commit = hashlib.sha256(b"SPAWN-SAS-COMMIT-V1" + device_pub + nonce).digest()
    resp = await client.post(
        "/api/trust/pairing",
        json={
            "initiator_device_id": device_id,
            "joiner_device_id": root_id,
            "initiator_public_key": _wire(device_pub),
            "initiator_commit": _wire(commit),
        },
        headers=auth,
    )
    assert resp.status_code == 422
