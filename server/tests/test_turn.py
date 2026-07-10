"""Ephemeral TURN credential minting (coturn use-auth-secret convention)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import time

from spawn_server.config import Settings
from spawn_server.turn import ice_servers_for_session, mint_turn_credential


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


def test_ice_servers_include_minted_turn_only_when_configured():
    plain = Settings(turn_urls="", turn_secret=None)
    assert all("turn:" not in u for s in ice_servers_for_session(plain, label="u") for u in s["urls"])

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


def test_turn_urls_without_secret_do_not_leak_an_unauthenticated_entry():
    settings = Settings(turn_urls="turn:relay.example:3478", turn_secret=None)
    servers = ice_servers_for_session(settings, label="u")
    assert all("turn:relay.example:3478" not in s["urls"] for s in servers)
