"""Key-bound device flow: start → review → approve → one-shot poll."""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError

from spawn_server.db import get_sessionmaker
from spawn_server.host_identity import decode_host_public_key, host_key_fingerprint
from spawn_server.models import DeviceCode, Host, User

_KEY_VECTORS = json.loads(
    (Path(__file__).parents[2] / "proto" / "ed25519-public-key-negative-vectors.json").read_text()
)
_ACCEPTED_PUBLIC_KEY_HEX: list[str] = _KEY_VECTORS["accepted_mixed_torsion_public_key_hex"]
_STRICT_NEGATIVE_KEYS = [
    *[
        (f"weak-{item['id']}", item["public_key_hex"])
        for item in _KEY_VECTORS["weak_public_keys"]
    ],
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


async def _review(client, start: dict, auth: dict[str, str]) -> dict:
    response = await client.post(
        "/api/auth/device/pending",
        json={"user_code": start["user_code"]},
        headers=auth,
    )
    assert response.status_code == 200, response.text
    return response.json()


def _approval_body(start: dict, review: dict) -> dict:
    return {
        "user_code": start["user_code"],
        "host_key_algorithm": review["host_key_algorithm"],
        "host_public_key": review["host_public_key"],
        "host_key_fingerprint": review["host_key_fingerprint"],
    }


async def _approve(client, start: dict, auth: dict[str, str], review: dict):
    return await client.post(
        "/api/auth/device/approve",
        json=_approval_body(start, review),
        headers=auth,
    )


async def _pair(client, auth: dict[str, str], public_key: str, *, name: str = "host") -> dict:
    start = await _start(client, public_key, name=name)
    review = await _review(client, start, auth)
    approval = await _approve(client, start, auth, review)
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

    review = await _review(client, start, auth)
    assert review == {
        "host_name": "gpu-box-1",
        "host_key_algorithm": "ed25519",
        "host_public_key": public_key,
        "host_key_fingerprint": fingerprint,
    }

    untrusted_fingerprint = await client.post(
        "/api/auth/device/approve",
        json={**_approval_body(start, review), "host_key_fingerprint": "attacker-choice"},
        headers=auth,
    )
    assert untrusted_fingerprint.status_code == 422

    unbound_approval = await client.post(
        "/api/auth/device/approve",
        json={"user_code": start["user_code"]},
        headers=auth,
    )
    assert unbound_approval.status_code == 422

    approval = await _approve(client, start, auth, review)
    assert approval.status_code == 200
    assert approval.json() == review

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
    review = await _review(client, start, auth)
    first = await _approve(client, start, auth, review)
    assert first.status_code == 200
    second = await _approve(client, start, auth, review)
    assert second.status_code == 400


async def test_approval_rejects_identity_changed_after_review_without_token_or_pin(client):
    _, auth = await _signup(client, "stale-review@example.com")
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

    stale_approval = await _approve(client, start, auth, review)
    assert stale_approval.status_code == 409
    assert "review" in stale_approval.json()["detail"]

    async with get_sessionmaker()() as session:
        dc = await session.get(DeviceCode, start["device_code"])
        assert dc is not None
        assert dc.status == "pending"
        assert dc.user_id is None
        assert dc.host_public_key == changed_key
        assert (await session.execute(select(func.count(Host.id)))).scalar_one() == 0

    assert (await _poll(client, start, reviewed_key)).json() == {
        "error": "invalid_device_binding"
    }
    assert (await client.get("/api/hosts", headers=auth)).json() == []
    fresh_review = await _review(client, start, auth)
    assert fresh_review["host_public_key"] == changed_key
    assert fresh_review["host_key_fingerprint"] != review["host_key_fingerprint"]


async def test_concurrent_approval_and_poll_issue_exactly_one_token_and_pin(client):
    _, auth = await _signup(client, "approval-poll-race@example.com")
    public_key = _public_key(10)
    start = await _start(client, public_key)
    review = await _review(client, start, auth)

    approval, racing_poll = await asyncio.gather(
        _approve(client, start, auth, review),
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
    review = await _review(client, attack, other_auth)
    denied = await _approve(client, attack, other_auth, review)
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
