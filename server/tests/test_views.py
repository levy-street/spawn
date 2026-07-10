"""Saved multi-terminal view CRUD, scoping, and layout sanitization."""

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


async def test_view_crud_and_cross_user_scoping(client):
    a_token = await _signup(client, "views-a@example.com")
    b_token = await _signup(client, "views-b@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    b_auth = {"Authorization": f"Bearer {b_token}"}
    agent_id = await _create_agent_row("views-a@example.com")

    created = await client.post(
        "/api/views",
        json={
            "name": "  daily drive  ",
            "layout": {"tabs": [{"name": "main", "agent_ids": [agent_id]}]},
        },
        headers=a_auth,
    )
    assert created.status_code == 201, created.text
    view = created.json()
    assert view["name"] == "daily drive"
    assert view["layout"]["tabs"][0]["agent_ids"] == [agent_id]
    view_id = view["id"]

    listed = await client.get("/api/views", headers=a_auth)
    assert [row["id"] for row in listed.json()] == [view_id]

    renamed = await client.patch(
        f"/api/views/{view_id}", json={"name": "focus"}, headers=a_auth
    )
    assert renamed.status_code == 200
    assert renamed.json()["name"] == "focus"
    assert renamed.json()["layout"]["tabs"][0]["agent_ids"] == [agent_id]

    blank = await client.post("/api/views", json={"name": "   "}, headers=a_auth)
    assert blank.status_code == 400

    # Other users cannot see, edit, or delete the view.
    assert (await client.get("/api/views", headers=b_auth)).json() == []
    assert (await client.get(f"/api/views/{view_id}", headers=b_auth)).status_code == 404
    assert (
        await client.patch(f"/api/views/{view_id}", json={"name": "x"}, headers=b_auth)
    ).status_code == 404
    assert (await client.delete(f"/api/views/{view_id}", headers=b_auth)).status_code == 404

    deleted = await client.delete(f"/api/views/{view_id}", headers=a_auth)
    assert deleted.status_code == 204
    assert (await client.get("/api/views", headers=a_auth)).json() == []


async def test_view_layout_drops_foreign_agent_ids(client):
    a_token = await _signup(client, "views-owner@example.com")
    await _signup(client, "views-intruder@example.com")
    a_auth = {"Authorization": f"Bearer {a_token}"}
    own_agent = await _create_agent_row("views-owner@example.com")
    foreign_agent = await _create_agent_row("views-intruder@example.com")

    created = await client.post(
        "/api/views",
        json={
            "name": "mixed",
            "layout": {"tabs": [{"agent_ids": [own_agent, foreign_agent]}]},
        },
        headers=a_auth,
    )
    assert created.status_code == 201, created.text
    assert created.json()["layout"]["tabs"][0]["agent_ids"] == [own_agent]

    patched = await client.patch(
        f"/api/views/{created.json()['id']}",
        json={"layout": {"tabs": [{"agent_ids": [foreign_agent]}, {"agent_ids": [own_agent]}]}},
        headers=a_auth,
    )
    assert patched.status_code == 200
    tabs = patched.json()["layout"]["tabs"]
    assert tabs[0]["agent_ids"] == []
    assert tabs[1]["agent_ids"] == [own_agent]
