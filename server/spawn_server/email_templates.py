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
from datetime import datetime

#: The product's name, set exactly as the repo requires it: capitals, one
#: space, no trailing period. `spawn` is the folder and `spawnd` is the
#: daemon; neither is what a person reading a message is looking at.
BRAND = "SPAWN D"

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

    Same lockup as the admin dashboard (the wordmark beside an `admin` chip),
    and the chip is the Badge component.

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
        preheader="One click to confirm this address and finish setting up SPAWN D.",
        eyebrow="Account setup",
        accent=SKY,
        heading="Confirm your email address",
        paragraphs=[
            "Confirming this address finishes setting up your SPAWN D account, and it is "
            "what makes account recovery possible later — a password reset can only be "
            "sent somewhere you control.",
        ],
        action=("Verify this address", link),
        footnote="This link works once and expires in two days. If you didn't create a SPAWN D account, you can ignore this message.",
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
            "Someone asked to reset the password for this SPAWN D account. If that was "
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
    opening = (
        f"{inviter} invited you to SPAWN D."
        if inviter
        else "You've been invited to SPAWN D."
    )
    return _render(
        subject=f"You're invited to {BRAND}",
        preheader="Your invitation link — it works once, and it expires.",
        eyebrow="Invitation",
        accent=EMERALD,
        heading="You're invited to SPAWN D",
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
        subject="SPAWN D test email",
        preheader="Outbound email is working.",
        eyebrow="Deployment check",
        accent=EMERALD,
        heading="Outbound email is working",
        paragraphs=[
            "This is a test message from your SPAWN D deployment. If you're reading it, "
            "delivery is configured correctly and account emails will reach your users.",
        ],
        footnote="Sent from the admin dashboard.",
        site_url=site_url,
    )


# --- billing ----------------------------------------------------------------
# These six are the one billing surface allowed to name a price. Apple's 3.1.3
# preamble is explicit that a developer may write to their user base about
# purchasing methods outside the app, and the app itself says nothing: the 402
# body is machine codes and numbers (`billing.limit_error_detail`) and the
# mobile copy is pure account state. So the tiers, the prices and the link live
# here, in a message no App Store binary renders.
#
# The register stays plainer than the rest of the product on purpose. These
# messages are also the pre-contract disclosure a subscription legally owes its
# buyer, and copy that gets clever about money reads as copy with something to
# hide.


@dataclass(frozen=True)
class PlanOption:
    """One row of the tier comparison an email may carry.

    Deliberately not `billing.Tier`: this module renders words and knows
    nothing about entitlement, and a template that imported the entitlement
    module would be one import away from deciding what somebody is owed.
    """

    name: str
    price_cents: int
    #: None = unlimited.
    host_limit: int | None


def _money(cents: int) -> str:
    """`500` → `$5.00 / month`.

    Display only. Stripe charges what its own price object says, and this
    number never reaches a payment — see `billing.Tier.price_cents`.
    """

    return f"${cents / 100:,.2f} / month"


def _hosts(count: int | None) -> str:
    """`None` = unlimited, here as everywhere else in this codebase."""

    if count is None:
        return "unlimited hosts"
    return "1 host" if count == 1 else f"{count} hosts"


def _date(when: datetime) -> str:
    """`24 September 2026`. Spelled out, because 09/10/2026 is two dates."""

    return f"{when.day} {when:%B %Y}"


def subscription_started(
    *,
    tier_name: str,
    price_cents: int,
    renewal_date: datetime | None,
    manage_url: str,
    site_url: str,
) -> RenderedEmail:
    """What was bought, what it costs, when it renews, and how to stop it.

    Stripe emails a receipt and it is not this. A receipt records a payment;
    EU and UK distance-selling rules want the terms of the thing bought, in a
    durable medium, from the seller — which is us. The cancellation sentence
    is the part that is legally load-bearing, so it is never trimmed for
    length.
    """

    renews = (
        f"It renews on {_date(renewal_date)}, and monthly from then on, until you cancel."
        if renewal_date is not None
        else "It renews monthly until you cancel."
    )
    return _render(
        subject=f"Your {BRAND} subscription is active",
        preheader=f"{tier_name}, {_money(price_cents)}. What it includes, and how to cancel.",
        eyebrow="Subscription",
        accent=EMERALD,
        heading="Your subscription is active",
        paragraphs=[
            f"This account is now on {tier_name}, at {_money(price_cents)}.",
            renews,
            "You can cancel whenever you like, from Settings → Subscription in "
            f"{BRAND}. Cancelling stops the next payment and leaves the plan "
            "running until the period you have already paid for runs out — "
            "nothing is cut short.",
            "Whatever happens to the plan afterwards, machines you have already "
            "possessed keep running. The limit only ever governs adding a new one.",
        ],
        action=("Manage subscription", manage_url),
        footnote="Keep this for your records. The payment receipt comes separately, from Stripe.",
        site_url=site_url,
    )


def payment_failed(*, portal_url: str, site_url: str) -> RenderedEmail:
    """A card declined, and deliberately not a revocation notice.

    Stripe's dunning runs for weeks and `past_due` still entitles
    (`billing.ENTITLING_STATUSES`), so at the moment this is sent nothing has
    been lost. Saying so is the whole job: an email that reads like a
    disconnection notice makes people panic about hosts that are still running
    perfectly well.
    """

    return _render(
        subject="We couldn't take payment",
        preheader="The card was declined. Nothing has been lost — your plan is still running.",
        eyebrow="Payment",
        accent=AMBER,
        heading="We couldn't take payment",
        paragraphs=[
            f"The card on file was declined for this month's payment on your {BRAND} subscription.",
            "Nothing has been lost. Your plan is still active, your hosts are "
            "still connected, and nothing has been revoked or deleted.",
            "We'll try the card again over the next few days. Updating it now "
            "settles the matter before then — the link below opens the billing "
            "portal, where you can change the card and see the outstanding invoice.",
        ],
        action=("Update payment method", portal_url),
        footnote="If you've already updated the card, there's nothing to do — the next attempt will use it.",
        site_url=site_url,
    )


def payment_action_required(*, invoice_url: str, site_url: str) -> RenderedEmail:
    """3-D Secure: the bank wants the cardholder, and only they can answer."""

    return _render(
        subject="Your bank needs to confirm a payment",
        preheader="One confirmation step and this month's payment goes through.",
        eyebrow="Payment",
        accent=AMBER,
        heading="Your bank needs to confirm a payment",
        paragraphs=[
            "Your bank has asked for an extra confirmation — 3-D Secure — before "
            f"this month's payment on your {BRAND} subscription can be taken.",
            "Opening the invoice below takes you straight to it. The confirmation "
            "happens on your bank's own page and takes a moment.",
            "Until it's done the payment stays pending. Your plan is still active "
            "in the meantime, and nothing has been revoked.",
        ],
        action=("Confirm this payment", invoice_url),
        footnote="Nothing is charged until the confirmation completes.",
        site_url=site_url,
    )


def plan_changed(
    *,
    from_tier_name: str,
    to_tier_name: str,
    host_limit: int | None,
    manage_url: str,
    site_url: str,
) -> RenderedEmail:
    """A plan moved, in either direction, and it moved now.

    Both directions land here and the wording has to survive both, so it says
    what changed rather than congratulating anybody. Immediacy is the fact
    worth stating: a downgrade that took effect at the end of the period would
    be a different product, and people reasonably assume that is what happened.
    """

    return _render(
        subject="Your plan has changed",
        preheader=f"{from_tier_name} → {to_tier_name}, effective immediately.",
        eyebrow="Subscription",
        accent=SKY,
        heading="Your plan has changed",
        paragraphs=[
            f"This account has moved from {from_tier_name} to {to_tier_name}. The "
            "change took effect immediately — there's no waiting for the end of a "
            "billing period.",
            f"The account can now hold {_hosts(host_limit)}.",
            "Any difference in price is settled on your next invoice.",
            "Machines you have already possessed are unaffected either way. They "
            "keep running, and the limit only governs adding a new one.",
        ],
        action=("Manage subscription", manage_url),
        footnote="Sent whenever the plan on this account changes.",
        site_url=site_url,
    )


def subscription_ended(
    *,
    host_limit: int | None,
    host_count: int,
    plans_url: str,
    site_url: str,
) -> RenderedEmail:
    """The end of a plan, and the promise that it costs them nothing yet.

    The fear this message has to answer is "which of my machines did you just
    kill". None of them: there is no suspend state and we are not building one
    (docs/BILLING.md §11.2), so an account over its limit simply sits there
    until the person picks what to keep. Both halves of that — the machines
    keep running, and nothing goes without an explicit choice — are load-
    bearing, and neither is conditional on the numbers.
    """

    return _render(
        subject="Your subscription has ended",
        preheader="Your machines keep running, and nothing has been deleted.",
        eyebrow="Subscription",
        accent=SKY,
        heading="Your subscription has ended",
        paragraphs=[
            "The subscription on this account has ended, and the account is back "
            f"to {_hosts(host_limit)}.",
            "Your machines keep running. Nothing was disconnected, nothing was "
            "stopped, and nothing has been deleted — the account is still holding "
            f"{_hosts(host_count)}, exactly as you left them.",
            "The limit only ever governs adding a new host. If the account is "
            f"holding more than the plan allows, the next time you open {BRAND} "
            "it will ask which hosts to keep — or to keep none. Nothing is removed "
            "until you choose.",
        ],
        action=("View plans", plans_url),
        footnote="You can start a plan again whenever you like; nothing about the account changes in the meantime.",
        site_url=site_url,
    )


def host_limit_reached(
    *,
    tier_name: str,
    host_limit: int,
    host_count: int,
    plans: list[PlanOption],
    upgrade_url: str,
    site_url: str,
) -> RenderedEmail:
    """A machine was turned away — the one message that may sell.

    The app that produced this refusal is allowed to say only "Host limit
    reached · Your plan includes 3 hosts. Disconnect one to connect another."
    — no price, no venue, no verb pointed off-platform. This message is
    outside the app, which is exactly the case Apple's 3.1.3 preamble
    permits, so it carries the comparison and the link the app cannot.

    The in-app action comes first anyway. Somebody who wanted to swap a dead
    laptop for a new one is not shopping, and leading with the plans would
    answer a question they did not ask.
    """

    return _render(
        subject="You've reached your host limit",
        preheader="A machine was turned away. Here's how to make room for it.",
        eyebrow="Host limit",
        accent=AMBER,
        heading="You've reached your host limit",
        paragraphs=[
            "A machine tried to join this account and was turned away: the account "
            f"is on {tier_name}, which includes {_hosts(host_limit)}, and is already "
            f"holding {_hosts(host_count)}.",
            "Nothing already connected is affected. Every host you have keeps "
            "running, and this changes none of them.",
            "You can free a slot by disconnecting a host you no longer use — Hosts "
            f"in {BRAND}, then Disconnect. The machine that was turned away can then "
            "be possessed again with no further setup.",
            "Or take more room:",
            *(
                f"{plan.name} — {_money(plan.price_cents)}, {_hosts(plan.host_limit)}"
                for plan in plans
            ),
        ],
        action=("Upgrade", upgrade_url),
        footnote="Sent at most once a day, and only when a machine is actually turned away.",
        site_url=site_url,
    )
