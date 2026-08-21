"""Workspace templates: CRUD, spec validation, ownership isolation."""

from __future__ import annotations


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


def _spec(tiles=None, *, name: str = "Tab 1") -> dict:
    return {
        "version": 2,
        "tabs": [
            {
                "name": name,
                "tiles": tiles
                if tiles is not None
                else [
                    {"x": 0, "y": 0, "w": 12, "h": 24, "run": {"kind": "shell"}},
                    {"x": 12, "y": 0, "w": 12, "h": 24, "run": {"kind": "agent", "command": "claude"}},
                ],
            }
        ],
    }


async def test_template_crud_round_trip(client):
    token = await _signup(client, "templates@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    created = await client.post(
        "/api/workspace-templates", json={"name": "  Pair setup  ", "spec": _spec()}, headers=auth
    )
    assert created.status_code == 201
    body = created.json()
    assert body["name"] == "Pair setup"
    assert body["spec"]["tabs"][0]["tiles"][1]["run"] == {"kind": "agent", "command": "claude"}

    listed = await client.get("/api/workspace-templates", headers=auth)
    assert [t["name"] for t in listed.json()] == ["Pair setup"]

    patched = await client.patch(
        f"/api/workspace-templates/{body['id']}", json={"name": "Solo"}, headers=auth
    )
    assert patched.status_code == 200
    assert patched.json()["name"] == "Solo"
    assert patched.json()["spec"] == body["spec"]

    deleted = await client.delete(f"/api/workspace-templates/{body['id']}", headers=auth)
    assert deleted.status_code == 204
    assert (await client.get("/api/workspace-templates", headers=auth)).json() == []


async def test_template_spec_validation(client):
    token = await _signup(client, "templates-bad@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    # Overlapping geometry is refused with the layouts' own validator.
    overlap = _spec(
        [
            {"x": 0, "y": 0, "w": 12, "h": 24, "run": {"kind": "shell"}},
            {"x": 6, "y": 0, "w": 12, "h": 24, "run": {"kind": "shell"}},
        ]
    )
    r = await client.post(
        "/api/workspace-templates", json={"name": "bad", "spec": overlap}, headers=auth
    )
    assert r.status_code == 400
    assert r.json()["detail"] == "invalid_template_geometry"

    # Agent tiles need a command; other kinds must not carry one.
    r = await client.post(
        "/api/workspace-templates",
        json={
            "name": "bad",
            "spec": _spec([{"x": 0, "y": 0, "w": 24, "h": 24, "run": {"kind": "agent"}}]),
        },
        headers=auth,
    )
    assert r.status_code == 400
    r = await client.post(
        "/api/workspace-templates",
        json={
            "name": "bad",
            "spec": _spec(
                [{"x": 0, "y": 0, "w": 24, "h": 24, "run": {"kind": "shell", "command": "ls"}}]
            ),
        },
        headers=auth,
    )
    assert r.status_code == 400

    # An empty tab list is a schema error.
    r = await client.post(
        "/api/workspace-templates",
        json={"name": "bad", "spec": {"version": 2, "tabs": []}},
        headers=auth,
    )
    assert r.status_code == 422


async def test_template_remembers_its_folder(client):
    token = await _signup(client, "templates-home@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    from tests.test_workspaces import _create_host

    host_id = await _create_host("templates-home@example.com")
    created = await client.post(
        "/api/workspace-templates",
        json={"name": "homed", "host_id": host_id, "cwd": "/srv/app", "spec": _spec()},
        headers=auth,
    )
    assert created.status_code == 201
    assert created.json()["host_id"] == host_id
    assert created.json()["cwd"] == "/srv/app"

    # A host_id needs a cwd, and a foreign host is invisible.
    r = await client.post(
        "/api/workspace-templates",
        json={"name": "bad", "host_id": host_id, "spec": _spec()},
        headers=auth,
    )
    assert r.status_code == 400

    other_token = await _signup(client, "templates-home-b@example.com")
    r = await client.post(
        "/api/workspace-templates",
        json={"name": "bad", "host_id": host_id, "cwd": "/srv", "spec": _spec()},
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert r.status_code == 404


async def test_templates_are_owner_scoped(client):
    token_a = await _signup(client, "templates-a@example.com")
    token_b = await _signup(client, "templates-b@example.com")
    auth_a = {"Authorization": f"Bearer {token_a}"}
    auth_b = {"Authorization": f"Bearer {token_b}"}

    created = await client.post(
        "/api/workspace-templates", json={"name": "mine", "spec": _spec()}, headers=auth_a
    )
    template_id = created.json()["id"]

    assert (await client.get("/api/workspace-templates", headers=auth_b)).json() == []
    r = await client.patch(
        f"/api/workspace-templates/{template_id}", json={"name": "stolen"}, headers=auth_b
    )
    assert r.status_code == 404
    r = await client.delete(f"/api/workspace-templates/{template_id}", headers=auth_b)
    assert r.status_code == 404


async def test_template_spec_v1_is_lifted_into_the_24x24_space(client):
    """A client that still speaks the 12x12 spec keeps working through a
    deploy: its geometry is scaled on the way in, not stored at half size."""
    token = await _signup(client, "spec-v1@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    r = await client.post(
        "/api/workspace-templates",
        json={
            "name": "legacy",
            "spec": {
                "version": 1,
                "tabs": [
                    {
                        "name": "Tab 1",
                        "tiles": [
                            {"x": 0, "y": 0, "w": 6, "h": 12, "run": {"kind": "shell"}},
                            {"x": 6, "y": 0, "w": 6, "h": 12, "run": {"kind": "shell"}},
                        ],
                    }
                ],
            },
        },
        headers=auth,
    )
    assert r.status_code == 201, r.text
    spec = r.json()["spec"]
    assert spec["version"] == 2
    assert [(t["x"], t["y"], t["w"], t["h"]) for t in spec["tabs"][0]["tiles"]] == [
        (0, 0, 12, 24),
        (12, 0, 12, 24),
    ]


ICON_PNG = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


async def test_a_template_carries_the_mark_it_was_saved_with(client):
    """Saving a workspace as a template keeps its icon, so every workspace
    created from it opens wearing the same mark."""
    token = await _signup(client, "template-icon@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    created = await client.post(
        "/api/workspace-templates",
        json={"name": "marked", "spec": _spec(), "icon": ICON_PNG, "icon_source": "custom"},
        headers=auth,
    )
    assert created.status_code == 201, created.text
    assert (created.json()["icon"], created.json()["icon_source"]) == (ICON_PNG, "custom")

    template_id = created.json()["id"]
    renamed = await client.patch(
        f"/api/workspace-templates/{template_id}", json={"name": "still marked"}, headers=auth
    )
    assert renamed.json()["icon"] == ICON_PNG

    cleared = await client.patch(
        f"/api/workspace-templates/{template_id}", json={"icon": None}, headers=auth
    )
    assert cleared.json()["icon"] is None


async def test_a_template_icon_is_held_to_the_same_rule_as_a_workspace(client):
    token = await _signup(client, "template-icon-bad@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    r = await client.post(
        "/api/workspace-templates",
        json={"name": "bad", "spec": _spec(), "icon": "https://example.com/logo.png"},
        headers=auth,
    )
    assert r.status_code == 422


async def test_a_workspace_can_be_created_already_wearing_a_mark(client):
    """The template flow hands the icon down at creation rather than in a
    follow-up PATCH, so the new row never renders as initials first."""
    token = await _signup(client, "template-instantiate-icon@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    created = await client.post(
        "/api/workspaces",
        json={"name": "from template", "icon": ICON_PNG, "icon_source": "custom"},
        headers=auth,
    )
    assert created.status_code == 201, created.text
    workspace = created.json()["workspace"]
    assert (workspace["icon"], workspace["icon_source"]) == (ICON_PNG, "custom")
