"""HTML and plain-text bodies for every message spawn sends.

The palette here is not chosen; it is spawn's, transcribed. The web app's
tokens live in `web/src/app/globals.css` as `oklch(L 0 0)` — pure neutral, zero
chroma — and the values below are those same tokens converted to hex, because
email has no oklch and no custom properties. Keep the two in step: if a token
moves there, move it here.

Email rendering is also a hostile environment, and the structural rules follow
from that rather than from taste:

- Tables for layout, inline styles for anything that must survive. Gmail on a
  non-Gmail account strips <style> entirely, so the design ships inline and
  <style> only defends it.
- No external images. The wordmark is built from a table cell and a character,
  so nothing breaks when images are blocked — which for a security email is
  the default, not the exception.
- Every message is multipart: a real plain-text part, not a stripped-tag
  afterthought, because plenty of people read mail as text and every spam
  filter reads it that way.
- The action is always available as a bare URL as well as a button. Buttons
  fail; a link the reader can copy always works.

On being dark: the app is dark-only, so the mail is too, and it declares that
with `color-scheme: dark` rather than leaving clients to guess. Clients that
re-tint mail (Outlook.com) tag what they changed with data-ogsc/data-ogsb, and
the <style> block claims those back.
"""

from __future__ import annotations

import html
from dataclasses import dataclass

BRAND = "spawn"

# --- spawn tokens, transcribed ----------------------------------------------
# Converted from web/src/app/globals.css @theme; the marketing pages use the
# same hexes literally (bg-[#080808], bg-[#0d0d0d]).
BG = "#080808"  # page
CARD = "#0d0d0d"  # --color-card, oklch(0.16 0 0)
WELL = "#050505"  # inset code/terminal surface
BORDER = "#262626"  # --color-border, oklch(0.27 0 0)
FG = "#f5f5f5"  # --color-foreground, oklch(0.97 0 0)
BODY = "#d4d4d8"  # zinc-300, the app's body copy on dark
MUTED = "#a1a1aa"  # zinc-400
FAINT = "#71717a"  # zinc-500

# Semantic accents, matching Badge's variants and the landing page's eyebrow
# labels. These are never the brand colour — spawn has no brand colour, it has
# neutrals plus meaning.
EMERALD = "#6ee7b7"  # emerald-300 — the `$` prompt, success
SKY = "#7dd3fc"  # sky-300 — informational
AMBER = "#fcd34d"  # amber-300 — security, attention

SANS = (
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,"
    "'Helvetica Neue',Arial,'Noto Sans',sans-serif"
)
MONO = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono','Courier New',monospace"


@dataclass(frozen=True)
class RenderedEmail:
    subject: str
    text: str
    html: str


def _wordmark() -> str:
    """The app's lockup without an image: a bordered square holding a mono `$`,
    then the wordmark. Mirrors the install-command motif on the landing page.
    Outlook squares off the corners; that is the whole degradation."""

    return f"""
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td width="30" height="30" align="center" valign="middle" bgcolor="#000000"
            style="width:30px;height:30px;background-color:#000000;border:1px solid {BORDER};border-radius:8px;
                   font-family:{MONO};font-size:14px;font-weight:700;color:{EMERALD};line-height:30px;">$</td>
        <td style="padding-left:10px;font-family:{SANS};font-size:17px;font-weight:600;
                   letter-spacing:-0.01em;color:{FG};">{BRAND}</td>
      </tr>
    </table>
    """


def _layout(
    *,
    preheader: str,
    eyebrow: str,
    accent: str,
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
        f'<p class="sp-body" style="margin:0 0 14px;font-family:{SANS};font-size:15px;'
        f'line-height:24px;mso-line-height-rule:exactly;color:{BODY};">{p}</p>'
        for p in paragraphs
    )

    action_block = ""
    if action is not None:
        label, url = action
        safe_url = html.escape(url, quote=True)
        action_block = f"""
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0;">
          <tr>
            <td align="center" bgcolor="{FG}" style="background-color:{FG};border-radius:8px;">
              <a href="{safe_url}" class="sp-btn"
                 style="display:inline-block;padding:12px 22px;font-family:{SANS};font-size:15px;
                        font-weight:600;color:{BG};text-decoration:none;mso-padding-alt:0;">{html.escape(label)}</a>
            </td>
          </tr>
        </table>

        <!-- Fallback: the same link, plain, in the app's code-well styling. -->
        <p class="sp-faint" style="margin:26px 0 8px;font-family:{SANS};font-size:12px;line-height:18px;color:{FAINT};">
          Or paste this link into your browser
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td class="sp-well" bgcolor="{WELL}"
                style="background-color:{WELL};border:1px solid {BORDER};border-radius:8px;padding:12px 14px;">
              <a href="{safe_url}" class="sp-mono"
                 style="font-family:{MONO};font-size:12px;line-height:20px;color:{BODY};
                        text-decoration:none;word-break:break-all;">{safe_url}</a>
            </td>
          </tr>
        </table>
        """

    note = (
        f"""
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;">
          <tr><td style="border-top:1px solid {BORDER};font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>
        <p class="sp-faint" style="margin:16px 0 0;font-family:{SANS};font-size:12px;line-height:19px;
                                   mso-line-height-rule:exactly;color:{FAINT};">{footnote}</p>
        """
        if footnote
        else ""
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- The app is dark-only. Say so, so clients stop guessing and stop inverting. -->
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{html.escape(heading)}</title>
<style>
  /* Outlook.com re-tints mail and tags what it touched with data-ogsc (text)
     and data-ogsb (background). Claim our colours back. */
  [data-ogsc] .sp-bg, [data-ogsb] .sp-bg {{ background-color:{BG} !important; }}
  [data-ogsc] .sp-card, [data-ogsb] .sp-card {{ background-color:{CARD} !important; }}
  [data-ogsc] .sp-well, [data-ogsb] .sp-well {{ background-color:{WELL} !important; }}
  [data-ogsc] .sp-head {{ color:{FG} !important; }}
  [data-ogsc] .sp-body, [data-ogsc] .sp-mono {{ color:{BODY} !important; }}
  [data-ogsc] .sp-faint {{ color:{FAINT} !important; }}
  [data-ogsc] .sp-link {{ color:{MUTED} !important; }}
  [data-ogsc] .sp-btn {{ color:{BG} !important; }}
  [data-ogsc] .sp-eyebrow {{ color:{accent} !important; }}
  /* Every surface carries its own bgcolor inline, so a client that forces a
     light canvas changes the gutter and nothing else. */
  @media (max-width:620px) {{
    .sp-card {{ padding:22px !important; }}
    .sp-gutter {{ padding:24px 12px !important; }}
  }}
</style>
</head>
<body class="sp-bg" style="margin:0;padding:0;background-color:{BG};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">{html.escape(preheader)}</div>
  <!-- Stops the client pulling body copy in after the preheader. -->
  <div style="display:none;max-height:0;overflow:hidden;">{"&#8199;&#65279;" * 30}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         class="sp-bg" bgcolor="{BG}" style="background-color:{BG};">
    <tr>
      <td class="sp-gutter" align="center" style="padding:36px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="width:100%;max-width:600px;">
          <tr>
            <td style="padding:0 2px 18px;">{_wordmark()}</td>
          </tr>
          <tr>
            <td class="sp-card" bgcolor="{CARD}"
                style="background-color:{CARD};border:1px solid {BORDER};border-radius:10px;padding:30px;">
              <p class="sp-eyebrow" style="margin:0 0 10px;font-family:{SANS};font-size:13px;font-weight:500;
                        line-height:18px;color:{accent};">{html.escape(eyebrow)}</p>
              <h1 class="sp-head" style="margin:0 0 14px;font-family:{SANS};font-size:21px;line-height:29px;
                                         mso-line-height-rule:exactly;font-weight:600;letter-spacing:-0.01em;
                                         color:{FG};">{html.escape(heading)}</h1>
              {body}
              {action_block}
              {note}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 4px 0;font-family:{SANS};">
              <p class="sp-faint" style="margin:0 0 6px;font-size:12px;line-height:18px;color:{FAINT};">
                Sent by {BRAND} · <a href="{html.escape(site_url, quote=True)}" class="sp-link"
                   style="color:{MUTED};text-decoration:underline;">{html.escape(site_url)}</a>
              </p>
              <p class="sp-faint" style="margin:0;font-size:12px;line-height:18px;color:{FAINT};">
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
    eyebrow: str,
    accent: str,
    heading: str,
    paragraphs: list[str],
    site_url: str,
    action: tuple[str, str] | None = None,
    footnote: str | None = None,
) -> RenderedEmail:
    return RenderedEmail(
        subject=subject,
        text=_text(
            heading=heading,
            paragraphs=paragraphs,
            action=action,
            footnote=footnote,
            site_url=site_url,
        ),
        html=_layout(
            preheader=preheader,
            eyebrow=eyebrow,
            accent=accent,
            heading=heading,
            paragraphs=[html.escape(p) for p in paragraphs],
            action=action,
            footnote=html.escape(footnote) if footnote else None,
            site_url=site_url,
        ),
    )


def verify_email(*, link: str, site_url: str) -> RenderedEmail:
    return _render(
        subject="Verify your email address",
        preheader="One click to confirm this address and finish setting up spawn.",
        eyebrow="Account setup",
        accent=SKY,
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
        eyebrow="Account security",
        accent=AMBER,
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
    # The inviter goes in the body, not the heading: addresses are long and
    # arbitrary, and one set as an H1 wraps into two lines of shouting.
    opening = f"{inviter} invited you to spawn." if inviter else "You've been invited to spawn."
    return _render(
        subject=f"You're invited to {BRAND}",
        preheader="Your invitation link — it works once, and it expires.",
        eyebrow="Invitation",
        accent=EMERALD,
        heading="You're invited to spawn",
        paragraphs=[
            f"{opening} It runs your coding agents on your own machines and gives you a "
            "terminal to them from any browser — your phone included.",
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
        eyebrow="Deployment check",
        accent=EMERALD,
        heading="Outbound email is working",
        paragraphs=[
            "This is a test message from your spawn deployment. If you're reading it, "
            "delivery is configured correctly and account emails will reach your users.",
        ],
        footnote="Sent from the admin dashboard.",
        site_url=site_url,
    )
