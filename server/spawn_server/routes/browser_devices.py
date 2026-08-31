"""Authenticated browser-device identity registration, listing, and revocation."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..browser_registration import BrowserRegistrationRefusal, verify_browser_registration_proof
from ..db import get_session
from ..models import BrowserDevice, Host, HostBrowserPin, RevokedBrowserKey, User
from ..ws.daemon import push_browser_pins

router = APIRouter(prefix="/api/browser-devices", tags=["browser-devices"])


def _to_out(device: BrowserDevice) -> schemas.BrowserDeviceOut:
    return schemas.BrowserDeviceOut(
        id=device.id,
        key_algorithm="ed25519",
        public_key=device.public_key,
        label=device.label,
        created_at=device.created_at,
        last_seen_at=device.last_seen_at,
        approval_requested_at=device.approval_requested_at,
        revoked_at=device.revoked_at,
        revoked_by_device_id=device.revoked_by_device_id,
        is_root=device.is_root,
    )


def _registration_result(
    device: BrowserDevice, user_id: str, claimed_is_root: bool
) -> schemas.BrowserDeviceOut:
    if device.owner_user_id != user_id:
        raise BrowserRegistrationRefusal(
            status_code=409,
            detail="browser public key is unavailable",
            code="device_key_owned_by_other_account",
        )
    if device.revoked_at is not None:
        raise BrowserRegistrationRefusal(
            status_code=409,
            detail="revoked browser public keys cannot be registered again",
            code="device_key_revoked",
        )
    if device.is_root != claimed_is_root:
        # A key is minted as either the account root or an ordinary device and
        # never changes role. No legitimate client re-registers a key under the
        # other designation, so a mismatch is confusion or mischief — refuse
        # rather than silently answering with a row whose authority differs
        # from what the proof attested.
        raise BrowserRegistrationRefusal(
            status_code=409,
            detail="browser public key is already registered with a different root designation",
            code="root_designation_mismatch",
        )
    return _to_out(device)


@router.post("/register", response_model=schemas.BrowserDeviceOut)
async def register_browser_device(
    body: schemas.BrowserDeviceRegisterRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrowserDeviceOut:
    user_id = user.id
    # The V2 proof binds the root claim: `body.is_root` is only ever consumed
    # after this verification, so the flag the row is inserted with is attested
    # by the key holder, never a bare server-mutable request field (mesh B1).
    verify_browser_registration_proof(
        user_id=user_id,
        public_key_wire=body.public_key,
        signature_wire=body.signature,
        is_root=body.is_root,
    )

    existing = (
        await session.execute(
            select(BrowserDevice)
            .where(
                BrowserDevice.key_algorithm == body.key_algorithm,
                BrowserDevice.public_key == body.public_key,
            )
            .with_for_update()
        )
    ).scalar_one_or_none()
    if existing is not None:
        # Registration reconciles on every app load; that touchpoint is the
        # honest "last seen" for the device. Stamp before answering (revoked
        # tombstones stay untouched — they are history, not presence).
        if existing.owner_user_id == user_id and existing.revoked_at is None:
            existing.last_seen_at = datetime.now(UTC)
            await session.commit()
        return _registration_result(existing, user_id, body.is_root)

    # A key this account revoked stays revoked forever (R10), even after the
    # roster tombstone was pruned away: re-admission takes a fresh ceremony
    # over a NEW key, never re-registration of the old one. Without this check
    # the pruned key would register "successfully" and then be silently refused
    # by every host's deny-list.
    permanently_revoked = (
        await session.execute(
            select(RevokedBrowserKey.public_key).where(
                RevokedBrowserKey.owner_user_id == user_id,
                RevokedBrowserKey.public_key == body.public_key,
            )
        )
    ).scalar_one_or_none()
    if permanently_revoked is not None:
        raise BrowserRegistrationRefusal(
            status_code=409,
            detail="revoked browser public keys cannot be registered again",
            code="device_key_revoked",
        )

    if body.is_root:
        # At most one account root. A live root already present means this is a
        # stale/duplicate mint; refuse rather than fork the account's anchor.
        already_root = (
            await session.execute(
                select(BrowserDevice.id).where(
                    BrowserDevice.owner_user_id == user_id,
                    BrowserDevice.is_root.is_(True),
                    BrowserDevice.revoked_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if already_root is not None:
            raise BrowserRegistrationRefusal(
                status_code=409,
                detail="account already has a root",
                code="root_already_exists",
            )

    device = BrowserDevice(
        id=str(uuid.uuid4()),
        owner_user_id=user_id,
        key_algorithm=body.key_algorithm,
        public_key=body.public_key,
        # Only on first registration. Re-registration returns the existing row,
        # so a name the operator chose is never overwritten by a later default.
        label=body.label,
        is_root=body.is_root,
        last_seen_at=None if body.is_root else datetime.now(UTC),
    )
    session.add(device)
    try:
        await session.commit()
    except IntegrityError:
        # A concurrent tab may have inserted the globally unique key. Resolve
        # that winner after rollback; never update or resurrect it.
        await session.rollback()
        winner = (
            await session.execute(
                select(BrowserDevice).where(
                    BrowserDevice.key_algorithm == body.key_algorithm,
                    BrowserDevice.public_key == body.public_key,
                )
            )
        ).scalar_one_or_none()
        if winner is None:
            if body.is_root:
                # No row with this key means the collision was the live-root
                # partial unique index: a concurrent mint won the race past the
                # app-level check above. Name the real conflict.
                concurrent_root = (
                    await session.execute(
                        select(BrowserDevice.id).where(
                            BrowserDevice.owner_user_id == user_id,
                            BrowserDevice.is_root.is_(True),
                            BrowserDevice.revoked_at.is_(None),
                        )
                    )
                ).scalar_one_or_none()
                if concurrent_root is not None:
                    raise BrowserRegistrationRefusal(
                        status_code=409,
                        detail="account already has a root",
                        code="root_already_exists",
                    ) from None
            raise BrowserRegistrationRefusal(
                status_code=409,
                detail="browser public key is unavailable",
                code="device_key_owned_by_other_account",
            ) from None
        return _registration_result(winner, user_id, body.is_root)
    await session.refresh(device)
    return _to_out(device)


@router.post("/lookup", response_model=schemas.BrowserDeviceLookupResponse)
async def lookup_browser_device(
    body: schemas.BrowserDeviceLookupRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrowserDeviceLookupResponse:
    device = (
        await session.execute(
            select(BrowserDevice).where(
                BrowserDevice.key_algorithm == "ed25519",
                BrowserDevice.public_key == body.public_key,
            )
        )
    ).scalar_one_or_none()
    if device is not None:
        if device.owner_user_id != user.id:
            return schemas.BrowserDeviceLookupResponse(status="other_account")
        return schemas.BrowserDeviceLookupResponse(
            status="revoked" if device.revoked_at is not None else "active"
        )

    permanently_revoked = await session.get(RevokedBrowserKey, (user.id, body.public_key))
    return schemas.BrowserDeviceLookupResponse(
        status="revoked" if permanently_revoked is not None else "unregistered"
    )


@router.get("", response_model=list[schemas.BrowserDeviceOut])
async def list_browser_devices(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.BrowserDeviceOut]:
    devices = (
        (
            await session.execute(
                select(BrowserDevice)
                .where(BrowserDevice.owner_user_id == user.id)
                .order_by(BrowserDevice.created_at.desc(), BrowserDevice.id.desc())
            )
        )
        .scalars()
        .all()
    )
    return [_to_out(device) for device in devices]


@router.get("/revoked-keys", response_model=list[schemas.RevokedBrowserKeyOut])
async def list_revoked_browser_keys(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.RevokedBrowserKeyOut]:
    """The account's permanent key tombstones (R10 deny-list source).

    Read-only corroboration surface (hardening B2): before a client acts
    destructively on a roster row's revocation claim — root rotation retires
    the sealed root — it cross-checks the key against this ADD-ONLY table, so
    a fabricated `revoked_at` on the mutable roster alone is not enough. The
    rows here survive roster pruning and are never deleted.
    """

    rows = (
        (
            await session.execute(
                select(RevokedBrowserKey)
                .where(RevokedBrowserKey.owner_user_id == user.id)
                .order_by(RevokedBrowserKey.revoked_at, RevokedBrowserKey.public_key)
            )
        )
        .scalars()
        .all()
    )
    return [
        schemas.RevokedBrowserKeyOut(
            public_key=row.public_key,
            key_algorithm=row.key_algorithm,
            revoked_at=row.revoked_at,
        )
        for row in rows
    ]


@router.post("/prune", response_model=schemas.BrowserDevicePruneResponse)
async def prune_revoked_browser_devices(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrowserDevicePruneResponse:
    """Hard-delete this account's revoked device ROSTER rows — history only.

    Deletion is fail-closed for pins by the same contract reconciliation relies
    on: a revoked device's own pins are already non-live and cascade away with
    the row, and pins whose endorsement chain ran through it stay severed
    because a dangling endorser id is never admitted (see
    ``_live_browser_device_id_set``).

    It never changes the account's deny-list: every revoked key was mirrored
    into ``revoked_browser_keys`` at revoke time (and by the 0036 backfill),
    prune deliberately does NOT touch that table, and the deny-list is the
    union of both. Revocation is a permanent tombstone (R10) — "Clear history"
    must never re-admit a stolen device that still carries a cached endorsement
    chain. Still push after deleting: a daemon's state replaces wholesale on
    push, so pushing reconverges any drift at a natural change point. Best
    effort as always.
    """
    result = await session.execute(
        delete(BrowserDevice).where(
            BrowserDevice.owner_user_id == user.id,
            BrowserDevice.revoked_at.is_not(None),
        )
    )
    await session.commit()
    pruned = result.rowcount or 0
    if pruned > 0:
        host_ids = (
            (await session.execute(select(Host.id).where(Host.owner_user_id == user.id)))
            .scalars()
            .all()
        )
        for host_id in host_ids:
            try:
                await push_browser_pins(host_id)
            except Exception:
                pass
    return schemas.BrowserDevicePruneResponse(pruned=pruned)


@router.post("/{device_id}/request-approval", response_model=schemas.BrowserDeviceOut)
async def request_browser_device_approval(
    device_id: str,
    body: schemas.BrowserDeviceApprovalRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrowserDeviceOut:
    """An unapproved device asks, out loud, to be approved.

    Stamped when the device tries to open an agent session: the other devices'
    roster poll picks it up and surfaces (or re-surfaces) the approval toast.
    Advisory display data in both directions — stamping it grants nothing, and
    a device that never stamps it is still visible as a waiting row (R4).
    """

    device = await session.get(BrowserDevice, device_id)
    if device is None or device.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="browser device not found")
    if device.public_key != body.public_key:
        raise HTTPException(
            status_code=409, detail="browser device changed; refresh before asking again"
        )
    if device.revoked_at is not None:
        raise HTTPException(status_code=409, detail="revoked devices cannot ask for approval")
    now = datetime.now(UTC)
    device.approval_requested_at = now
    # Asking is also presence: the device is right here, waiting on a human.
    device.last_seen_at = now
    await session.commit()
    return _to_out(device)


@router.post("/{device_id}/revoke", response_model=schemas.BrowserDeviceOut)
async def revoke_browser_device(
    device_id: str,
    body: schemas.BrowserDeviceRevokeRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrowserDeviceOut:
    now = datetime.now(UTC)
    # Attribution only (the removed screen names its remover, R4). Accept the
    # claimed device only if it is a live device of this same account; anything
    # else is silently dropped rather than failing the revoke.
    revoked_by: str | None = None
    if body.revoked_by_device_id is not None:
        claimed = await session.get(BrowserDevice, body.revoked_by_device_id)
        if claimed is not None and claimed.owner_user_id == user.id and claimed.revoked_at is None:
            revoked_by = claimed.id
    result = await session.execute(
        update(BrowserDevice)
        .where(
            BrowserDevice.id == device_id,
            BrowserDevice.owner_user_id == user.id,
            BrowserDevice.public_key == body.expected_public_key,
            BrowserDevice.revoked_at.is_(None),
        )
        .values(revoked_at=now, revoked_by_device_id=revoked_by)
    )

    device = (
        await session.execute(
            select(BrowserDevice).where(
                BrowserDevice.id == device_id, BrowserDevice.owner_user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if device is None:
        await session.rollback()
        raise HTTPException(status_code=404, detail="browser device not found")
    if device.public_key != body.expected_public_key:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="browser device changed; refresh before revoking",
        )
    if result.rowcount == 0 and device.revoked_at is None:
        # No matching update and no tombstone means the row changed outside
        # this immutable-key contract. Fail closed rather than claiming revoke.
        await session.rollback()
        raise HTTPException(status_code=409, detail="browser device revocation did not commit")

    # Revocation is a PERMANENT tombstone (R10): mirror the key into the
    # key-level tombstone table in the SAME transaction as the roster stamp, so
    # a later "Clear history" prune of the roster row can never drop this key
    # out of the account deny-list. Idempotent: a repeat revoke (or a heal after
    # an interrupted one) finds the tombstone already present and adds nothing.
    if device.revoked_at is not None:
        tombstone = await session.get(RevokedBrowserKey, (device.owner_user_id, device.public_key))
        if tombstone is None:
            session.add(
                RevokedBrowserKey(
                    owner_user_id=device.owner_user_id,
                    public_key=device.public_key,
                    key_algorithm=device.key_algorithm,
                    revoked_at=device.revoked_at,
                    revoked_by_device_id=device.revoked_by_device_id,
                )
            )
        # The permanent RevokedBrowserKey row above is the deny-list
        # authority. HostBrowserPin is only an admission snapshot, so deleting
        # this device's snapshots now safely reclaims bounded host capacity
        # without weakening or forgetting the revocation.
        await session.execute(
            delete(HostBrowserPin).where(HostBrowserPin.browser_device_id == device.id)
        )
    try:
        await session.commit()
    except IntegrityError:
        # A concurrent revoke of the same key committed its tombstone between
        # our get and our commit. The permanent deny is in place either way;
        # re-read the (already stamped) row and answer from it, failing closed
        # if the stamp is somehow absent.
        await session.rollback()
        device = (
            await session.execute(
                select(BrowserDevice).where(
                    BrowserDevice.id == device_id, BrowserDevice.owner_user_id == user.id
                )
            )
        ).scalar_one_or_none()
        if device is None or device.revoked_at is None:
            raise HTTPException(
                status_code=409, detail="browser device revocation did not commit"
            ) from None

    # Revocation only stamps a DB tombstone; a live daemon keeps trusting this
    # device -- directly, and via every pin it endorsed -- until it next
    # reconnects and reconciles. That wait can be days for a long-lived spawnd
    # WS, so mirror the endorsement route and push the recomputed live pin set
    # now to every host whose set this revocation changed (the device as
    # endorsed OR as endorser). Best effort by design: registration
    # reconciliation is the hard guarantee, so an absent or failed push must
    # never fail the revoke.
    #
    # Push to EVERY host of the account, not just those with a per-host pin
    # relationship to this device: the account deny-list (revoked_browser_keys)
    # is account-wide, and a revoked device could otherwise connect to a host it
    # was never directly pinned on via a carried endorsement chain to that host's
    # anchor (device mesh §3). The per-host pin-pruning targets are a subset.
    affected_host_ids = (
        (await session.execute(select(Host.id).where(Host.owner_user_id == user.id)))
        .scalars()
        .all()
    )
    for host_id in affected_host_ids:
        try:
            await push_browser_pins(host_id)
        except Exception:
            pass

    return _to_out(device)


@router.patch("/{device_id}", response_model=schemas.BrowserDeviceOut)
async def rename_browser_device(
    device_id: str,
    body: schemas.BrowserDeviceRenameRequest,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrowserDeviceOut:
    """Rename a device for recognition. Changes no trust: the key is unchanged."""

    device = await session.get(BrowserDevice, device_id)
    if device is None or device.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="browser device not found")
    device.label = body.label
    label = body.label
    public_key = device.public_key
    created_at = device.created_at
    last_seen_at = device.last_seen_at
    approval_requested_at = device.approval_requested_at
    revoked_at = device.revoked_at
    revoked_by_device_id = device.revoked_by_device_id
    is_root = device.is_root
    await session.commit()
    return schemas.BrowserDeviceOut(
        id=device_id,
        key_algorithm="ed25519",
        public_key=public_key,
        label=label,
        created_at=created_at,
        last_seen_at=last_seen_at,
        approval_requested_at=approval_requested_at,
        revoked_at=revoked_at,
        revoked_by_device_id=revoked_by_device_id,
        is_root=is_root,
    )
