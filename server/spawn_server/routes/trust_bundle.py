"""Storage for the operator's sealed trust bundle and passkey credential IDs.

The server is deliberately a dumb store here. It cannot read a trust bundle, it
cannot forge one, and it never verifies a passkey assertion -- the PRF secret is
derived and consumed entirely in the browser. Everything this module can do to a
hostile operator is deny service, which the server can already do by refusing to
serve at all.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .. import auth, schemas
from ..db import get_session
from ..models import PasskeyCredential, TrustBundle, User

router = APIRouter(prefix="/api/trust", tags=["trust"])

# A bundle holds at most 256 hosts; this bounds a hostile client's storage use
# while leaving generous headroom for a legitimate one.
MAX_SEALED_BYTES = 256 * 1024
MAX_PASSKEYS_PER_ACCOUNT = 32


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
