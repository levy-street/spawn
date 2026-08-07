"""HTML and plain-text bodies for every message spawn sends.

Email rendering is a hostile environment: Outlook uses Word to lay out HTML,
Gmail strips <style> in some clients, images are blocked by default, and dark
mode is applied by the client rather than the page. The rules below follow
from that rather than from taste:

- Tables for layout, inline styles for anything that must survive.
- No external images. The wordmark is text, so nothing breaks when images are
  blocked — which for a security email is the default, not the exception.
- Every message is multipart: a real plain-text part, not a stripped-tag
  afterthought, because plenty of people read mail as text and every spam
  filter reads it that way.
- The action is always available as a bare URL as well as a button. Buttons
  fail; a link the reader can copy always works.
"""

from __future__ import annotations

import html
from dataclasses import dataclass

BRAND = "spawn"
ACCENT = "#059669"
ACCENT_DARK = "#34d399"


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    text: str
    html: str


def _layout(
    *,
    preheader: str,
    heading: str,
    paragraphs: list[str],
    action: tuple[str, str] | None,
    footnote: str | None,
    site_url: str,
) -> str:
    """Wrap content in the shared shell.

    `preheader` is the grey line inboxes show after the subject. Left unset it
    fills with whatever text comes first — usually a URL — which looks broken
    in the one place every recipient sees before deciding to open.
    """

    body = "".join(
        f'<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#3f3f46;">{p}</p>'
        for p in paragraphs
    )

    button = ""
    if action is not None:
        label, url = action
        safe_url = html.escape(url, quote=True)
        button = f"""
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">
          <tr>
            <td align="center" bgcolor="{ACCENT}" style="border-radius:8px;">
              <a href="{safe_url}"
                 style="display:inline-block;padding:12px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                {html.escape(label)}
              </a>
            </td>
          </tr>
        </table>
        <p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#71717a;">
          Or paste this into your browser:
        </p>
        <p style="margin:0 0 20px;font-size:13px;line-height:20px;word-break:break-all;">
          <a href="{safe_url}" style="color:{ACCENT};text-decoration:underline;">{safe_url}</a>
        </p>
        """

    note = (
        f'<p style="margin:0 0 4px;font-size:13px;line-height:20px;color:#71717a;">{footnote}</p>'
        if footnote
        else ""
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>{html.escape(heading)}</title>
<style>
  /* Clients that honour <style> get dark mode; the rest keep the inline light
     styles, which are readable either way. */
  @media (prefers-color-scheme: dark) {{
    .sp-bg {{ background:#09090b !important; }}
    .sp-card {{ background:#18181b !important; border-color:#27272a !important; }}
    .sp-text {{ color:#e4e4e7 !important; }}
    .sp-muted {{ color:#a1a1aa !important; }}
    .sp-head {{ color:#fafafa !important; }}
    .sp-link {{ color:{ACCENT_DARK} !important; }}
  }}
  @media (max-width:620px) {{
    .sp-card {{ padding:24px !important; }}
  }}
</style>
</head>
<body class="sp-bg" style="margin:0;padding:0;background:#f4f4f5;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">{html.escape(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="sp-bg" style="background:#f4f4f5;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td style="padding:0 0 16px;">
              <span class="sp-head" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:17px;font-weight:700;letter-spacing:-0.02em;color:#18181b;">{BRAND}</span>
            </td>
          </tr>
          <tr>
            <td class="sp-card" style="background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <h1 class="sp-head" style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:650;color:#18181b;">{html.escape(heading)}</h1>
              <div class="sp-text">{body}</div>
              {button}
              {note}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 4px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <p class="sp-muted" style="margin:0 0 6px;font-size:12px;line-height:18px;color:#a1a1aa;">
                Sent by {BRAND} · <a href="{html.escape(site_url, quote=True)}" class="sp-link" style="color:#71717a;text-decoration:underline;">{html.escape(site_url)}</a>
              </p>
              <p class="sp-muted" style="margin:0;font-size:12px;line-height:18px;color:#a1a1aa;">
                This is an automated message about your account — we don't send marketing.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def _text(
    *,
    heading: str,
    paragraphs: list[str],
    action: tuple[str, str] | None,
    footnote: str | None,
    site_url: str,
) -> str:
    lines = [heading, "=" * len(heading), ""]
    lines.extend(paragraphs)
    if action is not None:
        _, url = action
        lines += ["", url, ""]
    if footnote:
        lines += [footnote, ""]
    lines += [
        "--",
        f"Sent by {BRAND} · {site_url}",
        "Automated account message; we don't send marketing.",
    ]
    return "\n".join(lines) + "\n"


def _render(
    *,
    subject: str,
    preheader: str,
    heading: str,
    paragraphs: list[str],
    site_url: str,
    action: tuple[str, str] | None = None,
    footnote: str | None = None,
) -> RenderedEmail:
    # The HTML escapes; the text part must carry the raw wording.
    plain = [p.replace("<b>", "").replace("</b>", "") for p in paragraphs]
    return RenderedEmail(
        subject=subject,
        text=_text(
            heading=heading, paragraphs=plain, action=action, footnote=footnote, site_url=site_url
        ),
        html=_layout(
            preheader=preheader,
            heading=heading,
            paragraphs=[html.escape(p) for p in plain],
            action=action,
            footnote=html.escape(footnote) if footnote else None,
            site_url=site_url,
        ),
    )


def verify_email(*, link: str, site_url: str) -> RenderedEmail:
    return _render(
        subject="Verify your email address",
        preheader="One click to confirm this address and finish setting up spawn.",
        heading="Confirm your email address",
        paragraphs=[
            "Confirming this address finishes setting up your spawn account, and it is "
            "what makes account recovery possible later — a password reset can only be "
            "sent somewhere you control.",
        ],
        action=("Verify this address", link),
        footnote="This link works once and expires in two days. If you didn't create a spawn account, you can ignore this message.",
        site_url=site_url,
    )


def password_reset(*, link: str, site_url: str) -> RenderedEmail:
    return _render(
        subject="Reset your password",
        preheader="A link to set a new password. Expires in one hour.",
        heading="Reset your password",
        paragraphs=[
            "Someone asked to reset the password for this spawn account. If that was "
            "you, use the link below to choose a new one.",
            "Setting a new password signs out every device currently signed in to this "
            "account, including any you don't recognise.",
        ],
        action=("Choose a new password", link),
        footnote="This link works once and expires in one hour. If this wasn't you, no action is needed — your password stays as it is until the link is used.",
        site_url=site_url,
    )


def invite(*, link: str, site_url: str, inviter: str | None = None) -> RenderedEmail:
    who = f"{inviter} invited you" if inviter else "You've been invited"
    return _render(
        subject=f"You're invited to {BRAND}",
        preheader="Your invitation link — it works once, and it expires.",
        heading=f"{who} to spawn",
        paragraphs=[
            "spawn runs your coding agents on your own machines and gives you a terminal "
            "to them from any browser — your phone included.",
            "Signing up is invite-only right now, so this link is what gets you in.",
        ],
        action=("Create your account", link),
        footnote="This invitation works once and expires. If you weren't expecting it, you can ignore this message.",
        site_url=site_url,
    )


def test_email(*, site_url: str) -> RenderedEmail:
    return _render(
        subject="spawn test email",
        preheader="Outbound email is working.",
        heading="Outbound email is working",
        paragraphs=[
            "This is a test message from your spawn deployment. If you're reading it, "
            "delivery is configured correctly and account emails will reach your users.",
        ],
        footnote="Sent from the admin dashboard.",
        site_url=site_url,
    )
