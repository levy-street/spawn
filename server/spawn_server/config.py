"""Runtime configuration loaded from environment / .env."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# The published default, plus the placeholder `.env.example` used to carry.
# Both are in the repository, so both are public knowledge and neither can
# authenticate anything.
INSECURE_JWT_SECRETS = frozenset(
    {
        "change-me-in-prod",
        "change-me-in-prod-please-this-is-only-for-local",
    }
)
# HS256 keys shorter than the hash output add nothing over a 32-byte one and
# are the length at which offline guessing becomes realistic. RFC 7518 §3.2
# names the same floor.
MIN_JWT_SECRET_BYTES = 32


class InsecureJwtSecretError(RuntimeError):
    """Raised at startup when the signing key cannot authenticate anything."""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="SPAWN_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = Field(
        default="sqlite+aiosqlite:///./spawn.db",
        description="SQLAlchemy async URL.",
    )
    redis_url: str = Field(default="redis://localhost:6379/0")
    jwt_secret: str = Field(default="change-me-in-prod")
    # Explicit opt-in that lets a throwaway signing key boot. Only ever set on
    # a local dev box: the whole point of the startup check is that a
    # deployment cannot reach production with a guessable key by omission.
    allow_insecure_jwt_secret: bool = Field(default=False)
    jwt_algorithm: str = "HS256"
    jwt_access_ttl_minutes: int = 15
    jwt_refresh_ttl_days: int = 30
    jwt_daemon_ttl_days: int = 365
    oauth_provider_state_ttl_minutes: int = 10

    google_client_id: str | None = None
    google_client_secret: str | None = None
    microsoft_client_id: str | None = None
    microsoft_client_secret: str | None = None
    github_client_id: str | None = None
    github_client_secret: str | None = None

    public_url: str = Field(default="http://localhost:8000")

    # Where password-reset and verification links point. Falls back to
    # public_url; set when the web app is served from a different origin than
    # the API (it is, in this deployment).
    web_url: str = Field(default="")

    # "smtp" delivers; "console" logs the message and does NOT deliver (dev
    # only — bodies contain live credentials); "disabled" refuses to send.
    email_backend: str = Field(default="console")
    email_from: str = Field(default="spawn <no-reply@localhost>")
    # Where replies should go. Empty means recipients reply into the void,
    # which is a poor experience on an account-security email.
    email_reply_to: str = Field(default="")
    smtp_host: str = Field(default="")
    smtp_port: int = Field(default=587)
    smtp_username: str = Field(default="")
    smtp_password: str = Field(default="")
    smtp_use_starttls: bool = Field(default=True)
    smtp_use_ssl: bool = Field(default=False)

    # Comma-separated emails promoted to admin on sign-in. The database flag
    # is the source of truth; this only bootstraps it, so an operator never
    # has to edit rows by hand to reach the admin surface.
    admin_emails: str = Field(default="")

    # Closed deployment: signup needs an unused invite. The first account on
    # an empty install is always allowed (nobody exists to invite it) and
    # becomes the owner.
    invite_only: bool = Field(default=True)
    invite_default_ttl_hours: int = Field(default=72)

    # Signup requires a verified address before terminals are reachable.
    # Deployments that front signup with their own gate can turn this off.
    require_email_verification: bool = Field(default=True)

    # Fixed-window request caps, per client IP. Redis-backed when available so
    # the limit is shared across workers; falls back to per-process counters.
    rate_limit_enabled: bool = Field(default=True)

    # Comma-separated list of allowed browser origins. The web app at
    # localhost:3000 needs to be in here in dev so fetch() with
    # `credentials: include` and the cross-origin browser WS handshake
    # both succeed.
    cors_origins: str = Field(default="http://localhost:3000")

    # When true, disables real Redis and runs an in-process pubsub fallback.
    # Used in tests so we don't need Redis available.
    use_inprocess_pubsub: bool = Field(default=False)

    # JSON array of WebRTC RTCIceServer-compatible objects used by browser and
    # daemon peers for direct terminal streams. STUN-only is best-effort across
    # restrictive NATs; production should add TURN credentials for reliability.
    webrtc_enabled: bool = Field(default=True)
    webrtc_ice_servers: str = Field(
        default='[{"urls":["stun:stun.l.google.com:19302"]}]',
        description="JSON array of RTCIceServer objects.",
    )

    # coturn with `use-auth-secret`: the server mints ephemeral per-session
    # credentials (RFC 5766 REST-API convention) instead of shipping a static
    # username/password in webrtc_ice_servers. Empty urls disables TURN.
    turn_urls: str = Field(
        default="",
        description="Comma-separated TURN URIs, e.g. turn:host:3478?transport=udp",
    )
    turn_secret: str | None = Field(default=None)
    turn_ttl_seconds: int = Field(default=24 * 3600)

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def turn_url_list(self) -> list[str]:
        return [u.strip() for u in self.turn_urls.split(",") if u.strip()]

    @property
    def webrtc_ice_server_list(self) -> list[dict[str, Any]]:
        try:
            raw = json.loads(self.webrtc_ice_servers)
        except json.JSONDecodeError:
            return []
        if not isinstance(raw, list):
            return []
        out: list[dict[str, Any]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            urls = item.get("urls")
            if isinstance(urls, str):
                urls = [urls]
            if not isinstance(urls, list) or not all(isinstance(url, str) for url in urls):
                continue
            server: dict[str, Any] = {"urls": urls}
            username = item.get("username")
            credential = item.get("credential")
            if isinstance(username, str):
                server["username"] = username
            if isinstance(credential, str):
                server["credential"] = credential
            out.append(server)
        return out


def assert_jwt_secret_usable(settings: Settings) -> None:
    """Refuse to serve with a signing key anyone can guess.

    `jwt_secret` is the single HS256 key behind every session cookie and every
    365-day daemon token. Booting on the published default is a silent
    full-impersonation hole -- including admin -- with no credential theft
    required, and nothing else in the tree would report it. So this fails
    closed, the way `web/next.config.ts` already refuses a production build
    with no proxy target.
    """

    secret = settings.jwt_secret or ""
    if settings.allow_insecure_jwt_secret:
        return
    hint = (
        "Generate one with: python -c 'import secrets; print(secrets.token_urlsafe(64))' "
        "and set SPAWN_JWT_SECRET. Rotating it invalidates every session and daemon "
        "token, so hosts must be re-paired. Set SPAWN_ALLOW_INSECURE_JWT_SECRET=1 to "
        "override on a local dev box only."
    )
    if not secret.strip():
        raise InsecureJwtSecretError(f"SPAWN_JWT_SECRET is not set. {hint}")
    if secret in INSECURE_JWT_SECRETS:
        raise InsecureJwtSecretError(
            f"SPAWN_JWT_SECRET is still the placeholder shipped in this repository. {hint}"
        )
    if len(secret.encode("utf-8")) < MIN_JWT_SECRET_BYTES:
        raise InsecureJwtSecretError(
            f"SPAWN_JWT_SECRET is shorter than {MIN_JWT_SECRET_BYTES} bytes. {hint}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
