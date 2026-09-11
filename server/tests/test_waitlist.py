"""The waitlist: joining it in public, working it from the admin surface."""

from __future__ import annotations

import pytest

from spawn_server import mail, rate_limit
from spawn_server.config import get_settings


@pytest.fixture(autouse=True)
def captured_mail(monkeypatch):
    sent: list[dict[str, str]] = []

    async def fake_send(
        *,
        to: str,
        subject: str,
        body: str,
        kind: str = "other",
        html_body: str | None = None,
    ) -> None:
        sent.append({"to": to, "subject": subject, "body": body, "kind": kind})

    monkeypatch.setattr(mail, "send_email", fake_send)
    import spawn_server.routes.admin as admin_routes

    monkeypatch.setattr(admin_routes, "send_email", fake_send)
    return sent


@pytest.fixture(autouse=True)
def closed_deployment(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "invite_only", True, raising=False)
    # The join cap is per client and per fixed window; a fresh bucket per test
    # keeps one test's submissions from counting against the next.
    rate_limit._local_counters.clear()
    return settings


async def _admin(client) -> None:
    """The first account on a closed install needs no invite and is its admin."""

    r = await client.post(
        "/api/auth/signup", json={"email": "owner@example.com", "password": "correct-horse-1"}
    )
    assert r.status_code == 200, r.text


async def _join(client, email: str, source: str | None = "/claude-code-remote", **headers):
    body: dict[str, str | None] = {"email": email, "source": source}
    return await client.post("/api/waitlist", json=body, headers=headers)


async def test_join_stores_a_normalised_address_once(client):
    await _admin(client)
    r = await _join(client, "  Someone@Example.COM ", source="/claude-code-remote")
    assert r.status_code == 200 and r.json() == {"ok": True}
    # The same person again, differently cased, from another page: still one row.
    r = await _join(client, "someone@example.com", source="signup")
    assert r.status_code == 200 and r.json() == {"ok": True}

    rows = (await client.get("/api/admin/waitlist")).json()
    assert [row["email"] for row in rows] == ["someone@example.com"]
    assert rows[0]["source"] == "/claude-code-remote"
    assert rows[0]["invited_at"] is None
    assert rows[0]["invite_state"] is None
    assert rows[0]["has_account"] is False


async def test_join_rejects_a_non_address(client):
    r = await _join(client, "not-an-email")
    assert r.status_code == 422


async def test_source_is_bounded_and_kept_plain(client):
    await _admin(client)
    r = await _join(client, "a@example.com", source="<img src=x onerror=alert(1)>/page" + "x" * 300)
    assert r.status_code == 200
    rows = (await client.get("/api/admin/waitlist")).json()
    assert rows[0]["source"] == ("img src=x onerror=alert(1)/page" + "x" * 300)[:120]
    assert "<" not in rows[0]["source"]

    r = await _join(client, "b@example.com", source=None)
    assert r.status_code == 200
    rows = (await client.get("/api/admin/waitlist")).json()
    assert {row["email"]: row["source"] for row in rows}["b@example.com"] is None


async def test_an_existing_account_is_acknowledged_but_not_listed(client):
    await _admin(client)
    r = await _join(client, "OWNER@example.com")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert (await client.get("/api/admin/waitlist")).json() == []


async def test_join_is_rate_limited_per_client(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "rate_limit_enabled", True, raising=False)
    for n in range(rate_limit.WAITLIST.limit):
        r = await _join(client, f"person{n}@example.com")
        assert r.status_code == 200, n
    r = await _join(client, "one-too-many@example.com")
    assert r.status_code == 429
    # Another client is another bucket.
    r = await _join(client, "elsewhere@example.com", **{"X-Forwarded-For": "203.0.113.9"})
    assert r.status_code == 200


async def test_admin_surface_is_hidden_from_non_admins(client):
    await _admin(client)
    invite = (await client.post("/api/admin/invites", json={})).json()
    code = invite["url"].split("invite=", 1)[1]
    await client.post("/api/auth/logout")
    r = await client.post(
        "/api/auth/signup",
        json={"email": "member@example.com", "password": "correct-horse-1", "invite": code},
    )
    assert r.status_code == 200, r.text

    assert (await client.get("/api/admin/waitlist")).status_code == 404
    assert (await client.post("/api/admin/waitlist/x/invite", json={})).status_code == 404
    assert (await client.delete("/api/admin/waitlist/x")).status_code == 404


async def test_inviting_an_entry_mails_a_code_that_admits_that_person(client, captured_mail):
    await _admin(client)
    await _join(client, "waiting@example.com", source="/guides")
    [entry] = (await client.get("/api/admin/waitlist")).json()

    r = await client.post(f"/api/admin/waitlist/{entry['id']}/invite", json={"ttl_hours": 48})
    assert r.status_code == 200, r.text
    invite = r.json()
    assert invite["email"] == "waiting@example.com"
    assert invite["state"] == "pending"
    assert invite["url"] and "invite=" in invite["url"]
    assert [m["to"] for m in captured_mail if m["kind"] == "invite"] == ["waiting@example.com"]

    [entry] = (await client.get("/api/admin/waitlist")).json()
    assert entry["invited_at"] is not None
    assert entry["invite_id"] == invite["id"]
    assert entry["invite_state"] == "pending"
    assert entry["has_account"] is False

    # The person redeems it.
    code = invite["url"].split("invite=", 1)[1]
    await client.post("/api/auth/logout")
    r = await client.post(
        "/api/auth/signup",
        json={"email": "waiting@example.com", "password": "correct-horse-1", "invite": code},
    )
    assert r.status_code == 200, r.text
    await client.post("/api/auth/logout")
    r = await client.post(
        "/api/auth/login", json={"email": "owner@example.com", "password": "correct-horse-1"}
    )
    assert r.status_code == 200, r.text

    [entry] = (await client.get("/api/admin/waitlist")).json()
    assert entry["invite_state"] == "used"
    assert entry["has_account"] is True

    # Nothing to invite any more.
    r = await client.post(f"/api/admin/waitlist/{entry['id']}/invite", json={})
    assert r.status_code == 409


async def test_inviting_again_points_the_entry_at_the_newest_invite(client):
    await _admin(client)
    await _join(client, "slow@example.com")
    [entry] = (await client.get("/api/admin/waitlist")).json()
    first = (await client.post(f"/api/admin/waitlist/{entry['id']}/invite")).json()
    second = (await client.post(f"/api/admin/waitlist/{entry['id']}/invite")).json()
    assert first["id"] != second["id"]
    [entry] = (await client.get("/api/admin/waitlist")).json()
    assert entry["invite_id"] == second["id"]
    # Both invites exist; the older one is still a live code until it expires.
    states = {i["id"]: i["state"] for i in (await client.get("/api/admin/invites")).json()}
    assert states[first["id"]] == "pending" and states[second["id"]] == "pending"


async def test_removing_an_entry(client):
    await _admin(client)
    await _join(client, "gone@example.com")
    [entry] = (await client.get("/api/admin/waitlist")).json()
    r = await client.delete(f"/api/admin/waitlist/{entry['id']}")
    assert r.status_code == 204
    assert (await client.get("/api/admin/waitlist")).json() == []
    assert (await client.delete(f"/api/admin/waitlist/{entry['id']}")).status_code == 404


async def test_removing_an_invited_entry_keeps_the_invite(client):
    """The invite is the credential the person holds; dropping the row must not revoke it."""

    await _admin(client)
    await _join(client, "keep@example.com")
    [entry] = (await client.get("/api/admin/waitlist")).json()
    invite = (await client.post(f"/api/admin/waitlist/{entry['id']}/invite")).json()
    assert (await client.delete(f"/api/admin/waitlist/{entry['id']}")).status_code == 204
    states = {i["id"]: i["state"] for i in (await client.get("/api/admin/invites")).json()}
    assert states[invite["id"]] == "pending"
