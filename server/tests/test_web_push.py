"""The browser half of remote alerts: VAPID, encryption, and what "gone" means.

Everything here is exercised against a `PushSubscription` shaped exactly as a
browser serializes one, and the delivery tests decrypt what the server put on
the wire rather than trusting that it called the right function.
"""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import UTC, datetime, timedelta

import http_ece
import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select

from spawn_server.config import Settings, get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import WebPushSubscription
from spawn_server.push import send_alert_push
from spawn_server.routes import push as push_routes
from spawn_server.web_push import (
    WEB_PUSH_TTL_SECONDS,
    WebPushConfigError,
    _b64url_decode,
    _b64url_encode,
    encrypt_payload,
    message_payload,
    send_web_push,
    vapid_public_key,
    web_push_configured,
)

ENDPOINT = "https://updates.push.services.mozilla.com/wpush/v2/aaaaaaaa"
OTHER_ENDPOINT = "https://fcm.googleapis.com/fcm/send/bbbbbbbb"

ALERT = {"event": "agent.finished", "session_id": "s-1", "command": "claude"}


def _aware(value: datetime) -> datetime:
    """SQLite hands timestamps back naive; Postgres does not."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _vapid_pem() -> str:
    key = ec.generate_private_key(ec.SECP256R1())
    return key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode("ascii")


class _Browser:
    """The subscriber's side: the key pair a user agent would have minted."""

    def __init__(self) -> None:
        self.private_key = ec.generate_private_key(ec.SECP256R1())
        self.auth_secret = b"0123456789abcdef"

    @property
    def p256dh(self) -> str:
        return _b64url_encode(
            self.private_key.public_key().public_bytes(
                serialization.Encoding.X962,
                serialization.PublicFormat.UncompressedPoint,
            )
        )

    @property
    def auth(self) -> str:
        return _b64url_encode(self.auth_secret)

    def open(self, body: bytes) -> dict:
        """What the service worker's `push` handler would see."""
        return json.loads(
            http_ece.decrypt(
                body,
                private_key=self.private_key,
                auth_secret=self.auth_secret,
                version="aes128gcm",
            )
        )


@pytest.fixture
def vapid(monkeypatch):
    """A server that has a browser channel."""
    pem = _vapid_pem()
    monkeypatch.setenv("SPAWN_VAPID_PRIVATE_KEY", pem)
    monkeypatch.setenv("SPAWN_VAPID_SUBJECT", "mailto:ops@example.com")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield Settings(vapid_private_key=pem, vapid_subject="mailto:ops@example.com")
    get_settings.cache_clear()  # type: ignore[attr-defined]


async def _account(client, email: str) -> tuple[str, dict[str, str]]:
    response = await client.post(
        "/api/auth/signup",
        json={"email": email, "password": "a-long-enough-password"},
    )
    assert response.status_code == 200
    body = response.json()
    return body["user"]["id"], {"Authorization": f"Bearer {body['access_token']}"}


async def _subscribe(
    client,
    headers: dict[str, str],
    browser: _Browser,
    endpoint: str = ENDPOINT,
    **extra: object,
) -> dict:
    body: dict[str, object] = {
        "endpoint": endpoint,
        "p256dh": browser.p256dh,
        "auth": browser.auth,
        **extra,
    }
    response = await client.post("/api/notifications/web-push", json=body, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


class TestKeyConfiguration:
    def test_a_pem_and_a_raw_scalar_are_the_same_key(self):
        """Operators paste whichever their tooling printed. Both must work.

        `openssl`/`vapid --gen` write a PKCS#8 PEM; `web-push
        generate-vapid-keys` prints the raw scalar as base64url. Refusing one
        of them would be arbitrary and the failure would show up as a browser
        console error rather than a server one.
        """
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii")
        raw = _b64url_encode(key.private_numbers().private_value.to_bytes(32, "big"))

        from_pem = vapid_public_key(Settings(vapid_private_key=pem))
        from_raw = vapid_public_key(Settings(vapid_private_key=raw))
        assert from_pem == from_raw
        # An application server key is the uncompressed point: 65 bytes.
        assert len(_b64url_decode(str(from_pem))) == 65

    def test_a_pem_whose_newlines_were_flattened_still_loads(self):
        pem = _vapid_pem()
        assert vapid_public_key(Settings(vapid_private_key=pem.replace("\n", "\\n"))) == (
            vapid_public_key(Settings(vapid_private_key=pem))
        )

    def test_no_key_is_a_configuration_not_a_failure(self):
        settings = Settings(vapid_private_key=None)
        assert web_push_configured(settings) is False
        assert vapid_public_key(settings) is None

    def test_push_switched_off_takes_the_browser_channel_with_it(self):
        settings = Settings(vapid_private_key=_vapid_pem(), push_enabled=False)
        assert web_push_configured(settings) is False

    @pytest.mark.parametrize(
        "key",
        [
            "not-a-key",
            # Right shape, wrong length: 31 bytes.
            _b64url_encode(b"\x01" * 31),
            "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----",
        ],
    )
    def test_an_unusable_key_reads_as_no_channel_rather_than_a_crash(self, key):
        """A bad key is an operator's problem, not a 500 on every alert."""
        assert web_push_configured(Settings(vapid_private_key=key)) is False

    def test_a_key_on_the_wrong_curve_is_refused(self):
        """VAPID is P-256 only; a P-384 key would sign tokens nobody accepts."""
        from spawn_server.web_push import _load_key

        key = ec.generate_private_key(ec.SECP384R1())
        pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode("ascii")
        with pytest.raises(WebPushConfigError):
            _load_key(pem)


class TestPayload:
    def test_the_wire_payload_carries_the_command_and_nothing_else(self):
        """The rule at the top of `push.py`, restated on an encrypted channel.

        End-to-end encryption protects the payload from the push service, not
        from the person the notification is rendered in front of, so the
        content discipline is exactly the phone's.
        """
        payload = json.loads(
            message_payload(
                "claude finished",
                "Tap to open the session.",
                {"sessionId": "s-1", "event": "agent.finished"},
            )
        )
        assert payload == {
            "title": "claude finished",
            "body": "Tap to open the session.",
            "data": {"sessionId": "s-1", "event": "agent.finished"},
        }
        # The session id is in data, which a `push` handler does not render.
        assert "s-1" not in payload["title"] + payload["body"]

    def test_a_payload_no_push_service_would_accept_is_refused_here(self):
        with pytest.raises(WebPushConfigError):
            browser = _Browser()
            encrypt_payload(b"x" * 5000, p256dh=browser.p256dh, auth=browser.auth)

    def test_what_goes_on_the_wire_is_what_the_browser_reads_back(self):
        browser = _Browser()
        body = encrypt_payload(
            message_payload("codex is waiting for you", "Tap to open the session.", {}),
            p256dh=browser.p256dh,
            auth=browser.auth,
        )
        assert browser.open(body)["title"] == "codex is waiting for you"

    def test_two_sends_never_reuse_a_salt_or_an_ephemeral_key(self):
        """Reusing either across messages is the classic way to break RFC 8291."""
        browser = _Browser()
        payload = message_payload("claude finished", "Tap to open the session.", {})
        first = encrypt_payload(payload, p256dh=browser.p256dh, auth=browser.auth)
        second = encrypt_payload(payload, p256dh=browser.p256dh, auth=browser.auth)
        # The aes128gcm header is 16 bytes of salt, 4 of record size, then the
        # length-prefixed sender public key.
        assert first[:16] != second[:16]
        assert first[21:86] != second[21:86]
        assert browser.open(first) == browser.open(second)


class TestRegistration:
    async def test_the_browser_learns_the_key_it_needs_to_subscribe(self, client, vapid):
        _, headers = await _account(client, "key@example.com")
        response = await client.get("/api/notifications/web-push/key", headers=headers)
        assert response.status_code == 200
        body = response.json()
        assert body["enabled"] is True
        assert len(_b64url_decode(body["public_key"])) == 65

    async def test_a_server_without_a_key_says_so_instead_of_erroring(self, client):
        _, headers = await _account(client, "nokey@example.com")
        response = await client.get("/api/notifications/web-push/key", headers=headers)
        assert response.status_code == 200
        assert response.json() == {"enabled": False, "public_key": None}

    async def test_subscribing_to_a_server_with_no_key_is_refused_not_swallowed(self, client):
        """The browser already registered with its push service by now.

        Accepting the subscription anyway would leave it showing notifications
        as on, forever, for a channel that cannot deliver.
        """
        _, headers = await _account(client, "nokey-sub@example.com")
        browser = _Browser()
        response = await client.post(
            "/api/notifications/web-push",
            json={"endpoint": ENDPOINT, "p256dh": browser.p256dh, "auth": browser.auth},
            headers=headers,
        )
        assert response.status_code == 503

    async def test_resubscribing_refreshes_the_same_row(self, client, vapid):
        _, headers = await _account(client, "resub@example.com")
        browser = _Browser()
        first = await _subscribe(client, headers, browser, label="Firefox")
        second = await _subscribe(client, headers, browser, label="Firefox on the laptop")
        assert second["id"] == first["id"]
        assert second["label"] == "Firefox on the laptop"

        sm = get_sessionmaker()
        async with sm() as session:
            rows = list((await session.execute(select(WebPushSubscription))).scalars())
        assert len(rows) == 1

    async def test_resubscribing_revives_a_subscription_the_service_had_disowned(
        self, client, vapid
    ):
        _, headers = await _account(client, "revive@example.com")
        browser = _Browser()
        await _subscribe(client, headers, browser)

        sm = get_sessionmaker()
        async with sm() as session:
            row = (await session.execute(select(WebPushSubscription))).scalar_one()
            row.disabled_at = datetime.now(UTC)
            row.retry_after = datetime.now(UTC) + timedelta(hours=1)
            await session.commit()

        await _subscribe(client, headers, browser)
        async with sm() as session:
            row = (await session.execute(select(WebPushSubscription))).scalar_one()
        assert row.disabled_at is None
        # A browser saying "I am here" outranks whatever the service said last.
        assert row.retry_after is None

    async def test_an_endpoint_that_reappears_under_another_account_moves(self, client, vapid):
        first_user, first_headers = await _account(client, "browser-one@example.com")
        _, second_headers = await _account(client, "browser-two@example.com")
        browser = _Browser()

        await _subscribe(client, first_headers, browser)
        await _subscribe(client, second_headers, browser)

        sm = get_sessionmaker()
        async with sm() as session:
            rows = list((await session.execute(select(WebPushSubscription))).scalars())
        assert len(rows) == 1
        assert rows[0].user_id != first_user

    async def test_an_endpoint_that_appears_mid_request_is_adopted_not_a_500(
        self, client, vapid, monkeypatch
    ):
        """The same check-then-act window `/devices` documents.

        A page that re-subscribes on focus can have two tabs arrive together,
        both find no row, and both insert. Racing real requests cannot be
        relied on to land inside that window, so the first lookup is blinded
        to a row that genuinely exists — precisely what the loser sees.
        """
        _, winner_headers = await _account(client, "winner-browser@example.com")
        loser_id, loser_headers = await _account(client, "loser-browser@example.com")
        browser = _Browser()

        first = await _subscribe(client, winner_headers, browser, label="winner")

        real_select = push_routes.select
        lookups = 0

        def blind_first_lookup(*args, **kwargs):
            nonlocal lookups
            lookups += 1
            statement = real_select(*args, **kwargs)
            if lookups == 1:
                return statement.where(WebPushSubscription.endpoint == "https://no-such/x")
            return statement

        monkeypatch.setattr(push_routes, "select", blind_first_lookup)
        second = await _subscribe(client, loser_headers, browser, label="loser")
        assert second["id"] == first["id"]

        sm = get_sessionmaker()
        async with sm() as session:
            rows = list((await session.execute(select(WebPushSubscription))).scalars())
        assert len(rows) == 1
        assert rows[0].user_id == loser_id
        assert rows[0].label == "loser"

    @pytest.mark.parametrize(
        "overrides",
        [
            {"endpoint": "http://updates.push.services.mozilla.com/wpush/v2/a"},
            {"endpoint": "wpush/v2/a"},
            # A p256dh that is not a 65-byte uncompressed point.
            {"p256dh": _b64url_encode(b"\x04" * 32)},
            # An auth secret that is not 16 bytes.
            {"auth": _b64url_encode(b"\x01" * 8)},
            {"p256dh": "!!!not base64!!!"},
        ],
    )
    async def test_a_subscription_that_could_never_be_encrypted_to_is_refused(
        self, client, vapid, overrides
    ):
        _, headers = await _account(client, f"bad-{abs(hash(str(overrides)))}@example.com")
        browser = _Browser()
        body = {
            "endpoint": ENDPOINT,
            "p256dh": browser.p256dh,
            "auth": browser.auth,
            **overrides,
        }
        response = await client.post(
            "/api/notifications/web-push", json=body, headers=headers
        )
        assert response.status_code == 422

    async def test_a_padded_key_is_accepted_because_it_is_the_same_bytes(
        self, client, vapid
    ):
        _, headers = await _account(client, "padded@example.com")
        browser = _Browser()
        padded = base64.b64encode(_b64url_decode(browser.p256dh)).decode("ascii")
        response = await client.post(
            "/api/notifications/web-push",
            json={"endpoint": ENDPOINT, "p256dh": padded, "auth": browser.auth},
            headers=headers,
        )
        assert response.status_code == 200, response.text

    async def test_subscribing_requires_a_session(self, client, vapid):
        browser = _Browser()
        response = await client.post(
            "/api/notifications/web-push",
            json={"endpoint": ENDPOINT, "p256dh": browser.p256dh, "auth": browser.auth},
        )
        assert response.status_code == 401

    async def test_unsubscribing_is_scoped_to_the_caller(self, client, vapid):
        _, owner = await _account(client, "browser-owner@example.com")
        _, stranger = await _account(client, "browser-stranger@example.com")
        await _subscribe(client, owner, _Browser())

        # A stranger gets the same 204 and changes nothing, so this cannot be
        # used to probe whether an endpoint belongs to somebody else.
        assert (
            await client.delete(
                "/api/notifications/web-push", params={"endpoint": ENDPOINT}, headers=stranger
            )
        ).status_code == 204
        sm = get_sessionmaker()
        async with sm() as session:
            assert len(list((await session.execute(select(WebPushSubscription))).scalars())) == 1

        assert (
            await client.delete(
                "/api/notifications/web-push", params={"endpoint": ENDPOINT}, headers=owner
            )
        ).status_code == 204
        async with sm() as session:
            assert list((await session.execute(select(WebPushSubscription))).scalars()) == []

    async def test_subscribing_prunes_subscriptions_disabled_over_ninety_days(
        self, client, vapid
    ):
        user_id, headers = await _account(client, "web-retention@example.com")
        now = datetime.now(UTC)
        browser = _Browser()
        sm = get_sessionmaker()
        async with sm() as session:
            session.add_all(
                [
                    WebPushSubscription(
                        user_id=user_id,
                        endpoint="https://push.example/old",
                        p256dh=browser.p256dh,
                        auth=browser.auth,
                        disabled_at=now - timedelta(days=91),
                        created_at=now - timedelta(days=100),
                        last_seen_at=now - timedelta(days=100),
                    ),
                    WebPushSubscription(
                        user_id=user_id,
                        endpoint="https://push.example/recent",
                        p256dh=browser.p256dh,
                        auth=browser.auth,
                        disabled_at=now - timedelta(days=89),
                        created_at=now - timedelta(days=100),
                        last_seen_at=now - timedelta(days=100),
                    ),
                ]
            )
            await session.commit()

        await _subscribe(client, headers, browser)
        async with sm() as session:
            endpoints = set(
                (await session.execute(select(WebPushSubscription.endpoint))).scalars()
            )
        assert endpoints == {"https://push.example/recent", ENDPOINT}


class TestDelivery:
    async def test_one_encrypted_post_per_subscription(self, client, vapid):
        user_id, headers = await _account(client, "web-send@example.com")
        one, two = _Browser(), _Browser()
        await _subscribe(client, headers, one, ENDPOINT)
        await _subscribe(client, headers, two, OTHER_ENDPOINT)

        seen: dict[str, httpx.Request] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen[str(request.url)] = request
            return httpx.Response(201)

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_web_push(
                session=session,
                user_id=user_id,
                title="claude finished",
                body="Tap to open the session.",
                data={"sessionId": "s-1", "event": "agent.finished"},
                settings=vapid,
                client=http,
            )

        assert sent == 2
        assert set(seen) == {ENDPOINT, OTHER_ENDPOINT}
        for endpoint, browser in ((ENDPOINT, one), (OTHER_ENDPOINT, two)):
            request = seen[endpoint]
            assert request.headers["content-encoding"] == "aes128gcm"
            assert request.headers["content-type"] == "application/octet-stream"
            assert request.headers["ttl"] == str(WEB_PUSH_TTL_SECONDS)
            assert request.headers["urgency"] == "high"
            assert request.headers["authorization"].startswith("vapid t=")
            # Each subscription gets a body only it can open.
            assert browser.open(request.content)["title"] == "claude finished"

    async def test_the_vapid_credential_is_addressed_to_the_service_it_is_sent_to(
        self, client, vapid
    ):
        """`aud` is the endpoint's origin. A token minted for one push service
        is simply not valid at another, so a shared credential would fail at
        whichever vendor it was not signed for."""
        import jwt

        user_id, headers = await _account(client, "web-aud@example.com")
        await _subscribe(client, headers, _Browser(), ENDPOINT)
        await _subscribe(client, headers, _Browser(), OTHER_ENDPOINT)

        audiences: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            credential = request.headers["authorization"].removeprefix("vapid ")
            fields = dict(part.strip().split("=", 1) for part in credential.split(","))
            claims = jwt.decode(fields["t"], options={"verify_signature": False})
            audiences[str(request.url)] = claims["aud"]
            assert claims["sub"] == "mailto:ops@example.com"
            assert fields["k"] == vapid_public_key(vapid)
            return httpx.Response(201)

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            await send_web_push(
                session=session,
                user_id=user_id,
                title="claude finished",
                body="Tap to open the session.",
                data={},
                settings=vapid,
                client=http,
            )

        assert audiences == {
            ENDPOINT: "https://updates.push.services.mozilla.com",
            OTHER_ENDPOINT: "https://fcm.googleapis.com",
        }

    @pytest.mark.parametrize("status", [404, 410])
    async def test_a_subscription_the_service_says_is_gone_is_retired(
        self, client, vapid, status
    ):
        user_id, headers = await _account(client, f"web-gone-{status}@example.com")
        await _subscribe(client, headers, _Browser())

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(status)

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_web_push(
                session=session,
                user_id=user_id,
                title="claude finished",
                body="Tap to open the session.",
                data={},
                settings=vapid,
                client=http,
            )
            assert sent == 0
            row = (await session.execute(select(WebPushSubscription))).scalar_one()
            # Kept, not deleted, so a re-subscribe is an update.
            assert row.disabled_at is not None

    async def test_a_retired_subscription_is_not_sent_to_again(self, client, vapid):
        user_id, headers = await _account(client, "web-retired@example.com")
        await _subscribe(client, headers, _Browser())

        sm = get_sessionmaker()
        async with sm() as session:
            row = (await session.execute(select(WebPushSubscription))).scalar_one()
            row.disabled_at = datetime.now(UTC)
            await session.commit()

        calls = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(201)

        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_web_push(
                session=session,
                user_id=user_id,
                title="claude finished",
                body="Tap to open the session.",
                data={},
                settings=vapid,
                client=http,
            )

        assert sent == 0
        assert calls == 0

    async def test_a_rate_limit_is_respected_rather_than_hammered(self, client, vapid):
        """429 with `Retry-After` is the service asking to be left alone."""
        user_id, headers = await _account(client, "web-429@example.com")
        await _subscribe(client, headers, _Browser())

        calls = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(429, headers={"retry-after": "600"})

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            assert (
                await send_web_push(
                    session=session,
                    user_id=user_id,
                    title="claude finished",
                    body="Tap to open the session.",
                    data={},
                    settings=vapid,
                    client=http,
                )
                == 0
            )
            row = (await session.execute(select(WebPushSubscription))).scalar_one()
            assert row.disabled_at is None, "a rate limit is not a dead subscription"
            assert row.retry_after is not None
            assert _aware(row.retry_after) > datetime.now(UTC) + timedelta(minutes=9)

            # The next alert skips it entirely rather than asking again.
            assert (
                await send_web_push(
                    session=session,
                    user_id=user_id,
                    title="claude finished",
                    body="Tap to open the session.",
                    data={},
                    settings=vapid,
                    client=http,
                )
                == 0
            )
        assert calls == 1

    async def test_an_http_date_retry_after_is_understood_too(self, client, vapid):
        user_id, headers = await _account(client, "web-429-date@example.com")
        await _subscribe(client, headers, _Browser())

        when = datetime.now(UTC) + timedelta(minutes=20)

        def handler(_request: httpx.Request) -> httpx.Response:
            from email.utils import format_datetime

            return httpx.Response(429, headers={"retry-after": format_datetime(when, usegmt=True)})

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            await send_web_push(
                session=session,
                user_id=user_id,
                title="claude finished",
                body="Tap to open the session.",
                data={},
                settings=vapid,
                client=http,
            )
            row = (await session.execute(select(WebPushSubscription))).scalar_one()
        assert row.retry_after is not None
        assert _aware(row.retry_after) > datetime.now(UTC) + timedelta(minutes=15)

    async def test_a_slow_endpoint_does_not_hold_up_the_others(self, client, vapid):
        """Endpoints are different hosts run by different companies, and one
        of them being slow must cost the others nothing.

        Both handlers sleep. Sent one at a time the fan-out takes twice the
        delay; sent together it takes one, and the second request has to be
        able to start while the first is still in flight — which is what the
        event proves.
        """
        user_id, headers = await _account(client, "web-slow@example.com")
        await _subscribe(client, headers, _Browser(), ENDPOINT)
        await _subscribe(client, headers, _Browser(), OTHER_ENDPOINT)

        delay = 0.3
        in_flight = asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == ENDPOINT:
                in_flight.set()
                await asyncio.sleep(delay)
            else:
                await asyncio.wait_for(in_flight.wait(), timeout=5)
                await asyncio.sleep(delay)
            return httpx.Response(201)

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            started = asyncio.get_running_loop().time()
            sent = await send_web_push(
                session=session,
                user_id=user_id,
                title="claude finished",
                body="Tap to open the session.",
                data={},
                settings=vapid,
                client=http,
            )
            elapsed = asyncio.get_running_loop().time() - started

        assert sent == 2
        assert elapsed < delay * 2, f"the fan-out serialized: {elapsed:.2f}s"

    async def test_an_endpoint_that_times_out_costs_only_itself(self, client, vapid):
        """A wedged push service loses its own alert and nothing else, and a
        timeout is never read as evidence that the browser unsubscribed."""
        user_id, headers = await _account(client, "web-timeout@example.com")
        await _subscribe(client, headers, _Browser(), ENDPOINT)
        await _subscribe(client, headers, _Browser(), OTHER_ENDPOINT)

        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url) == ENDPOINT:
                raise httpx.ReadTimeout("the push service never answered", request=request)
            return httpx.Response(201)

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_web_push(
                session=session,
                user_id=user_id,
                title="claude finished",
                body="Tap to open the session.",
                data={},
                settings=vapid,
                client=http,
            )

        assert sent == 1
        async with sm() as session:
            rows = list((await session.execute(select(WebPushSubscription))).scalars())
        assert all(row.disabled_at is None for row in rows)

    async def test_a_failing_push_service_never_reaches_the_caller(self, client, vapid):
        user_id, headers = await _account(client, "web-broken@example.com")
        await _subscribe(client, headers, _Browser())

        def handler(_request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("the push service is down")

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_web_push(
                session=session,
                user_id=user_id,
                title="claude finished",
                body="Tap to open the session.",
                data={},
                settings=vapid,
                client=http,
            )
            assert sent == 0
            row = (await session.execute(select(WebPushSubscription))).scalar_one()
            # A service having a bad afternoon is not a browser that left.
            assert row.disabled_at is None

    async def test_a_rejected_vapid_credential_leaves_the_subscription_alone(
        self, client, vapid
    ):
        """401/403 is this server's configuration, not the browser's fault."""
        user_id, headers = await _account(client, "web-401@example.com")
        await _subscribe(client, headers, _Browser())

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(403)

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            assert (
                await send_web_push(
                    session=session,
                    user_id=user_id,
                    title="claude finished",
                    body="Tap to open the session.",
                    data={},
                    settings=vapid,
                    client=http,
                )
                == 0
            )
            row = (await session.execute(select(WebPushSubscription))).scalar_one()
            assert row.disabled_at is None
            assert row.retry_after is None

    async def test_a_server_with_no_vapid_key_sends_nothing_and_says_nothing(self, client):
        """The development case. No key, no channel, no exception."""
        user_id, _ = await _account(client, "web-unconfigured@example.com")
        calls = 0

        def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(201)

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_web_push(
                session=session,
                user_id=user_id,
                title="claude finished",
                body="Tap to open the session.",
                data={},
                settings=Settings(vapid_private_key=None),
                client=http,
            )
        assert sent == 0
        assert calls == 0

    async def test_the_knocking_browser_is_not_told_about_its_own_knock(self, client, vapid):
        user_id, headers = await _account(client, "web-knock@example.com")
        asking = "00000000-0000-4000-8000-0000000000aa"
        await _subscribe(client, headers, _Browser(), ENDPOINT, browser_device_id=asking)
        await _subscribe(
            client,
            headers,
            _Browser(),
            OTHER_ENDPOINT,
            browser_device_id="00000000-0000-4000-8000-0000000000bb",
        )

        seen: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(str(request.url))
            return httpx.Response(201)

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_web_push(
                session=session,
                user_id=user_id,
                title="Approve SPAWN D on iPhone?",
                body="It signed in to your account and is waiting for you.",
                data={"event": "device.approval_requested", "requestId": "req-1"},
                settings=vapid,
                exclude_browser_device_id=asking,
                client=http,
            )

        assert sent == 1
        assert seen == [OTHER_ENDPOINT]


class TestBothChannels:
    async def test_one_alert_reaches_the_phone_and_the_browser(self, client, vapid):
        """The two channels are separate wires carrying the same message.

        The point of the test is that they are not separate *messages*: the
        title a browser renders and the title a lock screen renders come from
        the same `alert_push_message`.
        """
        user_id, headers = await _account(client, "both@example.com")
        browser = _Browser()
        await _subscribe(client, headers, browser)
        assert (
            await client.post(
                "/api/notifications/devices",
                json={"token": "ExponentPushToken[cccccccccccccccccccccc]", "platform": "ios"},
                headers=headers,
            )
        ).status_code == 200

        expo: list[dict] = []
        web: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if str(request.url).startswith("https://exp.host/"):
                expo.extend(json.loads(request.content))
                return httpx.Response(200, json={"data": [{"status": "ok"}]})
            web.append(request)
            return httpx.Response(201)

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_alert_push(
                session=session,
                user_id=user_id,
                payload=ALERT,
                client=http,
                settings=vapid,
            )

        assert sent == 2
        assert len(expo) == 1 and len(web) == 1
        assert expo[0]["title"] == "claude finished"
        assert browser.open(web[0].content) == {
            "title": "claude finished",
            "body": "Tap to open the session.",
            "data": {"sessionId": "s-1", "event": "agent.finished"},
        }

    async def test_a_phone_only_account_is_unaffected_by_the_browser_channel(
        self, client, vapid
    ):
        user_id, headers = await _account(client, "phone-only@example.com")
        assert (
            await client.post(
                "/api/notifications/devices",
                json={"token": "ExponentPushToken[dddddddddddddddddddddd]", "platform": "ios"},
                headers=headers,
            )
        ).status_code == 200

        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(str(request.url))
            return httpx.Response(200, json={"data": [{"status": "ok"}]})

        sm = get_sessionmaker()
        async with (
            sm() as session,
            httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http,
        ):
            sent = await send_alert_push(
                session=session,
                user_id=user_id,
                payload=ALERT,
                client=http,
                settings=vapid,
            )

        assert sent == 1
        assert calls == ["https://exp.host/--/api/v2/push/send"]
