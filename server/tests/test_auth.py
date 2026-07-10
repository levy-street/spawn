"""Signup, login, /api/me happy path."""

from __future__ import annotations


async def test_signup_login_me(client):
    r = await client.post(
        "/api/auth/signup",
        json={"email": "alice@example.com", "password": "hunter2hunter"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "access_token" in body
    assert body["user"]["email"] == "alice@example.com"
    token = body["access_token"]

    # Conflict on duplicate.
    r2 = await client.post(
        "/api/auth/signup",
        json={"email": "alice@example.com", "password": "hunter2hunter"},
    )
    assert r2.status_code == 409

    # Login.
    r3 = await client.post(
        "/api/auth/login",
        json={"email": "alice@example.com", "password": "hunter2hunter"},
    )
    assert r3.status_code == 200
    assert r3.json()["user"]["email"] == "alice@example.com"

    # /api/me with bearer.
    r4 = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert r4.status_code == 200
    assert r4.json()["user"]["email"] == "alice@example.com"

    # /api/me with the HTTP-only session cookie, then logout clears that cookie.
    r_cookie = await client.get("/api/me")
    assert r_cookie.status_code == 200
    assert r_cookie.json()["user"]["email"] == "alice@example.com"
    r_logout = await client.post("/api/auth/logout")
    assert r_logout.status_code == 204
    r_after_logout = await client.get("/api/me")
    assert r_after_logout.status_code == 401

    # Wipe cookies and confirm anonymous access fails.
    client.cookies.clear()
    r5 = await client.get("/api/me")
    assert r5.status_code == 401
