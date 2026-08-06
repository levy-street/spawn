"""Admin surface and invite-gated signup."""

from __future__ import annotations

import pytest

from spawn_server import mail
from spawn_server.config import get_settings

# Bound before any fixture patches the module attribute, so tests that want
# the REAL mailer (to exercise logging) can reach past the capture stub.
REAL_SEND_EMAIL = mail.send_email


@pytest.fixture(autouse=True)
def captured_mail(monkeypatch):
    sent: list[dict[str, str]] = []

    async def fake_send(*, to: str, subject: str, body: str, kind: str = "other") -> None:
        sent.append({"to": to, "subject": subject, "body": body, "kind": kind})

    monkeypatch.setattr(mail, "send_email", fake_send)
    import spawn_server.routes.account_recovery as recovery
    import spawn_server.routes.admin as admin_routes

    monkeypatch.setattr(recovery, "send_email", fake_send)
    monkeypatch.setattr(admin_routes, "send_email", fake_send)
    return sent


@pytest.fixture(autouse=True)
def closed_deployment(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "invite_only", True, raising=False)
    return settings


async def _signup(client, email: str, invite: str | None = None, password: str = "correct-horse-1"):
    body: dict[str, str] = {"email": email, "password": password}
    if invite is not None:
        body["invite"] = invite
    return await client.post("/api/auth/signup", json=body)


def code_from_url(url: str) -> str:
    return url.split("invite=", 1)[1]


async def test_first_account_needs_no_invite_and_owns_the_deployment(client):
    """An empty closed install has nobody who could issue the first invite."""

    first = await _signup(client, "owner@example.com")
    assert first.status_code == 200, first.text
    assert first.json()["user"]["is_admin"] is True

    # Everyone after the first needs one.
    second = await _signup(client, "stranger@example.com")
    assert second.status_code == 403
    assert "invite" in second.json()["detail"].lower()


async def test_admin_mints_an_invite_that_admits_exactly_one_account(client, captured_mail):
    owner = await _signup(client, "owner@example.com")
    headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}

    created = await client.post("/api/admin/invites", json={"ttl_hours": 24}, headers=headers)
    assert created.status_code == 200, created.text
    payload = created.json()
    assert payload["state"] == "pending"
    assert payload["url"] and "/signup?invite=" in payload["url"]
    code = code_from_url(payload["url"])

    joined = await _signup(client, "guest@example.com", invite=code)
    assert joined.status_code == 200, joined.text
    # An invited account is an ordinary user, not an admin.
    assert joined.json()["user"]["is_admin"] is False

    # Single use.
    reused = await _signup(client, "gatecrasher@example.com", invite=code)
    assert reused.status_code == 403

    listed = await client.get("/api/admin/invites", headers=headers)
    assert listed.status_code == 200
    row = listed.json()[0]
    assert row["state"] == "used"
    # The code is stored hashed, so it can never be served again.
    assert row["url"] is None


async def test_invite_email_is_sent_when_addressed(client, captured_mail):
    owner = await _signup(client, "owner@example.com")
    headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
    captured_mail.clear()

    created = await client.post(
        "/api/admin/invites", json={"email": "friend@example.com"}, headers=headers
    )
    assert created.status_code == 200
    assert [message["to"] for message in captured_mail] == ["friend@example.com"]
    # The URL comes back regardless, so the admin can hand it over directly.
    assert created.json()["url"] in captured_mail[0]["body"]


async def test_revoked_and_expired_invites_do_not_admit(client, monkeypatch):
    from datetime import UTC, datetime, timedelta

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Invite

    owner = await _signup(client, "owner@example.com")
    headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}

    revoked = (await client.post("/api/admin/invites", json={}, headers=headers)).json()
    revoked_code = code_from_url(revoked["url"])
    revoke_response = await client.post(
        f"/api/admin/invites/{revoked['id']}/revoke", headers=headers
    )
    assert revoke_response.status_code == 200
    assert revoke_response.json()["state"] == "revoked"
    assert (await _signup(client, "nope@example.com", invite=revoked_code)).status_code == 403

    expiring = (await client.post("/api/admin/invites", json={}, headers=headers)).json()
    expiring_code = code_from_url(expiring["url"])
    async with get_sessionmaker()() as session:
        row = await session.get(Invite, expiring["id"])
        row.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        await session.commit()
    assert (await _signup(client, "late@example.com", invite=expiring_code)).status_code == 403


async def test_admin_surface_is_invisible_to_ordinary_users(client):
    owner = await _signup(client, "owner@example.com")
    owner_headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
    invite = (await client.post("/api/admin/invites", json={}, headers=owner_headers)).json()
    guest = await _signup(client, "guest@example.com", invite=code_from_url(invite["url"]))
    guest_headers = {"Authorization": f"Bearer {guest.json()['access_token']}"}

    # 404, not 403: a non-admin should not learn the surface exists.
    for method, path in [
        ("get", "/api/admin/users"),
        ("get", "/api/admin/invites"),
    ]:
        response = await getattr(client, method)(path, headers=guest_headers)
        assert response.status_code == 404, f"{path}: {response.status_code}"
    assert (
        await client.post("/api/admin/invites", json={}, headers=guest_headers)
    ).status_code == 404

    # And anonymously it is simply unauthenticated.
    client.cookies.clear()
    assert (await client.get("/api/admin/users")).status_code == 401


async def test_admin_user_list_reports_account_details(client):
    owner = await _signup(client, "owner@example.com")
    headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
    invite = (await client.post("/api/admin/invites", json={}, headers=headers)).json()
    await _signup(client, "guest@example.com", invite=code_from_url(invite["url"]))

    listed = await client.get("/api/admin/users", headers=headers)
    assert listed.status_code == 200
    rows = {row["email"]: row for row in listed.json()}
    assert set(rows) == {"owner@example.com", "guest@example.com"}
    assert rows["owner@example.com"]["is_admin"] is True
    assert rows["guest@example.com"]["is_admin"] is False
    for row in rows.values():
        assert row["host_count"] == 0
        assert row["agent_count"] == 0
        assert row["browser_device_count"] == 0
        assert "email_verified_at" in row


async def test_configured_admin_email_is_promoted_on_login(client, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "invite_only", False, raising=False)
    monkeypatch.setattr(settings, "admin_emails", "boss@example.com", raising=False)

    # Not the first account, so nothing else would make them an admin.
    await _signup(client, "someone-else@example.com")
    joined = await _signup(client, "boss@example.com")
    assert joined.status_code == 200
    assert joined.json()["user"]["is_admin"] is True

    # And an address that is not configured stays ordinary.
    other = await _signup(client, "nobody@example.com")
    assert other.json()["user"]["is_admin"] is False


async def test_every_send_is_logged_with_credentials_redacted(client, monkeypatch):
    """The log answers "did that go out" without becoming a credential vault."""

    # Exercise the real send_email (not the captured stub) against the console
    # backend, which records but does not deliver.
    monkeypatch.setattr(get_settings(), "email_backend", "console", raising=False)
    import spawn_server.routes.account_recovery as recovery
    import spawn_server.routes.admin as admin_routes

    monkeypatch.setattr(recovery, "send_email", REAL_SEND_EMAIL)
    monkeypatch.setattr(admin_routes, "send_email", REAL_SEND_EMAIL)

    owner = await _signup(client, "owner@example.com")
    headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}

    created = await client.post(
        "/api/admin/invites", json={"email": "friend@example.com"}, headers=headers
    )
    assert created.status_code == 200
    real_url = created.json()["url"]
    code = code_from_url(real_url)

    logged = await client.get("/api/admin/emails", headers=headers)
    assert logged.status_code == 200
    rows = logged.json()
    invite_rows = [row for row in rows if row["kind"] == "invite"]
    assert len(invite_rows) == 1
    entry = invite_rows[0]
    assert entry["to_email"] == "friend@example.com"
    # Console backend records the attempt as undelivered rather than claiming success.
    assert entry["status"] == "not_delivered"
    # The prose survives; the live credential does not.
    assert "invited to create an account" in entry["body_redacted"]
    assert code not in entry["body_redacted"]
    assert "invite=<redacted>" in entry["body_redacted"]

    # Signup verification mail is logged too, and its token is stripped.
    verify_rows = [row for row in rows if row["kind"] == "email_verify"]
    assert verify_rows and "token=<redacted>" in verify_rows[0]["body_redacted"]


async def test_mail_status_and_test_send_report_the_truth(client, monkeypatch):

    monkeypatch.setattr(get_settings(), "email_backend", "console", raising=False)
    import spawn_server.routes.admin as admin_routes

    monkeypatch.setattr(admin_routes, "send_email", REAL_SEND_EMAIL)

    owner = await _signup(client, "owner@example.com")
    headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}

    status = await client.get("/api/admin/mail", headers=headers)
    assert status.status_code == 200
    # Console is honest about not delivering rather than reporting healthy.
    assert status.json() == {
        "backend": "console",
        "delivering": False,
        "from_address": status.json()["from_address"],
        "smtp_host": None,
    }

    sent = await client.post("/api/admin/emails/test", json={}, headers=headers)
    assert sent.status_code == 200
    assert sent.json()["kind"] == "test"
    assert sent.json()["to_email"] == "owner@example.com"
    assert sent.json()["status"] == "not_delivered"


async def test_email_log_is_admin_only(client):
    owner = await _signup(client, "owner@example.com")
    owner_headers = {"Authorization": f"Bearer {owner.json()['access_token']}"}
    invite = (await client.post("/api/admin/invites", json={}, headers=owner_headers)).json()
    guest = await _signup(client, "guest@example.com", invite=code_from_url(invite["url"]))
    guest_headers = {"Authorization": f"Bearer {guest.json()['access_token']}"}

    for path in ("/api/admin/emails", "/api/admin/mail"):
        assert (await client.get(path, headers=guest_headers)).status_code == 404
    assert (
        await client.post("/api/admin/emails/test", json={}, headers=guest_headers)
    ).status_code == 404
