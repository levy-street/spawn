"""Transactional ownership fencing for stable host identity keys."""

from __future__ import annotations

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .models import HostKeyClaim


async def lock_host_key_claim(
    session: AsyncSession,
    *,
    host_key_algorithm: str,
    host_public_key: str,
) -> str | None:
    """Write-lock an existing key claim and return its immutable owner.

    The self-assignment deliberately starts a write transaction on SQLite and
    takes a row lock on PostgreSQL. Device start, approval, poll, and Host
    deletion all use this as their first keyed write so revocation has one
    portable serialization boundary.
    """

    return (
        await session.execute(
            update(HostKeyClaim)
            .where(
                HostKeyClaim.host_key_algorithm == host_key_algorithm,
                HostKeyClaim.host_public_key == host_public_key,
            )
            .values(owner_user_id=HostKeyClaim.owner_user_id)
            .returning(HostKeyClaim.owner_user_id)
            .execution_options(synchronize_session=False)
        )
    ).scalar_one_or_none()


async def create_or_lock_host_key_claim(
    session: AsyncSession,
    *,
    host_key_algorithm: str,
    host_public_key: str,
    owner_user_id: str,
) -> str:
    """Create the first durable claim or return the concurrent winner."""

    candidate = HostKeyClaim(
        host_key_algorithm=host_key_algorithm,
        host_public_key=host_public_key,
        owner_user_id=owner_user_id,
    )
    try:
        async with session.begin_nested():
            session.add(candidate)
            await session.flush()
        return owner_user_id
    except IntegrityError:
        # A first-pair race may have committed the composite-PK winner while
        # this savepoint waited. Lock and compare that immutable winner without
        # rolling back the claimed DeviceCode transaction.
        claim = (
            await session.execute(
                select(HostKeyClaim)
                .where(
                    HostKeyClaim.host_key_algorithm == host_key_algorithm,
                    HostKeyClaim.host_public_key == host_public_key,
                )
                .with_for_update()
            )
        ).scalar_one_or_none()
        if claim is None:
            # The unique conflict can only name this composite primary key.
            # Treat an impossible disappearing winner as fail-closed.
            raise RuntimeError("host key claim winner disappeared") from None
        return claim.owner_user_id
