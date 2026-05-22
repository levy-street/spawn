"""Device-code flow: start → approve → poll → daemon token + host."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta


async def test_device_code_happy_path(client):
    # Web user signs up.
    r = await client.post(
        "/api/auth/signup",
        json={"email": "bob@example.com", "password": "correcthorse"},
    )
    assert r.status_code == 200
    user_token = r.json()["access_token"]
    auth = {"Authorization": f"Bearer {user_token}"}

    # Daemon kicks off device-code flow.
    r = await client.post(
        "/api/auth/device/start",
        json={
            "host_name": "gpu-box-1",
            "os": "linux",
            "arch": "x86_64",
            "version": "0.1.0",
        },
    )
    assert r.status_code == 200
    body = r.json()
    device_code = body["device_code"]
    user_code = body["user_code"]
    assert len(user_code.split("-")) == 2
    assert body["interval"] == 5
    assert body["expires_in"] == 30 * 60

    # Pre-approval poll → authorization_pending.
    r = await client.post("/api/auth/device/poll", json={"device_code": device_code})
    assert r.status_code == 200
    assert r.json()["error"] == "authorization_pending"

    # User approves the code.
    r = await client.post("/api/auth/device/approve", json={"user_code": user_code}, headers=auth)
    assert r.status_code == 200, r.text
    assert r.json()["host_name"] == "gpu-box-1"

    # Next poll succeeds — but rate limit may kick in. Force-allow by waiting/retrying:
    # the device endpoint requires interval-1 seconds between polls, which is 4s.
    # We'll bypass by directly poking last_polled_at via a fresh poll — easier: wait isn't
    # an option here. Instead we accept slow_down and then poll again.
    r = await client.post("/api/auth/device/poll", json={"device_code": device_code})
    if r.json().get("error") == "slow_down":
        # Patch last_polled_at to simulate elapsed time.
        from datetime import datetime, timedelta

        from sqlalchemy import select

        from spawn_server.db import get_sessionmaker
        from spawn_server.models import DeviceCode

        sm = get_sessionmaker()
        async with sm() as session:
            dc = (
                await session.execute(
                    select(DeviceCode).where(DeviceCode.device_code == device_code)
                )
            ).scalar_one()
            dc.last_polled_at = datetime.now(UTC) - timedelta(seconds=10)
            await session.commit()
        r = await client.post("/api/auth/device/poll", json={"device_code": device_code})

    assert r.status_code == 200, r.text
    body = r.json()
    assert "access_token" in body
    assert "host_id" in body

    # The host is visible via /api/hosts.
    r = await client.get("/api/hosts", headers=auth)
    assert r.status_code == 200
    hosts = r.json()
    assert len(hosts) == 1
    assert hosts[0]["name"] == "gpu-box-1"


async def test_device_poll_error_states(client):
    r = await client.post(
        "/api/auth/device/start",
        json={
            "host_name": "denied-box",
            "os": "linux",
            "arch": "x86_64",
            "version": "0.2.0",
        },
    )
    assert r.status_code == 200
    body = r.json()
    device_code = body["device_code"]

    r = await client.post("/api/auth/device/poll", json={"device_code": "missing"})
    assert r.status_code == 200
    assert r.json() == {"error": "expired_token"}

    first = await client.post("/api/auth/device/poll", json={"device_code": device_code})
    assert first.status_code == 200
    assert first.json() == {"error": "authorization_pending"}
    second = await client.post("/api/auth/device/poll", json={"device_code": device_code})
    assert second.status_code == 200
    assert second.json() == {"error": "slow_down"}

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import DeviceCode

    sm = get_sessionmaker()
    async with sm() as session:
        dc = (
            await session.execute(select(DeviceCode).where(DeviceCode.device_code == device_code))
        ).scalar_one()
        dc.status = "denied"
        dc.last_polled_at = datetime.now(UTC) - timedelta(seconds=10)
        await session.commit()

    denied = await client.post("/api/auth/device/poll", json={"device_code": device_code})
    assert denied.status_code == 200
    assert denied.json() == {"error": "denied"}

    expired_start = await client.post(
        "/api/auth/device/start",
        json={
            "host_name": "expired-box",
            "os": "linux",
            "arch": "x86_64",
            "version": "0.2.0",
        },
    )
    expired_code = expired_start.json()["device_code"]
    async with sm() as session:
        dc = (
            await session.execute(select(DeviceCode).where(DeviceCode.device_code == expired_code))
        ).scalar_one()
        dc.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await session.commit()

    expired = await client.post("/api/auth/device/poll", json={"device_code": expired_code})
    assert expired.status_code == 200
    assert expired.json() == {"error": "expired_token"}
