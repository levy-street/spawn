"""Cross-client data-change fan-out: mapping, whitelist, and the middleware.

The contract under guard: every successful mutation of client-visible data
publishes exactly one content-free frame on the owner's alert channel, the
frame echoes the mutating client's self-chosen id so it can skip its own
refetch, and nothing that is not on the resource allowlist — auth above all —
ever fans out.
"""

from __future__ import annotations

import asyncio
import json

from spawn_server.data_events import (
    data_changed_payload,
    forwardable_data_frame,
    resource_for_request,
)
from spawn_server.redis import get_backend, user_alert_channel


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


async def _user_id(email: str) -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import User

    sm = get_sessionmaker()
    async with sm() as session:
        return (await session.execute(select(User).where(User.email == email))).scalar_one().id


class _ChannelTap:
    """Collect everything published to one channel while the tap is open."""

    def __init__(self, channel: str) -> None:
        self.channel = channel
        self.frames: list[dict] = []
        self._task: asyncio.Task[None] | None = None
        self._ready = asyncio.Event()

    async def __aenter__(self) -> _ChannelTap:
        async def pump() -> None:
            async with get_backend().subscribe_channel(self.channel) as stream:
                self._ready.set()
                async for raw in stream:
                    self.frames.append(json.loads(raw))

        self._task = asyncio.create_task(pump())
        await asyncio.wait_for(self._ready.wait(), timeout=2)
        return self

    async def __aexit__(self, *_: object) -> None:
        assert self._task is not None
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    async def settled(self) -> list[dict]:
        # The middleware publishes on a scheduled task after the response;
        # yield until the loop has drained it.
        for _ in range(20):
            await asyncio.sleep(0)
        return self.frames


def test_resource_mapping_covers_data_and_refuses_ceremonies() -> None:
    assert resource_for_request("PATCH", "/api/workspaces/abc") == ("workspaces", "abc")
    assert resource_for_request("POST", "/api/workspaces") == ("workspaces", None)
    assert resource_for_request("POST", "/api/workspaces/abc/archive") == ("workspaces", "abc")
    assert resource_for_request("DELETE", "/api/sessions/s1") == ("sessions", "s1")
    assert resource_for_request("POST", "/api/workspace-templates") == (
        "workspace-templates",
        None,
    )
    # Reads never fan out.
    assert resource_for_request("GET", "/api/workspaces") is None
    # Ceremonies and non-resources never fan out, whatever the method.
    assert resource_for_request("POST", "/api/auth/session/renew") is None
    assert resource_for_request("POST", "/api/auth/signup") is None
    assert resource_for_request("POST", "/api/trust/pairing") is None
    assert resource_for_request("POST", "/api/admin/anything") is None
    assert resource_for_request("POST", "/healthz") is None


def test_forwardable_data_frame_is_a_strict_whitelist() -> None:
    good = data_changed_payload("workspaces", "w1", "tab-9")
    assert forwardable_data_frame(good) == good
    # Unknown resources, oversized ids, and smuggled keys are refused or shed.
    assert forwardable_data_frame({**good, "resource": "secrets"}) is None
    assert forwardable_data_frame({**good, "id": "x" * 65}) is None
    assert forwardable_data_frame({**good, "origin": "x" * 65}) is None
    assert forwardable_data_frame("not a dict") is None
    assert forwardable_data_frame({"type": "alert"}) is None
    forwarded = forwardable_data_frame({**good, "layout": {"tabs": []}})
    assert forwarded is not None and "layout" not in forwarded
    # Absent id and origin are the collection case, not an error.
    assert forwardable_data_frame(data_changed_payload("sessions", None, None)) is not None


async def test_workspace_mutations_fan_out_with_origin_echo(client) -> None:
    token = await _signup(client, "fanout@example.com")
    headers = {"Authorization": f"Bearer {token}", "X-Spawn-Client": "tab-1"}
    user_id = await _user_id("fanout@example.com")

    async with _ChannelTap(user_alert_channel(user_id)) as tap:
        r = await client.post("/api/workspaces", json={"name": "Alpha"}, headers=headers)
        assert r.status_code == 201
        workspace_id = r.json()["workspace"]["id"]
        r = await client.patch(
            f"/api/workspaces/{workspace_id}", json={"name": "Beta"}, headers=headers
        )
        assert r.status_code == 200
        frames = await tap.settled()

    data = [f for f in frames if f.get("type") == "data"]
    assert [f["resource"] for f in data] == ["workspaces", "workspaces"]
    assert data[0]["id"] is None and data[1]["id"] == workspace_id
    assert all(f["origin"] == "tab-1" for f in data)
    # Every frame that fanned out must also survive the socket's whitelist.
    assert all(forwardable_data_frame(f) is not None for f in data)


async def test_failed_and_readonly_requests_stay_silent(client) -> None:
    token = await _signup(client, "silent@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    user_id = await _user_id("silent@example.com")

    async with _ChannelTap(user_alert_channel(user_id)) as tap:
        # A read.
        assert (await client.get("/api/workspaces", headers=headers)).status_code == 200
        # A refused mutation: no such workspace.
        r = await client.patch("/api/workspaces/nope", json={"name": "X"}, headers=headers)
        assert r.status_code == 404
        # An unauthenticated mutation: no user to fan out to. The bearer
        # header outranks the cookie the signup left on this client.
        r = await client.post(
            "/api/workspaces", json={"name": "Y"}, headers={"Authorization": "Bearer junk"}
        )
        assert r.status_code == 401
        frames = await tap.settled()

    assert [f for f in frames if f.get("type") == "data"] == []
