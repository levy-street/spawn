"""Support statements are signed by devices, never authorized by this server.

These checks keep junk out of storage. Each daemon independently checks the
signature, account proof and signer trust against its own retained approvals.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from enum import StrEnum

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from fastapi import HTTPException
from sqlalchemy import and_, event, exists, literal, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .browser_registration import decode_ed25519_signature
from .db import get_sessionmaker
from .host_identity import _decode_strict_ed25519_point, decode_ed25519_public_key
from .models import BrowserDevice, SupportLogCollection, SupportLogConsent, _utcnow
from .ws.signed_signal_relay import sanitize_carried_endorsements

MAGIC = b"SPAWN-SUPPORT-LOG-CONSENT-V1"
U64_MAX = (1 << 64) - 1
FUTURE_MS = 86_400_000
_statement_generations: dict[str, int] = {}


def statement_generation(user_id: str) -> int:
    return _statement_generations.get(user_id, 0)


class ConsentReason(StrEnum):
    INVALID_ENVELOPE = "invalid_envelope"
    INVALID_SIGNATURE = "invalid_signature"
    ACCOUNT_MISMATCH = "account_mismatch"
    SIGNER_UNTRUSTED = "signer_untrusted"
    SIGNER_REMOVED = "signer_removed"
    SIGNER_KEY_MISMATCH = "signer_key_mismatch"
    FUTURE_TIMESTAMP = "future_timestamp"
    STALE_STATEMENT = "stale_statement"
    TIMESTAMP_OVERFLOW = "timestamp_overflow"


class ConsentError(ValueError):
    def __init__(self, reason: ConsentReason):
        self.reason = reason
        super().__init__(reason.value)


def now_ms() -> int:
    return time.time_ns() // 1_000_000


def next_timestamp(current_issued_at_ms: int | None, *, clock_ms: int | None = None) -> int:
    clock = now_ms() if clock_ms is None else clock_ms
    for value in (clock, current_issued_at_ms):
        if value is not None and (type(value) is not int or not 0 <= value <= U64_MAX):
            raise ConsentError(ConsentReason.TIMESTAMP_OVERFLOW)
    candidate = max(clock, 0 if current_issued_at_ms is None else current_issued_at_ms + 1)
    if candidate > U64_MAX:
        raise ConsentError(ConsentReason.TIMESTAMP_OVERFLOW)
    if candidate > clock + FUTURE_MS:
        raise ConsentError(ConsentReason.FUTURE_TIMESTAMP)
    return candidate


def canonical_uuid(value: str) -> bytes:
    try:
        parsed = uuid.UUID(value)
        if str(parsed) != value:
            raise ValueError
        return parsed.bytes
    except (ValueError, TypeError, AttributeError) as exc:
        raise ConsentError(ConsentReason.INVALID_ENVELOPE) from exc


def encode_transcript(statement: dict) -> bytes:
    if type(statement.get("version")) is not int or statement["version"] != 1:
        raise ConsentError(ConsentReason.INVALID_ENVELOPE)
    if type(statement.get("enabled")) is not bool:
        raise ConsentError(ConsentReason.INVALID_ENVELOPE)
    issued = statement.get("issued_at_ms")
    if type(issued) is not int or not 0 <= issued <= U64_MAX:
        raise ConsentError(ConsentReason.INVALID_ENVELOPE)
    try:
        key = decode_ed25519_public_key(statement["signer_public_key"])
        return (
            MAGIC
            + b"\x01"
            + canonical_uuid(statement["account_id"])
            + key
            + canonical_uuid(statement["signer_device_id"])
            + bytes([statement["enabled"]])
            + issued.to_bytes(8, "big")
        )
    except (HTTPException, KeyError, TypeError) as exc:
        raise ConsentError(ConsentReason.INVALID_ENVELOPE) from exc


def strict_json(body: bytes | str):
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON field")
            result[key] = value
        return result

    def reject_constant(_value):
        raise ValueError("non-JSON number")

    if isinstance(body, bytes):
        body = body.decode("utf-8")
    return json.loads(body, object_pairs_hook=object_pairs, parse_constant=reject_constant)


def verify_statement(value: dict | bytes) -> dict:
    """Validate the envelope without inventing server-side device trust."""
    try:
        raw = value if isinstance(value, bytes) else json.dumps(value).encode("utf-8")
        if len(raw) > 65536:
            raise ValueError
        statement = strict_json(raw)
        required = {
            "version",
            "account_id",
            "signer_public_key",
            "signer_device_id",
            "enabled",
            "issued_at_ms",
            "signature",
        }
        if not isinstance(statement, dict) or not required <= statement.keys():
            raise ValueError
        if statement.keys() - required - {"carried_endorsements"}:
            raise ValueError
        carried = statement.get("carried_endorsements", [])
        if not isinstance(carried, list) or (
            carried != [] and sanitize_carried_endorsements(carried) != carried
        ):
            raise ValueError
        transcript = encode_transcript(statement)
        signature = decode_ed25519_signature(statement["signature"])
    except (ValueError, TypeError, HTTPException, RecursionError) as exc:
        raise ConsentError(ConsentReason.INVALID_ENVELOPE) from exc
    try:
        # Match strict Ed25519 verification, including a non-weak canonical R.
        _decode_strict_ed25519_point(signature[:32])
        Ed25519PublicKey.from_public_bytes(transcript[45:77]).verify(signature, transcript)
    except (InvalidSignature, ValueError) as exc:
        raise ConsentError(ConsentReason.INVALID_SIGNATURE) from exc
    return statement


def live_signer(user_id, device_id, public_key):
    return exists(
        select(BrowserDevice.id).where(
            BrowserDevice.owner_user_id == user_id,
            BrowserDevice.id == device_id,
            BrowserDevice.public_key == public_key,
            BrowserDevice.revoked_at.is_(None),
        )
    )


def enabled_statement_time(user_id):
    """Query the enabled statement only while the roster still admits its signer."""
    return select(SupportLogConsent.issued_at_ms).where(
        SupportLogConsent.owner_user_id == user_id,
        SupportLogConsent.enabled.is_(True),
        live_signer(
            SupportLogConsent.owner_user_id,
            SupportLogConsent.signer_device_id,
            SupportLogConsent.signer_public_key,
        ),
    )


def sharing_on(user_id):
    return enabled_statement_time(user_id).exists()


async def is_sharing_on(user_id: str) -> bool:
    async with get_sessionmaker()() as session:
        return bool(await session.scalar(select(sharing_on(user_id))))


async def get_statement(user_id: str) -> dict | None:
    async with get_sessionmaker()() as session:
        row = await session.get(SupportLogConsent, user_id)
        return _envelope(row)


def _envelope(row: SupportLogConsent | None) -> dict | None:
    if row is None:
        return None
    return {
        "version": 1,
        "account_id": row.owner_user_id,
        "enabled": row.enabled,
        "issued_at_ms": row.issued_at_ms,
        "signer_device_id": row.signed_device_id,
        "signer_public_key": row.signer_public_key,
        "signature": row.signature,
        "carried_endorsements": row.carried_endorsements,
    }


async def effective_statement(user_id: str) -> dict | None:
    consent = SupportLogConsent
    async with get_sessionmaker()() as session:
        row = await session.scalar(
            select(consent).where(
                consent.owner_user_id == user_id,
                or_(
                    consent.enabled.is_(False),
                    live_signer(user_id, consent.signer_device_id, consent.signer_public_key),
                ),
            )
        )
        return _envelope(row)


async def store_statement(
    user_id: str, value: dict | bytes, *, clock_ms: int | None = None, store=None
):
    from .support_log import cancel_open
    from .support_log_retention import remove_files

    statement = await asyncio.to_thread(verify_statement, value)
    if statement["account_id"] != user_id:
        raise ConsentError(ConsentReason.ACCOUNT_MISMATCH)
    clock = now_ms() if clock_ms is None else clock_ms
    if statement["issued_at_ms"] > clock + FUTURE_MS:
        raise ConsentError(ConsentReason.FUTURE_TIMESTAMP)
    values = dict(
        owner_user_id=user_id,
        enabled=statement["enabled"],
        issued_at_ms=statement["issued_at_ms"],
        signer_device_id=statement["signer_device_id"],
        signed_device_id=statement["signer_device_id"],
        signer_public_key=statement["signer_public_key"],
        signature=statement["signature"],
        carried_endorsements=statement.get("carried_endorsements", []),
        updated_at=_utcnow(),
    )
    table = SupportLogConsent.__table__
    async with get_sessionmaker()() as session:
        insert = sqlite_insert if session.bind.dialect.name == "sqlite" else pg_insert
        # One conditional upsert covers both first-write races and monotonic updates.
        stmt = insert(table).from_select(
            list(values),
            select(
                *[literal(value, type_=table.c[key].type) for key, value in values.items()]
            ).where(live_signer(user_id, values["signer_device_id"], values["signer_public_key"])),
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=[table.c.owner_user_id],
            set_=values,
            where=or_(
                table.c.issued_at_ms < values["issued_at_ms"],
                and_(
                    table.c.issued_at_ms == values["issued_at_ms"],
                    table.c.enabled.is_(True),
                    literal(not values["enabled"]),
                ),
            ),
        ).returning(table.c.owner_user_id)
        saved = (await session.execute(stmt)).scalar_one_or_none()
        if saved is None:
            device = await session.get(BrowserDevice, values["signer_device_id"])
            if device is None or device.owner_user_id != user_id:
                reason = ConsentReason.SIGNER_UNTRUSTED
            elif device.revoked_at is not None:
                reason = ConsentReason.SIGNER_REMOVED
            elif device.public_key != values["signer_public_key"]:
                reason = ConsentReason.SIGNER_KEY_MISMATCH
            else:
                reason = ConsentReason.STALE_STATEMENT
            raise ConsentError(reason)
        files = []
        if not statement["enabled"]:
            now = _utcnow()
            await cancel_open(session, user_id, now)
            deleted = await session.scalars(
                update(SupportLogCollection)
                .where(
                    SupportLogCollection.owner_user_id == user_id,
                    SupportLogCollection.state == "collected",
                )
                .values(state="deleted", deleted_at=now)
                .returning(SupportLogCollection.id)
            )
            files = deleted.all()
        # Publish the change before commit() yields to return the connection to its pool.
        @event.listens_for(session.sync_session, "after_commit")
        def advance_generation(_session):
            _statement_generations[user_id] = statement_generation(user_id) + 1

        await session.commit()
    if store is not None and files:
        await remove_files(store, files)
    return statement
