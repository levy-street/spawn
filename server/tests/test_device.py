"""Key-bound device flow: start → review → approve → one-shot poll."""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from spawn_server.db import get_sessionmaker
from spawn_server.host_identity import host_key_fingerprint
from spawn_server.models import DeviceCode, Host


def _public_key(byte: int = 7) -> str:
    return base64.urlsafe_b64encode(bytes([byte]) * 32).rstrip(b"=").decode("ascii")


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup",
        json={"email": email, "password": "correcthorse"},
    )
    assert response.status_code == 200
    token = response.json()["access_token"]
    return token, {"Authorization": f"Bearer {token}"}


async def _start(client, public_key: str, *, name: str = "gpu-box-1") -> dict:
    response = await client.post(
        "/api/auth/device/start",
        json={
            "host_name": name,
            "os": "linux",
            "arch": "x86_64",
            "version": "0.1.0",
            "host_key_algorithm": "ed25519",
            "host_public_key": public_key,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _poll(client, start: dict, public_key: str):
    return await client.post(
        "/api/auth/device/poll",
        json={
            "device_code": start["device_code"],
            "host_key_algorithm": "ed25519",
            "host_public_key": public_key,
        },
    )


async def _pair(client, auth: dict[str, str], public_key: str, *, name: str = "host") -> dict:
    start = await _start(client, public_key, name=name)
    approval = await client.post(
        "/api/auth/device/approve",
        json={"user_code": start["user_code"]},
        headers=auth,
    )
    assert approval.status_code == 200, approval.text
    poll = await _poll(client, start, public_key)
    assert poll.status_code == 200, poll.text
    assert "access_token" in poll.json(), poll.text
    return poll.json()


async def test_device_code_happy_path_is_key_bound_and_one_shot(client):
    _, auth = await _signup(client, "bob@example.com")
    public_key = _public_key()
    fingerprint = host_key_fingerprint("ed25519", public_key)
    start = await _start(client, public_key)
    assert len(start["user_code"].split("-")) == 2
    assert start["interval"] == 5
    assert start["expires_in"] == 30 * 60

    pending_poll = await _poll(client, start, public_key)
    assert pending_poll.json() == {"error": "authorization_pending"}

    review = await client.post(
        "/api/auth/device/pending",
        json={"user_code": start["user_code"]},
        headers=auth,
    )
    assert review.status_code == 200
    assert review.json() == {
        "host_name": "gpu-box-1",
        "host_key_algorithm": "ed25519",
        "host_public_key": public_key,
        "host_key_fingerprint": fingerprint,
    }

    untrusted_fingerprint = await client.post(
        "/api/auth/device/approve",
        json={"user_code": start["user_code"], "host_key_fingerprint": "attacker-choice"},
        headers=auth,
    )
    assert untrusted_fingerprint.status_code == 422

    approval = await client.post(
        "/api/auth/device/approve",
        json={"user_code": start["user_code"]},
        headers=auth,
    )
    assert approval.status_code == 200
    assert approval.json() == review.json()

    # Move the earlier pending poll outside the rate-limit window.
    async with get_sessionmaker()() as session:
        dc = (
            await session.execute(
                select(DeviceCode).where(DeviceCode.device_code == start["device_code"])
            )
        ).scalar_one()
        dc.last_polled_at = datetime.now(UTC) - timedelta(seconds=10)
        await session.commit()

    poll = await _poll(client, start, public_key)
    assert poll.status_code == 200
    success = poll.json()
    assert success["host_key_algorithm"] == "ed25519"
    assert success["host_public_key"] == public_key
    assert success["host_key_fingerprint"] == fingerprint
    assert "private" not in str(success).lower()
    assert "seed" not in str(success).lower()

    replay = await _poll(client, start, public_key)
    assert replay.json() == {"error": "expired_token"}

    hosts = (await client.get("/api/hosts", headers=auth)).json()
    assert len(hosts) == 1
    assert hosts[0]["id"] == success["host_id"]
    assert hosts[0]["host_public_key"] == public_key
    assert hosts[0]["host_key_fingerprint"] == fingerprint


@pytest.mark.parametrize(
    ("algorithm", "public_key"),
    [
        ("rsa", _public_key()),
        ("ed25519", _public_key() + "="),
        ("ed25519", _public_key()[:-1]),
        ("ed25519", "!" * 43),
        ("ed25519", base64.urlsafe_b64encode(b"short").rstrip(b"=").decode()),
    ],
)
async def test_device_start_rejects_malformed_or_noncanonical_keys(
    client, algorithm: str, public_key: str
):
    response = await client.post(
        "/api/auth/device/start",
        json={
            "host_name": "bad-key",
            "host_key_algorithm": algorithm,
            "host_public_key": public_key,
        },
    )
    assert response.status_code == 422


async def test_legacy_unkeyed_device_client_fails_closed(client):
    response = await client.post(
        "/api/auth/device/start",
        json={"host_name": "legacy", "os": "linux", "arch": "x86_64", "version": "old"},
    )
    assert response.status_code == 422


async def test_duplicate_live_pairing_and_poll_key_change_are_rejected(client):
    public_key = _public_key(8)
    start = await _start(client, public_key)
    duplicate = await client.post(
        "/api/auth/device/start",
        json={
            "host_name": "duplicate",
            "host_key_algorithm": "ed25519",
            "host_public_key": public_key,
        },
    )
    assert duplicate.status_code == 409

    changed = await _poll(client, start, _public_key(9))
    assert changed.json() == {"error": "invalid_device_binding"}


async def test_approval_is_one_shot(client):
    _, auth = await _signup(client, "one-shot@example.com")
    start = await _start(client, _public_key(10))
    first = await client.post(
        "/api/auth/device/approve", json={"user_code": start["user_code"]}, headers=auth
    )
    assert first.status_code == 200
    second = await client.post(
        "/api/auth/device/approve", json={"user_code": start["user_code"]}, headers=auth
    )
    assert second.status_code == 400


async def test_same_owner_relogin_reuses_host_and_cross_user_cannot_claim_key(client):
    _, owner_auth = await _signup(client, "owner@example.com")
    _, other_auth = await _signup(client, "other@example.com")
    public_key = _public_key(11)

    first = await _pair(client, owner_auth, public_key, name="original-name")
    relogin = await _pair(client, owner_auth, public_key, name="must-not-overwrite")
    assert relogin["host_id"] == first["host_id"]

    owner_hosts = (await client.get("/api/hosts", headers=owner_auth)).json()
    assert len(owner_hosts) == 1
    assert owner_hosts[0]["name"] == "original-name"
    immutable = await client.patch(
        f"/api/hosts/{first['host_id']}",
        json={"host_public_key": _public_key(99)},
        headers=owner_auth,
    )
    assert immutable.status_code == 422
    unchanged = (await client.get(f"/api/hosts/{first['host_id']}", headers=owner_auth)).json()
    assert unchanged["host_public_key"] == public_key

    attack = await _start(client, public_key, name="stolen")
    review = await client.post(
        "/api/auth/device/pending",
        json={"user_code": attack["user_code"]},
        headers=other_auth,
    )
    assert review.status_code == 200
    denied = await client.post(
        "/api/auth/device/approve",
        json={"user_code": attack["user_code"]},
        headers=other_auth,
    )
    assert denied.status_code == 409
    assert (await client.get("/api/hosts", headers=other_auth)).json() == []


async def test_revocation_removes_pin_and_old_token_authority(client):
    _, auth = await _signup(client, "revoke@example.com")
    public_key = _public_key(12)
    first = await _pair(client, auth, public_key)

    removed = await client.delete(f"/api/hosts/{first['host_id']}", headers=auth)
    assert removed.status_code == 204
    async with get_sessionmaker()() as session:
        assert await session.get(Host, first["host_id"]) is None
        count = (
            await session.execute(
                select(func.count(Host.id)).where(Host.host_public_key == public_key)
            )
        ).scalar_one()
        assert count == 0

    repaired = await _pair(client, auth, public_key)
    assert repaired["host_id"] != first["host_id"]
