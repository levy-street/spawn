"""Authenticated setup claims route attention without granting host trust."""

from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import select

from spawn_server import rate_limit
from spawn_server.browser_registration import encode_browser_registration_transcript
from spawn_server.db import get_sessionmaker
from spawn_server.host_identity import decode_host_public_key, ed25519_key_fingerprint
from spawn_server.host_pair_approval import (
    decode_approval_nonce,
    encode_host_pair_approval_transcript,
)
from spawn_server.host_pair_possession import (
    decode_device_code,
    encode_host_pair_possession_transcript,
)
from spawn_server.models import DeviceCode, SetupClaim


def _wire(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup",
        json={"email": email, "password": "correcthorse"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    return body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"}


async def _register_browser(client, user_id: str, headers: dict[str, str]):
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes_raw()
    response = await client.post(
        "/api/browser-devices/register",
        json={
            "key_algorithm": "ed25519",
            "public_key": _wire(public),
            "signature": _wire(
                private.sign(encode_browser_registration_transcript(user_id, public, is_root=False))
            ),
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    return response.json(), private


async def _start_and_possess(client, setup_token: str):
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes_raw()
    public_wire = _wire(public)
    start_response = await client.post(
        "/api/auth/device/start",
        json={
            "host_name": "claim-box",
            "os": "linux",
            "arch": "x86_64",
            "version": "0.1.0",
            "host_key_algorithm": "ed25519",
            "host_public_key": public_wire,
            "setup_token": setup_token,
        },
    )
    assert start_response.status_code == 200, start_response.text
    start = start_response.json()
    transcript = encode_host_pair_possession_transcript(
        decode_device_code(start["device_code"]),
        decode_approval_nonce(start["approval_nonce"]),
        public,
    )
    possession = await client.post(
        "/api/auth/device/possession",
        json={
            "device_code": start["device_code"],
            "approval_nonce": start["approval_nonce"],
            "host_key_algorithm": "ed25519",
            "host_public_key": public_wire,
            "signature": _wire(private.sign(transcript)),
        },
    )
    assert possession.status_code == 200, possession.text
    return start, public_wire, possession.json()


async def test_setup_claim_mint_read_is_owner_scoped_and_expires(client):
    _owner_id, owner = await _signup(client, "claim-owner@example.com")
    _other_id, other = await _signup(client, "claim-other@example.com")

    minted = await client.post("/api/setup/claims", json={}, headers=owner)
    assert minted.status_code == 201, minted.text
    body = minted.json()
    assert len(body["token"]) == 43
    assert body["expires_in"] == 1800

    pending = await client.get(f"/api/setup/claims/{body['token']}", headers=owner)
    assert pending.status_code == 200
    assert pending.json() == {
        "status": "pending",
        "approval_ref": None,
        "host_name": None,
        "os": None,
        "host_key_fingerprint": None,
        "host_id": None,
        "error": None,
        "expires_at": body["expires_at"],
    }
    assert (
        await client.get(f"/api/setup/claims/{body['token']}", headers=other)
    ).status_code == 404
    assert (
        await client.get(
            "/api/setup/claims/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", headers=owner
        )
    ).status_code == 404
    assert (
        await client.get(
            "/api/setup/claims/+AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", headers=owner
        )
    ).status_code == 404
    assert (
        await client.post("/api/setup/claims", json={"authority": True}, headers=owner)
    ).status_code == 422

    async with get_sessionmaker()() as session:
        claim = (
            await session.execute(select(SetupClaim).where(SetupClaim.token == body["token"]))
        ).scalar_one()
        claim.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    expired = await client.get(f"/api/setup/claims/{body['token']}", headers=owner)
    assert expired.status_code == 200
    assert expired.json()["status"] == "failed"
    assert expired.json()["error"] == "expired"


async def test_setup_claim_rate_limit_is_per_user(client, monkeypatch):
    _owner_id, owner = await _signup(client, "claim-rate-owner@example.com")
    _other_id, other = await _signup(client, "claim-rate-other@example.com")
    settings = rate_limit.get_settings()
    monkeypatch.setattr(settings, "rate_limit_enabled", True, raising=False)
    rate_limit._local_counters.clear()
    try:
        for _ in range(10):
            assert (
                await client.post("/api/setup/claims", json={}, headers=owner)
            ).status_code == 201
        limited = await client.post("/api/setup/claims", json={}, headers=owner)
        assert limited.status_code == 429
        assert (await client.post("/api/setup/claims", json={}, headers=other)).status_code == 201
    finally:
        rate_limit._local_counters.clear()


async def test_setup_claim_create_prunes_claims_older_than_twenty_four_hours(client):
    owner_id, headers = await _signup(client, "claim-retention@example.com")
    now = datetime.now(UTC)
    old_token = "A" * 43
    async with get_sessionmaker()() as session:
        session.add(
            SetupClaim(
                user_id=owner_id,
                token=old_token,
                status="failed",
                error="expired",
                created_at=now - timedelta(hours=25),
                expires_at=now - timedelta(hours=24),
                resolved_at=now - timedelta(hours=24),
            )
        )
        await session.commit()

    created = await client.post("/api/setup/claims", json={}, headers=headers)
    assert created.status_code == 201
    async with get_sessionmaker()() as session:
        assert (
            await session.execute(select(SetupClaim).where(SetupClaim.token == old_token))
        ).scalar_one_or_none() is None


async def test_setup_claim_state_machine_follows_the_signed_ceremony(client, monkeypatch):
    from spawn_server.routes import device as device_routes

    events: list[dict[str, object]] = []

    async def capture_event(_owner_id: str, payload: dict[str, object]) -> None:
        events.append(payload)

    monkeypatch.setattr(device_routes, "publish_trust_event", capture_event)
    user_id, headers = await _signup(client, "claim-ceremony@example.com")
    browser, browser_private = await _register_browser(client, user_id, headers)
    minted = (await client.post("/api/setup/claims", json={}, headers=headers)).json()

    start, host_public, possession = await _start_and_possess(client, minted["token"])
    assert possession["attended"] is True
    ready = await client.get(f"/api/setup/claims/{minted['token']}", headers=headers)
    assert ready.status_code == 200
    assert ready.json()["status"] == "ready"
    assert ready.json()["approval_ref"] == start["approval_ref"]
    assert ready.json()["host_name"] == "claim-box"
    assert ready.json()["os"] == "linux"
    assert ready.json()["host_key_fingerprint"].startswith("SHA256:")

    review = await client.post(
        "/api/auth/device/pending",
        json={"approval_ref": start["approval_ref"]},
        headers=headers,
    )
    assert review.status_code == 200, review.text
    reviewed = review.json()
    transcript = encode_host_pair_approval_transcript(
        user_id,
        decode_approval_nonce(reviewed["approval_nonce"]),
        decode_host_public_key("ed25519", reviewed["host_public_key"]),
        browser_private.public_key().public_bytes_raw(),
    )
    approval = await client.post(
        "/api/auth/device/approve",
        json={
            "approval_ref": start["approval_ref"],
            "approval_nonce": reviewed["approval_nonce"],
            "host_key_algorithm": "ed25519",
            "host_public_key": reviewed["host_public_key"],
            "host_key_fingerprint": reviewed["host_key_fingerprint"],
            "browser_device_id": browser["id"],
            "browser_key_algorithm": "ed25519",
            "browser_public_key": browser["public_key"],
            "browser_key_fingerprint": ed25519_key_fingerprint(browser["public_key"]),
            "signature": _wire(browser_private.sign(transcript)),
        },
        headers=headers,
    )
    assert approval.status_code == 200, approval.text

    poll = await client.post(
        "/api/auth/device/poll",
        json={
            "device_code": start["device_code"],
            "host_key_algorithm": "ed25519",
            "host_public_key": host_public,
        },
    )
    assert poll.status_code == 200, poll.text
    assert "access_token" in poll.json()

    approved = await client.get(f"/api/setup/claims/{minted['token']}", headers=headers)
    assert approved.status_code == 200
    assert approved.json()["status"] == "approved"
    assert approved.json()["host_id"] == poll.json()["host_id"]
    assert approved.json()["error"] is None
    assert [event["event"] for event in events] == [
        "host.pair_requested",
        "host.pair_resolved",
    ]
    assert events[-1]["outcome"] == "approved"
    assert events[-1]["host_id"] == poll.json()["host_id"]


async def test_bound_setup_claim_fails_when_its_ceremony_expires(client, monkeypatch):
    from spawn_server.routes import device as device_routes

    _user_id, headers = await _signup(client, "claim-bound-expiry@example.com")
    minted = (await client.post("/api/setup/claims", json={}, headers=headers)).json()
    start, host_public, possession = await _start_and_possess(client, minted["token"])
    assert possession["attended"] is True
    events: list[dict[str, object]] = []

    async def capture_event(_owner_id: str, payload: dict[str, object]) -> None:
        events.append(payload)

    monkeypatch.setattr(device_routes, "publish_trust_event", capture_event)
    async with get_sessionmaker()() as session:
        code = await session.get(DeviceCode, start["device_code"])
        assert code is not None
        code.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()

    poll = await client.post(
        "/api/auth/device/poll",
        json={
            "device_code": start["device_code"],
            "host_key_algorithm": "ed25519",
            "host_public_key": host_public,
        },
    )
    assert poll.status_code == 200
    assert poll.json() == {"error": "expired_token"}
    failed = await client.get(f"/api/setup/claims/{minted['token']}", headers=headers)
    assert failed.json()["status"] == "failed"
    assert failed.json()["error"] == "expired"
    assert [event["event"] for event in events] == ["host.pair_resolved"]
    assert events[0]["outcome"] == "expired"


async def test_bound_setup_claim_observes_a_denied_terminal_ceremony(client, monkeypatch):
    from spawn_server.routes import device as device_routes

    _user_id, headers = await _signup(client, "claim-denied@example.com")
    minted = (await client.post("/api/setup/claims", json={}, headers=headers)).json()
    start, host_public, possession = await _start_and_possess(client, minted["token"])
    assert possession["attended"] is True
    events: list[dict[str, object]] = []

    async def capture_event(_owner_id: str, payload: dict[str, object]) -> None:
        events.append(payload)

    monkeypatch.setattr(device_routes, "publish_trust_event", capture_event)
    async with get_sessionmaker()() as session:
        code = await session.get(DeviceCode, start["device_code"])
        assert code is not None
        code.status = "denied"
        await session.commit()

    poll = await client.post(
        "/api/auth/device/poll",
        json={
            "device_code": start["device_code"],
            "host_key_algorithm": "ed25519",
            "host_public_key": host_public,
        },
    )
    assert poll.status_code == 200
    assert poll.json() == {"error": "denied"}
    failed = await client.get(f"/api/setup/claims/{minted['token']}", headers=headers)
    assert failed.json()["status"] == "failed"
    assert failed.json()["error"] == "denied"
    assert [event["event"] for event in events] == ["host.pair_resolved"]
    assert events[0]["outcome"] == "denied"
