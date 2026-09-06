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
import ipaddress
import json
import logging
import re
import time
from typing import Any

from .config import Settings

log = logging.getLogger("spawn.turn")

_ICE_URL = re.compile(
    r"\A(?P<scheme>stun|stuns|turn|turns):"
    r"(?P<host>\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)"
    r"(?::(?P<port>[0-9]{1,5}))?"
    r"(?:\?transport=(?P<transport>udp|tcp))?\Z"
)


def mint_turn_credential(
    secret: str, *, label: str, ttl_seconds: int, now: int | None = None
) -> tuple[str, str]:
    expiry = (int(time.time()) if now is None else now) + ttl_seconds
    username = f"{expiry}:{label}"
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode("ascii")


def turn_credentials_configured(settings: Settings) -> bool:
    """True when every ICE offer carries a minted TURN credential."""
    return bool(settings.turn_url_list) and bool(settings.turn_secret)


def ice_servers_for_session(
    settings: Settings, *, label: str, now: int | None = None
) -> list[dict[str, Any]]:
    """Static ICE servers plus, when configured, a freshly minted TURN entry."""
    servers = list(settings.webrtc_ice_server_list)
    if turn_credentials_configured(settings):
        username, credential = mint_turn_credential(
            settings.turn_secret or "",
            label=label,
            ttl_seconds=settings.turn_ttl_seconds,
            now=now,
        )
        servers.append(
            {"urls": settings.turn_url_list, "username": username, "credential": credential}
        )
    return servers


def rtc_ice_fields(settings: Settings, *, label: str) -> dict[str, Any]:
    """The ICE part of one `rtc.config` frame.

    `ice_servers` and the transport policy every channel already carried,
    plus the credential's window: `now`, the server's clock at minting, and
    `expires_at`, the same Unix expiry the minted username starts with. A
    client subtracts the two to learn how long the credential has left
    without trusting its own clock, and schedules a refresh before then;
    parsing the username for it would tie the refresh to clock agreement
    between the phone and the relay. `expires_at` is only present when a
    TURN credential was minted — a STUN-only deployment has nothing that
    expires. Clients that predate the two fields ignore them.
    """
    now = int(time.time())
    servers = ice_servers_for_session(settings, label=label, now=now)
    fields: dict[str, Any] = {
        "ice_servers": servers,
        "ice_transport_policy": ice_transport_policy(servers),
        "now": now,
    }
    if turn_credentials_configured(settings):
        fields["expires_at"] = now + settings.turn_ttl_seconds
    return fields


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


def validate_ice_url(value: object) -> str:
    """Return one validated STUN/TURN URL or raise a configuration error."""

    if not isinstance(value, str):
        raise ValueError("ICE URL must be a string")
    match = _ICE_URL.fullmatch(value)
    if match is None:
        raise ValueError(f"malformed ICE URL: {value!r}")
    host = match.group("host")
    if host.startswith("["):
        try:
            parsed = ipaddress.ip_address(host[1:-1])
        except ValueError as exc:
            raise ValueError(f"malformed ICE URL host: {value!r}") from exc
        if parsed.version != 6:
            raise ValueError(f"bracketed ICE URL host is not IPv6: {value!r}")
    elif all(character.isdigit() or character == "." for character in host):
        try:
            parsed = ipaddress.ip_address(host)
        except ValueError as exc:
            raise ValueError(f"malformed ICE URL IPv4 host: {value!r}") from exc
        if parsed.version != 4:
            raise ValueError(f"ICE URL host is not IPv4: {value!r}")
    else:
        for label in host.split("."):
            if not label or len(label) > 63 or not label[0].isalnum() or not label[-1].isalnum():
                raise ValueError(f"malformed ICE URL hostname: {value!r}")
    port = match.group("port")
    if port is not None and not (1 <= int(port) <= 65535):
        raise ValueError(f"ICE URL port is out of range: {value!r}")
    return value


def validate_ice_config(settings: Settings) -> list[str]:
    """Validate every configured URL and return the credential-free URL list."""

    try:
        static_raw = json.loads(settings.webrtc_ice_servers)
    except json.JSONDecodeError as exc:
        raise ValueError("SPAWN_WEBRTC_ICE_SERVERS must be valid JSON") from exc
    if not isinstance(static_raw, list):
        raise ValueError("SPAWN_WEBRTC_ICE_SERVERS must be a JSON array")

    urls: list[str] = []
    for index, server in enumerate(static_raw):
        if not isinstance(server, dict):
            raise ValueError(f"ICE server {index} must be an object")
        raw_urls = server.get("urls")
        candidates = [raw_urls] if isinstance(raw_urls, str) else raw_urls
        if not isinstance(candidates, list) or not candidates:
            raise ValueError(f"ICE server {index} must have one or more URLs")
        for candidate in candidates:
            urls.append(validate_ice_url(candidate))
    for candidate in settings.turn_url_list:
        urls.append(validate_ice_url(candidate))
    return urls


def validate_and_log_ice_config(settings: Settings) -> None:
    """Startup guard and one credential-free operational summary."""

    urls = validate_ice_config(settings)
    policy = ice_transport_policy(ice_servers_for_session(settings, label="startup"))
    log.info("effective WebRTC ICE URLs=%s policy=%s", urls, policy)
    turn_urls = [url for url in urls if url.startswith(("turn:", "turns:"))]
    if turn_urls and not any(
        match is not None and match.group("scheme") == "turn" and match.group("transport") != "tcp"
        for value in turn_urls
        if (match := _ICE_URL.fullmatch(value)) is not None
    ):
        log.warning("TURN is configured without a UDP turn: URL; daemon relay is unavailable")
