"""Owner-scoped trust events, published onto the alert channel.

These ride `/ws/alerts` rather than a socket of their own because that socket
already exists for exactly this shape of problem: something happened that the
operator needs to see on whichever device they happen to be looking at, which
is not necessarily the one it happened on. A device knocking for approval is
the same kind of event as an agent finishing.

They are a distinct frame `type` so the alert whitelist stays exactly as narrow
as it was: nothing here can be mistaken for a session event, and `ws/alerts`
validates the two families separately.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from .redis import get_backend, user_alert_channel

log = logging.getLogger("spawn.trust.events")

TRUST_FRAME_TYPE = "trust"
TRUST_EVENTS = frozenset({"device.approval_requested", "device.approval_resolved"})


def approval_requested_payload(
    request_id: str,
    browser_device_id: str,
    label: str | None,
    fingerprint: str,
) -> dict[str, object]:
    return {
        "type": TRUST_FRAME_TYPE,
        "event": "device.approval_requested",
        "request_id": request_id,
        "browser_device_id": browser_device_id,
        "label": label,
        "fingerprint": fingerprint,
        "at": datetime.now(UTC).isoformat(),
    }


def approval_resolved_payload(
    request_id: str,
    browser_device_id: str,
    status: str,
) -> dict[str, object]:
    return {
        "type": TRUST_FRAME_TYPE,
        "event": "device.approval_resolved",
        "request_id": request_id,
        "browser_device_id": browser_device_id,
        "status": status,
        "at": datetime.now(UTC).isoformat(),
    }


async def publish_trust_event(user_id: str, payload: dict[str, object]) -> None:
    """Best effort. A lost frame costs a device the live prompt, not the ceremony.

    Every consumer also reads the pending list on open, so the durable row is
    what makes this correct and the frame is only what makes it immediate.
    """
    try:
        await get_backend().publish_channel(
            user_alert_channel(user_id),
            json.dumps(payload, separators=(",", ":")).encode(),
        )
    except Exception as e:  # noqa: BLE001
        log.warning("trust event publish failed: %s", e)


def forwardable_trust_frame(event: object) -> dict[str, object] | None:
    """Whitelist a channel payload before it reaches a browser."""
    if not isinstance(event, dict):
        return None
    if event.get("type") != TRUST_FRAME_TYPE:
        return None
    if event.get("event") not in TRUST_EVENTS:
        return None
    for key in ("request_id", "browser_device_id"):
        value = event.get(key)
        if not isinstance(value, str) or not value or len(value) > 64:
            return None
    label = event.get("label")
    if label is not None and (not isinstance(label, str) or len(label) > 64):
        return None
    fingerprint = event.get("fingerprint")
    if fingerprint is not None and (not isinstance(fingerprint, str) or len(fingerprint) > 64):
        return None
    status = event.get("status")
    if status is not None and status not in {"approved", "denied"}:
        return None
    return event
