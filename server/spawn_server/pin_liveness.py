"""Transitive liveness of a host's browser pins — the single authority.

Extracted from ``ws.daemon`` so every surface that reports "which devices does
this host trust" (the daemon pin push AND the ``/api/trust/hosts/{id}/pins``
family) computes the same answer. Serving raw ``HostBrowserPin`` rows anywhere
lets a revoked device — or a revoked account root — read as approved exactly
where the R5 sole-trust warning needs the opposite (see the field bug in
docs/TRUST_DEVICE_MESH.md's red-team ledger).
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from .models import BrowserDevice, HostBrowserPin


async def live_browser_device_id_set(session: AsyncSession, host_id: str) -> set[str]:
    """Device IDs whose pin on this host is *transitively* live.

    A pin is live iff its endorsed device is not revoked AND either the pin was
    directly approved (no endorser) or its endorser device is not revoked and the
    endorser's own pin on this host is itself live. Revoking a device therefore
    drops the whole endorsement subtree beneath it, not just the pins it directly
    endorsed: checking only the immediate endorser's revoked flag would let a
    2+-hop chain of attacker devices (root->mid->leaf) survive revocation of the
    compromised root, because leaf's endorser `mid` still reads as not-revoked
    even though `mid`'s own pin was dropped.

    Computed as a fixpoint over the host's pins (bounded by
    MAX_BROWSER_PINS_PER_HOST) rather than a recursive SQL CTE, so the logic is
    identical on SQLite and Postgres. A missing endorser row (no FK on
    endorser_device_id, so a hard-deleted endorser leaves a dangling id) fails
    closed: endorser_id is NULL, so the pin is never admitted.

    The account ROOT's pin is a deliberate ratchet exception (mesh stage 5c):
    once endorsed onto a host it stays live as long as the root itself is not
    revoked, even after its endorser dies. The endorser was live when the route
    verified and stored the row, and the whole point of anchoring on `R` is
    surviving the loss/revocation of every ordinary device — a root pin that
    died with its endorser would re-couple recovery to a single device's fate
    (breaking P3′). Root compromise is handled by revoking the root itself,
    which drops the pin here AND lands pk_R on the account deny-list.
    """

    endorser = aliased(BrowserDevice)
    rows = (
        await session.execute(
            select(
                HostBrowserPin.browser_device_id,
                HostBrowserPin.endorser_device_id,
                BrowserDevice.revoked_at.label("endorsed_revoked_at"),
                BrowserDevice.is_root.label("endorsed_is_root"),
                endorser.id.label("endorser_id"),
                endorser.revoked_at.label("endorser_revoked_at"),
            )
            .join(BrowserDevice, BrowserDevice.id == HostBrowserPin.browser_device_id)
            .outerjoin(endorser, endorser.id == HostBrowserPin.endorser_device_id)
            .where(HostBrowserPin.host_id == host_id)
        )
    ).all()

    # Only pins whose own endorsed device is not revoked are ever eligible.
    eligible = [row for row in rows if row.endorsed_revoked_at is None]
    live: set[str] = set()
    changed = True
    while changed:
        changed = False
        for row in eligible:
            if row.browser_device_id in live:
                continue
            rooted = row.endorser_device_id is None or row.endorsed_is_root
            endorsed_by_live = (
                row.endorser_id is not None
                and row.endorser_revoked_at is None
                and row.endorser_device_id in live
            )
            if rooted or endorsed_by_live:
                live.add(row.browser_device_id)
                changed = True
    return live
