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
from spawn_server.models import BrowserDevice, DeviceCode, Host, HostBrowserPin, User

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

    repaired = await _pair(client, user_id, auth, browser, public_key)
    assert repaired["host_id"] != first["host_id"]
