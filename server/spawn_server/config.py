"""Runtime configuration loaded from environment / .env."""

from __future__ import annotations

import json
from functools import lru_cache
from ipaddress import ip_address
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

#: The default below, and every stand-in this repository ships beside it. All
#: three are readable by anyone who can read the repository, so a server that
#: signs session tokens with one is letting them mint a token for any account.
#: `.env.example` and `scripts/dev.sh` carry their own — copying either file
#: into production and editing everything except this line is the likeliest
#: way to end up here, so they are named too.
DEVELOPMENT_JWT_SECRET = "change-me-in-prod"
PUBLISHED_JWT_SECRETS = frozenset(
    {
        DEVELOPMENT_JWT_SECRET,
        "change-me-in-prod-please-this-is-only-for-local",
        "spawn-local-dev-only-secret-change-before-production",
    }
)

#: Hostnames that mean "somebody's own machine" no matter what resolves them.
_LOCAL_HOSTNAMES = frozenset({"localhost", "ip6-localhost", "ip6-loopback"})

#: Suffixes with the same meaning. `.local` is mDNS — a Mac on its own LAN.
_LOCAL_SUFFIXES = (".localhost", ".local")


class InsecureConfigurationError(RuntimeError):
    """A deployment that is evidently not local is still holding a development
    default. Raised while the settings are being built, so the process refuses
    to start rather than serving with a secret that is published in this
    repository."""


def is_local_deployment(public_url: str) -> bool:
    """Whether `public_url` describes a machine only its owner can reach.

    Deliberately generous. Loopback is obvious, but a developer testing the
    phone app points `SPAWN_PUBLIC_URL` at their LAN address — that is still
    somebody's laptop, and a guard that refused to start there would be the
    most hated line in the repository. Private, loopback and link-local
    ranges, `.local`, `.localhost` and a bare `localhost` all pass; a name
    that resolves on the public internet does not.
    """
    value = public_url.strip()
    host = (urlsplit(value).hostname or "").strip().lower()
    if not host and value:
        # A value with no scheme: `urlsplit` puts the whole thing in `path`
        # and reports no host. Such a URL is already broken elsewhere, but
        # reading it as "no host, therefore local" would let the one shape
        # this guard exists for slip past it.
        host = (urlsplit(f"//{value}").hostname or "").strip().lower()
    if not host:
        # Nothing configured at all is not evidence of a production
        # deployment. Say nothing rather than guess.
        return True
    if host in _LOCAL_HOSTNAMES or host.endswith(_LOCAL_SUFFIXES):
        return True
    try:
        address = ip_address(host)
    except ValueError:
        # A hostname, not an address. Anything that is not one of the names
        # above is treated as reachable from outside.
        return False
    return address.is_loopback or address.is_private or address.is_link_local


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
    oauth_provider_state_ttl_minutes: int = 10

    # A native OAuth callback cannot hand a browser cookie to an app, so it
    # returns a one-time code on a custom scheme instead. Matching is exact:
    # a prefix or host rule here would let anything claiming the scheme collect
    # codes on the real app's behalf.
    oauth_native_redirect_uris: str = Field(
        default="spawn://auth/oauth,spawn://oauth/callback",
        description="Comma-separated exact redirect URIs the native app may hand back to.",
    )
    # Long enough to survive a slow provider handoff, short enough that a code
    # left in a log is worthless by the time anyone reads it.
    oauth_exchange_ttl_seconds: int = 120

    google_client_id: str | None = None
    google_client_secret: str | None = None
    microsoft_client_id: str | None = None
    microsoft_client_secret: str | None = None
    github_client_id: str | None = None
    github_client_secret: str | None = None

    # Sign in with Apple does not issue a client secret. You sign one yourself,
    # as a short-lived ES256 JWT over the team/key/client triple below, so all
    # four values have to be present before the provider can be offered at all.
    #
    # There are two client ids because Apple treats the app and the website as
    # different clients: the web redirect uses a Services ID, the native button
    # authorizes under the app's bundle id. Both are minted from the same key,
    # and an id_token from either one is accepted.
    apple_team_id: str | None = None
    apple_key_id: str | None = None
    apple_private_key: str | None = None
    apple_client_id: str | None = None
    apple_native_client_id: str | None = Field(
        default=None,
        description="Bundle id the iOS button authorizes under; defaults to apple_client_id.",
    )
    # Apple caps a client secret at six months. Well under it, so a long-lived
    # process re-signs rather than waking up one day holding an expired secret.
    apple_client_secret_ttl_seconds: int = 15_552_000

    # Push delivery goes through Expo's service, which fronts both APNs and
    # FCM, so the signing keys live with the EAS project rather than here.
    push_enabled: bool = True
    # Only required when the Expo project enables enhanced push security.
    expo_access_token: str | None = None

    # Browsers do not go through Expo. A browser subscribes with the push
    # service its own vendor runs (Mozilla's, Google's, Apple's) and the server
    # authenticates to that service with a P-256 key pair it holds — VAPID,
    # RFC 8292. The key is server configuration, never committed: see
    # `docs/PUSH.md` for how to generate and set it.
    #
    # Absent is a supported configuration, not an error. A server with no key
    # simply has no browser channel; `/api/notifications/web-push/key` says so
    # and phones are unaffected.
    #
    # A PKCS#8 PEM, or the base64url raw private scalar the JavaScript tools
    # emit. Newlines may arrive escaped; `web_push.py` normalizes either form.
    vapid_private_key: str | None = None
    # The contact a push service can reach if this server misbehaves — RFC 8292
    # requires a `mailto:` or `https:` URI. Empty falls back to `public_url`,
    # which is valid but tells an operator nothing; set a real mailbox.
    vapid_subject: str = ""

    public_url: str = Field(default="http://localhost:8000")

    # Release identity overrides are stamped by production deploys. Empty
    # values fall back to the checkout when git is available.
    release_commit: str | None = None
    mobile_tree: str | None = None
    desktop_version: str | None = None
    desktop_tree: str | None = None
    daemon_auto_update: bool = True
    prebuilt_dir: Path = Field(
        default=Path(__file__).resolve().parents[2] / "daemon" / "target" / "prebuilt"
    )
    # Where the published desktop artifacts actually live: notarized Mac disk
    # images and the signed Windows setup EXE. Not derivable from the checkout:
    # `/desktop/` is nginx's alias over a static root
    # (`infra/nginx-spawnd.conf.example`), and the server has to look in the
    # same place to know whether the version it advertises was ever published.
    # The name matches `scripts/publish-desktop.sh`'s own SPAWN_DESKTOP_DIR on
    # purpose — the publisher and the server mean one directory.
    desktop_dir: Path = Field(default=Path("/var/www/spawnd/desktop"))

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
    daemon_registration_concurrency: int = Field(default=32, ge=1, le=256)

    # Subscriptions, on the hosted instance only. Absent is the supported
    # configuration and not an error: a self-hoster sets none of this, gets
    # unlimited hosts, and has no billing surface anywhere — no limit, no UI,
    # no Stripe calls, and none of the new columns consulted. See docs/BILLING.md.
    #
    # `is_local_deployment()` looks like the right switch for that and is not:
    # it answers "is this a laptop or a LAN address", so a self-hoster on a
    # real domain would read as hosted and start being billed. The flag below
    # is the only thing that turns billing on.
    billing_enabled: bool = False
    stripe_secret_key: str | None = None
    # Stripe signs every webhook with this. Without it the endpoint cannot
    # tell Stripe from anybody else — see the validator below.
    stripe_webhook_secret: str | None = None
    # One monthly USD price per paid tier. These ids are the authority for
    # what an account is entitled to; Stripe's own price metadata is editable
    # by anyone with a dashboard login and is never read.
    stripe_price_coven: str | None = None
    stripe_price_legion: str | None = None
    stripe_price_pandemonium: str | None = None
    # Where Checkout and the Customer Portal return the browser. Falls back to
    # `web_url`, then `public_url`, like every other link the server builds.
    billing_return_url: str | None = None

    # Whether the mobile apps may show a link out to somewhere a plan can be
    # changed. False at launch, and deliberately server-driven: a binary that
    # is already in the store cannot be recalled, so the only way to withdraw
    # this is to flip it here — same day, no resubmission. That the flag can
    # be turned back off is the point of it, more than that it can be turned
    # on. `/api/auth/config` advertises it.
    #
    # Never part of the refuse-to-boot validator below: false is always a
    # valid state, and it is what a self-hosted deployment sits at forever.
    # The effective value is `billing_enabled and billing_mobile_upgrade_link`
    # — read it that way at every site, so switching billing off can never
    # leave a link advertised to a shipped app.
    billing_mobile_upgrade_link: bool = False

    @model_validator(mode="after")
    def _refuse_billing_without_its_secrets(self) -> Settings:
        """Billing on with no webhook secret is an unauthenticated grant API.

        A webhook endpoint that cannot verify a signature will accept anybody's
        POST claiming anybody's subscription. Refusing to boot is the only safe
        reading of that configuration; the alternative is a warning in a log
        nobody reads and a paid tier anyone can mint.

        The price ids are here for a duller reason with the same shape. A
        half-configured catalogue means a tier that cannot be bought and a
        button that answers 500, which is a broken product rather than a hole
        — but it is broken in a way that only shows up when a customer tries
        to pay, which is the worst moment to find out.

        Unlike `_refuse_development_defaults_off_a_laptop` this applies
        everywhere, laptops included. That guard exists to stop a *default*
        surviving into production, and defaults are exactly what make local
        development work. Nothing here has a working default: switching
        billing on is a deliberate act, and a deliberate act done halfway is
        as wrong on a laptop as it is on the internet.
        """
        if not self.billing_enabled:
            return self

        problems: list[str] = []
        if not self.stripe_webhook_secret:
            problems.append(
                "SPAWN_STRIPE_WEBHOOK_SECRET is empty, so the webhook endpoint cannot "
                "verify that an event came from Stripe. Anyone who can reach it could "
                "grant themselves any plan. Copy the signing secret from the webhook "
                "endpoint in the Stripe dashboard."
            )
        if not self.stripe_secret_key:
            problems.append(
                "SPAWN_STRIPE_SECRET_KEY is empty, so no Stripe call the server makes "
                "can be authenticated and no subscription can be read or created."
            )
        for name, value in (
            ("SPAWN_STRIPE_PRICE_COVEN", self.stripe_price_coven),
            ("SPAWN_STRIPE_PRICE_LEGION", self.stripe_price_legion),
            ("SPAWN_STRIPE_PRICE_PANDEMONIUM", self.stripe_price_pandemonium),
        ):
            if not value:
                problems.append(
                    f"{name} is empty, so that tier has no price to attach a subscription "
                    "to and the server cannot map a subscription back to it."
                )
        if not problems:
            return self

        raise InsecureConfigurationError(
            "SPAWN D refuses to start. SPAWN_BILLING_ENABLED is true, but the "
            "configuration it depends on is incomplete:\n"
            + "\n".join(f"  - {problem}" for problem in problems)
            + "\nLeave SPAWN_BILLING_ENABLED unset for a deployment that does not bill."
        )

    @model_validator(mode="after")
    def _refuse_development_defaults_off_a_laptop(self) -> Settings:
        """Refuse to start a public deployment that is still holding defaults.

        Every value here has a default that makes `git clone && uv run` work,
        and nothing until now noticed when one of those survived into
        production. A truncated env file or a misspelled variable name would
        boot happily and sign session tokens with a secret published in this
        repository, silently.

        `public_url` is the tell: it is the one setting a deployment cannot
        avoid getting right, because the daemon and the browser are handed it.
        When it names something the internet can reach, a default that is
        merely convenient locally becomes a hole, and this stops the process
        instead of logging a warning nobody reads.

        Local development is untouched — see `is_local_deployment`.
        """
        if is_local_deployment(self.public_url):
            return self

        problems: list[str] = []
        if self.jwt_secret in PUBLISHED_JWT_SECRETS:
            problems.append(
                "SPAWN_JWT_SECRET is still one of the placeholders that ship in this "
                "repository, so anyone who can read it can mint a session token for any "
                "account. Set it to something random: "
                "python -c 'import secrets; print(secrets.token_urlsafe(64))'"
            )
        if self.email_backend == "console":
            problems.append(
                "SPAWN_EMAIL_BACKEND is 'console', which records every message and sends "
                "none. Signup asks for a verified address, so nobody could finish creating "
                "an account. Set it to 'smtp' and configure delivery (docs/EMAIL.md), or to "
                "'disabled' if this deployment genuinely sends no mail."
            )
        if not problems:
            return self

        raise InsecureConfigurationError(
            f"SPAWN D refuses to start. SPAWN_PUBLIC_URL is {self.public_url!r}, which is "
            "not a local address, but development defaults are still in place:\n"
            + "\n".join(f"  - {problem}" for problem in problems)
        )

    @property
    def billing_return_base(self) -> str:
        """Origin Checkout and the Portal send the browser back to, no trailing slash.

        Three levels because the API and the web app are different origins in
        this deployment: an explicit override first, then the web app, then
        whatever the server itself answers on. The last is a poor landing page
        but always exists, so a return link is never empty.
        """
        return (self.billing_return_url or self.web_url or self.public_url).rstrip("/")

    @property
    def oauth_native_redirect_uri_list(self) -> list[str]:
        return [u.strip() for u in self.oauth_native_redirect_uris.split(",") if u.strip()]

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


@lru_cache
def get_settings() -> Settings:
    return Settings()
