"""Device-code OAuth-style flow for daemon (`spawnd`) onboarding."""

from __future__ import annotations

import base64
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..config import get_settings
from ..db import get_session
from ..host_identity import host_key_fingerprint
from ..host_key_claims import create_or_lock_host_key_claim, lock_host_key_claim
from ..host_pair_approval import verify_host_pair_approval_proof
from ..host_pair_possession import verify_host_pair_possession_proof
from ..models import BrowserDevice, DeviceCode, Host, HostBrowserPin, User

router = APIRouter(prefix="/api/auth/device", tags=["device"])

DEVICE_CODE_TTL_SECONDS = (
    30 * 60
)  # 30 minutes — comfortable for "see code, switch to phone, approve".
POLL_INTERVAL_SECONDS = 5
USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I
MAX_BROWSER_PINS_PER_HOST = 32


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite drops tzinfo. Re-attach UTC if missing so comparisons work."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def _gen_user_code() -> str:
    a = "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(4))
    b = "".join(secrets.choice(USER_CODE_ALPHABET) for _ in range(4))
    return f"{a}-{b}"


def _gen_device_code() -> str:
    return secrets.token_urlsafe(32)


def _gen_approval_nonce() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")


async def _expire_device_code(
    session: AsyncSession,
    *,
    device_code: str,
    host_key_algorithm: str,
    host_public_key: str,
    now: datetime,
) -> None:
    """Commit an expiry transition in the shared claim-first lock order."""

    await lock_host_key_claim(
        session,
        host_key_algorithm=host_key_algorithm,
        host_public_key=host_public_key,
    )
    await session.execute(
        update(DeviceCode)
        .where(
            DeviceCode.device_code == device_code,
            DeviceCode.expires_at <= now,
            DeviceCode.status != "consuming",
        )
        .values(status="expired", last_polled_at=now)
        .execution_options(synchronize_session=False)
    )
    await session.commit()


@router.post("/start", response_model=schemas.DeviceStartResponse)
async def device_start(
    body: schemas.DeviceStartRequest,
    session: AsyncSession = Depends(get_session),
) -> schemas.DeviceStartResponse:
    now = _utcnow()
    expires_at = now + timedelta(seconds=DEVICE_CODE_TTL_SECONDS)

    # Existing host keys have a retained ownership claim. Taking its write
    # fence before inserting the ceremony makes start linearize with deletion:
    # a start committed before deletion is removed, while one that begins after
    # committed deletion is a deliberately fresh re-pair attempt.
    await lock_host_key_claim(
        session,
        host_key_algorithm=body.host_key_algorithm,
        host_public_key=body.host_public_key,
    )

    # Retry user_code generation on rare collision.
    for _ in range(8):
        user_code = _gen_user_code()
        existing = (
            await session.execute(select(DeviceCode).where(DeviceCode.user_code == user_code))
        ).scalar_one_or_none()
        if existing is None:
            break
    else:
        raise HTTPException(status_code=500, detail="could not allocate user_code")

    dc = DeviceCode(
        device_code=_gen_device_code(),
        user_code=user_code,
        host_name=body.host_name,
        os=body.os,
        arch=body.arch,
        version=body.version,
        host_key_algorithm=body.host_key_algorithm,
        host_public_key=body.host_public_key,
        approval_nonce=_gen_approval_nonce(),
        status="pending",
        expires_at=expires_at,
    )
    session.add(dc)
    try:
        await session.commit()
    except IntegrityError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail="could not allocate device code; retry") from exc

    assert dc.approval_nonce is not None
    return schemas.DeviceStartResponse(
        device_code=dc.device_code,
        user_code=dc.user_code,
        approval_nonce=dc.approval_nonce,
        verification_uri=f"{get_settings().public_url.rstrip('/')}/device",
        interval=POLL_INTERVAL_SECONDS,
        expires_in=DEVICE_CODE_TTL_SECONDS,
    )


@router.post("/possession", response_model=schemas.DevicePossessionResponse)
async def device_possession(
    body: schemas.DevicePossessionRequest,
    session: AsyncSession = Depends(get_session),
) -> schemas.DevicePossessionResponse:
    """Activate one ceremony only after its host proves private-key possession."""

    verify_host_pair_possession_proof(
        device_code_wire=body.device_code,
        approval_nonce_wire=body.approval_nonce,
        host_public_key_wire=body.host_public_key,
        signature_wire=body.signature,
    )
    now = _utcnow()

    # Preserve the F8 claim-first ordering shared by start, approval, poll, and
    # Host deletion. Existing-host deletion therefore either fences this
    # unproved code first or waits for the exact proof transition to commit.
    await lock_host_key_claim(
        session,
        host_key_algorithm=body.host_key_algorithm,
        host_public_key=body.host_public_key,
    )
    verified = (
        await session.execute(
            update(DeviceCode)
            .where(
                DeviceCode.device_code == body.device_code,
                DeviceCode.approval_nonce == body.approval_nonce,
                DeviceCode.host_key_algorithm == body.host_key_algorithm,
                DeviceCode.host_public_key == body.host_public_key,
                DeviceCode.status == "pending",
                DeviceCode.host_possession_version.is_(None),
                DeviceCode.host_possession_verified_at.is_(None),
                DeviceCode.expires_at > now,
            )
            .values(
                host_possession_version=1,
                host_possession_verified_at=now,
            )
            .returning(DeviceCode.device_code)
            .execution_options(synchronize_session=False)
        )
    ).scalar_one_or_none()
    if verified is not None:
        await session.commit()
        return schemas.DevicePossessionResponse(verified=True, version=1)

    # Release any claim/row lock before diagnosing a lost conditional update.
    # An exact already-verified tuple is the sole idempotent retry case.
    await session.rollback()
    snapshot = (
        await session.execute(
            select(
                DeviceCode.approval_nonce,
                DeviceCode.host_key_algorithm,
                DeviceCode.host_public_key,
                DeviceCode.host_possession_version,
                DeviceCode.host_possession_verified_at,
                DeviceCode.status,
                DeviceCode.expires_at,
            ).where(DeviceCode.device_code == body.device_code)
        )
    ).mappings().one_or_none()
    if snapshot is None:
        raise HTTPException(status_code=404, detail="unknown device code")
    if (
        snapshot["approval_nonce"] != body.approval_nonce
        or snapshot["host_key_algorithm"] != body.host_key_algorithm
        or snapshot["host_public_key"] != body.host_public_key
    ):
        raise HTTPException(status_code=409, detail="device ceremony binding changed")
    expires = _aware(snapshot["expires_at"])
    if expires is None or expires <= now:
        raise HTTPException(status_code=400, detail="device code expired")
    if (
        snapshot["host_possession_version"] == 1
        and snapshot["host_possession_verified_at"] is not None
    ):
        return schemas.DevicePossessionResponse(verified=True, version=1)
    raise HTTPException(status_code=409, detail="device ceremony is no longer provable")


@router.post("/poll")
async def device_poll(
    body: schemas.DevicePollRequest,
    session: AsyncSession = Depends(get_session),
) -> dict:
    now = _utcnow()
    poll_cutoff = now - timedelta(seconds=POLL_INTERVAL_SECONDS - 1)

    # For an already-claimed key this is the common first write used by start,
    # approval, poll, and deletion. It prevents a poll claim from crossing a
    # committed revocation boundary on both SQLite and PostgreSQL.
    claimed_owner = await lock_host_key_claim(
        session,
        host_key_algorithm=body.host_key_algorithm,
        host_public_key=body.host_public_key,
    )

    # Claim first, before loading an ORM entity. On SQLite this write-first
    # transition serializes competing writers without read-to-write upgrade
    # deadlocks; on PostgreSQL the conditional UPDATE provides the same CAS.
    # RETURNING supplies the immutable ceremony snapshot without introducing a
    # tracked DeviceCode that an autoflush could later race against deletion.
    claim_result = await session.execute(
        update(DeviceCode)
        .where(
            DeviceCode.device_code == body.device_code,
            DeviceCode.status == "approved",
            DeviceCode.user_id.is_not(None),
            DeviceCode.host_key_algorithm == body.host_key_algorithm,
            DeviceCode.host_public_key == body.host_public_key,
            DeviceCode.browser_device_id.is_not(None),
            DeviceCode.browser_key_algorithm == "ed25519",
            DeviceCode.browser_public_key.is_not(None),
            DeviceCode.browser_key_fingerprint.is_not(None),
            DeviceCode.host_possession_version == 1,
            DeviceCode.host_possession_verified_at.is_not(None),
            DeviceCode.expires_at > now,
            or_(
                DeviceCode.last_polled_at.is_(None),
                DeviceCode.last_polled_at <= poll_cutoff,
            ),
        )
        .values(status="consuming", last_polled_at=now)
        .returning(
            DeviceCode.user_id,
            DeviceCode.host_name,
            DeviceCode.os,
            DeviceCode.arch,
            DeviceCode.version,
            DeviceCode.browser_device_id,
            DeviceCode.browser_key_algorithm,
            DeviceCode.browser_public_key,
            DeviceCode.browser_key_fingerprint,
        )
        .execution_options(synchronize_session=False)
    )
    claimed = claim_result.mappings().one_or_none()

    if claimed is None:
        # Release the write transaction before examining why the CAS lost. A
        # concurrent winner may already have deleted the row by the time this
        # fresh read begins, which is the stable one-shot expired response.
        await session.rollback()
        snapshot = (
            (
                await session.execute(
                    select(
                        DeviceCode.host_key_algorithm,
                        DeviceCode.host_public_key,
                        DeviceCode.status,
                        DeviceCode.user_id,
                        DeviceCode.host_possession_version,
                        DeviceCode.host_possession_verified_at,
                        DeviceCode.expires_at,
                        DeviceCode.last_polled_at,
                    ).where(DeviceCode.device_code == body.device_code)
                )
            )
            .mappings()
            .one_or_none()
        )
        if snapshot is None:
            return {"error": "expired_token"}

        if (
            snapshot["host_key_algorithm"] is None
            or snapshot["host_public_key"] is None
            or snapshot["host_key_algorithm"] != body.host_key_algorithm
            or snapshot["host_public_key"] != body.host_public_key
        ):
            return {"error": "invalid_device_binding"}

        expires = _aware(snapshot["expires_at"])
        if expires is not None and expires <= now:
            await session.rollback()
            await _expire_device_code(
                session,
                device_code=body.device_code,
                host_key_algorithm=body.host_key_algorithm,
                host_public_key=body.host_public_key,
                now=now,
            )
            return {"error": "expired_token"}

        if (
            snapshot["host_possession_version"] != 1
            or snapshot["host_possession_verified_at"] is None
        ):
            await session.rollback()
            return {"error": "authorization_pending"}

        # A claimed ceremony is already one-shot even while its winning
        # transaction is still creating the Host. Never expose that transient
        # state as pending or slow_down to a losing concurrent poll.
        if snapshot["status"] in {"consuming", "expired"}:
            await session.rollback()
            return {"error": "expired_token"}

        if snapshot["status"] in {"denied", "pin_conflict", "pin_limit"}:
            terminal_error = snapshot["status"]
            await session.execute(
                update(DeviceCode)
                .where(
                    DeviceCode.device_code == body.device_code,
                    DeviceCode.status == terminal_error,
                )
                .values(last_polled_at=now)
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return {"error": terminal_error}

        last = _aware(snapshot["last_polled_at"])
        if last is not None and (now - last).total_seconds() < (POLL_INTERVAL_SECONDS - 1):
            await session.execute(
                update(DeviceCode)
                .where(
                    DeviceCode.device_code == body.device_code,
                    DeviceCode.status != "consuming",
                )
                .values(last_polled_at=now)
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return {"error": "slow_down"}

        if snapshot["status"] != "approved" or snapshot["user_id"] is None:
            await session.execute(
                update(DeviceCode)
                .where(
                    DeviceCode.device_code == body.device_code,
                    DeviceCode.status != "consuming",
                )
                .values(last_polled_at=now)
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return {"error": "authorization_pending"}

        # An eligible approved snapshot can reach this point only by losing the
        # claim to a concurrent consumer. Keep that loss one-shot and stable.
        await session.rollback()
        return {"error": "expired_token"}

    user_id = claimed["user_id"]
    assert user_id is not None

    if claimed_owner is not None and claimed_owner != user_id:
        await session.execute(
            update(DeviceCode)
            .where(DeviceCode.device_code == body.device_code)
            .values(status="denied")
            .execution_options(synchronize_session=False)
        )
        await session.commit()
        return {"error": "key_conflict"}

    browser_active = (
        await session.execute(
            update(BrowserDevice)
            .where(
                BrowserDevice.id == claimed["browser_device_id"],
                BrowserDevice.owner_user_id == user_id,
                BrowserDevice.key_algorithm == claimed["browser_key_algorithm"],
                BrowserDevice.public_key == claimed["browser_public_key"],
                BrowserDevice.revoked_at.is_(None),
            )
            .values(public_key=claimed["browser_public_key"])
            .returning(BrowserDevice.id)
            .execution_options(synchronize_session=False)
        )
    ).scalar_one_or_none()
    if browser_active is None:
        await session.execute(
            update(DeviceCode)
            .where(
                DeviceCode.device_code == body.device_code,
                DeviceCode.status == "consuming",
            )
            .values(
                status="pending",
                user_id=None,
                browser_device_id=None,
                browser_key_algorithm=None,
                browser_public_key=None,
                browser_key_fingerprint=None,
            )
            .execution_options(synchronize_session=False)
        )
        await session.commit()
        return {"error": "authorization_pending"}

    host = (
        await session.execute(
            select(Host)
            .where(
                Host.host_key_algorithm == body.host_key_algorithm,
                Host.host_public_key == body.host_public_key,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if host is not None and host.owner_user_id != user_id:
        await session.execute(
            update(DeviceCode)
            .where(DeviceCode.device_code == body.device_code)
            .values(status="denied")
            .execution_options(synchronize_session=False)
        )
        await session.commit()
        return {"error": "key_conflict"}

    if claimed_owner is None:
        claimed_owner = await create_or_lock_host_key_claim(
            session,
            host_key_algorithm=body.host_key_algorithm,
            host_public_key=body.host_public_key,
            owner_user_id=user_id,
        )
        if claimed_owner != user_id:
            await session.execute(
                update(DeviceCode)
                .where(DeviceCode.device_code == body.device_code)
                .values(status="denied")
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return {"error": "key_conflict"}

    if host is None:
        candidate = Host(
            owner_user_id=user_id,
            name=claimed["host_name"] or "host",
            os=claimed["os"],
            arch=claimed["arch"],
            version=claimed["version"],
            host_key_algorithm=body.host_key_algorithm,
            host_public_key=body.host_public_key,
            status="offline",
        )
        try:
            # An absent-row SELECT cannot serialize first contact. Keep the
            # claimed DeviceCode transaction alive while a nested savepoint
            # absorbs the expected unique-key race, then lock/reuse the
            # committed winner instead of leaking an IntegrityError as a 500.
            async with session.begin_nested():
                session.add(candidate)
                await session.flush()
            host = candidate
        except IntegrityError:
            host = (
                await session.execute(
                    select(Host)
                    .where(
                        Host.host_key_algorithm == body.host_key_algorithm,
                        Host.host_public_key == body.host_public_key,
                    )
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if host is None:
                await session.execute(
                    update(DeviceCode)
                    .where(DeviceCode.device_code == body.device_code)
                    .values(status="denied")
                    .execution_options(synchronize_session=False)
                )
                await session.commit()
                return {"error": "key_conflict"}
            if host.owner_user_id != user_id:
                await session.execute(
                    update(DeviceCode)
                    .where(DeviceCode.device_code == body.device_code)
                    .values(status="denied")
                    .execution_options(synchronize_session=False)
                )
                await session.commit()
                return {"error": "key_conflict"}
    else:
        # Re-login preserves both host identity and any user-assigned name.
        host.os = claimed["os"]
        host.arch = claimed["arch"]
        host.version = claimed["version"]

    existing_pin = await session.get(
        HostBrowserPin, (host.id, claimed["browser_device_id"])
    )
    pin_values = (
        claimed["browser_key_algorithm"],
        claimed["browser_public_key"],
        claimed["browser_key_fingerprint"],
    )
    if existing_pin is not None:
        existing_values = (
            existing_pin.browser_key_algorithm,
            existing_pin.browser_public_key,
            existing_pin.browser_key_fingerprint,
        )
        if existing_values != pin_values:
            await session.execute(
                update(DeviceCode)
                .where(DeviceCode.device_code == body.device_code)
                .values(status="pin_conflict")
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return {"error": "pin_conflict"}
    else:
        pin_count = (
            await session.execute(
                select(func.count(HostBrowserPin.browser_device_id)).where(
                    HostBrowserPin.host_id == host.id
                )
            )
        ).scalar_one()
        if pin_count >= MAX_BROWSER_PINS_PER_HOST:
            await session.execute(
                update(DeviceCode)
                .where(DeviceCode.device_code == body.device_code)
                .values(status="pin_limit")
                .execution_options(synchronize_session=False)
            )
            await session.commit()
            return {"error": "pin_limit"}
        session.add(
            HostBrowserPin(
                host_id=host.id,
                browser_device_id=claimed["browser_device_id"],
                browser_key_algorithm=pin_values[0],
                browser_public_key=pin_values[1],
                browser_key_fingerprint=pin_values[2],
            )
        )

    token = auth.issue_daemon_token(host.id, user_id)
    fingerprint = host_key_fingerprint(body.host_key_algorithm, body.host_public_key)
    await session.execute(
        delete(DeviceCode)
        .where(
            DeviceCode.device_code == body.device_code,
            DeviceCode.status == "consuming",
        )
        .execution_options(synchronize_session=False)
    )
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        return {"error": "key_conflict"}
    return {
        "access_token": token,
        "host_id": host.id,
        "host_key_algorithm": body.host_key_algorithm,
        "host_public_key": body.host_public_key,
        "host_key_fingerprint": fingerprint,
        "browser_device_id": claimed["browser_device_id"],
        "browser_key_algorithm": claimed["browser_key_algorithm"],
        "browser_public_key": claimed["browser_public_key"],
        "browser_key_fingerprint": claimed["browser_key_fingerprint"],
    }


def _pending_response(dc: DeviceCode) -> schemas.DevicePendingResponse:
    if dc.host_key_algorithm is None or dc.host_public_key is None or dc.approval_nonce is None:
        raise HTTPException(status_code=400, detail="legacy device code must be restarted")
    return schemas.DevicePendingResponse(
        host_name=dc.host_name or "host",
        approval_nonce=dc.approval_nonce,
        host_key_algorithm=dc.host_key_algorithm,
        host_public_key=dc.host_public_key,
        host_key_fingerprint=host_key_fingerprint(dc.host_key_algorithm, dc.host_public_key),
    )


async def _pending_device_code(session: AsyncSession, user_code: str) -> DeviceCode:
    code = user_code.strip().upper()
    dc = (
        await session.execute(select(DeviceCode).where(DeviceCode.user_code == code))
    ).scalar_one_or_none()
    if dc is None:
        raise HTTPException(status_code=404, detail="unknown user code")
    expires = _aware(dc.expires_at)
    if expires is not None and expires <= _utcnow():
        raise HTTPException(status_code=400, detail="user code expired")
    if dc.status != "pending":
        raise HTTPException(status_code=400, detail=f"user code is {dc.status}")
    if dc.host_possession_version != 1 or dc.host_possession_verified_at is None:
        raise HTTPException(status_code=409, detail="host possession proof is pending")
    _pending_response(dc)
    return dc


@router.post("/pending", response_model=schemas.DevicePendingResponse)
async def device_pending(
    body: schemas.DevicePendingRequest,
    session: AsyncSession = Depends(get_session),
    _user: User = Depends(auth.current_user),
) -> schemas.DevicePendingResponse:
    """Inspect the server-derived identity before the user confirms approval."""

    dc = await _pending_device_code(session, body.user_code)
    return _pending_response(dc)


@router.post("/approve", response_model=schemas.DeviceApproveResponse)
async def device_approve(
    body: schemas.DeviceApproveRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.current_user),
) -> schemas.DeviceApproveResponse:
    dc = await _pending_device_code(session, body.user_code)
    assert dc.host_key_algorithm is not None
    assert dc.host_public_key is not None
    reviewed = _pending_response(dc)
    if (
        body.approval_nonce != reviewed.approval_nonce
        or body.host_key_algorithm != reviewed.host_key_algorithm
        or body.host_public_key != reviewed.host_public_key
        or body.host_key_fingerprint != reviewed.host_key_fingerprint
    ):
        raise HTTPException(
            status_code=409,
            detail="host identity changed since review; review the device code again",
        )

    user_id = user.id
    verify_host_pair_approval_proof(
        user_id=user_id,
        approval_nonce_wire=body.approval_nonce,
        host_public_key_wire=body.host_public_key,
        browser_public_key_wire=body.browser_public_key,
        signature_wire=body.signature,
    )

    device_code = dc.device_code
    await session.rollback()
    claimed_owner = await lock_host_key_claim(
        session,
        host_key_algorithm=body.host_key_algorithm,
        host_public_key=body.host_public_key,
    )
    if claimed_owner is not None and claimed_owner != user_id:
        await session.execute(delete(DeviceCode).where(DeviceCode.device_code == device_code))
        await session.commit()
        raise HTTPException(status_code=409, detail="host key is retained by another account")

    browser_claim = (
        await session.execute(
            update(BrowserDevice)
            .where(
                BrowserDevice.id == body.browser_device_id,
                BrowserDevice.owner_user_id == user_id,
                BrowserDevice.key_algorithm == body.browser_key_algorithm,
                BrowserDevice.public_key == body.browser_public_key,
                BrowserDevice.revoked_at.is_(None),
            )
            .values(public_key=body.browser_public_key)
            .returning(BrowserDevice.id)
            .execution_options(synchronize_session=False)
        )
    ).scalar_one_or_none()
    if browser_claim is None:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="browser identity changed or was revoked; review the device code again",
        )

    pinned_host = (
        await session.execute(
            select(Host).where(
                Host.host_key_algorithm == body.host_key_algorithm,
                Host.host_public_key == body.host_public_key,
            )
        )
    ).scalar_one_or_none()
    if pinned_host is not None and pinned_host.owner_user_id != user_id:
        await session.execute(delete(DeviceCode).where(DeviceCode.device_code == device_code))
        await session.commit()
        raise HTTPException(status_code=409, detail="host key is already paired")

    approved = await session.execute(
        update(DeviceCode)
        .where(
            DeviceCode.device_code == device_code,
            DeviceCode.status == "pending",
            DeviceCode.user_id.is_(None),
            DeviceCode.approval_nonce == body.approval_nonce,
            DeviceCode.host_key_algorithm == body.host_key_algorithm,
            DeviceCode.host_public_key == body.host_public_key,
            DeviceCode.browser_device_id.is_(None),
            DeviceCode.host_possession_version == 1,
            DeviceCode.host_possession_verified_at.is_not(None),
        )
        .values(
            status="approved",
            user_id=user_id,
            browser_device_id=body.browser_device_id,
            browser_key_algorithm=body.browser_key_algorithm,
            browser_public_key=body.browser_public_key,
            browser_key_fingerprint=body.browser_key_fingerprint,
        )
        .execution_options(synchronize_session=False)
    )
    if approved.rowcount != 1:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="host identity or approval state changed; review the device code again",
        )
    await session.commit()
    return schemas.DeviceApproveResponse(
        **reviewed.model_dump(),
        browser_device_id=body.browser_device_id,
        browser_key_algorithm=body.browser_key_algorithm,
        browser_public_key=body.browser_public_key,
        browser_key_fingerprint=body.browser_key_fingerprint,
    )
