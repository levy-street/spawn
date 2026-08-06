"""Password reset, email verification, and the caps around them."""

from __future__ import annotations

import pytest

from spawn_server import mail
from spawn_server.config import get_settings


@pytest.fixture(autouse=True)
def captured_mail(monkeypatch):
    """Capture outbound mail instead of delivering it."""

    sent: list[dict[str, str]] = []

    async def fake_send(*, to: str, subject: str, body: str, kind: str = "other") -> None:
        sent.append({"to": to, "subject": subject, "body": body, "kind": kind})

    monkeypatch.setattr(mail, "send_email", fake_send)
    # The routes import the symbol directly.
    import spawn_server.routes.account_recovery as recovery

    monkeypatch.setattr(recovery, "send_email", fake_send)
    return sent


def link_token(body: str, path: str) -> str:
    for line in body.splitlines():
        if path in line:
            return line.split("token=", 1)[1].strip()
    raise AssertionError(f"no {path} link in {body!r}")


async def _signup(client, email: str, password: str = "correct-horse-battery"):
    response = await client.post("/api/auth/signup", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return response.json()


async def test_reset_changes_password_and_evicts_existing_sessions(client, captured_mail):
    body = await _signup(client, "reset@example.com")
    old_token = body["access_token"]
    headers = {"Authorization": f"Bearer {old_token}"}
    assert (await client.get("/api/me", headers=headers)).status_code == 200

    captured_mail.clear()
    requested = await client.post(
        "/api/auth/password-reset/request", json={"email": "Reset@Example.com"}
    )
    assert requested.status_code == 204
    assert len(captured_mail) == 1
    token = link_token(captured_mail[0]["body"], "reset-password")

    confirmed = await client.post(
        "/api/auth/password-reset/confirm",
        json={"token": token, "new_password": "a-brand-new-password"},
    )
    assert confirmed.status_code == 200, confirmed.text

    # The pre-reset session is dead: that is the entire point of a reset.
    assert (await client.get("/api/me", headers=headers)).status_code == 401
    # The response's fresh token works.
    new_headers = {"Authorization": f"Bearer {confirmed.json()['access_token']}"}
    assert (await client.get("/api/me", headers=new_headers)).status_code == 200

    # Old password is gone; new one works.
    old_login = await client.post(
        "/api/auth/login",
        json={"email": "reset@example.com", "password": "correct-horse-battery"},
    )
    assert old_login.status_code == 401
    new_login = await client.post(
        "/api/auth/login",
        json={"email": "reset@example.com", "password": "a-brand-new-password"},
    )
    assert new_login.status_code == 200


async def test_reset_tokens_are_single_use_and_superseded(client, captured_mail):
    await _signup(client, "single-use@example.com")

    captured_mail.clear()
    await client.post("/api/auth/password-reset/request", json={"email": "single-use@example.com"})
    first = link_token(captured_mail[-1]["body"], "reset-password")
    await client.post("/api/auth/password-reset/request", json={"email": "single-use@example.com"})
    second = link_token(captured_mail[-1]["body"], "reset-password")
    assert first != second

    # Requesting again invalidates the earlier link: an intercepted old email
    # must not stay useful.
    stale = await client.post(
        "/api/auth/password-reset/confirm",
        json={"token": first, "new_password": "password-number-one"},
    )
    assert stale.status_code == 400

    ok = await client.post(
        "/api/auth/password-reset/confirm",
        json={"token": second, "new_password": "password-number-two"},
    )
    assert ok.status_code == 200

    replay = await client.post(
        "/api/auth/password-reset/confirm",
        json={"token": second, "new_password": "password-number-three"},
    )
    assert replay.status_code == 400


async def test_reset_request_does_not_reveal_whether_an_account_exists(client, captured_mail):
    await _signup(client, "known@example.com")
    captured_mail.clear()

    known = await client.post(
        "/api/auth/password-reset/request", json={"email": "known@example.com"}
    )
    unknown = await client.post(
        "/api/auth/password-reset/request", json={"email": "nobody@example.com"}
    )
    assert known.status_code == unknown.status_code == 204
    assert known.text == unknown.text
    # Only the real address is mailed, but the caller cannot tell.
    assert [message["to"] for message in captured_mail] == ["known@example.com"]


async def test_signup_sends_verification_and_confirm_marks_verified(client, captured_mail):
    captured_mail.clear()
    body = await _signup(client, "verify@example.com")
    assert body["user"]["email_verified_at"] is None
    assert len(captured_mail) == 1
    token = link_token(captured_mail[0]["body"], "verify-email")

    confirmed = await client.post("/api/auth/verify-email/confirm", json={"token": token})
    assert confirmed.status_code == 200, confirmed.text
    assert confirmed.json()["user"]["email_verified_at"] is not None

    replay = await client.post("/api/auth/verify-email/confirm", json={"token": token})
    assert replay.status_code == 400


async def test_reaching_the_mailbox_via_reset_also_verifies_the_address(client, captured_mail):
    await _signup(client, "reset-verifies@example.com")
    captured_mail.clear()
    await client.post(
        "/api/auth/password-reset/request", json={"email": "reset-verifies@example.com"}
    )
    token = link_token(captured_mail[-1]["body"], "reset-password")
    confirmed = await client.post(
        "/api/auth/password-reset/confirm",
        json={"token": token, "new_password": "mailbox-proves-control"},
    )
    assert confirmed.status_code == 200
    # Completing a reset proves control of the mailbox just as verification does.
    assert confirmed.json()["user"]["email_verified_at"] is not None


async def test_signup_is_rate_limited_per_client(client, captured_mail, monkeypatch):
    from spawn_server import rate_limit

    settings = get_settings()
    monkeypatch.setattr(settings, "rate_limit_enabled", True, raising=False)
    rate_limit._local_counters.clear()

    statuses = []
    for index in range(rate_limit.SIGNUP.limit + 2):
        response = await client.post(
            "/api/auth/signup",
            json={"email": f"flood{index}@example.com", "password": "correct-horse-battery"},
        )
        statuses.append(response.status_code)

    assert statuses[: rate_limit.SIGNUP.limit] == [200] * rate_limit.SIGNUP.limit
    assert statuses[rate_limit.SIGNUP.limit] == 429
    rate_limit._local_counters.clear()


async def test_pairing_requires_a_verified_address(client, captured_mail, monkeypatch):
    """The gate sits where an account first costs the operator something.

    Signing in, reading settings, and resending verification all stay
    reachable — a user who cannot sign in cannot verify — but attaching a host
    (and with it TURN relay usage) waits for a confirmed address.
    """

    from spawn_server import auth as auth_module
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import User

    settings = get_settings()
    monkeypatch.setattr(settings, "require_email_verification", True, raising=False)
    # The gate only engages where verification mail can actually be delivered.
    monkeypatch.setattr(auth_module, "mailer_ready", lambda: True, raising=False)
    import spawn_server.mail as mail_module

    monkeypatch.setattr(mail_module, "mailer_ready", lambda: True)

    captured_mail.clear()
    body = await _signup(client, "unverified@example.com")
    headers = {"Authorization": f"Bearer {body['access_token']}"}
    assert body["user"]["email_verified_at"] is None

    blocked = await client.post(
        "/api/auth/device/approve",
        json={
            "user_code": "AAAA-BBBB",
            "approval_nonce": "A" * 43,
            "host_key_algorithm": "ed25519",
            "host_public_key": "P" * 43,
            "host_key_fingerprint": "SHA256:" + "a" * 16,
            "browser_device_id": "00000000-0000-4000-8000-000000000055",
            "browser_key_algorithm": "ed25519",
            "browser_public_key": "B" * 43,
            "browser_key_fingerprint": "SHA256:" + "b" * 16,
            "signature": "S" * 86,
        },
        headers=headers,
    )
    assert blocked.status_code == 403
    assert "verify" in blocked.json()["detail"].lower()

    # Signing in and requesting another verification mail stay available.
    assert (await client.get("/api/me", headers=headers)).status_code == 200
    resend = await client.post("/api/auth/verify-email/request", headers=headers)
    assert resend.status_code == 204

    token = link_token(captured_mail[-1]["body"], "verify-email")
    assert (
        await client.post("/api/auth/verify-email/confirm", json={"token": token})
    ).status_code == 200

    # Now the gate is open: the request fails on its own merits, not on verification.
    after = await client.post(
        "/api/auth/device/approve",
        json={
            "user_code": "AAAA-BBBB",
            "approval_nonce": "A" * 43,
            "host_key_algorithm": "ed25519",
            "host_public_key": "P" * 43,
            "host_key_fingerprint": "SHA256:" + "a" * 16,
            "browser_device_id": "00000000-0000-4000-8000-000000000055",
            "browser_key_algorithm": "ed25519",
            "browser_public_key": "B" * 43,
            "browser_key_fingerprint": "SHA256:" + "b" * 16,
            "signature": "S" * 86,
        },
        headers=headers,
    )
    assert after.status_code != 403
    _ = auth_module, get_sessionmaker, User
