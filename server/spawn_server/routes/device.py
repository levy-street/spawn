"""Device-code OAuth-style flow for daemon (`spawnd`) onboarding."""

from __future__ import annotations

import base64
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, rate_limit, schemas
from ..config import get_settings
from ..db import get_session
from ..host_identity import host_key_fingerprint
from ..host_key_claims import create_or_lock_host_key_claim, lock_host_key_claim
from ..host_pair_approval import verify_host_pair_approval_proof
from ..host_pair_possession import verify_host_pair_possession_proof
from ..models import BrowserDevice, DeviceCode, Host, HostBrowserPin, SetupClaim, User
from ..pin_liveness import live_browser_device_id_set
from ..push import schedule_pairing_push
from ..trust_events import (
    pair_requested_payload,
    pair_resolved_payload,
    publish_trust_event,
)

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


def _gen_approval_ref() -> str:
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
    await _commit_setup_resolution(session, device_code, "expired", now=now)


async def _resolve_setup_claim(
    session: AsyncSession,
    device_code: str,
    outcome: str,
    *,
    host_id: str | None = None,
    now: datetime | None = None,
) -> tuple[str, dict[str, object]] | None:
    """Resolve the routing claim bound to a terminal ceremony, if any."""

    resolved_at = now or _utcnow()
    claim = (
        await session.execute(
            select(SetupClaim)
            .where(
                SetupClaim.device_code_id == device_code,
                SetupClaim.status.in_(("pending", "ready")),
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if claim is None or claim.approval_ref is None:
        return None
    if outcome == "approved":
        claim.status = "approved"
        claim.error = None
        claim.host_id = host_id
    else:
        claim.status = "failed"
        claim.error = outcome
        claim.host_id = None
    claim.resolved_at = resolved_at
    return (
        claim.user_id,
        pair_resolved_payload(claim.approval_ref, outcome, host_id),
    )


async def _commit_setup_resolution(
    session: AsyncSession,
    device_code: str,
    outcome: str,
    *,
    host_id: str | None = None,
    now: datetime | None = None,
) -> None:
    event = await _resolve_setup_claim(
        session,
        device_code,
        outcome,
        host_id=host_id,
        now=now,
    )
    await session.commit()
    if event is not None:
        await publish_trust_event(*event)


async def _bind_setup_claim(
    session: AsyncSession,
    *,
    device_code: str,
    setup_token: str | None,
    approval_ref: str | None,
    host_name: str | None,
    os_name: str | None,
    host_key_algorithm: str,
    host_public_key: str,
    now: datetime,
) -> tuple[str, dict[str, object], str, str] | None:
    """Bind only the first possession-proved ceremony for a live token."""

    if setup_token is None or approval_ref is None:
        return None
    fingerprint = host_key_fingerprint(host_key_algorithm, host_public_key)
    result = await session.execute(
        update(SetupClaim)
        .where(
            SetupClaim.token == setup_token,
            SetupClaim.status == "pending",
            SetupClaim.device_code_id.is_(None),
            SetupClaim.expires_at > now,
        )
        .values(
            status="ready",
            device_code_id=device_code,
            approval_ref=approval_ref,
            host_name=host_name or "host",
            os=os_name,
            host_key_fingerprint=fingerprint,
        )
        .returning(SetupClaim.user_id)
        .execution_options(synchronize_session=False)
    )
    user_id = result.scalar_one_or_none()
    if user_id is None:
        return None
    display_name = host_name or "host"
    return (
        user_id,
        pair_requested_payload(approval_ref, display_name, os_name, fingerprint),
        approval_ref,
        display_name,
    )


@router.post(
    "/start",
    response_model=schemas.DeviceStartResponse,
    dependencies=[Depends(rate_limit.limiter(rate_limit.DEVICE_PAIRING))],
)
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
        approval_ref=_gen_approval_ref(),
        setup_token=body.setup_token,
        sas_commit=body.sas_commit,
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
        raise HTTPException(
            status_code=409, detail="could not allocate device code; retry"
        ) from exc

    assert dc.approval_nonce is not None
    assert dc.approval_ref is not None
    return schemas.DeviceStartResponse(
        device_code=dc.device_code,
        user_code=dc.user_code,
        approval_ref=dc.approval_ref,
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
        (
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
                .returning(
                    DeviceCode.device_code,
                    DeviceCode.setup_token,
                    DeviceCode.approval_ref,
                    DeviceCode.host_name,
                    DeviceCode.os,
                )
                .execution_options(synchronize_session=False)
            )
        )
        .mappings()
        .one_or_none()
    )
    if verified is not None:
        claim = await _bind_setup_claim(
            session,
            device_code=verified["device_code"],
            setup_token=verified["setup_token"],
            approval_ref=verified["approval_ref"],
            host_name=verified["host_name"],
            os_name=verified["os"],
            host_key_algorithm=body.host_key_algorithm,
            host_public_key=body.host_public_key,
            now=now,
        )
        await session.commit()
        if claim is not None:
            user_id, payload, approval_ref, display_name = claim
            await publish_trust_event(user_id, payload)
            schedule_pairing_push(user_id, approval_ref, display_name)
        return schemas.DevicePossessionResponse(
            verified=True,
            version=1,
            attended=claim is not None,
        )

    # Release any claim/row lock before diagnosing a lost conditional update.
    # An exact already-verified tuple is the sole idempotent retry case.
    await session.rollback()
    snapshot = (
        (
            await session.execute(
                select(
                    DeviceCode.approval_nonce,
                    DeviceCode.host_key_algorithm,
                    DeviceCode.host_public_key,
                    DeviceCode.host_possession_version,
                    DeviceCode.host_possession_verified_at,
                    DeviceCode.status,
                    DeviceCode.expires_at,
                    DeviceCode.setup_token,
                ).where(DeviceCode.device_code == body.device_code)
            )
        )
        .mappings()
        .one_or_none()
    )
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
        attended = False
        if snapshot["setup_token"] is not None:
            attended = (
                await session.execute(
                    select(SetupClaim.id).where(
                        SetupClaim.token == snapshot["setup_token"],
                        SetupClaim.device_code_id == body.device_code,
                        SetupClaim.status.in_(("ready", "approved")),
                        SetupClaim.expires_at > now,
                    )
                )
            ).scalar_one_or_none() is not None
        return schemas.DevicePossessionResponse(
            verified=True,
            version=1,
            attended=attended,
        )
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
            DeviceCode.browser_approval_signature,
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
            event = await _resolve_setup_claim(
                session,
                body.device_code,
                terminal_error,
                now=now,
            )
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
            if event is not None:
                await publish_trust_event(*event)
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
        await _commit_setup_resolution(session, body.device_code, "key_conflict")
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
                # The proof is bound to the browser key being cleared here, so
                # it must go with it: a stale signature would otherwise outlive
                # the binding it attests to and be handed to the daemon on a
                # later approval by a different browser.
                browser_approval_signature=None,
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
        await _commit_setup_resolution(session, body.device_code, "key_conflict")
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
            await _commit_setup_resolution(session, body.device_code, "key_conflict")
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
                await _commit_setup_resolution(session, body.device_code, "key_conflict")
                return {"error": "key_conflict"}
            if host.owner_user_id != user_id:
                await session.execute(
                    update(DeviceCode)
                    .where(DeviceCode.device_code == body.device_code)
                    .values(status="denied")
                    .execution_options(synchronize_session=False)
                )
                await _commit_setup_resolution(session, body.device_code, "key_conflict")
                return {"error": "key_conflict"}
    else:
        # Re-login preserves both host identity and any user-assigned name.
        host.os = claimed["os"]
        host.arch = claimed["arch"]
        host.version = claimed["version"]

    existing_pin = await session.get(HostBrowserPin, (host.id, claimed["browser_device_id"]))
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
            await _commit_setup_resolution(session, body.device_code, "pin_conflict")
            return {"error": "pin_conflict"}
    else:
        pin_count = len(await live_browser_device_id_set(session, host.id))
        if pin_count >= MAX_BROWSER_PINS_PER_HOST:
            await session.execute(
                update(DeviceCode)
                .where(DeviceCode.device_code == body.device_code)
                .values(status="pin_limit")
                .execution_options(synchronize_session=False)
            )
            await _commit_setup_resolution(session, body.device_code, "pin_limit")
            return {"error": "pin_limit"}
        session.add(
            HostBrowserPin(
                host_id=host.id,
                browser_device_id=claimed["browser_device_id"],
                browser_key_algorithm=pin_values[0],
                browser_public_key=pin_values[1],
                browser_key_fingerprint=pin_values[2],
                delivered_at=now,
            )
        )

    token = auth.issue_daemon_token(host.id, user_id)
    fingerprint = host_key_fingerprint(body.host_key_algorithm, body.host_public_key)
    event = await _resolve_setup_claim(
        session,
        body.device_code,
        "approved",
        host_id=host.id,
        now=now,
    )
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
        await session.execute(
            update(DeviceCode)
            .where(DeviceCode.device_code == body.device_code)
            .values(status="denied")
            .execution_options(synchronize_session=False)
        )
        await _commit_setup_resolution(session, body.device_code, "key_conflict")
        return {"error": "key_conflict"}
    if event is not None:
        await publish_trust_event(*event)
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
        # The account ID and the browser's approval signature let the daemon
        # verify the SPAWN-HOST-PAIR-APPROVE-V1 transcript against the approval
        # nonce and host key it already holds from its own device/start call.
        "account_id": claimed["user_id"],
        "browser_approval_signature": claimed["browser_approval_signature"],
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
        sas_commit=dc.sas_commit,
        sas_host_nonce=dc.sas_host_nonce,
    )


async def _pending_device_code(
    session: AsyncSession,
    *,
    user_code: str | None = None,
    approval_ref: str | None = None,
) -> DeviceCode:
    # Identify by exactly one of the two handles (the schema guarantees this):
    # the opaque URL ref the browser normally sends, or the short user_code from
    # the manual-entry form.
    if approval_ref:
        where = DeviceCode.approval_ref == approval_ref.strip()
    else:
        assert user_code is not None
        where = DeviceCode.user_code == user_code.strip().upper()
    dc = (await session.execute(select(DeviceCode).where(where))).scalar_one_or_none()
    if dc is None:
        raise HTTPException(status_code=404, detail="unknown device code")
    expires = _aware(dc.expires_at)
    if expires is not None and expires <= _utcnow():
        await _commit_setup_resolution(session, dc.device_code, "expired")
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

    dc = await _pending_device_code(
        session, user_code=body.user_code, approval_ref=body.approval_ref
    )
    return _pending_response(dc)


@router.post("/sas", response_model=schemas.DeviceSasResponse)
async def device_sas(
    body: schemas.DeviceSasRequest,
    session: AsyncSession = Depends(get_session),
    _user: User = Depends(auth.current_user),
) -> schemas.DeviceSasResponse:
    """LEGACY (pre-fragment daemons only). Browser's committed-ephemeral SAS
    contribution: its nonce Nb and key B. The server only stores/forwards them
    (it is a dumb relay); the daemon reads them on its next poll and reveals its
    own Nd. Set-once, and only while the ceremony is still pending with a daemon
    commitment present.

    Since 2026-08-21 possession verifies the host key via the out-of-band URL
    fragment instead (docs/TRUST_DEVICE_MESH.md Appendix A note): new daemons
    send no sas_commit and new web builds never call this. It remains so that
    an old daemon paired against an old cached web build keeps working."""

    dc = await _pending_device_code(
        session, user_code=body.user_code, approval_ref=body.approval_ref
    )
    if dc.sas_commit is None:
        # No daemon commitment ⇒ this daemon doesn't speak SAS; nothing to relay.
        raise HTTPException(status_code=409, detail="host did not offer a SAS commitment")
    if dc.sas_browser_nonce is not None or dc.sas_browser_key is not None:
        # Set-once: a second contribution would let a relay swap Nb after seeing Nd.
        raise HTTPException(status_code=409, detail="SAS contribution already recorded")
    await session.execute(
        update(DeviceCode)
        .where(
            DeviceCode.device_code == dc.device_code,
            DeviceCode.sas_browser_nonce.is_(None),
        )
        .values(
            sas_browser_nonce=body.sas_browser_nonce,
            sas_browser_key=body.browser_public_key,
        )
        .execution_options(synchronize_session=False)
    )
    await session.commit()
    return schemas.DeviceSasResponse(ok=True)


@router.post("/sas-host", response_model=schemas.DeviceSasHostResponse)
async def device_sas_host(
    body: schemas.DeviceSasHostRequest,
    session: AsyncSession = Depends(get_session),
) -> schemas.DeviceSasHostResponse:
    """Daemon's SAS handshake, authenticated by the device_code (no user
    session, like poll). Returns the browser's Nb/B once present, and — when the
    daemon supplies its opened Nd (only after it has seen Nb) — records it once.
    Deliberately independent of the approval CAS so the pairing race is untouched.

    Commit-reveal ordering is enforced here: Nd is accepted only while Nb is
    already present, and set-once, so a relay cannot make the daemon reveal Nd
    before the browser has committed to Nb."""
    dc = (
        await session.execute(select(DeviceCode).where(DeviceCode.device_code == body.device_code))
    ).scalar_one_or_none()
    # Match on the daemon's own key; never echo which check failed.
    if (
        dc is None
        or dc.host_key_algorithm != body.host_key_algorithm
        or dc.host_public_key != body.host_public_key
    ):
        raise HTTPException(status_code=404, detail="unknown device code")
    expires = _aware(dc.expires_at)
    if expires is not None and expires <= _utcnow():
        raise HTTPException(status_code=400, detail="device code expired")

    if (
        body.sas_host_nonce is not None
        and dc.sas_browser_nonce is not None
        and dc.sas_host_nonce is None
    ):
        await session.execute(
            update(DeviceCode)
            .where(
                DeviceCode.device_code == dc.device_code,
                DeviceCode.sas_browser_nonce.is_not(None),
                DeviceCode.sas_host_nonce.is_(None),
            )
            .values(sas_host_nonce=body.sas_host_nonce)
            .execution_options(synchronize_session=False)
        )
        await session.commit()
        return schemas.DeviceSasHostResponse(
            sas_browser_nonce=dc.sas_browser_nonce,
            sas_browser_key=dc.sas_browser_key,
            sas_host_nonce=body.sas_host_nonce,
        )
    return schemas.DeviceSasHostResponse(
        sas_browser_nonce=dc.sas_browser_nonce,
        sas_browser_key=dc.sas_browser_key,
        sas_host_nonce=dc.sas_host_nonce,
    )


@router.post("/approve", response_model=schemas.DeviceApproveResponse)
async def device_approve(
    body: schemas.DeviceApproveRequest,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(auth.verified_user),
) -> schemas.DeviceApproveResponse:
    dc = await _pending_device_code(
        session, user_code=body.user_code, approval_ref=body.approval_ref
    )
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
        event = await _resolve_setup_claim(session, device_code, "key_conflict")
        await session.execute(delete(DeviceCode).where(DeviceCode.device_code == device_code))
        await session.commit()
        if event is not None:
            await publish_trust_event(*event)
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
        event = await _resolve_setup_claim(session, device_code, "key_conflict")
        await session.execute(delete(DeviceCode).where(DeviceCode.device_code == device_code))
        await session.commit()
        if event is not None:
            await publish_trust_event(*event)
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
            # Retained (not just verified and dropped) so the daemon can check
            # for itself that this browser consented to this host in this
            # ceremony, instead of trusting the server's assertion.
            browser_approval_signature=body.signature,
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
    # Echo the reviewed identity minus the SAS relay fields (pending-only) and
    # minus the fingerprint (mesh B5: the response carries the keys themselves,
    # so the client derives any fingerprint it needs locally).
    return schemas.DeviceApproveResponse(
        **reviewed.model_dump(exclude={"host_key_fingerprint", "sas_commit", "sas_host_nonce"}),
        browser_device_id=body.browser_device_id,
        browser_key_algorithm=body.browser_key_algorithm,
        browser_public_key=body.browser_public_key,
        host_id=pinned_host.id if pinned_host is not None else None,
    )
