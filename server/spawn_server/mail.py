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
import smtplib
from email.message import EmailMessage

from .config import get_settings

log = logging.getLogger(__name__)


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


async def send_email(*, to: str, subject: str, body: str) -> None:
    """Deliver one message, or raise.

    Callers decide whether a delivery failure should surface to the user.
    Endpoints that must not leak whether an address exists swallow the error
    after logging it; everything else propagates.
    """

    settings = get_settings()
    backend = settings.email_backend.strip().lower()

    if backend == "disabled":
        raise MailNotConfigured("email backend is disabled")

    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)

    if backend == "console":
        # Never quietly acceptable in production: an operator reading logs is
        # not a delivery mechanism, and the body contains live credentials.
        log.warning(
            "EMAIL BACKEND IS 'console' — not delivered. to=%s subject=%s\n%s",
            to,
            subject,
            body,
        )
        return

    if backend != "smtp":
        raise MailNotConfigured(f"unknown email backend {backend!r}")

    # smtplib is blocking; keep the event loop free.
    await asyncio.to_thread(_send_smtp, message)
    log.info("sent email to=%s subject=%s", to, subject)


def mailer_ready() -> bool:
    """Whether a real delivery path is configured (not console/disabled)."""
    settings = get_settings()
    return settings.email_backend.strip().lower() == "smtp" and bool(settings.smtp_host)
