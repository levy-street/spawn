"""Key-bound device flow: start → review → approve → one-shot poll."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import HTTPException
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from spawn_server import auth as server_auth
from spawn_server.browser_registration import encode_browser_registration_transcript
from spawn_server.db import get_sessionmaker
from spawn_server.host_identity import (
    decode_host_public_key,
    ed25519_key_fingerprint,
    host_key_fingerprint,
)
from spawn_server.host_pair_approval import (
    decode_approval_nonce,
    encode_host_pair_approval_transcript,
)
from spawn_server.host_pair_possession import (
    decode_device_code,
    encode_host_pair_possession_transcript,
)
from spawn_server.models import (
    BrowserDevice,
    DeviceCode,
    Host,
    HostBrowserPin,
    HostKeyClaim,
    User,
)
from spawn_server.routes import device as device_routes

_KEY_VECTORS = json.loads(
    (Path(__file__).parents[2] / "proto" / "ed25519-public-key-negative-vectors.json").read_text()
)
_ACCEPTED_PUBLIC_KEY_HEX: list[str] = _KEY_VECTORS["accepted_mixed_torsion_public_key_hex"]
_STRICT_NEGATIVE_KEYS = [
    *[(f"weak-{item['id']}", item["public_key_hex"]) for item in _KEY_VECTORS["weak_public_keys"]],
    *[
        (f"noncanonical-{index}", public_key_hex)
        for index, public_key_hex in enumerate(_KEY_VECTORS["noncanonical_public_key_hex"])
    ],
    *[
        (f"invalid-{item['id']}", item["public_key_hex"])
        for item in _KEY_VECTORS["invalid_encodings"]
    ],
]


def _encoded_hex(public_key_hex: str) -> str:
    return base64.urlsafe_b64encode(bytes.fromhex(public_key_hex)).rstrip(b"=").decode("ascii")


def _public_key(byte: int = 7) -> str:
    return _encoded_hex(_ACCEPTED_PUBLIC_KEY_HEX[byte % len(_ACCEPTED_PUBLIC_KEY_HEX)])


async def _signup(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup",
        json={"email": email, "password": "correcthorse"},
    )
    assert response.status_code == 200
    body = response.json()
    token = body["access_token"]
    return body["user"]["id"], {"Authorization": f"Bearer {token}"}


def _wire(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


async def _register_browser(client, user_id: str, auth: dict[str, str]):
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes_raw()
    public_wire = _wire(public_key)
    response = await client.post(
        "/api/browser-devices/register",
        json={
            "key_algorithm": "ed25519",
            "public_key": public_wire,
            "signature": _wire(
                private_key.sign(encode_browser_registration_transcript(user_id, public_key))
            ),
        },
        headers=auth,
    )
    assert response.status_code == 200, response.text
    return response.json(), private_key


async def _revoke_browser(client, auth: dict[str, str], device: dict):
    response = await client.post(
        f"/api/browser-devices/{device['id']}/revoke",
        json={"expected_public_key": device["public_key"]},
        headers=auth,
    )
    assert response.status_code == 200, response.text
    return response.json()


async def _mark_possession_verified(device_code: str) -> None:
    async with get_sessionmaker()() as session:
        dc = await session.get(DeviceCode, device_code)
        assert dc is not None
        dc.host_possession_version = 1
        dc.host_possession_verified_at = datetime.now(UTC)
        await session.commit()


async def _start(
    client,
    public_key: str,
    *,
    name: str = "gpu-box-1",
    proved: bool = True,
) -> dict:
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
    start = response.json()
    if proved:
        # Most existing device-flow tests use the shared accepted-point corpus,
        # whose private scalars are deliberately unavailable. Dedicated proof
        # tests below exercise the real endpoint with generated signing keys.
        await _mark_possession_verified(start["device_code"])
    return start


async def _prove_possession(client, start: dict, private_key: Ed25519PrivateKey):
    public_key = private_key.public_key().public_bytes_raw()
    transcript = encode_host_pair_possession_transcript(
        decode_device_code(start["device_code"]),
        decode_approval_nonce(start["approval_nonce"]),
        public_key,
    )
    return await client.post(
        "/api/auth/device/possession",
        json={
            "device_code": start["device_code"],
            "approval_nonce": start["approval_nonce"],
            "host_key_algorithm": "ed25519",
            "host_public_key": _wire(public_key),
            "signature": _wire(private_key.sign(transcript)),
        },
    )


async def _poll(client, start: dict, public_key: str):
    return await client.post(
        "/api/auth/device/poll",
        json={
            "device_code": start["device_code"],
            "host_key_algorithm": "ed25519",
            "host_public_key": public_key,
        },
    )


async def _review(client, start: dict, auth: dict[str, str]) -> dict:
    response = await client.post(
        "/api/auth/device/pending",
        json={"user_code": start["user_code"]},
        headers=auth,
    )
    assert response.status_code == 200, response.text
    return response.json()


def _approval_body(
    start: dict,
    review: dict,
    user_id: str,
    browser: tuple[dict, Ed25519PrivateKey],
) -> dict:
    device, private_key = browser
    transcript = encode_host_pair_approval_transcript(
        user_id,
        decode_approval_nonce(review["approval_nonce"]),
        decode_host_public_key("ed25519", review["host_public_key"]),
        private_key.public_key().public_bytes_raw(),
    )
    return {
        "user_code": start["user_code"],
        "approval_nonce": review["approval_nonce"],
        "host_key_algorithm": review["host_key_algorithm"],
        "host_public_key": review["host_public_key"],
        "host_key_fingerprint": review["host_key_fingerprint"],
        "browser_device_id": device["id"],
        "browser_key_algorithm": device["key_algorithm"],
        "browser_public_key": device["public_key"],
        "browser_key_fingerprint": device["fingerprint"],
        "signature": _wire(private_key.sign(transcript)),
    }


async def _approve(
    client,
    start: dict,
    user_id: str,
    auth: dict[str, str],
    review: dict,
    browser: tuple[dict, Ed25519PrivateKey],
):
    return await client.post(
        "/api/auth/device/approve",
        json=_approval_body(start, review, user_id, browser),
        headers=auth,
    )


async def _pair(
    client,
    user_id: str,
    auth: dict[str, str],
    browser: tuple[dict, Ed25519PrivateKey],
    public_key: str,
    *,
    name: str = "host",
) -> dict:
    start = await _start(client, public_key, name=name)
    review = await _review(client, start, auth)
    approval = await _approve(client, start, user_id, auth, review, browser)
    assert approval.status_code == 200, approval.text
    poll = await _poll(client, start, public_key)
    assert poll.status_code == 200, poll.text
    assert "access_token" in poll.json(), poll.text
    return poll.json()


async def test_device_code_happy_path_is_key_bound_and_one_shot(client):
    user_id, auth = await _signup(client, "bob@example.com")
    browser = await _register_browser(client, user_id, auth)
    public_key = _public_key()
    fingerprint = host_key_fingerprint("ed25519", public_key)
    start = await _start(client, public_key)
    assert len(start["user_code"].split("-")) == 2
    assert start["interval"] == 5
    assert start["expires_in"] == 30 * 60

    pending_poll = await _poll(client, start, public_key)
    assert pending_poll.json() == {"error": "authorization_pending"}

    review = await _review(client, start, auth)
    assert review == {
        "host_name": "gpu-box-1",
        "approval_nonce": review["approval_nonce"],
        "host_key_algorithm": "ed25519",
        "host_public_key": public_key,
        "host_key_fingerprint": fingerprint,
    }

    untrusted_fingerprint = await client.post(
        "/api/auth/device/approve",
        json={
            **_approval_body(start, review, user_id, browser),
            "host_key_fingerprint": "attacker-choice",
        },
        headers=auth,
    )
    assert untrusted_fingerprint.status_code == 422

    unbound_approval = await client.post(
        "/api/auth/device/approve",
        json={"user_code": start["user_code"]},
        headers=auth,
    )
    assert unbound_approval.status_code == 422

    approval = await _approve(client, start, user_id, auth, review, browser)
    assert approval.status_code == 200
    assert approval.json() == {
        **review,
        "browser_device_id": browser[0]["id"],
        "browser_key_algorithm": "ed25519",
        "browser_public_key": browser[0]["public_key"],
        "browser_key_fingerprint": browser[0]["fingerprint"],
    }

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
    assert success["browser_device_id"] == browser[0]["id"]
    assert success["browser_public_key"] == browser[0]["public_key"]
    assert "private" not in str(success).lower()
    assert "seed" not in str(success).lower()

    replay = await _poll(client, start, public_key)
    assert replay.json() == {"error": "expired_token"}

    hosts = (await client.get("/api/hosts", headers=auth)).json()
    assert len(hosts) == 1
    assert hosts[0]["id"] == success["host_id"]
    assert hosts[0]["host_public_key"] == public_key
    assert hosts[0]["host_key_fingerprint"] == fingerprint

    async with get_sessionmaker()() as session:
        pin = await session.get(HostBrowserPin, (success["host_id"], browser[0]["id"]))
        assert pin is not None
        assert pin.browser_public_key == browser[0]["public_key"]
        assert pin.browser_key_fingerprint == browser[0]["fingerprint"]


async def test_host_possession_is_required_before_review_approval_or_token_issue(client):
    user_id, auth = await _signup(client, "host-possession-required@example.com")
    browser = await _register_browser(client, user_id, auth)
    host_private_key = Ed25519PrivateKey.generate()
    public_key = _wire(host_private_key.public_key().public_bytes_raw())
    start = await _start(client, public_key, name="proved-host", proved=False)
    untrusted_review = {
        "host_name": "proved-host",
        "approval_nonce": start["approval_nonce"],
        "host_key_algorithm": "ed25519",
        "host_public_key": public_key,
        "host_key_fingerprint": host_key_fingerprint("ed25519", public_key),
    }

    pending = await client.post(
        "/api/auth/device/pending",
        json={"user_code": start["user_code"]},
        headers=auth,
    )
    assert pending.status_code == 409
    assert "possession proof" in pending.json()["detail"]
    blocked_approval = await _approve(
        client,
        start,
        user_id,
        auth,
        untrusted_review,
        browser,
    )
    assert blocked_approval.status_code == 409
    assert (await _poll(client, start, public_key)).json() == {
        "error": "authorization_pending"
    }
    async with get_sessionmaker()() as session:
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 0
        assert (
            await session.execute(select(func.count(HostKeyClaim.host_public_key)))
        ).scalar_one() == 0
        assert (
            await session.execute(select(func.count(HostBrowserPin.host_id)))
        ).scalar_one() == 0

    proof = await _prove_possession(client, start, host_private_key)
    assert proof.status_code == 200, proof.text
    assert proof.json() == {"verified": True, "version": 1}
    retry = await _prove_possession(client, start, host_private_key)
    assert retry.status_code == 200, retry.text
    assert retry.json() == proof.json()

    review = await _review(client, start, auth)
    approval = await _approve(client, start, user_id, auth, review, browser)
    assert approval.status_code == 200, approval.text
    poll = await _poll(client, start, public_key)
    assert poll.status_code == 200, poll.text
    assert "access_token" in poll.json()
    assert "signature" not in str(proof.json()).lower()
    assert "private" not in str(start).lower()


def _possession_request(
    start: dict,
    host_private_key: Ed25519PrivateKey,
    *,
    device_code: str | None = None,
    approval_nonce: str | None = None,
    host_public_key: str | None = None,
) -> dict:
    device_code = device_code or start["device_code"]
    approval_nonce = approval_nonce or start["approval_nonce"]
    public_bytes = host_private_key.public_key().public_bytes_raw()
    transcript = encode_host_pair_possession_transcript(
        decode_device_code(start["device_code"]),
        decode_approval_nonce(start["approval_nonce"]),
        public_bytes,
    )
    return {
        "device_code": device_code,
        "approval_nonce": approval_nonce,
        "host_key_algorithm": "ed25519",
        "host_public_key": host_public_key or _wire(public_bytes),
        "signature": _wire(host_private_key.sign(transcript)),
    }


async def test_possession_proof_rejects_binding_substitution_and_cross_ceremony_replay(client):
    host_private_key = Ed25519PrivateKey.generate()
    public_key = _wire(host_private_key.public_key().public_bytes_raw())
    first = await _start(client, public_key, proved=False)
    second = await _start(client, public_key, proved=False)
    valid_first = _possession_request(first, host_private_key)

    changed_code = bytearray(decode_device_code(first["device_code"]))
    changed_code[0] ^= 1
    wrong_code = await client.post(
        "/api/auth/device/possession",
        json={**valid_first, "device_code": _wire(changed_code)},
    )
    assert wrong_code.status_code == 422

    changed_nonce = bytearray(decode_approval_nonce(first["approval_nonce"]))
    changed_nonce[0] ^= 1
    wrong_nonce = await client.post(
        "/api/auth/device/possession",
        json={**valid_first, "approval_nonce": _wire(changed_nonce)},
    )
    assert wrong_nonce.status_code == 422

    wrong_private_key = Ed25519PrivateKey.generate()
    wrong_key = await client.post(
        "/api/auth/device/possession",
        json={
            **valid_first,
            "host_public_key": _wire(wrong_private_key.public_key().public_bytes_raw()),
        },
    )
    assert wrong_key.status_code == 422

    cross_ceremony = await client.post(
        "/api/auth/device/possession",
        json={
            **valid_first,
            "device_code": second["device_code"],
            "approval_nonce": second["approval_nonce"],
        },
    )
    assert cross_ceremony.status_code == 422

    async with get_sessionmaker()() as session:
        for start in (first, second):
            dc = await session.get(DeviceCode, start["device_code"])
            assert dc is not None
            assert dc.host_possession_version is None
            assert dc.host_possession_verified_at is None


async def test_possession_proof_rejects_malformed_high_s_invalid_r_and_expiry(client):
    host_private_key = Ed25519PrivateKey.generate()
    public_key = _wire(host_private_key.public_key().public_bytes_raw())
    start = await _start(client, public_key, proved=False)
    valid = _possession_request(start, host_private_key)
    signature = bytearray(base64.urlsafe_b64decode(valid["signature"] + "=="))
    ed25519_order = 2**252 + 27742317777372353535851937790883648493
    high_s = bytes(signature[:32]) + ed25519_order.to_bytes(32, "little")
    invalid_r = bytes([0xFF] * 32) + bytes(signature[32:])

    for rejected_signature in (
        valid["signature"][:-1],
        valid["signature"] + "=",
        _wire(high_s),
        _wire(invalid_r),
    ):
        rejected = await client.post(
            "/api/auth/device/possession",
            json={**valid, "signature": rejected_signature},
        )
        assert rejected.status_code == 422, rejected.text

    async with get_sessionmaker()() as session:
        dc = await session.get(DeviceCode, start["device_code"])
        assert dc is not None
        dc.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()
    expired = await client.post("/api/auth/device/possession", json=valid)
    assert expired.status_code == 400
    assert "expired" in expired.json()["detail"]
    async with get_sessionmaker()() as session:
        dc = await session.get(DeviceCode, start["device_code"])
        assert dc is not None
        assert dc.host_possession_version is None
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 0


async def _assert_concurrent_possession_retries_are_idempotent(
    client,
    *,
    public_key: str,
    host_private_key: Ed25519PrivateKey,
) -> None:
    start = await _start(client, public_key, proved=False)
    responses = await asyncio.gather(
        *(_prove_possession(client, start, host_private_key) for _ in range(16))
    )
    assert [(response.status_code, response.json()) for response in responses] == [
        (200, {"verified": True, "version": 1})
    ] * 16
    async with get_sessionmaker()() as session:
        dc = await session.get(DeviceCode, start["device_code"])
        assert dc is not None
        assert dc.host_possession_version == 1
        assert dc.host_possession_verified_at is not None


async def test_file_sqlite_concurrent_possession_retries_are_idempotent(file_sqlite_client):
    private_key = Ed25519PrivateKey.generate()
    await _assert_concurrent_possession_retries_are_idempotent(
        file_sqlite_client,
        public_key=_wire(private_key.public_key().public_bytes_raw()),
        host_private_key=private_key,
    )


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires independent PostgreSQL transactions",
)
async def test_postgresql_concurrent_possession_retries_are_idempotent(client):
    private_key = Ed25519PrivateKey.generate()
    await _assert_concurrent_possession_retries_are_idempotent(
        client,
        public_key=_wire(private_key.public_key().public_bytes_raw()),
        host_private_key=private_key,
    )


async def _assert_host_possession_state_constraint(client) -> None:
    private_key = Ed25519PrivateKey.generate()
    public_key = _wire(private_key.public_key().public_bytes_raw())
    start = await _start(client, public_key, proved=False)
    verified_at = datetime.now(UTC)

    for version, timestamp in (
        (1, None),
        (None, verified_at),
        (2, verified_at),
    ):
        async with get_sessionmaker()() as session:
            with pytest.raises(IntegrityError):
                await session.execute(
                    update(DeviceCode)
                    .where(DeviceCode.device_code == start["device_code"])
                    .values(
                        host_possession_version=version,
                        host_possession_verified_at=timestamp,
                    )
                )
                await session.commit()

    async with get_sessionmaker()() as session:
        row = await session.get(DeviceCode, start["device_code"])
        assert row is not None
        assert row.host_possession_version is None
        assert row.host_possession_verified_at is None
        row.host_possession_version = 1
        row.host_possession_verified_at = verified_at
        await session.commit()


async def test_file_sqlite_host_possession_state_constraint(file_sqlite_client):
    await _assert_host_possession_state_constraint(file_sqlite_client)


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires PostgreSQL constraint enforcement",
)
async def test_postgresql_host_possession_state_constraint(client):
    await _assert_host_possession_state_constraint(client)


def _is_possession_transition(statement) -> bool:
    table = getattr(statement, "table", None)
    return bool(
        getattr(statement, "is_update", False)
        and getattr(table, "name", None) == "device_codes"
        and "host_possession_version" in str(statement)
        and getattr(statement, "_returning", ())
    )


def _is_expiry_transition(statement) -> bool:
    table = getattr(statement, "table", None)
    where = str(getattr(statement, "whereclause", ""))
    return bool(
        getattr(statement, "is_update", False)
        and getattr(table, "name", None) == "device_codes"
        and "device_codes.expires_at <=" in where
        and "device_codes.status" in where
    )


async def _assert_proof_delete_race_linearizes(
    client,
    monkeypatch,
    *,
    email: str,
    proof_commits_first: bool,
) -> None:
    user_id, auth = await _signup(client, email)
    browser = await _register_browser(client, user_id, auth)
    private_key = Ed25519PrivateKey.generate()
    public_key = _wire(private_key.public_key().public_bytes_raw())
    paired = await _pair(client, user_id, auth, browser, public_key)
    start = await _start(client, public_key, proved=False)
    reached = asyncio.Event()
    release = asyncio.Event()

    with monkeypatch.context() as patch:
        original_execute = AsyncSession.execute

        async def execute_with_barrier(self, statement, *args, **kwargs):
            result = await original_execute(self, statement, *args, **kwargs)
            target = (
                _is_possession_transition(statement)
                if proof_commits_first
                else _is_host_device_code_fence(statement)
            )
            if target and not reached.is_set():
                reached.set()
                await release.wait()
            return result

        patch.setattr(AsyncSession, "execute", execute_with_barrier)
        first = asyncio.create_task(
            _prove_possession(client, start, private_key)
            if proof_commits_first
            else client.delete(f"/api/hosts/{paired['host_id']}", headers=auth)
        )
        await asyncio.wait_for(reached.wait(), timeout=5)
        second = asyncio.create_task(
            client.delete(f"/api/hosts/{paired['host_id']}", headers=auth)
            if proof_commits_first
            else _prove_possession(client, start, private_key)
        )
        try:
            await asyncio.sleep(0.05)
            assert not second.done()
        finally:
            release.set()
        first_response, second_response = await asyncio.wait_for(
            asyncio.gather(first, second), timeout=10
        )

    proof = first_response if proof_commits_first else second_response
    deletion = second_response if proof_commits_first else first_response
    assert deletion.status_code == 204, deletion.text
    if proof_commits_first:
        assert proof.status_code == 200, proof.text
    else:
        assert proof.status_code == 404, proof.text
    async with get_sessionmaker()() as session:
        assert await session.get(Host, paired["host_id"]) is None
        assert await session.get(DeviceCode, start["device_code"]) is None
        assert (
            await session.execute(select(func.count(HostBrowserPin.host_id)))
        ).scalar_one() == 0
        claim = await session.get(HostKeyClaim, ("ed25519", public_key))
        assert claim is not None
        assert claim.owner_user_id == user_id


async def test_file_sqlite_proof_delete_race_linearizes_both_orders(
    file_sqlite_client,
    monkeypatch,
):
    await _assert_proof_delete_race_linearizes(
        file_sqlite_client,
        monkeypatch,
        email="sqlite-proof-before-delete@example.com",
        proof_commits_first=True,
    )
    await _assert_proof_delete_race_linearizes(
        file_sqlite_client,
        monkeypatch,
        email="sqlite-delete-before-proof@example.com",
        proof_commits_first=False,
    )


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires independent PostgreSQL transactions",
)
async def test_postgresql_proof_delete_race_linearizes_both_orders(client, monkeypatch):
    await _assert_proof_delete_race_linearizes(
        client,
        monkeypatch,
        email="postgres-proof-before-delete@example.com",
        proof_commits_first=True,
    )
    await _assert_proof_delete_race_linearizes(
        client,
        monkeypatch,
        email="postgres-delete-before-proof@example.com",
        proof_commits_first=False,
    )


async def _assert_proof_expiry_race_linearizes(
    client,
    monkeypatch,
    *,
    proof_commits_first: bool,
) -> None:
    private_key = Ed25519PrivateKey.generate()
    public_key = _wire(private_key.public_key().public_bytes_raw())
    start = await _start(client, public_key, proved=False)
    boundary = datetime(2030, 1, 1, tzinfo=UTC)
    async with get_sessionmaker()() as session:
        dc = await session.get(DeviceCode, start["device_code"])
        assert dc is not None
        dc.expires_at = boundary
        await session.commit()

    reached = asyncio.Event()
    release = asyncio.Event()
    with monkeypatch.context() as patch:
        original_execute = AsyncSession.execute

        def task_clock() -> datetime:
            task = asyncio.current_task()
            return (
                boundary - timedelta(seconds=1)
                if task is not None and task.get_name() == "possession-proof"
                else boundary + timedelta(seconds=1)
            )

        async def execute_with_barrier(self, statement, *args, **kwargs):
            result = await original_execute(self, statement, *args, **kwargs)
            target = (
                _is_possession_transition(statement)
                if proof_commits_first
                else _is_expiry_transition(statement)
            )
            if target and not reached.is_set():
                reached.set()
                await release.wait()
            return result

        patch.setattr(device_routes, "_utcnow", task_clock)
        patch.setattr(AsyncSession, "execute", execute_with_barrier)
        first = asyncio.create_task(
            _prove_possession(client, start, private_key)
            if proof_commits_first
            else _poll(client, start, public_key),
            name="possession-proof" if proof_commits_first else "ceremony-expiry",
        )
        await asyncio.wait_for(reached.wait(), timeout=5)
        second = asyncio.create_task(
            _poll(client, start, public_key)
            if proof_commits_first
            else _prove_possession(client, start, private_key),
            name="ceremony-expiry" if proof_commits_first else "possession-proof",
        )
        try:
            await asyncio.sleep(0.05)
            assert not second.done()
        finally:
            release.set()
        first_response, second_response = await asyncio.wait_for(
            asyncio.gather(first, second), timeout=10
        )

    proof = first_response if proof_commits_first else second_response
    expiry = second_response if proof_commits_first else first_response
    assert expiry.json() == {"error": "expired_token"}
    assert proof.status_code == (200 if proof_commits_first else 409), proof.text
    async with get_sessionmaker()() as session:
        dc = await session.get(DeviceCode, start["device_code"])
        assert dc is not None
        assert dc.status == "expired"
        assert (dc.host_possession_version == 1) == proof_commits_first
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 0
        assert (
            await session.execute(select(func.count(HostKeyClaim.host_public_key)))
        ).scalar_one() == 0


async def test_file_sqlite_proof_expiry_race_linearizes_both_orders(
    file_sqlite_client,
    monkeypatch,
):
    await _assert_proof_expiry_race_linearizes(
        file_sqlite_client,
        monkeypatch,
        proof_commits_first=True,
    )
    await _assert_proof_expiry_race_linearizes(
        file_sqlite_client,
        monkeypatch,
        proof_commits_first=False,
    )


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires independent PostgreSQL transactions",
)
async def test_postgresql_proof_expiry_race_linearizes_both_orders(client, monkeypatch):
    await _assert_proof_expiry_race_linearizes(
        client,
        monkeypatch,
        proof_commits_first=True,
    )
    await _assert_proof_expiry_race_linearizes(
        client,
        monkeypatch,
        proof_commits_first=False,
    )


async def test_approval_rejects_stale_nonce_and_substituted_browser_tuple(client):
    user_id, auth = await _signup(client, "approval-substitution@example.com")
    browser = await _register_browser(client, user_id, auth)
    start = await _start(client, _public_key(4))
    review = await _review(client, start, auth)
    body = _approval_body(start, review, user_id, browser)

    stale_nonce = await client.post(
        "/api/auth/device/approve",
        json={**body, "approval_nonce": "_" + body["approval_nonce"][1:]},
        headers=auth,
    )
    assert stale_nonce.status_code == 409
    substituted_id = await client.post(
        "/api/auth/device/approve",
        json={**body, "browser_device_id": str(uuid.uuid4())},
        headers=auth,
    )
    assert substituted_id.status_code == 409

    async with get_sessionmaker()() as session:
        dc = await session.get(DeviceCode, start["device_code"])
        assert dc is not None
        assert dc.status == "pending"
        assert dc.user_id is None
        assert dc.browser_device_id is None
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 0
        assert (
            await session.execute(select(func.count(HostBrowserPin.host_id)))
        ).scalar_one() == 0


async def test_browser_revocation_after_approval_blocks_poll_and_forces_rereview(client):
    user_id, auth = await _signup(client, "approval-revoked@example.com")
    browser = await _register_browser(client, user_id, auth)
    public_key = _public_key(5)
    start = await _start(client, public_key)
    review = await _review(client, start, auth)
    approval = await _approve(client, start, user_id, auth, review, browser)
    assert approval.status_code == 200, approval.text

    revoked = await _revoke_browser(client, auth, browser[0])
    assert revoked["revoked_at"] is not None
    blocked = await _poll(client, start, public_key)
    assert blocked.json() == {"error": "authorization_pending"}

    async with get_sessionmaker()() as session:
        dc = await session.get(DeviceCode, start["device_code"])
        assert dc is not None
        assert dc.status == "pending"
        assert dc.user_id is None
        assert dc.browser_device_id is None
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 0
        assert (
            await session.execute(select(func.count(HostBrowserPin.host_id)))
        ).scalar_one() == 0
    assert (await _review(client, start, auth))["approval_nonce"] == review["approval_nonce"]


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


@pytest.mark.parametrize(
    ("_case_id", "public_key_hex"),
    _STRICT_NEGATIVE_KEYS,
    ids=[case_id for case_id, _ in _STRICT_NEGATIVE_KEYS],
)
async def test_device_start_rejects_shared_strict_ed25519_negative_corpus(
    client, _case_id: str, public_key_hex: str
):
    response = await client.post(
        "/api/auth/device/start",
        json={
            "host_name": "strict-negative",
            "host_key_algorithm": "ed25519",
            "host_public_key": _encoded_hex(public_key_hex),
        },
    )
    assert response.status_code == 422


@pytest.mark.parametrize("public_key_hex", _ACCEPTED_PUBLIC_KEY_HEX)
async def test_device_start_accepts_shared_mixed_torsion_controls(client, public_key_hex: str):
    start = await _start(client, _encoded_hex(public_key_hex), name="mixed-torsion-control")
    assert start["device_code"]


def test_host_key_decode_rejects_giant_input_before_base64_allocation():
    giant = "A" * (16 * 1024 * 1024)
    with pytest.raises(HTTPException, match="invalid Ed25519 public key"):
        decode_host_public_key("ed25519", giant)


@pytest.mark.parametrize(
    ("table", "algorithm", "public_key"),
    [
        ("hosts", "ed25519", None),
        ("hosts", None, _public_key()),
        ("device_codes", "ed25519", None),
        ("device_codes", None, _public_key()),
    ],
)
async def test_orm_key_pair_constraints_reject_both_partial_null_permutations(
    client, table: str, algorithm: str | None, public_key: str | None
):
    await _signup(client, f"partial-{table}-{algorithm or 'null'}@example.com")
    async with get_sessionmaker()() as session:
        owner_id = (
            await session.execute(select(User.id).where(User.email.like("partial-%")))
        ).scalar_one()
        now = datetime.now(UTC)
        if table == "hosts":
            statement = text(
                "insert into hosts "
                "(id, owner_user_id, name, host_key_algorithm, host_public_key, status, "
                "daemon_generation, daemon_generation_counter, created_at) "
                "values (:id, :owner, 'partial', :algorithm, :public_key, 'offline', 0, 0, :now)"
            )
            parameters = {
                "id": "partial-host",
                "owner": owner_id,
                "algorithm": algorithm,
                "public_key": public_key,
                "now": now,
            }
        else:
            statement = text(
                "insert into device_codes "
                "(device_code, user_code, host_name, host_key_algorithm, host_public_key, "
                "status, expires_at, created_at) "
                "values ('partial-device', 'PART-NULL', 'partial', :algorithm, :public_key, "
                "'pending', :expires, :now)"
            )
            parameters = {
                "algorithm": algorithm,
                "public_key": public_key,
                "expires": now + timedelta(minutes=5),
                "now": now,
            }
        with pytest.raises(IntegrityError):
            await session.execute(statement, parameters)
            await session.commit()
        await session.rollback()


async def _assert_browser_binding_constraint_is_exact(client, *, email: str) -> None:
    user_id, auth = await _signup(client, email)
    browser = (await _register_browser(client, user_id, auth))[0]
    now = datetime.now(UTC)
    insert = text(
        "insert into device_codes "
        "(device_code, user_code, host_name, approval_nonce, browser_device_id, "
        "browser_key_algorithm, browser_public_key, browser_key_fingerprint, status, "
        "expires_at, created_at) values "
        "(:device_code, :user_code, 'binding-check', :approval_nonce, "
        ":browser_device_id, :browser_key_algorithm, :browser_public_key, "
        ":browser_key_fingerprint, 'pending', :expires_at, :created_at)"
    )
    full = {
        "browser_device_id": browser["id"],
        "browser_key_algorithm": "ed25519",
        "browser_public_key": browser["public_key"],
        "browser_key_fingerprint": browser["fingerprint"],
    }

    async with get_sessionmaker()() as session:
        for index, binding in enumerate(({field: None for field in full}, full)):
            await session.execute(
                insert,
                {
                    "device_code": f"valid-binding-{index}",
                    "user_code": f"VBND-000{index}",
                    "approval_nonce": _wire(bytes([index]) * 32),
                    "expires_at": now + timedelta(minutes=5),
                    "created_at": now,
                    **binding,
                },
            )
        await session.commit()

    fields = list(full)
    for mask in range(1, (1 << len(fields)) - 1):
        binding = {
            field: value if mask & (1 << index) else None
            for index, (field, value) in enumerate(full.items())
        }
        async with get_sessionmaker()() as session:
            with pytest.raises(IntegrityError):
                await session.execute(
                    insert,
                    {
                        "device_code": f"partial-binding-{mask}",
                        "user_code": f"PBND-{mask:04d}",
                        "approval_nonce": _wire(bytes([mask]) * 32),
                        "expires_at": now + timedelta(minutes=5),
                        "created_at": now,
                        **binding,
                    },
                )
                await session.commit()
            await session.rollback()

    invalid_full_bindings = [
        {**full, "browser_key_algorithm": "rsa"},
        {**full, "browser_public_key": full["browser_public_key"][:-1]},
        {**full, "browser_key_fingerprint": full["browser_key_fingerprint"][:-1]},
    ]
    for index, binding in enumerate(invalid_full_bindings):
        async with get_sessionmaker()() as session:
            with pytest.raises(IntegrityError):
                await session.execute(
                    insert,
                    {
                        "device_code": f"invalid-full-binding-{index}",
                        "user_code": f"IBND-000{index}",
                        "approval_nonce": _wire(bytes([index + 20]) * 32),
                        "expires_at": now + timedelta(minutes=5),
                        "created_at": now,
                        **binding,
                    },
                )
                await session.commit()
            await session.rollback()


async def test_file_sqlite_browser_binding_constraint_rejects_every_partial_permutation(
    file_sqlite_client,
):
    await _assert_browser_binding_constraint_is_exact(
        file_sqlite_client, email="sqlite-browser-binding-constraint@example.com"
    )


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires PostgreSQL constraint semantics",
)
async def test_postgresql_browser_binding_constraint_rejects_every_partial_permutation(client):
    await _assert_browser_binding_constraint_is_exact(
        client, email="postgres-browser-binding-constraint@example.com"
    )


async def test_legacy_unkeyed_device_client_fails_closed(client):
    response = await client.post(
        "/api/auth/device/start",
        json={"host_name": "legacy", "os": "linux", "arch": "x86_64", "version": "old"},
    )
    assert response.status_code == 422


async def test_parallel_pairing_ceremonies_are_distinct_and_poll_key_change_is_rejected(client):
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
    assert duplicate.status_code == 200
    duplicate_body = duplicate.json()
    assert duplicate_body["device_code"] != start["device_code"]
    assert duplicate_body["user_code"] != start["user_code"]

    changed = await _poll(client, start, _public_key(9))
    assert changed.json() == {"error": "invalid_device_binding"}


async def test_approval_is_one_shot(client):
    user_id, auth = await _signup(client, "one-shot@example.com")
    browser = await _register_browser(client, user_id, auth)
    start = await _start(client, _public_key(10))
    review = await _review(client, start, auth)
    first = await _approve(client, start, user_id, auth, review, browser)
    assert first.status_code == 200
    second = await _approve(client, start, user_id, auth, review, browser)
    assert second.status_code == 400


async def test_approval_rejects_identity_changed_after_review_without_token_or_pin(client):
    user_id, auth = await _signup(client, "stale-review@example.com")
    browser = await _register_browser(client, user_id, auth)
    reviewed_key = _public_key(8)
    changed_key = _public_key(9)
    start = await _start(client, reviewed_key)
    review = await _review(client, start, auth)

    async with get_sessionmaker()() as session:
        changed = await session.execute(
            update(DeviceCode)
            .where(
                DeviceCode.device_code == start["device_code"],
                DeviceCode.status == "pending",
            )
            .values(host_public_key=changed_key)
        )
        assert changed.rowcount == 1
        await session.commit()

    stale_approval = await _approve(client, start, user_id, auth, review, browser)
    assert stale_approval.status_code == 409
    assert "review" in stale_approval.json()["detail"]

    async with get_sessionmaker()() as session:
        dc = await session.get(DeviceCode, start["device_code"])
        assert dc is not None
        assert dc.status == "pending"
        assert dc.user_id is None
        assert dc.host_public_key == changed_key
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 0

    assert (await _poll(client, start, reviewed_key)).json() == {"error": "invalid_device_binding"}
    assert (await client.get("/api/hosts", headers=auth)).json() == []
    fresh_review = await _review(client, start, auth)
    assert fresh_review["host_public_key"] == changed_key
    assert fresh_review["host_key_fingerprint"] != review["host_key_fingerprint"]


async def test_concurrent_approval_and_poll_issue_exactly_one_token_and_pin(client):
    user_id, auth = await _signup(client, "approval-poll-race@example.com")
    browser = await _register_browser(client, user_id, auth)
    public_key = _public_key(10)
    start = await _start(client, public_key)
    review = await _review(client, start, auth)

    approval, racing_poll = await asyncio.gather(
        _approve(client, start, user_id, auth, review, browser),
        _poll(client, start, public_key),
    )
    assert approval.status_code == 200, approval.text

    successful_polls = []
    racing_body = racing_poll.json()
    if "access_token" in racing_body:
        successful_polls.append(racing_body)
    else:
        assert racing_body["error"] in {"authorization_pending", "slow_down"}
        async with get_sessionmaker()() as session:
            dc = await session.get(DeviceCode, start["device_code"])
            assert dc is not None
            dc.last_polled_at = datetime.now(UTC) - timedelta(seconds=10)
            await session.commit()
        follow_up = await _poll(client, start, public_key)
        assert follow_up.status_code == 200, follow_up.text
        successful_polls.append(follow_up.json())

    assert len(successful_polls) == 1
    assert successful_polls[0]["host_public_key"] == public_key
    assert (await _poll(client, start, public_key)).json() == {"error": "expired_token"}
    async with get_sessionmaker()() as session:
        hosts = (await session.execute(select(Host))).scalars().all()
        assert len(hosts) == 1
        assert hosts[0].host_public_key == public_key


async def _assert_concurrent_approved_polls_are_one_shot(
    client, *, email: str, public_key: str
) -> None:
    user_id, auth = await _signup(client, email)
    browser = await _register_browser(client, user_id, auth)
    start = await _start(client, public_key, name="poll-race")
    review = await _review(client, start, auth)
    approval = await _approve(client, start, user_id, auth, review, browser)
    assert approval.status_code == 200, approval.text

    responses = await asyncio.gather(*(_poll(client, start, public_key) for _ in range(24)))
    assert all(response.status_code == 200 for response in responses), [
        (response.status_code, response.text) for response in responses
    ]
    bodies = [response.json() for response in responses]
    successes = [body for body in bodies if "access_token" in body]
    failures = [body for body in bodies if "access_token" not in body]
    assert len(successes) == 1
    assert failures == [{"error": "expired_token"}] * 23
    assert successes[0]["host_public_key"] == public_key

    async with get_sessionmaker()() as session:
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 1
        assert (await session.execute(select(func.count(DeviceCode.device_code)))).scalar_one() == 0


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="the shared-connection in-memory SQLite fixture cannot model concurrent transactions",
)
async def test_concurrent_approved_polls_issue_one_token_on_postgresql(client):
    await _assert_concurrent_approved_polls_are_one_shot(
        client,
        email="approved-poll-race@example.com",
        public_key=_public_key(13),
    )


async def test_concurrent_approved_polls_issue_one_token_on_file_sqlite(file_sqlite_client):
    await _assert_concurrent_approved_polls_are_one_shot(
        file_sqlite_client,
        email="file-sqlite-poll-race@example.com",
        public_key=_public_key(14),
    )


async def _assert_concurrent_first_host_ceremonies_all_reuse_one_host(
    client, *, email: str, public_key: str
) -> None:
    user_id, auth = await _signup(client, email)
    browsers = [await _register_browser(client, user_id, auth) for _ in range(12)]
    starts = [await _start(client, public_key, name="first-host-race") for _ in range(12)]
    reviews = [await _review(client, start, auth) for start in starts]
    approvals = await asyncio.gather(
        *(
            _approve(client, start, user_id, auth, review, browser)
            for start, review, browser in zip(starts, reviews, browsers, strict=True)
        )
    )
    assert [response.status_code for response in approvals] == [200] * 12

    polls = await asyncio.gather(*(_poll(client, start, public_key) for start in starts))
    assert [response.status_code for response in polls] == [200] * 12
    bodies = [response.json() for response in polls]
    assert all("access_token" in body for body in bodies), bodies
    host_ids = {body["host_id"] for body in bodies}
    assert len(host_ids) == 1
    assert {body["browser_device_id"] for body in bodies} == {
        browser[0]["id"] for browser in browsers
    }

    async with get_sessionmaker()() as session:
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 1
        assert (
            await session.execute(select(func.count(HostBrowserPin.browser_device_id)))
        ).scalar_one() == 12
        assert (
            await session.execute(select(func.count(DeviceCode.device_code)))
        ).scalar_one() == 0


async def test_file_sqlite_concurrent_first_host_ceremonies_reuse_one_host(
    file_sqlite_client,
):
    await _assert_concurrent_first_host_ceremonies_all_reuse_one_host(
        file_sqlite_client,
        email="sqlite-first-host-race@example.com",
        public_key=_public_key(26),
    )


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires independent PostgreSQL transactions",
)
async def test_postgresql_concurrent_first_host_ceremonies_reuse_one_host(client):
    await _assert_concurrent_first_host_ceremonies_all_reuse_one_host(
        client,
        email="postgres-first-host-race@example.com",
        public_key=_public_key(27),
    )


async def _assert_approve_revoke_race_has_no_issuance(client, *, email: str, key: str) -> None:
    user_id, auth = await _signup(client, email)
    browser = await _register_browser(client, user_id, auth)
    start = await _start(client, key)
    review = await _review(client, start, auth)

    approval, revocation = await asyncio.gather(
        _approve(client, start, user_id, auth, review, browser),
        _revoke_browser(client, auth, browser[0]),
    )
    assert approval.status_code in {200, 409}, approval.text
    assert revocation["revoked_at"] is not None
    assert (await _poll(client, start, key)).json() == {"error": "authorization_pending"}
    async with get_sessionmaker()() as session:
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 0
        assert (
            await session.execute(select(func.count(HostBrowserPin.host_id)))
        ).scalar_one() == 0


async def _assert_poll_revoke_race_is_transactionally_consistent(
    client, *, email: str, key: str
) -> None:
    user_id, auth = await _signup(client, email)
    browser = await _register_browser(client, user_id, auth)
    start = await _start(client, key)
    review = await _review(client, start, auth)
    assert (
        await _approve(client, start, user_id, auth, review, browser)
    ).status_code == 200

    poll, revocation = await asyncio.gather(
        _poll(client, start, key),
        _revoke_browser(client, auth, browser[0]),
    )
    assert revocation["revoked_at"] is not None
    body = poll.json()
    assert "access_token" in body or body == {"error": "authorization_pending"}
    async with get_sessionmaker()() as session:
        host_count = (await session.execute(select(func.count(Host.id)))).scalar_one()
        pin_count = (
            await session.execute(select(func.count(HostBrowserPin.host_id)))
        ).scalar_one()
        assert host_count == pin_count
        assert host_count == (1 if "access_token" in body else 0)


async def test_file_sqlite_approve_revoke_and_poll_revoke_races_are_consistent(
    file_sqlite_client,
):
    await _assert_approve_revoke_race_has_no_issuance(
        file_sqlite_client,
        email="sqlite-approve-revoke@example.com",
        key=_public_key(20),
    )
    await _assert_poll_revoke_race_is_transactionally_consistent(
        file_sqlite_client,
        email="sqlite-poll-revoke@example.com",
        key=_public_key(21),
    )


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires independent PostgreSQL transactions",
)
async def test_postgresql_approve_revoke_and_poll_revoke_races_are_consistent(client):
    await _assert_approve_revoke_race_has_no_issuance(
        client,
        email="postgres-approve-revoke@example.com",
        key=_public_key(22),
    )
    await _assert_poll_revoke_race_is_transactionally_consistent(
        client,
        email="postgres-poll-revoke@example.com",
        key=_public_key(23),
    )


async def test_same_owner_relogin_reuses_host_and_cross_user_cannot_claim_key(client):
    owner_id, owner_auth = await _signup(client, "owner@example.com")
    other_id, other_auth = await _signup(client, "other@example.com")
    owner_browser = await _register_browser(client, owner_id, owner_auth)
    other_browser = await _register_browser(client, other_id, other_auth)
    public_key = _public_key(11)

    first = await _pair(
        client, owner_id, owner_auth, owner_browser, public_key, name="original-name"
    )
    relogin = await _pair(
        client, owner_id, owner_auth, owner_browser, public_key, name="must-not-overwrite"
    )
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
    review = await _review(client, attack, other_auth)
    denied = await _approve(client, attack, other_id, other_auth, review, other_browser)
    assert denied.status_code == 409
    assert (await client.get("/api/hosts", headers=other_auth)).json() == []

    async with get_sessionmaker()() as session:
        assert (
            await session.execute(
                select(func.count(HostBrowserPin.browser_device_id)).where(
                    HostBrowserPin.host_id == first["host_id"]
                )
            )
        ).scalar_one() == 1


async def test_explicit_relogin_adds_an_immutable_second_browser_pin(client):
    user_id, auth = await _signup(client, "multi-browser-pin@example.com")
    first_browser = await _register_browser(client, user_id, auth)
    second_browser = await _register_browser(client, user_id, auth)
    public_key = _public_key(15)

    first = await _pair(client, user_id, auth, first_browser, public_key)
    second = await _pair(client, user_id, auth, second_browser, public_key)
    assert second["host_id"] == first["host_id"]

    async with get_sessionmaker()() as session:
        pins = (
            await session.execute(
                select(HostBrowserPin)
                .where(HostBrowserPin.host_id == first["host_id"])
                .order_by(HostBrowserPin.browser_device_id)
            )
        ).scalars().all()
        assert len(pins) == 2
        assert {pin.browser_device_id for pin in pins} == {
            first_browser[0]["id"],
            second_browser[0]["id"],
        }
        assert {pin.browser_public_key for pin in pins} == {
            first_browser[0]["public_key"],
            second_browser[0]["public_key"],
        }


async def test_host_browser_pin_bound_rejects_the_thirty_third_without_partial_row(client):
    user_id, auth = await _signup(client, "pin-bound@example.com")
    first_browser = await _register_browser(client, user_id, auth)
    public_key = _public_key(16)
    first = await _pair(client, user_id, auth, first_browser, public_key)

    async with get_sessionmaker()() as session:
        for _ in range(31):
            private_key = Ed25519PrivateKey.generate()
            browser_public_key = _wire(private_key.public_key().public_bytes_raw())
            device = BrowserDevice(
                id=str(uuid.uuid4()),
                owner_user_id=user_id,
                key_algorithm="ed25519",
                public_key=browser_public_key,
            )
            session.add(device)
            session.add(
                HostBrowserPin(
                    host_id=first["host_id"],
                    browser_device_id=device.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=browser_public_key,
                    browser_key_fingerprint=ed25519_key_fingerprint(browser_public_key),
                )
            )
        await session.commit()

    overflow_browser = await _register_browser(client, user_id, auth)
    start = await _start(client, public_key)
    review = await _review(client, start, auth)
    approved = await _approve(client, start, user_id, auth, review, overflow_browser)
    assert approved.status_code == 200, approved.text
    poll = await _poll(client, start, public_key)
    assert poll.json() == {"error": "pin_limit"}

    async with get_sessionmaker()() as session:
        assert (
            await session.execute(
                select(func.count(HostBrowserPin.browser_device_id)).where(
                    HostBrowserPin.host_id == first["host_id"]
                )
            )
        ).scalar_one() == 32
        assert (
            await session.execute(
                select(func.count(HostBrowserPin.browser_device_id)).where(
                    HostBrowserPin.browser_device_id == overflow_browser[0]["id"]
                )
            )
        ).scalar_one() == 0


async def _assert_pin_capacity_race_admits_exactly_one(
    client, *, email: str, public_key: str
) -> None:
    user_id, auth = await _signup(client, email)
    initial_browser = await _register_browser(client, user_id, auth)
    paired = await _pair(client, user_id, auth, initial_browser, public_key)

    async with get_sessionmaker()() as session:
        for _ in range(30):
            browser_public_key = _wire(
                Ed25519PrivateKey.generate().public_key().public_bytes_raw()
            )
            device = BrowserDevice(
                id=str(uuid.uuid4()),
                owner_user_id=user_id,
                key_algorithm="ed25519",
                public_key=browser_public_key,
            )
            session.add(device)
            session.add(
                HostBrowserPin(
                    host_id=paired["host_id"],
                    browser_device_id=device.id,
                    browser_key_algorithm="ed25519",
                    browser_public_key=browser_public_key,
                    browser_key_fingerprint=ed25519_key_fingerprint(browser_public_key),
                )
            )
        await session.commit()

    contenders = [
        await _register_browser(client, user_id, auth),
        await _register_browser(client, user_id, auth),
    ]
    starts = [await _start(client, public_key), await _start(client, public_key)]
    reviews = [
        await _review(client, starts[0], auth),
        await _review(client, starts[1], auth),
    ]
    approvals = await asyncio.gather(
        _approve(client, starts[0], user_id, auth, reviews[0], contenders[0]),
        _approve(client, starts[1], user_id, auth, reviews[1], contenders[1]),
    )
    assert [response.status_code for response in approvals] == [200, 200]

    polls = await asyncio.gather(
        _poll(client, starts[0], public_key),
        _poll(client, starts[1], public_key),
    )
    bodies = [response.json() for response in polls]
    successes = [index for index, body in enumerate(bodies) if "access_token" in body]
    losers = [index for index, body in enumerate(bodies) if body == {"error": "pin_limit"}]
    assert len(successes) == 1, bodies
    assert len(losers) == 1, bodies
    loser = losers[0]
    assert (await _poll(client, starts[loser], public_key)).json() == {
        "error": "pin_limit"
    }

    async with get_sessionmaker()() as session:
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 1
        assert (
            await session.execute(
                select(func.count(HostBrowserPin.browser_device_id)).where(
                    HostBrowserPin.host_id == paired["host_id"]
                )
            )
        ).scalar_one() == 32
        assert (
            await session.execute(
                select(func.count(HostBrowserPin.browser_device_id)).where(
                    HostBrowserPin.browser_device_id == contenders[loser][0]["id"]
                )
            )
        ).scalar_one() == 0
        remaining_codes = (
            await session.execute(select(DeviceCode).order_by(DeviceCode.device_code))
        ).scalars().all()
        assert len(remaining_codes) == 1
        assert remaining_codes[0].device_code == starts[loser]["device_code"]
        assert remaining_codes[0].status == "pin_limit"
        assert remaining_codes[0].browser_device_id == contenders[loser][0]["id"]


async def test_file_sqlite_pin_capacity_race_admits_exactly_one(file_sqlite_client):
    await _assert_pin_capacity_race_admits_exactly_one(
        file_sqlite_client,
        email="sqlite-pin-cap-race@example.com",
        public_key=_public_key(24),
    )


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires PostgreSQL row locking",
)
async def test_postgresql_pin_capacity_race_admits_exactly_one(client):
    await _assert_pin_capacity_race_admits_exactly_one(
        client,
        email="postgres-pin-cap-race@example.com",
        public_key=_public_key(25),
    )


async def test_revocation_removes_pin_and_old_token_authority(client):
    user_id, auth = await _signup(client, "revoke@example.com")
    browser = await _register_browser(client, user_id, auth)
    public_key = _public_key(12)
    first = await _pair(client, user_id, auth, browser, public_key)

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
        with pytest.raises(HTTPException) as exc_info:
            await server_auth.daemon_principal(
                authorization=f"Bearer {first['access_token']}",
                session=session,
            )
        assert exc_info.value.status_code == 401

    repaired = await _pair(client, user_id, auth, browser, public_key)
    assert repaired["host_id"] != first["host_id"]


async def test_revocation_fences_every_existing_ceremony_retains_owner_and_allows_repair(
    client,
):
    owner_id, owner_auth = await _signup(client, "durable-host-owner@example.com")
    other_id, other_auth = await _signup(client, "host-key-capture@example.com")
    owner_browser = await _register_browser(client, owner_id, owner_auth)
    other_browser = await _register_browser(client, other_id, other_auth)
    public_key = _public_key(28)
    paired = await _pair(client, owner_id, owner_auth, owner_browser, public_key)

    pending = await _start(client, public_key, name="pending-before-delete")
    pending_review = await _review(client, pending, owner_auth)
    approved = await _start(client, public_key, name="approved-before-delete")
    approved_review = await _review(client, approved, owner_auth)
    assert (
        await _approve(
            client,
            approved,
            owner_id,
            owner_auth,
            approved_review,
            owner_browser,
        )
    ).status_code == 200
    consuming = await _start(client, public_key, name="consuming-before-delete")
    async with get_sessionmaker()() as session:
        changed = await session.execute(
            update(DeviceCode)
            .where(DeviceCode.device_code == consuming["device_code"])
            .values(status="consuming")
        )
        assert changed.rowcount == 1
        await session.commit()

    removed = await client.delete(f"/api/hosts/{paired['host_id']}", headers=owner_auth)
    assert removed.status_code == 204, removed.text
    assert (
        await _approve(
            client,
            pending,
            owner_id,
            owner_auth,
            pending_review,
            owner_browser,
        )
    ).status_code == 404
    for fenced in (pending, approved, consuming):
        assert (await _poll(client, fenced, public_key)).json() == {"error": "expired_token"}

    async with get_sessionmaker()() as session:
        assert await session.get(Host, paired["host_id"]) is None
        assert (
            await session.execute(
                select(func.count(DeviceCode.device_code)).where(
                    DeviceCode.host_key_algorithm == "ed25519",
                    DeviceCode.host_public_key == public_key,
                )
            )
        ).scalar_one() == 0
        assert (
            await session.execute(select(func.count(HostBrowserPin.host_id)))
        ).scalar_one() == 0
        claim = await session.get(HostKeyClaim, ("ed25519", public_key))
        assert claim is not None
        assert claim.owner_user_id == owner_id

    capture = await _start(client, public_key, name="capture-attempt")
    capture_review = await _review(client, capture, other_auth)
    capture_approval = await _approve(
        client,
        capture,
        other_id,
        other_auth,
        capture_review,
        other_browser,
    )
    assert capture_approval.status_code == 409
    assert "another account" in capture_approval.json()["detail"]
    assert (await _poll(client, capture, public_key)).json() == {"error": "expired_token"}

    repaired = await _pair(client, owner_id, owner_auth, owner_browser, public_key)
    assert repaired["host_id"] != paired["host_id"]
    async with get_sessionmaker()() as session:
        claim = await session.get(HostKeyClaim, ("ed25519", public_key))
        assert claim is not None
        assert claim.owner_user_id == owner_id
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 1
        assert (
            await session.execute(select(func.count(HostBrowserPin.host_id)))
        ).scalar_one() == 1


def _is_device_poll_claim(statement) -> bool:
    table = getattr(statement, "table", None)
    return bool(
        getattr(statement, "is_update", False)
        and getattr(table, "name", None) == "device_codes"
        and getattr(statement, "_returning", ())
    )


def _is_host_device_code_fence(statement) -> bool:
    table = getattr(statement, "table", None)
    where = str(getattr(statement, "whereclause", ""))
    return bool(
        getattr(statement, "is_delete", False)
        and getattr(table, "name", None) == "device_codes"
        and "device_codes.host_key_algorithm" in where
        and "device_codes.host_public_key" in where
    )


def _is_host_key_claim_lock(statement) -> bool:
    table = getattr(statement, "table", None)
    return bool(
        getattr(statement, "is_update", False)
        and getattr(table, "name", None) == "host_key_claims"
        and getattr(statement, "_returning", ())
    )


async def _assert_delete_poll_race_linearizes(
    client,
    monkeypatch,
    *,
    email: str,
    public_key: str,
    poll_commits_first: bool,
) -> None:
    user_id, auth = await _signup(client, email)
    browser = await _register_browser(client, user_id, auth)
    paired = await _pair(client, user_id, auth, browser, public_key)
    start = await _start(client, public_key, name="delete-poll-race")
    review = await _review(client, start, auth)
    assert (
        await _approve(client, start, user_id, auth, review, browser)
    ).status_code == 200

    reached = asyncio.Event()
    release = asyncio.Event()
    with monkeypatch.context() as patch:
        original_execute = AsyncSession.execute

        async def execute_with_barrier(self, statement, *args, **kwargs):
            result = await original_execute(self, statement, *args, **kwargs)
            target = (
                _is_device_poll_claim(statement)
                if poll_commits_first
                else _is_host_device_code_fence(statement)
            )
            if target and not reached.is_set():
                reached.set()
                await release.wait()
            return result

        patch.setattr(AsyncSession, "execute", execute_with_barrier)
        first = asyncio.create_task(
            _poll(client, start, public_key)
            if poll_commits_first
            else client.delete(f"/api/hosts/{paired['host_id']}", headers=auth)
        )
        await asyncio.wait_for(reached.wait(), timeout=5)
        second = asyncio.create_task(
            client.delete(f"/api/hosts/{paired['host_id']}", headers=auth)
            if poll_commits_first
            else _poll(client, start, public_key)
        )
        try:
            await asyncio.sleep(0.05)
            assert not second.done()
        finally:
            release.set()
        first_response, second_response = await asyncio.wait_for(
            asyncio.gather(first, second), timeout=10
        )

    poll = first_response if poll_commits_first else second_response
    deletion = second_response if poll_commits_first else first_response
    assert deletion.status_code == 204, deletion.text
    if poll_commits_first:
        assert "access_token" in poll.json(), poll.text
    else:
        assert poll.json() == {"error": "expired_token"}

    async with get_sessionmaker()() as session:
        assert await session.get(Host, paired["host_id"]) is None
        assert await session.get(DeviceCode, start["device_code"]) is None
        assert (
            await session.execute(select(func.count(HostBrowserPin.host_id)))
        ).scalar_one() == 0
        claim = await session.get(HostKeyClaim, ("ed25519", public_key))
        assert claim is not None
        assert claim.owner_user_id == user_id


async def test_file_sqlite_delete_poll_race_linearizes_both_commit_orders(
    file_sqlite_client,
    monkeypatch,
):
    await _assert_delete_poll_race_linearizes(
        file_sqlite_client,
        monkeypatch,
        email="sqlite-delete-poll-first@example.com",
        public_key=_public_key(29),
        poll_commits_first=True,
    )
    await _assert_delete_poll_race_linearizes(
        file_sqlite_client,
        monkeypatch,
        email="sqlite-delete-first@example.com",
        public_key=_public_key(30),
        poll_commits_first=False,
    )


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires independent PostgreSQL transactions",
)
async def test_postgresql_delete_poll_race_linearizes_both_commit_orders(
    client,
    monkeypatch,
):
    await _assert_delete_poll_race_linearizes(
        client,
        monkeypatch,
        email="postgres-delete-poll-first@example.com",
        public_key=_public_key(31),
        poll_commits_first=True,
    )
    await _assert_delete_poll_race_linearizes(
        client,
        monkeypatch,
        email="postgres-delete-first@example.com",
        public_key=_public_key(32),
        poll_commits_first=False,
    )


async def _assert_delete_start_race_linearizes(
    client,
    monkeypatch,
    *,
    email: str,
    public_key: str,
    start_commits_first: bool,
) -> None:
    user_id, auth = await _signup(client, email)
    browser = await _register_browser(client, user_id, auth)
    paired = await _pair(client, user_id, auth, browser, public_key)

    reached = asyncio.Event()
    release = asyncio.Event()
    with monkeypatch.context() as patch:
        original_execute = AsyncSession.execute

        async def execute_with_barrier(self, statement, *args, **kwargs):
            result = await original_execute(self, statement, *args, **kwargs)
            target = (
                _is_host_key_claim_lock(statement)
                if start_commits_first
                else _is_host_device_code_fence(statement)
            )
            if target and not reached.is_set():
                reached.set()
                await release.wait()
            return result

        patch.setattr(AsyncSession, "execute", execute_with_barrier)
        first = asyncio.create_task(
            _start(client, public_key, name="delete-start-race", proved=False)
            if start_commits_first
            else client.delete(f"/api/hosts/{paired['host_id']}", headers=auth)
        )
        await asyncio.wait_for(reached.wait(), timeout=5)
        second = asyncio.create_task(
            client.delete(f"/api/hosts/{paired['host_id']}", headers=auth)
            if start_commits_first
            else _start(client, public_key, name="delete-start-race", proved=False)
        )
        try:
            await asyncio.sleep(0.05)
            assert not second.done()
        finally:
            release.set()
        first_response, second_response = await asyncio.wait_for(
            asyncio.gather(first, second), timeout=10
        )

    start = first_response if start_commits_first else second_response
    deletion = second_response if start_commits_first else first_response
    assert deletion.status_code == 204, deletion.text
    async with get_sessionmaker()() as session:
        claim = await session.get(HostKeyClaim, ("ed25519", public_key))
        assert claim is not None
        assert claim.owner_user_id == user_id
        code = await session.get(DeviceCode, start["device_code"])
        assert (code is None) == start_commits_first

    if start_commits_first:
        assert (await _poll(client, start, public_key)).json() == {"error": "expired_token"}
        return

    await _mark_possession_verified(start["device_code"])
    review = await _review(client, start, auth)
    approval = await _approve(client, start, user_id, auth, review, browser)
    assert approval.status_code == 200, approval.text
    repaired = await _poll(client, start, public_key)
    assert "access_token" in repaired.json(), repaired.text
    assert repaired.json()["host_id"] != paired["host_id"]


async def test_file_sqlite_delete_start_race_linearizes_both_commit_orders(
    file_sqlite_client,
    monkeypatch,
):
    await _assert_delete_start_race_linearizes(
        file_sqlite_client,
        monkeypatch,
        email="sqlite-start-first@example.com",
        public_key=_public_key(33),
        start_commits_first=True,
    )
    await _assert_delete_start_race_linearizes(
        file_sqlite_client,
        monkeypatch,
        email="sqlite-delete-before-start@example.com",
        public_key=_public_key(34),
        start_commits_first=False,
    )


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires independent PostgreSQL transactions",
)
async def test_postgresql_delete_start_race_linearizes_both_commit_orders(
    client,
    monkeypatch,
):
    await _assert_delete_start_race_linearizes(
        client,
        monkeypatch,
        email="postgres-start-first@example.com",
        public_key=_public_key(35),
        start_commits_first=True,
    )
    await _assert_delete_start_race_linearizes(
        client,
        monkeypatch,
        email="postgres-delete-before-start@example.com",
        public_key=_public_key(36),
        start_commits_first=False,
    )
