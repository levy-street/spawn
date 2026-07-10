"""Screen CRUD, scoping, and split-tree layout sanitization."""

from __future__ import annotations


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


async def _create_agent_row(email: str) -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Agent, Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        host = Host(owner_user_id=user.id, name="box", status="online")
        session.add(host)
        await session.flush()
        agent = Agent(
            owner_user_id=user.id,
            host_id=host.id,
            cwd="/repo",
            argv=["bash", "-l"],
            env={},
            status="running",
        )
        session.add(agent)
        await session.commit()
        return agent.id


def _pane(agent_id: str) -> dict:
    return {"type": "pane", "agent_id": agent_id}


def _split(direction: str, a: dict, b: dict, ratio: float = 0.5) -> dict:
    return {"type": "split", "direction": direction, "ratio": ratio, "a": a, "b": b}


async def test_screen_crud_and_cross_user_scoping(client):
    a_token = await _signup(client, "screens-a@example.com")
    b_token = await _signup(client, "screens-b@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    b_auth = {"Authorization": f"Bearer {b_token}"}
    agent_one = await _create_agent_row("screens-a@example.com")
    agent_two = await _create_agent_row("screens-a@example.com")

    root = _split("row", _pane(agent_one), _pane(agent_two), ratio=0.7)
    created = await client.post(
        "/api/screens",
        json={"name": "  daily drive  ", "layout": {"root": root}},
        headers=a_auth,
    )
    assert created.status_code == 201, created.text
    screen = created.json()
    assert screen["name"] == "daily drive"
    assert screen["layout"]["root"]["ratio"] == 0.7
    assert screen["layout"]["root"]["a"]["agent_id"] == agent_one
    screen_id = screen["id"]

    listed = await client.get("/api/screens", headers=a_auth)
    assert [row["id"] for row in listed.json()] == [screen_id]

    renamed = await client.patch(f"/api/screens/{screen_id}", json={"name": "focus"}, headers=a_auth)
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "focus"

    blank = await client.post("/api/screens", json={"name": "   "}, headers=a_auth)
    assert blank.status_code == 400

    assert (await client.get("/api/screens", headers=b_auth)).json() == []
    assert (await client.get(f"/api/screens/{screen_id}", headers=b_auth)).status_code == 404
    assert (
        await client.patch(f"/api/screens/{screen_id}", json={"name": "x"}, headers=b_auth)
    ).status_code == 404
    assert (await client.delete(f"/api/screens/{screen_id}", headers=b_auth)).status_code == 404

    deleted = await client.delete(f"/api/screens/{screen_id}", headers=a_auth)
    assert deleted.status_code == 204
    assert (await client.get("/api/screens", headers=a_auth)).json() == []


async def test_screen_layout_prunes_foreign_agents_and_collapses_splits(client):
    a_token = await _signup(client, "screens-owner@example.com")
    await _signup(client, "screens-intruder@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    own_agent = await _create_agent_row("screens-owner@example.com")
    foreign_agent = await _create_agent_row("screens-intruder@example.com")

    # A split whose sibling is a foreign pane must collapse to the owned pane.
    root = _split("row", _pane(own_agent), _pane(foreign_agent))
    created = await client.post(
        "/api/screens",
        json={"name": "mixed", "layout": {"root": root}},
        headers=a_auth,
    )
    assert created.status_code == 201, created.text
    pruned = created.json()["layout"]["root"]
    assert pruned == {"type": "pane", "agent_id": own_agent}

    # Duplicate panes for one agent keep only the first occurrence.
    dup_root = _split("column", _pane(own_agent), _pane(own_agent))
    patched = await client.patch(
        f"/api/screens/{created.json()['id']}",
        json={"layout": {"root": dup_root}},
        headers=a_auth,
    )
    assert patched.status_code == 200
    assert patched.json()["layout"]["root"] == {
        "type": "pane",
        "agent_id": own_agent,
    }


async def test_screen_layout_limits(client):
    token = await _signup(client, "screens-limits@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    agent_ids = [await _create_agent_row("screens-limits@example.com") for _ in range(9)]

    # 9 panes exceeds the 8-pane cap.
    root = _pane(agent_ids[0])
    for agent_id in agent_ids[1:]:
        root = _split("row", root, _pane(agent_id))
    too_many = await client.post(
        "/api/screens",
        json={"name": "too many", "layout": {"root": root}},
        headers=auth,
    )
    assert too_many.status_code == 400
    assert "8 panes" in too_many.text

    # Ratios outside 0.05..0.95 are rejected by validation.
    bad_ratio = await client.post(
        "/api/screens",
        json={
            "name": "bad ratio",
            "layout": {
                "root": _split("row", _pane(agent_ids[0]), _pane(agent_ids[1]), ratio=0.01)
            },
        },
        headers=auth,
    )
    assert bad_ratio.status_code == 422
