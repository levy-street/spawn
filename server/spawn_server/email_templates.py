"""HTML and plain-text bodies for every message spawn sends.

The palette here is not chosen; it is spawn's, transcribed. The web app's
tokens live in `web/src/app/globals.css` as `oklch(L 0 0)` — pure neutral, zero
chroma — and the values below are those same tokens converted to hex, because
email has no oklch and no custom properties. Keep the two in step: if a token
moves there, move it here.

Email rendering is a hostile environment, and the structure follows from that
rather than from taste:

- Tables for layout, inline styles for anything that must survive. Gmail on a
  non-Gmail account strips <style> entirely, so the design ships inline and
  <style> only defends it.
- No external images. The wordmark is a table cell and a character, so nothing
  breaks when images are blocked — which for a security email is the default,
  not the exception.
- Every message is multipart: a real plain-text part, not a stripped-tag
  afterthought, because plenty of people read mail as text and every spam
  filter reads it that way.
- The action is always available as a bare URL as well as a button. Buttons
  fail; a link the reader can copy always works.

On being dark in a light client: the message is one self-contained dark card
on an unpainted canvas, never a dark canvas. Painting the canvas is the
tempting version and it looks wrong everywhere it half-works — a light client
renders a black band jammed edge-to-edge into a white pane, and anything
sitting outside the card (a wordmark, a footer) turns invisible the moment a
client drops that background, which Gmail does routinely by deleting <body>.
Leaving the canvas alone costs nothing in a dark client and reads as a
deliberate card in a light one, so every pixel we colour is inside the border.
"""

from __future__ import annotations

import html
from dataclasses import dataclass

BRAND = "spawn"

# --- spawn tokens, transcribed ----------------------------------------------
# Converted from web/src/app/globals.css @theme; the marketing pages use these
# same hexes literally (bg-[#0d0d0d], bg-black, text-zinc-300).
CARD = "#0d0d0d"  # --color-card, oklch(0.16 0 0)
CHROME = "#0a0a0a"  # --color-terminal-bg; the header/footer bands
WELL = "#000000"  # bg-black, the app's code/terminal boxes
BORDER = "#262626"  # --color-border, oklch(0.27 0 0)
INK = "#080808"  # the app's page colour, used for text on the light button
FG = "#f5f5f5"  # --color-foreground, oklch(0.97 0 0)
BODY = "#d4d4d8"  # zinc-300, the app's body copy on dark
MUTED = "#a1a1aa"  # zinc-400
FAINT = "#71717a"  # zinc-500


@dataclass(frozen=True)
class Accent:
    """One Badge variant, flattened.

    The app writes these as `bg-emerald-500/10 border-emerald-500/25
    text-emerald-400`. Email has no alpha compositing worth relying on, so the
    translucent pair is precomputed over CARD.
    """

    text: str
    chip_bg: str
    chip_border: str


EMERALD = Accent("#34d399", "#0d1e19", "#0e382a")  # success — the `$` prompt
SKY = Accent("#38bdf8", "#0d1c23", "#0d3344")  # informational
AMBER = Accent("#fbbf24", "#241c0d", "#47310c")  # security, attention

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


def _header(*, eyebrow: str, accent: Accent) -> str:
    """The app's own header: wordmark left, bordered chip right.

    Same lockup as the admin dashboard (`spawn` beside an `admin` chip), and
    the chip is the Badge component.

    The mark is the app's icon rebuilt from markup rather than fetched: lucide
    square-terminal is a rounded frame around a chevron and an underscore, so
    a bordered cell holding `>_` is the same drawing by other means. An image
    would be the obvious approach and the wrong one — Outlook blocks images by
    default, and the logo on a security email is the last thing that should
    render as an empty box.
    """

    return f"""
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td width="28" height="28" align="center" valign="middle" bgcolor="{WELL}"
                  style="width:28px;height:28px;background-color:{WELL};border:1px solid {BORDER};
                         border-radius:7px;font-family:{MONO};font-size:12px;font-weight:700;
                         color:{FG};line-height:28px;letter-spacing:-0.5px;">&gt;_</td>
              <td style="padding-left:9px;font-family:{SANS};font-size:16px;font-weight:600;
                         letter-spacing:-0.01em;color:{FG};">{BRAND}</td>
            </tr>
          </table>
        </td>
        <td align="right">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="right">
            <tr>
              <td bgcolor="{accent.chip_bg}"
                  style="background-color:{accent.chip_bg};border:1px solid {accent.chip_border};
                         border-radius:999px;padding:3px 10px;font-family:{SANS};font-size:11px;
                         font-weight:500;line-height:16px;color:{accent.text};
                         white-space:nowrap;">{html.escape(eyebrow)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    """


def _layout(
    *,
    preheader: str,
    eyebrow: str,
    accent: Accent,
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
                        font-weight:600;color:{INK};text-decoration:none;mso-padding-alt:0;">{html.escape(label)}</a>
            </td>
          </tr>
        </table>

        <!-- Fallback: the same link, plain, in the app's code-well styling. -->
        <p class="sp-faint" style="margin:24px 0 8px;font-family:{SANS};font-size:12px;
                                   line-height:18px;color:{FAINT};">
          Or paste this link into your browser
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td class="sp-well" bgcolor="{WELL}"
                style="background-color:{WELL};border:1px solid {BORDER};border-radius:8px;padding:11px 13px;">
              <a href="{safe_url}" class="sp-mono"
                 style="font-family:{MONO};font-size:12px;line-height:20px;color:{BODY};
                        text-decoration:none;word-break:break-all;">{safe_url}</a>
            </td>
          </tr>
        </table>
        """

    note = (
        f"""
          <tr>
            <td class="sp-card" bgcolor="{CARD}"
                style="background-color:{CARD};border-top:1px solid {BORDER};padding:18px 26px;">
              <p class="sp-faint" style="margin:0;font-family:{SANS};font-size:12px;line-height:19px;
                                         mso-line-height-rule:exactly;color:{FAINT};">{footnote}</p>
            </td>
          </tr>
        """
        if footnote
        else ""
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- The card is already dark. Say so, so clients stop guessing and stop inverting. -->
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>{html.escape(heading)}</title>
<style>
  /* Outlook.com re-tints mail and tags what it touched with data-ogsc (text)
     and data-ogsb (background). Claim our colours back. */
  [data-ogsc] .sp-card, [data-ogsb] .sp-card {{ background-color:{CARD} !important; }}
  [data-ogsc] .sp-chrome, [data-ogsb] .sp-chrome {{ background-color:{CHROME} !important; }}
  [data-ogsc] .sp-well, [data-ogsb] .sp-well {{ background-color:{WELL} !important; }}
  [data-ogsc] .sp-head {{ color:{FG} !important; }}
  [data-ogsc] .sp-body, [data-ogsc] .sp-mono {{ color:{BODY} !important; }}
  [data-ogsc] .sp-faint {{ color:{FAINT} !important; }}
  [data-ogsc] .sp-link {{ color:{MUTED} !important; }}
  [data-ogsc] .sp-btn {{ color:{INK} !important; }}
  @media (max-width:620px) {{
    .sp-pad {{ padding:22px 18px !important; }}
    .sp-gutter {{ padding:20px 10px !important; }}
  }}
</style>
</head>
<body style="margin:0;padding:0;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">{html.escape(preheader)}</div>
  <!-- Stops the client pulling body copy in after the preheader. -->
  <div style="display:none;max-height:0;overflow:hidden;">{"&#8199;&#65279;" * 30}</div>
  <!-- No background on the canvas: see the module docstring. -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>
      <td class="sp-gutter" align="center" style="padding:28px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="width:100%;max-width:600px;border:1px solid {BORDER};border-radius:12px;">
          <tr>
            <td class="sp-chrome sp-pad" bgcolor="{CHROME}"
                style="background-color:{CHROME};border-bottom:1px solid {BORDER};
                       border-radius:12px 12px 0 0;padding:15px 26px;">{_header(eyebrow=eyebrow, accent=accent)}</td>
          </tr>
          <tr>
            <td class="sp-card sp-pad" bgcolor="{CARD}"
                style="background-color:{CARD};padding:28px 26px;">
              <h1 class="sp-head" style="margin:0 0 14px;font-family:{SANS};font-size:22px;line-height:30px;
                                         mso-line-height-rule:exactly;font-weight:600;letter-spacing:-0.02em;
                                         color:{FG};">{html.escape(heading)}</h1>
              {body}
              {action_block}
            </td>
          </tr>
          {note}
          <tr>
            <td class="sp-chrome sp-pad" bgcolor="{CHROME}"
                style="background-color:{CHROME};border-top:1px solid {BORDER};
                       border-radius:0 0 12px 12px;padding:16px 26px;font-family:{SANS};">
              <p class="sp-faint" style="margin:0 0 5px;font-size:12px;line-height:18px;color:{FAINT};">
                Sent by {BRAND} · <a href="{html.escape(site_url, quote=True)}" class="sp-link"
                   style="color:{MUTED};text-decoration:underline;">{html.escape(site_url)}</a>
              </p>
              <p class="sp-faint" style="margin:0;font-size:12px;line-height:18px;color:{FAINT};">
                An automated message about your account — we don't send marketing.
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
    accent: Accent,
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
