"""Ephemeral TURN credentials.

coturn runs with `use-auth-secret`; instead of storing per-user TURN
accounts, both sides derive time-limited credentials from a shared secret
(the "TURN REST API" convention): username is `<unix-expiry>:<label>` and
the password is base64(HMAC-SHA1(secret, username)). coturn rejects the
credential after the expiry, so leaked credentials age out on their own.

The TURN relay only ever carries DTLS ciphertext between WebRTC peers —
minting credentials here does not give the control plane any content
visibility (see docs/TRUST.md).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import time
from typing import Any

from .config import Settings


def mint_turn_credential(secret: str, *, label: str, ttl_seconds: int) -> tuple[str, str]:
    expiry = int(time.time()) + ttl_seconds
    username = f"{expiry}:{label}"
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode("ascii")


def ice_servers_for_session(settings: Settings, *, label: str) -> list[dict[str, Any]]:
    """Static ICE servers plus, when configured, a freshly minted TURN entry."""
    servers = list(settings.webrtc_ice_server_list)
    urls = settings.turn_url_list
    if urls and settings.turn_secret:
        username, credential = mint_turn_credential(
            settings.turn_secret, label=label, ttl_seconds=settings.turn_ttl_seconds
        )
        servers.append({"urls": urls, "username": username, "credential": credential})
    return servers


def _urls_of(server: dict[str, Any]) -> list[str]:
    raw = server.get("urls")
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        return [value for value in raw if isinstance(value, str)]
    return []


def ice_transport_policy(ice_servers: list[dict[str, Any]]) -> str:
    """``"relay"`` when the only way out is the TURN relay.

    Configuring nothing but TURN servers is how an operator says "every peer
    goes through the relay" — there is no direct path to offer. Every channel
    reads it from here so the answer cannot differ between the terminal, the
    host control channel, and the daemon.
    """
    urls = [url for server in ice_servers for url in _urls_of(server)]
    relay_only = bool(urls) and all(url.startswith(("turn:", "turns:")) for url in urls)
    return "relay" if relay_only else "all"
