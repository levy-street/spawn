"""Delivery of attention alerts to app installs that are not connected.

`/ws/alerts` can only reach a client holding a socket, and on a phone that is
the one client that does not need telling: the app is suspended or closed by
the time an agent finishes. The push service holds the connection instead.

Content discipline is the same rule `ws/alerts.py` states and for the same
reason, only stricter in consequence — a push notification is rendered on a
lock screen, in front of whoever is holding the phone. The only session-derived
string that goes out is `command`, the foreground process basename the server
already stores and already serves from `GET /api/sessions`. No terminal bytes,
no argv, no cwd, no output. `session_id` travels in the data payload, which is
not displayed, so the app can open the right session on tap.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings, get_settings
from .db import get_sessionmaker
from .models import PushDevice

log = logging.getLogger("spawn.push")

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"

#: Expo accepts at most 100 messages per request.
_MAX_BATCH = 100

#: A token the service says it has never heard of, or has retired. The row is
#: switched off rather than deleted so a re-register is an update.
_DEAD_TOKEN_ERRORS = frozenset({"DeviceNotRegistered", "InvalidCredentials"})


@dataclass(frozen=True)
class PushMessage:
    title: str
    body: str
    data: dict[str, str]


def _utcnow() -> datetime:
    return datetime.now(UTC)


def alert_push_message(payload: dict[str, Any]) -> PushMessage | None:
    """Turn a `/ws/alerts` frame into lock-screen copy, or None to stay silent.

    Phrasing tracks `alertTitle` in `mobile/src/components/alerts/alert-content.ts`
    so the same event does not read as two different things depending on whether
    the app happened to be open.
    """
    event = payload.get("event")
    session_id = payload.get("session_id")
    if not isinstance(event, str) or not isinstance(session_id, str) or not session_id:
        return None

    command = payload.get("command")
    subject = command.strip() if isinstance(command, str) and command.strip() else "A session"

    if event == "agent.finished":
        title = f"{subject} finished"
    elif event == "agent.awaiting_input":
        title = f"{subject} is waiting for you"
    elif event == "session.died":
        signal = payload.get("signal")
        title = f"{subject} was killed" if signal else f"{subject} exited"
    else:
        return None

    exit_code = payload.get("exit_code")
    if event == "session.died" and isinstance(exit_code, int):
        body = f"Exit {exit_code}"
    elif event == "session.died" and isinstance(payload.get("signal"), str):
        body = str(payload["signal"])
    else:
        body = "Tap to open the session."

    return PushMessage(title=title, body=body, data={"sessionId": session_id, "event": event})


def approval_push_message(request_id: str, label: str | None) -> PushMessage:
    """The knock (docs/TRUST_UX.md §3) as lock-screen copy for the phones that
    can answer it. The label is the asking device's own name for itself and is
    the only device-derived string shown; the fingerprint the operator must
    compare is deliberately NOT here, because a lock screen is not where that
    comparison happens — the prompt the tap opens is."""
    subject = label.strip() if isinstance(label, str) and label.strip() else "A new device"
    return PushMessage(
        title=f"Approve {subject}?",
        body="It signed in to your account and is waiting for you.",
        data={"event": "device.approval_requested", "requestId": request_id},
    )


def pairing_push_message(approval_ref: str, host_name: str) -> PushMessage:
    subject = host_name.strip() if host_name.strip() else "A machine"
    return PushMessage(
        title="SPAWN D",
        body=f"{subject} is ready to join your account",
        data={"event": "host.pair_requested", "approvalRef": approval_ref},
    )


async def _live_tokens(session: AsyncSession, user_id: str) -> list[PushDevice]:
    rows = await session.execute(
        select(PushDevice).where(
            PushDevice.user_id == user_id,
            PushDevice.disabled_at.is_(None),
        )
    )
    return list(rows.scalars())


def _headers(settings: Settings) -> dict[str, str]:
    headers = {"accept": "application/json", "content-type": "application/json"}
    # Only needed when the Expo project has enhanced push security switched on;
    # harmless otherwise, so it is sent whenever configured.
    if settings.expo_access_token:
        headers["authorization"] = f"Bearer {settings.expo_access_token}"
    return headers


async def _disable_tokens(session: AsyncSession, tokens: list[str]) -> None:
    if not tokens:
        return
    rows = await session.execute(select(PushDevice).where(PushDevice.token.in_(tokens)))
    now = _utcnow()
    for row in rows.scalars():
        row.disabled_at = now
    await session.commit()


async def send_alert_push(
    *,
    session: AsyncSession,
    user_id: str,
    payload: dict[str, Any],
    client: httpx.AsyncClient | None = None,
    settings: Settings | None = None,
) -> int:
    """Push one alert to every live install of an account. Returns the count sent.

    Never raises. An alert is a courtesy and this runs off the daemon socket's
    hot path — a push service having a bad afternoon must not surface as a
    broken agent session.
    """
    settings = settings or get_settings()
    if not settings.push_enabled:
        return 0
    message = alert_push_message(payload)
    if message is None:
        return 0
    return await _send_push(
        session=session, user_id=user_id, message=message, client=client, settings=settings
    )


async def send_approval_push(
    *,
    session: AsyncSession,
    user_id: str,
    request_id: str,
    label: str | None,
    exclude_browser_device_id: str | None,
    client: httpx.AsyncClient | None = None,
    settings: Settings | None = None,
) -> int:
    """Tell the account's phones a device is knocking. Returns the count sent.

    The knocking device's own install is skipped: it registered its push token
    with its browser device id, and "Approve spawn on iPhone?" arriving on that
    same iPhone would only confuse. Never raises, same as the alert path.
    """
    settings = settings or get_settings()
    if not settings.push_enabled:
        return 0
    return await _send_push(
        session=session,
        user_id=user_id,
        message=approval_push_message(request_id, label),
        exclude_browser_device_id=exclude_browser_device_id,
        client=client,
        settings=settings,
    )


async def send_pairing_push(
    *,
    session: AsyncSession,
    user_id: str,
    approval_ref: str,
    host_name: str,
    client: httpx.AsyncClient | None = None,
    settings: Settings | None = None,
) -> int:
    """Tell every phone that a possession-proved host is ready for review."""

    settings = settings or get_settings()
    if not settings.push_enabled:
        return 0
    return await _send_push(
        session=session,
        user_id=user_id,
        message=pairing_push_message(approval_ref, host_name),
        client=client,
        settings=settings,
    )


_push_tasks: set[asyncio.Task[None]] = set()


def schedule_approval_push(
    user_id: str, request_id: str, label: str | None, exclude_browser_device_id: str | None
) -> None:
    """Fire-and-forget `send_approval_push` from a request handler.

    The knock must return as soon as its row is durable; a push round-trip to
    an external service is neither quick nor reliable enough to sit in that
    response. Nothing waits on the result and the sender never raises.
    """

    async def deliver() -> None:
        try:
            async with get_sessionmaker()() as session:
                await send_approval_push(
                    session=session,
                    user_id=user_id,
                    request_id=request_id,
                    label=label,
                    exclude_browser_device_id=exclude_browser_device_id,
                )
        except Exception as e:  # noqa: BLE001
            log.warning("approval push failed: %s", e)

    try:
        task = asyncio.create_task(deliver())
    except RuntimeError:
        return
    _push_tasks.add(task)
    task.add_done_callback(_push_tasks.discard)


def schedule_pairing_push(
    user_id: str,
    approval_ref: str,
    host_name: str,
) -> None:
    """Fire-and-forget pairing attention after the claim transition commits."""

    async def deliver() -> None:
        try:
            async with get_sessionmaker()() as session:
                await send_pairing_push(
                    session=session,
                    user_id=user_id,
                    approval_ref=approval_ref,
                    host_name=host_name,
                )
        except Exception as e:  # noqa: BLE001
            log.warning("pairing push failed: %s", e)

    try:
        task = asyncio.create_task(deliver())
    except RuntimeError:
        return
    _push_tasks.add(task)
    task.add_done_callback(_push_tasks.discard)


async def _send_push(
    *,
    session: AsyncSession,
    user_id: str,
    message: PushMessage,
    settings: Settings,
    exclude_browser_device_id: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> int:
    try:
        devices = await _live_tokens(session, user_id)
    except Exception as e:  # noqa: BLE001
        log.warning("push token lookup failed: %s", e)
        return 0
    if exclude_browser_device_id is not None:
        devices = [d for d in devices if d.browser_device_id != exclude_browser_device_id]
    if not devices:
        return 0

    sent = 0
    dead: list[str] = []
    owned = client is None
    http = client or httpx.AsyncClient(timeout=10)
    try:
        for start in range(0, len(devices), _MAX_BATCH):
            batch = devices[start : start + _MAX_BATCH]
            body = [
                {
                    "to": device.token,
                    "title": message.title,
                    "body": message.body,
                    "data": message.data,
                    "sound": "default",
                    # Attention alerts are the entire point of the app being
                    # installed, so they are worth waking the device for.
                    "priority": "high",
                    "channelId": "alerts",
                }
                for device in batch
            ]
            response = await http.post(EXPO_PUSH_URL, json=body, headers=_headers(settings))
            if response.status_code >= 400:
                log.warning("push send rejected: HTTP %s", response.status_code)
                continue
            results = response.json().get("data")
            if not isinstance(results, list):
                continue
            for device, result in zip(batch, results, strict=False):
                if not isinstance(result, dict):
                    continue
                if result.get("status") == "ok":
                    sent += 1
                    continue
                detail = result.get("details")
                reason = detail.get("error") if isinstance(detail, dict) else None
                if reason in _DEAD_TOKEN_ERRORS:
                    dead.append(device.token)
                else:
                    log.warning("push send failed: %s", result.get("message"))
    except Exception as e:  # noqa: BLE001
        log.warning("push send failed: %s", e)
    finally:
        if owned:
            await http.aclose()

    try:
        await _disable_tokens(session, dead)
    except Exception as e:  # noqa: BLE001
        log.warning("push token cleanup failed: %s", e)

    return sent
