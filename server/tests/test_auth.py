"""Signup, login, /api/me happy path."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import update

from spawn_server import auth
from spawn_server.db import get_sessionmaker
from spawn_server.models import User


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


async def test_session_cookie_slides_only_after_half_life_and_never_after_epoch_revoke(
    client, monkeypatch
):
    signup = await client.post(
        "/api/auth/signup",
        json={"email": "slide@example.com", "password": "hunter2hunter"},
    )
    user_id = signup.json()["user"]["id"]
    now = datetime.now(UTC)

    monkeypatch.setattr(auth, "_now", lambda: now - timedelta(days=14))
    young = auth.issue_session_token(user_id)
    monkeypatch.setattr(auth, "_now", lambda: now)
    before = await client.get("/api/me", headers={"Authorization": f"Bearer {young}"})
    assert before.status_code == 200
    assert "spawn_session=" not in before.headers.get("set-cookie", "")

    monkeypatch.setattr(auth, "_now", lambda: now - timedelta(days=16))
    old = auth.issue_session_token(user_id)
    monkeypatch.setattr(auth, "_now", lambda: now)
    after = await client.get("/api/me", headers={"Authorization": f"Bearer {old}"})
    assert after.status_code == 200
    renewed_cookie = after.headers["set-cookie"]
    assert renewed_cookie.startswith("spawn_session=")
    renewed = renewed_cookie.split("spawn_session=", 1)[1].split(";", 1)[0]
    assert auth.decode_token(renewed)["epoch"] == 0

    async with get_sessionmaker()() as session:
        await session.execute(
            update(User).where(User.id == user_id).values(session_epoch=User.session_epoch + 1)
        )
        await session.commit()
    revoked = await client.get("/api/me", headers={"Authorization": f"Bearer {old}"})
    assert revoked.status_code == 401
    assert "spawn_session=" not in revoked.headers.get("set-cookie", "")


async def test_explicit_session_renewal_and_sign_out_everywhere_keep_only_caller(
    client, monkeypatch
):
    signup = await client.post(
        "/api/auth/signup",
        json={"email": "everywhere@example.com", "password": "hunter2hunter"},
    )
    user_id = signup.json()["user"]["id"]
    issued_at = datetime.now(UTC)
    monkeypatch.setattr(auth, "_now", lambda: issued_at - timedelta(seconds=2))
    first = auth.issue_session_token(user_id)
    monkeypatch.setattr(auth, "_now", lambda: issued_at - timedelta(seconds=1))
    second = auth.issue_session_token(user_id)
    assert first != second

    renewed = await client.post(
        "/api/auth/session/renew",
        headers={"Authorization": f"Bearer {first}"},
    )
    assert renewed.status_code == 200, renewed.text
    assert renewed.json()["expires_at"]
    assert auth.decode_token(renewed.json()["access_token"])["epoch"] == 0
    assert renewed.headers["set-cookie"].startswith("spawn_session=")

    everywhere = await client.post(
        "/api/auth/sign-out-everywhere",
        json={},
        headers={"Authorization": f"Bearer {first}"},
    )
    assert everywhere.status_code == 200, everywhere.text
    caller = everywhere.json()["access_token"]
    assert auth.decode_token(caller)["epoch"] == 1
    assert (
        await client.get("/api/me", headers={"Authorization": f"Bearer {caller}"})
    ).status_code == 200
    assert (
        await client.get("/api/me", headers={"Authorization": f"Bearer {first}"})
    ).status_code == 401
    assert (
        await client.get("/api/me", headers={"Authorization": f"Bearer {second}"})
    ).status_code == 401


async def test_account_deletion_confirms_and_cascades(client):
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import BrowserDevice, Host, HostKeyClaim, User

    signup = await client.post(
        "/api/auth/signup",
        json={"email": "doomed@example.com", "password": "delete-me-password"},
    )
    assert signup.status_code == 200
    body = signup.json()
    user_id = body["user"]["id"]
    headers = {"Authorization": f"Bearer {body['access_token']}"}

    survivor = await client.post(
        "/api/auth/signup",
        json={"email": "survivor@example.com", "password": "survivor-password"},
    )
    survivor_id = survivor.json()["user"]["id"]

    # Give the account a host with a durable key claim and a browser device,
    # so deletion has real cascades (and an explicit RESTRICT row) to clear.
    async with get_sessionmaker()() as session:
        host = Host(
            name="doomed-box",
            owner_user_id=user_id,
            host_key_algorithm="ed25519",
            host_public_key="K" * 43,
        )
        device = BrowserDevice(owner_user_id=user_id, key_algorithm="ed25519", public_key="B" * 43)
        claim = HostKeyClaim(
            host_key_algorithm="ed25519",
            host_public_key="K" * 43,
            owner_user_id=user_id,
        )
        session.add_all([host, device, claim])
        await session.commit()

    # Wrong confirmation email fails closed.
    wrong_email = await client.post(
        "/api/account/delete",
        json={"confirm_email": "someone-else@example.com", "password": "delete-me-password"},
        headers=headers,
    )
    assert wrong_email.status_code == 403

    # A password account cannot delete without its password, nor with a wrong one.
    no_password = await client.post(
        "/api/account/delete",
        json={"confirm_email": "doomed@example.com"},
        headers=headers,
    )
    assert no_password.status_code == 403
    wrong_password = await client.post(
        "/api/account/delete",
        json={"confirm_email": "doomed@example.com", "password": "not-the-password"},
        headers=headers,
    )
    assert wrong_password.status_code == 403

    deleted = await client.post(
        "/api/account/delete",
        json={"confirm_email": "Doomed@Example.com", "password": "delete-me-password"},
        headers=headers,
    )
    assert deleted.status_code == 204

    # The token dies with the row, and every owned record is gone — including
    # the RESTRICT-protected host key claim, whose release must be exactly
    # this deliberate.
    assert (await client.get("/api/me", headers=headers)).status_code == 401
    async with get_sessionmaker()() as session:
        assert await session.get(User, user_id) is None
        hosts = (
            (await session.execute(select(Host).where(Host.owner_user_id == user_id)))
            .scalars()
            .all()
        )
        devices = (
            (
                await session.execute(
                    select(BrowserDevice).where(BrowserDevice.owner_user_id == user_id)
                )
            )
            .scalars()
            .all()
        )
        claims = (
            (
                await session.execute(
                    select(HostKeyClaim).where(HostKeyClaim.owner_user_id == user_id)
                )
            )
            .scalars()
            .all()
        )
        assert hosts == [] and devices == [] and claims == []
        assert await session.get(User, survivor_id) is not None


async def test_provider_only_account_deletes_with_typed_email_alone(client):
    from spawn_server import auth as auth_module
    from spawn_server.db import get_sessionmaker
    from spawn_server.models import AuthIdentity, User

    async with get_sessionmaker()() as session:
        user = User(
            email="oauth-only@example.com",
            password_hash=auth_module.hash_random_password(),
        )
        session.add(user)
        await session.flush()
        session.add(
            AuthIdentity(
                user_id=user.id,
                provider="github",
                provider_user_id="oauth-only-subject",
                email="oauth-only@example.com",
            )
        )
        await session.commit()
        user_id = user.id

    headers = {"Authorization": f"Bearer {auth_module.issue_access_token(user_id)}"}

    # A supplied-but-wrong password still fails closed even for provider accounts.
    wrong = await client.post(
        "/api/account/delete",
        json={"confirm_email": "oauth-only@example.com", "password": "guessing"},
        headers=headers,
    )
    assert wrong.status_code == 403

    deleted = await client.post(
        "/api/account/delete",
        json={"confirm_email": "oauth-only@example.com"},
        headers=headers,
    )
    assert deleted.status_code == 204
    async with get_sessionmaker()() as session:
        assert await session.get(User, user_id) is None
