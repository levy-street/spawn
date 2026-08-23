"""Storage for the operator's sealed trust bundle and passkey credential IDs.

The server is deliberately a dumb store here. It cannot read a trust bundle, it
cannot forge one, and it never verifies a passkey assertion -- the PRF secret is
derived and consumed entirely in the browser. Everything this module can do to a
hostile operator is deny service, which the server can already do by refusing to
serve at all.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from .. import auth, schemas
from ..browser_endorsement import verify_browser_endorsement_proof
from ..db import get_session
from ..host_identity import ed25519_key_fingerprint
from ..models import (
    BrowserDevice,
    DeviceApprovalRequest,
    Host,
    HostBrowserPin,
    PasskeyCredential,
    TrustBundle,
    User,
)
from ..trust_events import (
    approval_requested_payload,
    approval_resolved_payload,
    publish_trust_event,
)
from ..ws.daemon import push_browser_pins

router = APIRouter(prefix="/api/trust", tags=["trust"])

# A bundle holds at most 256 hosts; this bounds a hostile client's storage use
# while leaving generous headroom for a legitimate one.
MAX_SEALED_BYTES = 256 * 1024
MAX_PASSKEYS_PER_ACCOUNT = 32

#: How long a knock stays live. Long enough to walk to another machine, short
#: enough that a request nobody answered stops nagging every device that opens.
APPROVAL_REQUEST_TTL = timedelta(minutes=30)


@router.get("/bundle", response_model=schemas.TrustBundleOut | None)
async def get_trust_bundle(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.TrustBundleOut | None:
    row = await session.get(TrustBundle, user.id)
    if row is None:
        # Not an error: an account that has never sealed a bundle is the normal
        # state before the first device bootstraps.
        return None
    return schemas.TrustBundleOut(
        sealed=row.sealed, revision=row.revision, updated_at=row.updated_at
    )


@router.put("/bundle", response_model=schemas.TrustBundleOut)
async def put_trust_bundle(
    body: schemas.TrustBundlePut,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.TrustBundleOut:
    # Capture before any commit or rollback: either expires the ORM User, and
    # a later user.id would attempt IO outside the async context.
    user_id = user.id
    if len(body.sealed.encode("utf-8")) > MAX_SEALED_BYTES:
        raise HTTPException(status_code=413, detail="sealed trust bundle is too large")

    now = datetime.now(UTC)
    existing = await session.get(TrustBundle, user_id)

    if existing is None:
        if body.expected_revision not in (None, 0):
            # The caller believed it was updating something that is not there.
            raise HTTPException(status_code=409, detail="no stored trust bundle to replace")
        session.add(
            TrustBundle(owner_user_id=user_id, sealed=body.sealed, revision=1, updated_at=now)
        )
        try:
            await session.commit()
        except IntegrityError:
            # Another device sealed the first bundle concurrently.
            await session.rollback()
            raise HTTPException(
                status_code=409, detail="trust bundle was created concurrently"
            ) from None
        return schemas.TrustBundleOut(sealed=body.sealed, revision=1, updated_at=now)

    # Compare-and-set on revision. Without this a device holding a stale bundle
    # would silently drop host keys another device had added -- a trust
    # regression that would look like nothing at all.
    if body.expected_revision is None:
        raise HTTPException(
            status_code=409,
            detail="a stored trust bundle exists; supply expected_revision to replace it",
        )
    next_revision = existing.revision + 1
    result = await session.execute(
        update(TrustBundle)
        .where(
            TrustBundle.owner_user_id == user_id,
            TrustBundle.revision == body.expected_revision,
        )
        .values(sealed=body.sealed, revision=next_revision, updated_at=now)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await session.rollback()
        raise HTTPException(
            status_code=409,
            detail="trust bundle changed since it was read; re-read and merge before replacing",
        )
    await session.commit()
    return schemas.TrustBundleOut(sealed=body.sealed, revision=next_revision, updated_at=now)


@router.get("/passkeys", response_model=list[schemas.PasskeyCredentialOut])
async def list_passkeys(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.PasskeyCredentialOut]:
    rows = (
        await session.execute(
            select(PasskeyCredential)
            .where(PasskeyCredential.owner_user_id == user.id)
            .order_by(PasskeyCredential.created_at)
        )
    ).scalars()
    return [
        schemas.PasskeyCredentialOut(
            id=row.id,
            credential_id=row.credential_id,
            label=row.label,
            created_at=row.created_at,
        )
        for row in rows
    ]


@router.post("/passkeys", response_model=schemas.PasskeyCredentialOut)
async def add_passkey(
    body: schemas.PasskeyCredentialCreate,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.PasskeyCredentialOut:
    user_id = user.id
    count = len(
        (
            await session.execute(
                select(PasskeyCredential.id).where(PasskeyCredential.owner_user_id == user_id)
            )
        )
        .scalars()
        .all()
    )
    if count >= MAX_PASSKEYS_PER_ACCOUNT:
        raise HTTPException(status_code=409, detail="passkey capacity is exhausted")

    created_at = datetime.now(UTC)
    row = PasskeyCredential(
        owner_user_id=user_id,
        credential_id=body.credential_id,
        label=body.label,
        created_at=created_at,
    )
    session.add(row)
    try:
        # Flush inside the guard: a duplicate credential violates the unique
        # constraint here, not at commit. Reading the generated ID must also
        # happen before commit, which expires ORM attributes and would make
        # reloading them attempt IO outside the async context.
        await session.flush()
        row_id = row.id
        await session.commit()
    except IntegrityError:
        await session.rollback()
        # Idempotent: registering the same credential twice is not an error.
        existing = (
            await session.execute(
                select(PasskeyCredential).where(
                    PasskeyCredential.owner_user_id == user_id,
                    PasskeyCredential.credential_id == body.credential_id,
                )
            )
        ).scalar_one_or_none()
        if existing is None:
            raise HTTPException(status_code=409, detail="passkey could not be stored") from None
        return schemas.PasskeyCredentialOut(
            id=existing.id,
            credential_id=existing.credential_id,
            label=existing.label,
            created_at=existing.created_at,
        )
    return schemas.PasskeyCredentialOut(
        id=row_id,
        credential_id=body.credential_id,
        label=body.label,
        created_at=created_at,
    )


@router.delete("/passkeys/{passkey_id}", status_code=204)
async def delete_passkey(
    passkey_id: str,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    result = await session.execute(
        delete(PasskeyCredential).where(
            PasskeyCredential.id == passkey_id,
            PasskeyCredential.owner_user_id == user.id,
        )
    )
    if result.rowcount != 1:
        raise HTTPException(status_code=404, detail="passkey not found")
    await session.commit()


MAX_BROWSER_PINS_PER_HOST = 32


@router.get("/endorsements", response_model=list[schemas.BrowserEndorsementRecord])
async def list_endorsements_for_device(
    endorsed_device_id: str,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.BrowserEndorsementRecord]:
    """Endorsements naming a device, so IT can learn its hosts' true keys.

    This is the delivery leg of the bidirectional approval ceremony: after a
    trusted browser endorses a new device (verifying ITS fingerprint), the new
    device fetches these records, has the operator confirm the ENDORSER's
    fingerprint in the other direction, and verifies each endorsement
    signature locally — the transcript covers the host key, so a server that
    substitutes any field breaks a signature it cannot re-mint. Nothing here
    is trusted as served; endorsements from revoked endorsers are omitted
    only to avoid offering introductions the daemon already rejects.
    """

    endorser = aliased(BrowserDevice)
    rows = await session.execute(
        select(
            HostBrowserPin.host_id,
            Host.name.label("host_name"),
            Host.host_public_key,
            HostBrowserPin.endorser_device_id,
            endorser.public_key.label("endorser_public_key"),
            endorser.label.label("endorser_label"),
            HostBrowserPin.endorsement_signature,
        )
        .join(Host, Host.id == HostBrowserPin.host_id)
        .join(endorser, endorser.id == HostBrowserPin.endorser_device_id)
        .where(
            HostBrowserPin.browser_device_id == endorsed_device_id,
            HostBrowserPin.endorsement_signature.is_not(None),
            Host.owner_user_id == user.id,
            Host.host_public_key.is_not(None),
            endorser.revoked_at.is_(None),
        )
        .order_by(HostBrowserPin.host_id)
    )
    return [
        schemas.BrowserEndorsementRecord(
            host_id=row.host_id,
            host_name=row.host_name,
            host_public_key=row.host_public_key,
            endorser_device_id=row.endorser_device_id,
            endorser_public_key=row.endorser_public_key,
            endorser_label=row.endorser_label,
            signature=row.endorsement_signature,
        )
        for row in rows
    ]


@router.post("/endorsements", response_model=schemas.BrowserEndorsementOut)
async def create_browser_endorsement(
    body: schemas.BrowserEndorsementCreate,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.BrowserEndorsementOut:
    """Admit a browser device to a host on an already-trusted device's authority.

    The signature is verified here only to keep malformed rows out of the store.
    The daemon re-verifies it against the browser keys it already pins, so a
    server that skipped or forged this check would gain nothing: it cannot
    produce an endorsement signed by a key the daemon trusts.
    """

    user_id = user.id
    host = await session.get(Host, body.host_id)
    if host is None or host.owner_user_id != user_id:
        raise HTTPException(status_code=404, detail="host not found")
    if host.host_public_key is None:
        raise HTTPException(status_code=409, detail="host has no identity key to bind to")

    devices = {
        row.id: row
        for row in (
            await session.execute(
                select(BrowserDevice).where(
                    BrowserDevice.owner_user_id == user_id,
                    BrowserDevice.id.in_([body.endorser_device_id, body.endorsed_device_id]),
                )
            )
        ).scalars()
    }
    endorser = devices.get(body.endorser_device_id)
    endorsed = devices.get(body.endorsed_device_id)
    if endorser is None or endorsed is None:
        raise HTTPException(status_code=404, detail="browser device not found")
    for device in (endorser, endorsed):
        if device.revoked_at is not None:
            raise HTTPException(
                status_code=409, detail="revoked browser devices cannot endorse or be endorsed"
            )

    # The endorser must already be pinned to this host. An endorsement from a
    # device the host does not trust carries no authority, and accepting it here
    # would invite the daemon to reject rows this table had blessed.
    endorser_pinned = (
        await session.execute(
            select(HostBrowserPin.browser_device_id).where(
                HostBrowserPin.host_id == host.id,
                HostBrowserPin.browser_device_id == endorser.id,
            )
        )
    ).scalar_one_or_none()
    if endorser_pinned is None:
        raise HTTPException(
            status_code=409, detail="the endorsing device is not trusted by this host"
        )

    verify_browser_endorsement_proof(
        user_id=user_id,
        host_public_key_wire=host.host_public_key,
        endorser_public_key_wire=endorser.public_key,
        endorsed_public_key_wire=endorsed.public_key,
        endorsed_device_id=endorsed.id,
        signature_wire=body.signature,
    )

    fingerprint = ed25519_key_fingerprint(endorsed.public_key)
    created_at = datetime.now(UTC)
    existing = await session.get(HostBrowserPin, (host.id, endorsed.id))
    if existing is not None:
        # Idempotent: re-endorsing an already-admitted device is a retry. The
        # knock still closes, or a device admitted between the request and the
        # retry would keep prompting every screen on the account.
        resolved = await _resolve_pending_requests(
            session, user_id, endorsed.id, "approved", endorser.id
        )
        if resolved:
            await session.commit()
            for request_id in resolved:
                await publish_trust_event(
                    user_id, approval_resolved_payload(request_id, endorsed.id, "approved")
                )
        return schemas.BrowserEndorsementOut(
            host_id=host.id,
            endorsed_device_id=endorsed.id,
            endorsed_key_fingerprint=existing.browser_key_fingerprint,
            endorser_device_id=body.endorser_device_id,
            created_at=existing.created_at,
        )

    count = len(
        (
            await session.execute(
                select(HostBrowserPin.browser_device_id).where(HostBrowserPin.host_id == host.id)
            )
        )
        .scalars()
        .all()
    )
    if count >= MAX_BROWSER_PINS_PER_HOST:
        raise HTTPException(status_code=409, detail="host browser pin capacity is exhausted")

    session.add(
        HostBrowserPin(
            host_id=host.id,
            browser_device_id=endorsed.id,
            browser_key_algorithm="ed25519",
            browser_public_key=endorsed.public_key,
            browser_key_fingerprint=fingerprint,
            endorser_device_id=endorser.id,
            endorsement_signature=body.signature,
            created_at=created_at,
        )
    )
    # The knock and the pin are resolved in one transaction: an endorsement is
    # exactly the answer the request was waiting for, whether it came from this
    # prompt or from the Devices panel as before.
    resolved = await _resolve_pending_requests(
        session, user_id, endorsed.id, "approved", endorser.id
    )
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=409, detail="endorsement could not be stored") from None

    for request_id in resolved:
        await publish_trust_event(
            user_id, approval_resolved_payload(request_id, endorsed.id, "approved")
        )

    # Nudge the daemon so the endorsement applies now rather than whenever it
    # next reconnects. Failure is fine: registration reconciles regardless.
    await push_browser_pins(host.id)

    return schemas.BrowserEndorsementOut(
        host_id=host.id,
        endorsed_device_id=body.endorsed_device_id,
        endorsed_key_fingerprint=fingerprint,
        endorser_device_id=body.endorser_device_id,
        created_at=created_at,
    )


async def _resolve_pending_requests(
    session: AsyncSession,
    user_id: str,
    browser_device_id: str,
    status: str,
    resolved_by_device_id: str | None,
) -> list[str]:
    """Close out any live knock from this device and report which ones closed."""
    now = datetime.now(UTC)
    rows = (
        (
            await session.execute(
                select(DeviceApprovalRequest).where(
                    DeviceApprovalRequest.owner_user_id == user_id,
                    DeviceApprovalRequest.browser_device_id == browser_device_id,
                    DeviceApprovalRequest.status == "pending",
                )
            )
        )
        .scalars()
        .all()
    )
    for row in rows:
        row.status = status
        row.resolved_at = now
        row.resolved_by_device_id = resolved_by_device_id
    return [row.id for row in rows]


def _approval_out(
    row: DeviceApprovalRequest, device: BrowserDevice
) -> schemas.DeviceApprovalRequestOut:
    return schemas.DeviceApprovalRequestOut(
        id=row.id,
        browser_device_id=device.id,
        label=device.label,
        fingerprint=ed25519_key_fingerprint(device.public_key),
        status=row.status,
        created_at=row.created_at,
        expires_at=row.expires_at,
    )


@router.post("/device-approvals", response_model=schemas.DeviceApprovalRequestOut)
async def request_device_approval(
    body: schemas.DeviceApprovalRequestCreate,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.DeviceApprovalRequestOut:
    """Raise (or refresh) this device's knock.

    Deliberately unsigned. The caller is already the account owner, the device
    must already be registered under that account by a signed registration, and
    the row grants nothing on its own — the pin still comes from an endorsement
    signed on a device the host trusts. Requiring a second signature here would
    add a transcript to maintain and stop nothing.
    """
    device = await session.get(BrowserDevice, body.browser_device_id)
    if device is None or device.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="browser device not found")
    if device.revoked_at is not None:
        raise HTTPException(status_code=409, detail="revoked devices cannot request approval")

    now = datetime.now(UTC)
    existing = (
        await session.execute(
            select(DeviceApprovalRequest).where(
                DeviceApprovalRequest.browser_device_id == device.id,
                DeviceApprovalRequest.status == "pending",
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        # Re-asking extends the same knock rather than minting a second one, so
        # a device that reopens the app does not stack prompts elsewhere.
        existing.expires_at = now + APPROVAL_REQUEST_TTL
        row = existing
    else:
        row = DeviceApprovalRequest(
            owner_user_id=user.id,
            browser_device_id=device.id,
            status="pending",
            created_at=now,
            expires_at=now + APPROVAL_REQUEST_TTL,
        )
        session.add(row)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=409, detail="approval request already exists") from None

    out = _approval_out(row, device)
    await publish_trust_event(
        user.id,
        approval_requested_payload(row.id, device.id, device.label, out.fingerprint),
    )
    return out


@router.get("/device-approvals", response_model=list[schemas.DeviceApprovalRequestOut])
async def list_device_approvals(
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> list[schemas.DeviceApprovalRequestOut]:
    """Live knocks, so a device that opens later still offers the ceremony."""
    now = datetime.now(UTC)
    rows = (
        (
            await session.execute(
                select(DeviceApprovalRequest, BrowserDevice)
                .join(BrowserDevice, BrowserDevice.id == DeviceApprovalRequest.browser_device_id)
                .where(
                    DeviceApprovalRequest.owner_user_id == user.id,
                    DeviceApprovalRequest.status == "pending",
                    DeviceApprovalRequest.expires_at > now,
                    BrowserDevice.revoked_at.is_(None),
                )
                .order_by(DeviceApprovalRequest.created_at)
            )
        )
        .all()
    )
    return [_approval_out(row, device) for row, device in rows]


@router.post(
    "/device-approvals/{request_id}/deny", response_model=schemas.DeviceApprovalRequestOut
)
async def deny_device_approval(
    request_id: str,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> schemas.DeviceApprovalRequestOut:
    """Dismiss a knock. Denial is not a revocation: it closes this request only."""
    row = await session.get(DeviceApprovalRequest, request_id)
    if row is None or row.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="approval request not found")
    device = await session.get(BrowserDevice, row.browser_device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="approval request not found")
    if row.status == "pending":
        row.status = "denied"
        row.resolved_at = datetime.now(UTC)
        await session.commit()
        await publish_trust_event(
            user.id, approval_resolved_payload(row.id, device.id, "denied")
        )
    return _approval_out(row, device)


@router.get("/hosts/{host_id}/pins", response_model=list[str])
async def list_host_browser_pins(
    host_id: str,
    user: User = Depends(auth.current_user),
    session: AsyncSession = Depends(get_session),
) -> list[str]:
    """Browser device IDs this host trusts, so the UI can offer to endorse the rest."""

    host = await session.get(Host, host_id)
    if host is None or host.owner_user_id != user.id:
        raise HTTPException(status_code=404, detail="host not found")
    rows = (
        await session.execute(
            select(HostBrowserPin.browser_device_id)
            .where(HostBrowserPin.host_id == host_id)
            .order_by(HostBrowserPin.browser_device_id)
        )
    ).scalars()
    return list(rows)
