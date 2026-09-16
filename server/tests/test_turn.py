"""Ephemeral TURN credential minting (coturn use-auth-secret convention)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

import pytest

from spawn_server.config import Settings
from spawn_server.turn import (
    ice_servers_for_session,
    ice_transport_policy,
    mint_turn_credential,
    rtc_ice_fields,
    validate_and_log_ice_config,
    validate_ice_config,
    validate_ice_url,
)


def test_mint_turn_credential_matches_coturn_convention():
    username, credential = mint_turn_credential("s3cret", label="user-1", ttl_seconds=600)

    expiry_str, label = username.split(":", 1)
    assert label == "user-1"
    expiry = int(expiry_str)
    now = int(time.time())
    assert now + 590 <= expiry <= now + 610

    expected = base64.b64encode(
        hmac.new(b"s3cret", username.encode(), hashlib.sha1).digest()
    ).decode()
    assert credential == expected


def test_default_credential_lifetime_is_seven_days():
    """What production runs without an env var (docs/NETWORK.md).

    A day was the value that stranded every pane older than a day on
    2026-09-05: coturn checks the expiry on every refresh, and the daemon's
    ICE agent cannot take fresh credentials mid-connection.
    """
    assert Settings().turn_ttl_seconds == 7 * 24 * 3600


def test_ice_servers_include_minted_turn_only_when_configured():
    plain = Settings(turn_urls="", turn_secret=None)
    assert all(
        "turn:" not in u for s in ice_servers_for_session(plain, label="u") for u in s["urls"]
    )

    configured = Settings(
        turn_urls="turn:relay.example:3478?transport=udp, turn:relay.example:3478?transport=tcp",
        turn_secret="s3cret",
        turn_ttl_seconds=60,
    )
    servers = ice_servers_for_session(configured, label="user-2")
    turn = servers[-1]
    assert turn["urls"] == [
        "turn:relay.example:3478?transport=udp",
        "turn:relay.example:3478?transport=tcp",
    ]
    assert turn["username"].endswith(":user-2")
    assert turn["credential"]
    # The static STUN defaults stay in front of the minted entry.
    assert any("stun:" in u for s in servers for u in s["urls"])


def test_rtc_ice_fields_carry_the_credential_window_only_when_turn_is_minted():
    """`now` and `expires_at` let a client measure the credential's remaining
    life without trusting its own clock; `expires_at` is the very expiry the
    minted username starts with, so the two can never disagree."""
    configured = Settings(
        turn_urls="turn:relay.example:3478?transport=udp",
        turn_secret="s3cret",
        turn_ttl_seconds=600,
    )
    before = int(time.time())
    fields = rtc_ice_fields(configured, label="user-3")
    after = int(time.time())
    assert before <= fields["now"] <= after
    assert fields["expires_at"] == fields["now"] + 600
    assert fields["ice_servers"][-1]["username"] == f"{fields['expires_at']}:user-3"
    assert fields["ice_transport_policy"] == "all"

    stun_only = Settings(turn_urls="", turn_secret=None)
    fields = rtc_ice_fields(stun_only, label="user-3")
    assert "expires_at" not in fields
    assert isinstance(fields["now"], int)
    assert all("turn:" not in u for s in fields["ice_servers"] for u in s["urls"])


def test_turn_urls_without_secret_do_not_leak_an_unauthenticated_entry():
    settings = Settings(turn_urls="turn:relay.example:3478", turn_secret=None)
    servers = ice_servers_for_session(settings, label="u")
    assert all("turn:relay.example:3478" not in s["urls"] for s in servers)


def test_transport_policy_is_relay_only_when_there_is_no_direct_path():
    # A STUN entry alongside TURN means direct paths are on offer.
    mixed = Settings(turn_urls="turn:relay.example:3478", turn_secret="s3cret")
    assert ice_transport_policy(ice_servers_for_session(mixed, label="u")) == "all"

    # Dropping the STUN defaults is how an operator says "everything relays".
    relay_only = Settings(
        webrtc_ice_servers="[]",
        turn_urls="turn:relay.example:3478,turns:relay.example:443",
        turn_secret="s3cret",
    )
    assert ice_transport_policy(ice_servers_for_session(relay_only, label="u")) == "relay"

    # Nothing configured at all is not a relay instruction.
    assert ice_transport_policy([]) == "all"
    assert ice_transport_policy([{"urls": "stun:stun.example:19302"}]) == "all"


def test_transport_policy_is_always_a_concrete_string():
    """The other half of the daemon's discriminator.

    A *host* offer is recognised by `ice_transport_policy` being present
    (`daemon/src/run.rs`); a session offer by its absence. So this helper must
    never return None or "" for any configuration, or a host offer would start
    looking like a session one to every daemon in the field.
    """
    for settings in (
        Settings(),
        Settings(webrtc_ice_servers="[]"),
        Settings(webrtc_ice_servers="not json"),
        Settings(turn_urls="turn:relay.example:3478", turn_secret="s3cret"),
        Settings(webrtc_ice_servers="[]", turn_urls="turn:r.example:3478", turn_secret="s"),
    ):
        assert ice_transport_policy(ice_servers_for_session(settings, label="u")) in {
            "all",
            "relay",
        }


def test_policy_matches_the_retired_is_turn_only_logic():
    """Byte-for-byte the behaviour `ws/host.py` had before it shared this."""

    def old_is_turn_only(ice_servers):
        urls = []
        for server in ice_servers:
            raw = server.get("urls")
            if isinstance(raw, str):
                urls.append(raw)
            elif isinstance(raw, list):
                urls.extend(v for v in raw if isinstance(v, str))
        return bool(urls) and all(u.startswith(("turn:", "turns:")) for u in urls)

    cases = [
        [],
        [{"urls": []}],
        [{"urls": "stun:a:1"}],
        [{"urls": ["turn:a:1", "turns:b:2"]}],
        [{"urls": ["turn:a:1", "stun:b:2"]}],
        [{"urls": "turn:a:1"}, {"urls": ["turns:b:2"]}],
        [{"urls": [1, "turn:a:1"]}],
        [{"nope": 1}],
    ]
    for servers in cases:
        expected = "relay" if old_is_turn_only(servers) else "all"
        assert ice_transport_policy(servers) == expected, servers


@pytest.mark.parametrize(
    "url",
    [
        "stun:stun.example.com",
        "stuns:stun.example.com:5349",
        "turn:192.0.2.1:3478?transport=udp",
        "turns:[2001:db8::1]:5349?transport=tcp",
        "turn:relay-1.example:3478",
    ],
)
def test_ice_url_validator_accepts_supported_forms(url):
    assert validate_ice_url(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "https://relay.example",
        "turn:",
        "turn:bad_host:3478",
        "turn:999.1.1.1:3478",
        "turn:relay.example:0",
        "turn:relay.example:65536",
        "turn:relay.example:3478?transport=sctp",
        "turn:2001:db8::1:3478",
        "turn:[not-ipv6]:3478",
        "turn:good.-bad:3478",
        "turn:bad-.good:3478",
    ],
)
def test_ice_url_validator_rejects_malformed_forms(url):
    with pytest.raises(ValueError, match="ICE URL"):
        validate_ice_url(url)


def test_ice_config_validator_checks_static_and_turn_urls():
    settings = Settings(
        webrtc_ice_servers='[{"urls":["stun:stun.example:19302"]}]',
        turn_urls="turn:relay.example:3478?transport=udp",
        turn_secret="secret",
    )
    assert validate_ice_config(settings) == [
        "stun:stun.example:19302",
        "turn:relay.example:3478?transport=udp",
    ]
    with pytest.raises(ValueError, match="valid JSON"):
        validate_ice_config(Settings(webrtc_ice_servers="not-json"))


def test_ice_startup_summary_warns_without_udp_turn(caplog):
    settings = Settings(
        webrtc_ice_servers='[{"urls":"turns:relay.example:443?transport=tcp"}]',
        turn_urls="",
        turn_secret="never-log-this",
    )
    validate_and_log_ice_config(settings)
    assert "without a UDP turn: URL" in caplog.text
    assert "never-log-this" not in caplog.text
