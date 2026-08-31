"""Opportunistic retention sweeps for terminal coordination rows."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from spawn_server.db import get_sessionmaker
from spawn_server.models import (
    BrowserDevice,
    DeviceCode,
    DevicePairing,
    Host,
    HostIntroduction,
    User,
)


async def test_host_inventory_sweeps_only_safely_stale_coordination_rows(client):
    signup = await client.post(
        "/api/auth/signup",
        json={"email": "hygiene@example.com", "password": "hygiene-test-password"},
    )
    assert signup.status_code == 200, signup.text
    auth = {"Authorization": f"Bearer {signup.json()['access_token']}"}
    now = datetime.now(UTC)

    async with get_sessionmaker()() as session:
        user = (
            await session.execute(select(User).where(User.email == "hygiene@example.com"))
        ).scalar_one()
        devices = [
            BrowserDevice(
                owner_user_id=user.id,
                key_algorithm="ed25519",
                public_key=letter * 43,
            )
            for letter in ("A", "B", "C")
        ]
        live_host_key = "L" * 43
        host = Host(
            owner_user_id=user.id,
            name="hygiene-host",
            host_key_algorithm="ed25519",
            host_public_key=live_host_key,
        )
        session.add_all([*devices, host])
        await session.flush()

        session.add_all(
            [
                DeviceCode(
                    device_code="old-terminal",
                    user_code="OLD1-CODE",
                    status="denied",
                    expires_at=now - timedelta(days=8),
                ),
                DeviceCode(
                    device_code="recent-terminal",
                    user_code="NEW1-CODE",
                    status="pin_limit",
                    expires_at=now - timedelta(days=1),
                ),
                DeviceCode(
                    device_code="old-nonterminal",
                    user_code="LIVE-CODE",
                    status="pending",
                    expires_at=now - timedelta(days=8),
                ),
                DevicePairing(
                    id="00000000-0000-4000-8000-000000000001",
                    owner_user_id=user.id,
                    initiator_device_id=devices[0].id,
                    joiner_device_id=devices[1].id,
                    initiator_public_key="I" * 43,
                    initiator_commit="C" * 43,
                    created_at=now - timedelta(days=3),
                    expires_at=now - timedelta(days=2),
                ),
                DevicePairing(
                    id="00000000-0000-4000-8000-000000000002",
                    owner_user_id=user.id,
                    initiator_device_id=devices[1].id,
                    joiner_device_id=devices[2].id,
                    initiator_public_key="J" * 43,
                    initiator_commit="D" * 43,
                    created_at=now - timedelta(hours=2),
                    expires_at=now - timedelta(hours=1),
                ),
                HostIntroduction(
                    owner_user_id=user.id,
                    publisher_device_id=devices[0].id,
                    host_id="00000000-0000-4000-8000-000000000010",
                    host_name="dead-old",
                    host_public_key="D" * 43,
                    signature="d" * 86,
                    created_at=now - timedelta(days=31),
                ),
                HostIntroduction(
                    owner_user_id=user.id,
                    publisher_device_id=devices[0].id,
                    host_id="00000000-0000-4000-8000-000000000011",
                    host_name="dead-recent",
                    host_public_key="E" * 43,
                    signature="e" * 86,
                    created_at=now - timedelta(days=1),
                ),
                HostIntroduction(
                    owner_user_id=user.id,
                    publisher_device_id=devices[0].id,
                    host_id=host.id,
                    host_name="still-live",
                    host_public_key=live_host_key,
                    signature="l" * 86,
                    created_at=now - timedelta(days=31),
                ),
            ]
        )
        await session.commit()

    listed = await client.get("/api/hosts", headers=auth)
    assert listed.status_code == 200, listed.text

    async with get_sessionmaker()() as session:
        code_ids = set((await session.execute(select(DeviceCode.device_code))).scalars())
        pairing_ids = set((await session.execute(select(DevicePairing.id))).scalars())
        intro_names = set((await session.execute(select(HostIntroduction.host_name))).scalars())
    assert code_ids == {"recent-terminal", "old-nonterminal"}
    assert pairing_ids == {"00000000-0000-4000-8000-000000000002"}
    assert intro_names == {"dead-recent", "still-live"}
