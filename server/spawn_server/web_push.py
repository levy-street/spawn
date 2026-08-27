"""Web Push (RFC 8030) delivery to browsers that are not holding a socket.

The browser half of what `push.py` does for phones, and the same problem: a
tab with `/ws/alerts` open is the one client that does not need telling. An
alert has to arrive for a browser that was closed an hour ago, and the only
thing still listening then is the push service the browser's vendor runs —
Mozilla's, Google's, Apple's. This module talks to whichever one a given
subscription names.

**Content discipline is unchanged.** Read the rule at the top of `push.py`.
A Web Push payload is encrypted end to end (RFC 8291), and that relaxes
nothing: the notification is still rendered on a screen, in front of whoever
is holding the machine, and the encryption protects it from the push service
rather than from the room. The same `PushMessage` goes out here as goes to a
phone — `command` is the only session-derived string, `session_id` rides in
the data payload, which is not displayed.

Three pieces, none of them Firebase. FCM-for-web is this protocol underneath;
a browser SDK and a service-account credential would buy a second vendor
relationship and no capability that is not already here.

1. **VAPID** (RFC 8292) — the server proves to the push service that it is
   the same server the browser subscribed to, with an ES256 JWT signed by a
   P-256 key pair it holds. `pyjwt` and `cryptography` are already
   dependencies, so this is a dozen lines rather than a package.
2. **aes128gcm content encryption** (RFC 8188/8291) — the one thing the
   standard library cannot do. `http-ece` does exactly it and drags in only
   `cryptography`, which is already here. `pywebpush` wraps the same library
   but also pulls in `requests` *and* `aiohttp`: a synchronous HTTP client
   whose `send()` would block this event loop, and a second async stack, on a
   server that has standardized on `httpx`.
3. **The POST**, through the `httpx` client the caller already owns.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

import http_ece
import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings
from .models import WebPushSubscription

log = logging.getLogger("spawn.push.web")

#: How long a push service should hold an undelivered alert. An attention
#: alert is perishable: "claude finished" surfacing four hours late is noise
#: on a lock screen and the session list is the durable record either way.
WEB_PUSH_TTL_SECONDS = 900

#: RFC 8292 caps a VAPID token at 24 hours. Half that, re-signed a minute
#: early, so one is never presented after it expired.
_VAPID_TOKEN_TTL_SECONDS = 12 * 60 * 60
_VAPID_TOKEN_SKEW_SECONDS = 60

#: Every push service is required to accept at least 4096 bytes of encrypted
#: body. Subtract the aes128gcm header (16 salt + 4 rs + 1 length + 65 key),
#: the GCM tag and the padding delimiter to get what the plaintext may be.
_MAX_PLAINTEXT = 4096 - 86 - 16 - 1

#: A push service that answers 429 with an unusable or absurd Retry-After
#: still gets a rest, but not an indefinite one.
_MIN_BACKOFF = timedelta(seconds=30)
_MAX_BACKOFF = timedelta(hours=6)
_DEFAULT_BACKOFF = timedelta(minutes=5)

#: The subscription is gone: unsubscribed, or the browser profile it belonged
#: to no longer exists. Distinct from every other failure, which is transient
#: until proven otherwise.
_GONE_STATUSES = frozenset({404, 410})

#: How many endpoints to have in flight at once. An account has a handful of
#: browsers, not a thousand, and the cap is here so one pathological account
#: cannot open an unbounded number of sockets.
_MAX_CONCURRENCY = 8


class WebPushConfigError(Exception):
    """The configured VAPID key cannot be used. A configuration fault, not a
    delivery one, so it is raised rather than logged and swallowed."""


@dataclass(frozen=True)
class _VapidKey:
    private_key: ec.EllipticCurvePrivateKey
    #: The `applicationServerKey` a browser passes to `pushManager.subscribe`:
    #: the uncompressed P-256 point, base64url, unpadded.
    public_key: str


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _b64url_decode(value: str) -> bytes:
    """Decode base64url whether or not the sender kept the padding.

    `PushSubscription.toJSON()` emits unpadded base64url, but plenty of client
    code round-trips those keys through helpers that pad them, and the
    standard alphabet turns up too. All three decode to the same bytes and
    rejecting two of them would be a bug the operator has to debug in a
    browser console.
    """
    normalized = value.strip().replace("+", "-").replace("/", "_").rstrip("=")
    return base64.urlsafe_b64decode(normalized + "=" * (-len(normalized) % 4))


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def valid_subscription_key(value: str, *, length: int) -> bool:
    """Whether a browser-supplied key decodes to exactly the expected bytes.

    Checked at the boundary rather than at send time: a subscription that
    cannot be encrypted to is not a delivery failure to retire later, it is a
    malformed request to refuse now.
    """
    try:
        return len(_b64url_decode(value)) == length
    except (ValueError, TypeError):
        return False


_key_cache: dict[str, _VapidKey] = {}
_token_cache: dict[tuple[str, str], tuple[str, float]] = {}


def _normalized_pem(raw: str) -> str:
    """Some secret stores flatten a PEM's newlines to `\\n` on the way through.

    The same normalization `apple_identity.py` does, and for the same reason:
    `cryptography` rejects the flattened form with an error that says nothing
    useful about why.
    """
    return raw.replace("\\n", "\n").strip()


def _load_key(raw: str) -> _VapidKey:
    """Parse a configured VAPID private key in either shape it arrives in.

    A PKCS#8 PEM is what `openssl` and the `vapid` CLI write. The base64url
    raw private scalar is what the JavaScript tooling (`web-push
    generate-vapid-keys`) emits, and pasting that into an env var is the
    likeliest way an operator will configure this. Both are 32 bytes of the
    same secret; refusing one would be arbitrary.
    """
    cached = _key_cache.get(raw)
    if cached is not None:
        return cached

    text = _normalized_pem(raw)
    private_key: ec.EllipticCurvePrivateKey | None = None
    if "-----BEGIN" in text:
        try:
            loaded = serialization.load_pem_private_key(text.encode("utf-8"), password=None)
        except Exception as e:  # noqa: BLE001 - surfaces as a configuration error
            raise WebPushConfigError("the VAPID private key PEM could not be read") from e
        if not isinstance(loaded, ec.EllipticCurvePrivateKey):
            raise WebPushConfigError("the VAPID private key is not an elliptic-curve key")
        private_key = loaded
    else:
        try:
            scalar = _b64url_decode(text)
        except (ValueError, TypeError) as e:
            raise WebPushConfigError("the VAPID private key is not valid base64url") from e
        if len(scalar) != 32:
            raise WebPushConfigError(
                "the VAPID private key must be 32 bytes; "
                f"this one decodes to {len(scalar)}"
            )
        private_key = ec.derive_private_key(
            int.from_bytes(scalar, "big"), ec.SECP256R1()
        )

    if not isinstance(private_key.curve, ec.SECP256R1):
        raise WebPushConfigError("the VAPID private key must be on P-256 (prime256v1)")

    key = _VapidKey(
        private_key=private_key,
        public_key=_b64url_encode(
            private_key.public_key().public_bytes(
                serialization.Encoding.X962,
                serialization.PublicFormat.UncompressedPoint,
            )
        ),
    )
    _key_cache[raw] = key
    return key


def web_push_configured(settings: Settings) -> bool:
    """Whether this server has a browser channel at all.

    False is a supported state, not a fault: development has no VAPID key and
    must not need one. Callers say so rather than raising.
    """
    if not settings.push_enabled or not settings.vapid_private_key:
        return False
    try:
        _load_key(settings.vapid_private_key)
    except WebPushConfigError as e:
        log.warning("web push is configured with an unusable VAPID key: %s", e)
        return False
    return True


def vapid_public_key(settings: Settings) -> str | None:
    """The `applicationServerKey` the browser needs, or None when unconfigured."""
    if not web_push_configured(settings):
        return None
    return _load_key(str(settings.vapid_private_key)).public_key


def _contact(settings: Settings) -> str:
    """The `sub` claim: who a push service complains to about this server.

    RFC 8292 wants a `mailto:` or `https:` URI. `public_url` is a legal
    fallback and keeps a server with only a key configured working, but it
    routes a complaint to a web page rather than a person — `docs/PUSH.md`
    says to set a real mailbox.
    """
    return settings.vapid_subject.strip() or settings.public_url


def _origin(endpoint: str) -> str:
    parts = urlsplit(endpoint)
    return f"{parts.scheme}://{parts.netloc}"


def authorization_header(endpoint: str, settings: Settings) -> str:
    """The `vapid t=<jwt>, k=<key>` credential for one push service.

    Cached per origin, because an account with six browsers on the same
    vendor is six signatures of the same claim set otherwise.
    """
    key = _load_key(str(settings.vapid_private_key))
    origin = _origin(endpoint)
    cache_key = (origin, key.public_key)
    now = time.time()

    cached = _token_cache.get(cache_key)
    if cached is not None and cached[1] - _VAPID_TOKEN_SKEW_SECONDS > now:
        return f"vapid t={cached[0]}, k={key.public_key}"

    expires_at = now + _VAPID_TOKEN_TTL_SECONDS
    token = jwt.encode(
        {"aud": origin, "exp": int(expires_at), "sub": _contact(settings)},
        key.private_key,
        algorithm="ES256",
    )
    _token_cache[cache_key] = (token, expires_at)
    return f"vapid t={token}, k={key.public_key}"


def encrypt_payload(payload: bytes, *, p256dh: str, auth: str) -> bytes:
    """RFC 8291 content encryption for one subscription.

    A fresh ephemeral key pair and salt per message per recipient — that is
    what `http_ece` does when handed a `private_key` and generates internally
    for the salt, and reusing either across recipients would be the classic
    way to get this wrong.
    """
    if len(payload) > _MAX_PLAINTEXT:
        raise WebPushConfigError(
            f"a web push payload of {len(payload)} bytes exceeds the {_MAX_PLAINTEXT} "
            "bytes every push service is required to accept"
        )
    return http_ece.encrypt(
        payload,
        private_key=ec.generate_private_key(ec.SECP256R1()),
        dh=_b64url_decode(p256dh),
        auth_secret=_b64url_decode(auth),
        version="aes128gcm",
    )


def message_payload(title: str, body: str, data: dict[str, str]) -> bytes:
    """The bytes the service worker's `push` handler will parse.

    The wire contract with `web/public/sw.js`. Deliberately flat and
    deliberately the same three fields the phone gets, so the two clients
    cannot drift into rendering different things for the same event.
    """
    return json.dumps(
        {"title": title, "body": body, "data": data}, separators=(",", ":")
    ).encode("utf-8")


def _retry_after(response: httpx.Response, now: datetime) -> datetime:
    """When a 429'd push service has asked to be left alone until.

    Both forms RFC 9110 allows, clamped: a header that cannot be parsed, or
    that asks for a week, still earns a rest but not an indefinite one.
    """
    raw = response.headers.get("retry-after", "").strip()
    delay: timedelta | None = None
    if raw:
        try:
            delay = timedelta(seconds=int(raw))
        except ValueError:
            try:
                parsed = parsedate_to_datetime(raw)
            except (TypeError, ValueError):
                parsed = None
            if parsed is not None:
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=UTC)
                delay = parsed - now
    if delay is None:
        delay = _DEFAULT_BACKOFF
    return now + min(max(delay, _MIN_BACKOFF), _MAX_BACKOFF)


async def _live_subscriptions(
    session: AsyncSession, user_id: str, now: datetime
) -> list[WebPushSubscription]:
    rows = await session.execute(
        select(WebPushSubscription).where(
            WebPushSubscription.user_id == user_id,
            WebPushSubscription.disabled_at.is_(None),
            or_(
                WebPushSubscription.retry_after.is_(None),
                WebPushSubscription.retry_after <= now,
            ),
        )
    )
    return list(rows.scalars())


@dataclass
class _Outcome:
    """What one endpoint did, decided by the sender and applied by the caller.

    Sending happens concurrently and writing does not: the rows are updated in
    one pass afterwards, on the one session, rather than by eight coroutines
    racing for it.
    """

    subscription_id: str
    sent: bool = False
    gone: bool = False
    retry_after: datetime | None = None


async def _deliver(
    subscription: WebPushSubscription,
    body: bytes,
    settings: Settings,
    http: httpx.AsyncClient,
) -> _Outcome:
    outcome = _Outcome(subscription_id=subscription.id)
    try:
        encrypted = encrypt_payload(
            body, p256dh=subscription.p256dh, auth=subscription.auth
        )
    except Exception as e:  # noqa: BLE001
        # The stored keys do not encrypt. Nothing will ever be delivered to
        # this row, but it is our parsing that failed, so it is not evidence
        # the browser unsubscribed — say so and leave the row alone.
        log.warning("web push encryption failed for %s: %s", _origin(subscription.endpoint), e)
        return outcome

    try:
        response = await http.post(
            subscription.endpoint,
            content=encrypted,
            headers={
                "authorization": authorization_header(subscription.endpoint, settings),
                "content-encoding": "aes128gcm",
                "content-type": "application/octet-stream",
                "ttl": str(WEB_PUSH_TTL_SECONDS),
                # Attention alerts are the reason notifications were switched
                # on, so they are worth waking a sleeping machine for.
                "urgency": "high",
            },
        )
    except Exception as e:  # noqa: BLE001
        log.warning("web push send failed for %s: %s", _origin(subscription.endpoint), e)
        return outcome

    status = response.status_code
    if status in _GONE_STATUSES:
        outcome.gone = True
    elif status == 429:
        outcome.retry_after = _retry_after(response, _utcnow())
        log.info(
            "web push rate limited by %s until %s",
            _origin(subscription.endpoint),
            outcome.retry_after,
        )
    elif status in (401, 403):
        # The push service rejected our VAPID credential. That is this
        # server's configuration, not a browser that went away, so the
        # subscription is left exactly where it is.
        log.warning(
            "web push rejected our VAPID credential at %s: HTTP %s",
            _origin(subscription.endpoint),
            status,
        )
    elif status >= 400:
        log.warning("web push rejected by %s: HTTP %s", _origin(subscription.endpoint), status)
    else:
        outcome.sent = True
    return outcome


async def _apply(session: AsyncSession, outcomes: list[_Outcome]) -> None:
    changed = {
        outcome.subscription_id: outcome
        for outcome in outcomes
        if outcome.gone or outcome.retry_after is not None
    }
    if not changed:
        return
    rows = await session.execute(
        select(WebPushSubscription).where(WebPushSubscription.id.in_(list(changed)))
    )
    now = _utcnow()
    for row in rows.scalars():
        outcome = changed[row.id]
        if outcome.gone:
            # Switched off, never deleted — the same rule `push_devices`
            # follows, so a browser that re-subscribes updates a row instead
            # of resurrecting state nobody can account for.
            row.disabled_at = now
        elif outcome.retry_after is not None:
            row.retry_after = outcome.retry_after
    await session.commit()


async def send_web_push(
    *,
    session: AsyncSession,
    user_id: str,
    title: str,
    body: str,
    data: dict[str, str],
    settings: Settings,
    exclude_browser_device_id: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> int:
    """Push one alert to every live browser subscription of an account.

    Returns the count accepted by a push service. Never raises, for the same
    reason the Expo path never raises: this runs off the daemon socket's hot
    path and a push service having a bad afternoon must not surface as a
    broken agent session.
    """
    if not web_push_configured(settings):
        return 0

    now = _utcnow()
    try:
        subscriptions = await _live_subscriptions(session, user_id, now)
    except Exception as e:  # noqa: BLE001
        log.warning("web push subscription lookup failed: %s", e)
        return 0
    if exclude_browser_device_id is not None:
        subscriptions = [
            s for s in subscriptions if s.browser_device_id != exclude_browser_device_id
        ]
    if not subscriptions:
        return 0

    payload = message_payload(title, body, data)
    owned = client is None
    # Endpoints are spread across vendors and one of them being slow must not
    # hold up the rest, so the timeout is per request and the requests run
    # together.
    http = client or httpx.AsyncClient(timeout=10)
    gate = asyncio.Semaphore(_MAX_CONCURRENCY)

    async def one(subscription: WebPushSubscription) -> _Outcome:
        async with gate:
            return await _deliver(subscription, payload, settings, http)

    try:
        results = await asyncio.gather(
            *(one(subscription) for subscription in subscriptions),
            return_exceptions=True,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("web push fan-out failed: %s", e)
        return 0
    finally:
        if owned:
            await http.aclose()

    outcomes = [result for result in results if isinstance(result, _Outcome)]
    for result in results:
        if isinstance(result, BaseException):
            log.warning("web push send failed: %s", result)

    try:
        await _apply(session, outcomes)
    except Exception as e:  # noqa: BLE001
        log.warning("web push subscription cleanup failed: %s", e)

    return sum(1 for outcome in outcomes if outcome.sent)
