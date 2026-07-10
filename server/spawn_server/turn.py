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
