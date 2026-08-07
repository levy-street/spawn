"""Properties every outbound message must hold, whatever the copy says."""

from __future__ import annotations

import re

import pytest

from spawn_server import email_templates

SITE = "https://spawn.example"
LINK = "https://spawn.example/reset-password?token=abc123XYZ"

RENDERED = [
    email_templates.verify_email(link=LINK, site_url=SITE),
    email_templates.password_reset(link=LINK, site_url=SITE),
    email_templates.invite(link=LINK, site_url=SITE, inviter="owner@example.com"),
    email_templates.test_email(site_url=SITE),
]


@pytest.mark.parametrize("rendered", RENDERED, ids=lambda r: r.subject)
def test_every_message_has_a_real_text_part(rendered):
    """Plain text is a first-class body, not stripped tags.

    Plenty of people read mail as text, and every spam filter does.
    """

    assert rendered.text.strip()
    assert "<" not in rendered.text.replace("<br>", "")
    assert SITE in rendered.text


@pytest.mark.parametrize("rendered", RENDERED, ids=lambda r: r.subject)
def test_every_message_is_self_contained(rendered):
    """No external images or scripts: images are blocked by default, and a
    security email that renders as broken boxes teaches people to distrust it."""

    lowered = rendered.html.lower()
    assert "<img" not in lowered
    assert "<script" not in lowered
    assert "http://" not in lowered.replace("http://www.w3.org", "")


@pytest.mark.parametrize("rendered", RENDERED, ids=lambda r: r.subject)
def test_every_message_carries_a_preheader(rendered):
    # The preheader is the grey line inboxes show after the subject; left
    # unset it fills with whatever comes first, usually a raw URL.
    assert 'style="display:none' in rendered.html


@pytest.mark.parametrize("rendered", RENDERED, ids=lambda r: r.subject)
def test_every_message_declares_and_defends_dark(rendered):
    """The app is dark-only, so the mail is too.

    Declaring the scheme stops clients "helpfully" inverting it, and the
    data-ogsc/data-ogsb overrides claim colours back from Outlook.com, which
    re-tints mail and tags whatever it changed.
    """

    assert 'name="color-scheme" content="dark"' in rendered.html
    assert 'name="supported-color-schemes" content="dark"' in rendered.html
    assert "[data-ogsc]" in rendered.html
    assert "[data-ogsb]" in rendered.html


@pytest.mark.parametrize("rendered", RENDERED, ids=lambda r: r.subject)
def test_messages_only_use_the_app_palette(rendered):
    """Every colour must be a spawn token.

    These emails once shipped a light card and an emerald button borrowed from
    nowhere. The palette below is transcribed from web/src/app/globals.css, so
    an off-brand colour fails here rather than in someone's inbox.
    """

    allowed = {
        email_templates.BG,
        email_templates.CARD,
        email_templates.WELL,
        email_templates.BORDER,
        email_templates.FG,
        email_templates.BODY,
        email_templates.MUTED,
        email_templates.FAINT,
        email_templates.EMERALD,
        email_templates.SKY,
        email_templates.AMBER,
        "#000000",
    }
    used = {c.lower() for c in re.findall(r"#[0-9a-fA-F]{6}\b", rendered.html)}
    assert used <= allowed, f"off-palette colours: {sorted(used - allowed)}"


def test_action_links_appear_as_button_and_copyable_url():
    """Buttons fail — in text mode, in old clients, behind proxies. The bare
    URL is what makes the message work anyway."""

    rendered = email_templates.password_reset(link=LINK, site_url=SITE)
    assert rendered.html.count(LINK) >= 2  # button href + visible link
    assert LINK in rendered.text


def test_untrusted_values_cannot_inject_markup():
    """An inviter address is attacker-influenced in the general case."""

    rendered = email_templates.invite(
        link=LINK, site_url=SITE, inviter="<script>alert(1)</script>@example.com"
    )
    assert "<script>alert" not in rendered.html
    assert "&lt;script&gt;" in rendered.html


def test_subjects_are_plain_and_short():
    for rendered in RENDERED:
        assert rendered.subject == rendered.subject.strip()
        assert len(rendered.subject) <= 60, rendered.subject
        assert "\n" not in rendered.subject
