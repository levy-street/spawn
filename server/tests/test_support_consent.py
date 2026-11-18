"""Read-only shared vectors, exact timestamps and signed current-statement storage."""

from __future__ import annotations

import base64
import copy
import hashlib
import json
import uuid
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from sqlalchemy import delete, update

from spawn_server.db import get_sessionmaker
from spawn_server.models import BrowserDevice, SupportLogConsent, User, _utcnow
from spawn_server.support_consent import (
    FUTURE_MS,
    U64_MAX,
    ConsentError,
    ConsentReason,
    encode_transcript,
    get_statement,
    is_sharing_on,
    next_timestamp,
    store_statement,
    verify_statement,
)

VECTORS = json.loads(
    (Path(__file__).resolve().parents[2] / "proto/support-log-consent-v1-vectors.json").read_text()
)


def b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def sign(statement, key):
    value = {**statement}
    value["signature"] = b64(key.sign(encode_transcript(value)))
    return value


async def seed_signer(*, enabled, issued, owner=None):
    key = Ed25519PrivateKey.generate()
    user_id, device_id = owner or str(uuid.uuid4()), str(uuid.uuid4())
    value = dict(
        version=1,
        account_id=user_id,
        signer_device_id=device_id,
        signer_public_key=b64(key.public_key().public_bytes_raw()),
        enabled=enabled,
        issued_at_ms=issued,
        carried_endorsements=[],
    )
    async with get_sessionmaker()() as session:
        if owner is None:
            session.add(User(id=user_id, email=uuid.uuid4().hex, password_hash="unused"))
            await session.flush()
        session.add(
            BrowserDevice(
                id=device_id,
                owner_user_id=user_id,
                key_algorithm="ed25519",
                public_key=value["signer_public_key"],
            )
        )
        await session.commit()
    return sign(value, key), key


async def seed_statement(*, enabled=True, issued=1000):
    value, key = await seed_signer(enabled=enabled, issued=issued)
    await store_statement(value["account_id"], value, clock_ms=issued)
    return value, key


@pytest.mark.parametrize("vector", VECTORS["positive"])
def test_shared_positive_and_every_transcript_byte(vector, monkeypatch):
    value = verify_statement(vector["consent"])
    transcript = encode_transcript(value)
    assert len(transcript) == 102
    assert transcript.hex() == vector["transcript_hex"]
    assert hashlib.sha256(transcript).hexdigest() == vector["transcript_sha256"]
    key = Ed25519PrivateKey.from_private_bytes(bytes.fromhex(vector["signing_seed_hex"]))
    signature = key.sign(transcript)
    assert b64(signature) == value["signature"]
    for index in range(len(transcript)):
        mutated = bytearray(transcript)
        mutated[index] ^= 1
        monkeypatch.setattr(
            "spawn_server.support_consent.encode_transcript",
            lambda _value, transcript=bytes(mutated): transcript,
        )
        with pytest.raises(ConsentError) as caught:
            verify_statement(value)
        assert caught.value.reason == ConsentReason.INVALID_SIGNATURE


@pytest.mark.parametrize("vector", VECTORS["negative"], ids=lambda v: v["case"])
async def test_shared_negative_attribution(app, vector):
    value = vector["consent"]
    # These have valid signatures. The roster, like the retained pin/last edge,
    # must attribute the key to its actual device, not the signed mismatched ID.
    verify_statement(value)
    positive = VECTORS["positive"][0]["consent"]
    carried = value["carried_endorsements"]
    device_id = carried[-1]["endorsed_device_id"] if carried else VECTORS["trusted_device_id"]
    async with get_sessionmaker()() as session:
        session.add(User(id=positive["account_id"], email=uuid.uuid4().hex, password_hash="unused"))
        await session.flush()
        session.add(
            BrowserDevice(
                id=device_id,
                owner_user_id=value["account_id"],
                key_algorithm="ed25519",
                public_key=value["signer_public_key"],
            )
        )
        await session.commit()
    with pytest.raises(ConsentError) as caught:
        await store_statement(value["account_id"], value)
    assert caught.value.reason == vector["expected"]


@pytest.mark.parametrize(
    "mutation",
    [
        {"version": True},
        {"version": 2},
        {"enabled": 1},
        {"issued_at_ms": True},
        {"issued_at_ms": -1},
        {"issued_at_ms": U64_MAX + 1},
        {"extra": 1},
        {"carried_endorsements": None},
        {"carried_endorsements": {}},
        {"carried_endorsements": [{}] * 65},
        {"carried_endorsements": [{}]},
        {"account_id": "invalid"},
        {"signer_device_id": "invalid"},
        {"signer_public_key": "="},
        {"signature": "="},
        {"signature": 1},
    ],
)
def test_envelope_refusals(mutation):
    with pytest.raises(ConsentError) as caught:
        verify_statement({**VECTORS["positive"][0]["consent"], **mutation})
    assert caught.value.reason == ConsentReason.INVALID_ENVELOPE


def test_noncanonical_encodings_duplicate_fields_and_oversize():
    value = copy.deepcopy(VECTORS["positive"][0]["consent"])
    for field in ("signer_public_key", "signature"):
        with pytest.raises(ConsentError):
            verify_statement({**value, field: value[field] + "="})
    for field in ("account_id", "signer_device_id"):
        with pytest.raises(ConsentError):
            verify_statement({**value, field: value[field].replace("-", "")})
    raw = json.dumps(value).encode()
    with pytest.raises(ConsentError):
        verify_statement(raw[:-1] + b', "enabled": false}')
    with pytest.raises(ConsentError):
        verify_statement(b" " * 65536 + raw)


def test_signature_mutation_is_typed():
    value = VECTORS["positive"][0]["consent"]
    with pytest.raises(ConsentError) as caught:
        verify_statement({**value, "enabled": not value["enabled"]})
    assert caught.value.reason == ConsentReason.INVALID_SIGNATURE


@pytest.mark.parametrize(
    ("current", "clock", "expected"),
    [
        (None, 0, 0),
        (None, 100, 100),
        (0, 0, 1),
        (50, 100, 100),
        (100, 100, 101),
        (FUTURE_MS - 1, 0, FUTURE_MS),
        (U64_MAX - 1, U64_MAX, U64_MAX),
    ],
)
def test_timestamp_edges(current, clock, expected):
    assert next_timestamp(current, clock_ms=clock) == expected


@pytest.mark.parametrize(
    ("current", "clock", "reason"),
    [
        (FUTURE_MS, 0, ConsentReason.FUTURE_TIMESTAMP),
        (U64_MAX, U64_MAX, ConsentReason.TIMESTAMP_OVERFLOW),
        (None, U64_MAX + 1, ConsentReason.TIMESTAMP_OVERFLOW),
        (-1, 0, ConsentReason.TIMESTAMP_OVERFLOW),
    ],
)
def test_timestamp_refuses_without_clamping(current, clock, reason):
    with pytest.raises(ConsentError) as caught:
        next_timestamp(current, clock_ms=clock)
    assert caught.value.reason == reason


async def test_ordering_off_tie_and_no_expiry(app):
    value, key = await seed_statement()
    assert await is_sharing_on(value["account_id"])
    for mutation in ({}, {"issued_at_ms": 999}):
        with pytest.raises(ConsentError) as caught:
            await store_statement(value["account_id"], sign({**value, **mutation}, key))
        assert caught.value.reason == ConsentReason.STALE_STATEMENT
    off = sign({**value, "enabled": False}, key)
    await store_statement(value["account_id"], off)
    assert await get_statement(value["account_id"]) == off
    assert not await is_sharing_on(value["account_id"])
    with pytest.raises(ConsentError) as caught:
        await store_statement(value["account_id"], value)
    assert caught.value.reason == ConsentReason.STALE_STATEMENT
    newer = sign({**value, "issued_at_ms": 1001}, key)
    await store_statement(value["account_id"], newer)
    assert await get_statement(value["account_id"]) == newer


@pytest.mark.parametrize("action", ["revoke", "delete"])
async def test_removal_keeps_signed_history_and_floor(app, action):
    value, _key = await seed_statement()
    async with get_sessionmaker()() as session:
        if action == "revoke":
            await session.execute(update(BrowserDevice).values(revoked_at=_utcnow()))
        else:
            await session.execute(delete(BrowserDevice))
        await session.commit()
    assert not await is_sharing_on(value["account_id"])
    assert await get_statement(value["account_id"]) == value
    assert next_timestamp(value["issued_at_ms"], clock_ms=0) == 1001
    async with get_sessionmaker()() as session:
        row = await session.get(SupportLogConsent, value["account_id"])
        assert row.enabled
        assert (row.signer_device_id is None) == (action == "delete")


async def test_storage_typed_refusals(app):
    value, key = await seed_statement()

    async def refused(caller, statement, reason, **kwargs):
        with pytest.raises(ConsentError) as caught:
            await store_statement(caller, statement, **kwargs)
        assert caught.value.reason == reason

    await refused(str(uuid.uuid4()), value, ConsentReason.ACCOUNT_MISMATCH)
    await refused(
        value["account_id"],
        sign({**value, "issued_at_ms": FUTURE_MS + 1}, key),
        ConsentReason.FUTURE_TIMESTAMP,
        clock_ms=0,
    )
    await refused(
        value["account_id"],
        sign({**value, "signer_device_id": str(uuid.uuid4())}, key),
        ConsentReason.SIGNER_UNTRUSTED,
    )
    other_key = Ed25519PrivateKey.generate()
    mismatch = {**value, "signer_public_key": b64(other_key.public_key().public_bytes_raw())}
    await refused(value["account_id"], sign(mismatch, other_key), ConsentReason.SIGNER_KEY_MISMATCH)
    async with get_sessionmaker()() as session:
        await session.execute(update(BrowserDevice).values(revoked_at=_utcnow()))
        await session.commit()
    await refused(value["account_id"], value, ConsentReason.SIGNER_REMOVED)


async def test_full_unsigned_range_and_future_boundary(app):
    value, key = await seed_statement(issued=U64_MAX)
    assert (await get_statement(value["account_id"]))["issued_at_ms"] == U64_MAX
    # A fresh account admits the exact future boundary.
    value, key = await seed_statement(issued=0)
    await store_statement(
        value["account_id"], sign({**value, "issued_at_ms": FUTURE_MS}, key), clock_ms=0
    )


async def test_carried_endorsements_preserved(app):
    value, key = await seed_statement()
    carried = VECTORS["negative"][1]["consent"]["carried_endorsements"]
    value = sign({**value, "issued_at_ms": 1001, "carried_endorsements": carried}, key)
    await store_statement(value["account_id"], value)
    assert (await get_statement(value["account_id"]))["carried_endorsements"] == carried


async def test_concurrent_first_write_and_off_tie(file_sqlite_client):
    import asyncio

    value, key = await seed_statement()
    async with get_sessionmaker()() as session:
        await session.execute(delete(SupportLogConsent))
        await session.commit()
    assert await get_statement(value["account_id"]) is None
    newer = sign({**value, "issued_at_ms": 1001}, key)
    results = await asyncio.gather(
        store_statement(value["account_id"], value),
        store_statement(value["account_id"], newer),
        return_exceptions=True,
    )
    assert all(
        not isinstance(result, Exception)
        or isinstance(result, ConsentError)
        and result.reason == ConsentReason.STALE_STATEMENT
        for result in results
    )
    assert await get_statement(value["account_id"]) == newer
    on = sign({**value, "issued_at_ms": 1002}, key)
    off = sign({**on, "enabled": False}, key)
    await asyncio.gather(
        store_statement(value["account_id"], on),
        store_statement(value["account_id"], off),
        return_exceptions=True,
    )
    assert await get_statement(value["account_id"]) == off
