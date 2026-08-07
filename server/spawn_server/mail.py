"""Outbound transactional email.

Deliberately transport-agnostic and dependency-free: SMTP credentials work
with every provider, so a deployment is never wedged waiting for this project
to add support for its vendor.

The backend is explicit rather than inferred. A misconfigured mailer that
silently swallows password-reset links is indistinguishable from a working one
until a user is locked out, so `console` announces itself loudly on every send
and `disabled` refuses instead of pretending.
"""

from __future__ import annotations

import asyncio
import logging
import re
import smtplib
from email.message import EmailMessage

from .config import get_settings

log = logging.getLogger(__name__)

# Query parameters whose values admit whoever holds them.
_CREDENTIAL_PARAMS = ("token", "invite", "code")
_CREDENTIAL_PATTERN = re.compile(
    r"\b(" + "|".join(_CREDENTIAL_PARAMS) + r")=([A-Za-z0-9._~\-]+)",
)


def redact_credentials(text: str) -> str:
    """Strip bearer secrets from a message body before it is stored.

    A reset or invite link is a credential: anyone holding it can take over
    an account or create one. Keeping the prose (so an operator can see what
    was sent) while dropping the secret is the difference between an audit
    trail and a vault of live keys.
    """

    return _CREDENTIAL_PATTERN.sub(lambda m: f"{m.group(1)}=<redacted>", text)


async def _record(
    *, to: str, subject: str, kind: str, status: str, body: str, error: str | None
) -> None:
    """Append to the delivery log on its own transaction.

    Deliberately independent of the caller's session: the log answers "did
    this leave the building", which stays true even when the request that
    triggered it later rolls back.
    """

    try:
        from .db import get_sessionmaker
        from .models import EmailLog

        async with get_sessionmaker()() as session:
            session.add(
                EmailLog(
                    to_email=to[:255],
                    subject=subject[:255],
                    kind=kind[:32],
                    status=status,
                    error=(error[:2000] if error else None),
                    body_redacted=redact_credentials(body),
                )
            )
            await session.commit()
    except Exception as exc:  # pragma: no cover - logging must never break sending
        log.warning("could not record email log entry: %s", exc)


class MailNotConfigured(RuntimeError):
    """Raised when a send is attempted with the mailer switched off."""


def _send_smtp(message: EmailMessage) -> None:
    settings = get_settings()
    host = settings.smtp_host
    if not host:
        raise MailNotConfigured("SPAWN_SMTP_HOST is not set")
    port = settings.smtp_port
    if settings.smtp_use_ssl:
        server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=20)
    else:
        server = smtplib.SMTP(host, port, timeout=20)
    try:
        if settings.smtp_use_starttls and not settings.smtp_use_ssl:
            server.starttls()
        if settings.smtp_username:
            server.login(settings.smtp_username, settings.smtp_password or "")
        server.send_message(message)
    finally:
        try:
            server.quit()
        except Exception:
            pass


async def send_email(
    *, to: str, subject: str, body: str, kind: str = "other", html_body: str | None = None
) -> None:
    """Deliver one message, or raise.

    Every attempt is recorded (sent, failed, or never delivered because the
    backend only logs), so an operator can answer "did that email go out"
    without reading server logs.

    Callers decide whether a delivery failure should surface to the user.
    Endpoints that must not leak whether an address exists swallow the error
    after logging it; everything else propagates.
    """

    settings = get_settings()
    backend = settings.email_backend.strip().lower()

    if backend == "disabled":
        await _record(
            to=to,
            subject=subject,
            kind=kind,
            status="not_delivered",
            body=body,
            error="email backend is disabled",
        )
        raise MailNotConfigured("email backend is disabled")

    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = to
    message["Subject"] = subject
    # Transactional mail should say so: these stop out-of-office autoresponders
    # and ticketing systems from replying to a no-reply address, and mark the
    # message as machine-generated for filters that look.
    message["Auto-Submitted"] = "auto-generated"
    message["X-Auto-Response-Suppress"] = "All"
    reply_to = settings.email_reply_to.strip()
    if reply_to:
        message["Reply-To"] = reply_to
    message.set_content(body)
    if html_body:
        # multipart/alternative: text first, HTML as the richer alternative.
        message.add_alternative(html_body, subtype="html")

    if backend == "console":
        # Never quietly acceptable in production: an operator reading logs is
        # not a delivery mechanism, and the body contains live credentials.
        log.warning(
            "EMAIL BACKEND IS 'console' — not delivered. to=%s subject=%s\n%s",
            to,
            subject,
            body,
        )
        await _record(
            to=to,
            subject=subject,
            kind=kind,
            status="not_delivered",
            body=body,
            error="email backend is 'console' (logged, not sent)",
        )
        return

    if backend != "smtp":
        await _record(
            to=to,
            subject=subject,
            kind=kind,
            status="failed",
            body=body,
            error=f"unknown email backend {backend!r}",
        )
        raise MailNotConfigured(f"unknown email backend {backend!r}")

    try:
        # smtplib is blocking; keep the event loop free.
        await asyncio.to_thread(_send_smtp, message)
    except Exception as exc:
        await _record(to=to, subject=subject, kind=kind, status="failed", body=body, error=str(exc))
        raise
    await _record(to=to, subject=subject, kind=kind, status="sent", body=body, error=None)
    log.info("sent email to=%s subject=%s", to, subject)


def mailer_ready() -> bool:
    """Whether a real delivery path is configured (not console/disabled)."""
    settings = get_settings()
    return settings.email_backend.strip().lower() == "smtp" and bool(settings.smtp_host)
