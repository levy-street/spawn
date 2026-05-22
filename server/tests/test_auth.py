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
    csrf = client.cookies.get("spawn_csrf")
    assert csrf

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
    csrf = client.cookies.get("spawn_csrf")
    assert csrf
    r_logout = await client.post("/api/auth/logout", headers={"X-CSRF-Token": csrf})
    assert r_logout.status_code == 204
    r_after_logout = await client.get("/api/me")
    assert r_after_logout.status_code == 401

    # Wipe cookies and confirm anonymous access fails.
    client.cookies.clear()
    r5 = await client.get("/api/me")
    assert r5.status_code == 401


async def test_cookie_mutations_require_csrf_but_bearer_does_not(client):
    r = await client.post(
        "/api/auth/signup",
        json={"email": "csrf@example.com", "password": "hunter2hunter"},
    )
    assert r.status_code == 200, r.text
    access_token = r.json()["access_token"]
    csrf = client.cookies.get("spawn_csrf")
    assert csrf

    preset = {
        "name": "cookie-preset",
        "agent_kind": "shell",
        "default_argv": ["bash", "-l"],
    }

    r_missing = await client.post("/api/presets", json=preset)
    assert r_missing.status_code == 403
    assert r_missing.json()["detail"] == "CSRF token missing or invalid"

    r_wrong = await client.post(
        "/api/presets",
        json=preset,
        headers={"X-CSRF-Token": "wrong"},
    )
    assert r_wrong.status_code == 403

    r_cookie = await client.post(
        "/api/presets",
        json=preset,
        headers={"X-CSRF-Token": csrf},
    )
    assert r_cookie.status_code == 201, r_cookie.text

    bearer_preset = {**preset, "name": "bearer-preset"}
    r_bearer = await client.post(
        "/api/presets",
        json=bearer_preset,
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert r_bearer.status_code == 201, r_bearer.text
