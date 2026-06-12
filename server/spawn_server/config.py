"""Runtime configuration loaded from environment / .env."""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


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
    jwt_algorithm: str = "HS256"
    jwt_access_ttl_minutes: int = 15
    jwt_refresh_ttl_days: int = 30
    jwt_daemon_ttl_days: int = 365
    oauth_authorization_code_ttl_minutes: int = 10
    oauth_access_ttl_minutes: int = 60
    oauth_refresh_ttl_days: int = 30
    oauth_provider_state_ttl_minutes: int = 10

    google_client_id: str | None = None
    google_client_secret: str | None = None
    microsoft_client_id: str | None = None
    microsoft_client_secret: str | None = None
    github_client_id: str | None = None
    github_client_secret: str | None = None

    public_url: str = Field(default="http://localhost:8000")

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

    ringbuffer_max_bytes: int = 256 * 1024  # legacy; kept for API compatibility

    # On-disk transcripts give each agent durable scrollback that survives
    # server restarts. Default ~32 MB per file × 2 rotated files = ~64 MB
    # of scrollback per agent before old data is dropped.
    transcript_dir: str = Field(default="./data/transcripts")
    transcript_max_bytes_per_file: int = Field(default=32 * 1024 * 1024)

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
