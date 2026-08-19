"""Preset API behavior."""

from __future__ import annotations


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


async def test_user_preset_can_be_updated(client):
    token = await _signup(client, "preset-owner@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.post(
        "/api/presets",
        json={
            "name": "custom-codex",
            "agent_kind": "codex",
            "default_argv": ["codex"],
            "env_template": {"FOO": "bar"},
            "install": "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh",
        },
        headers=auth,
    )
    assert r.status_code == 201, r.text
    preset_id = r.json()["id"]

    r = await client.patch(
        f"/api/presets/{preset_id}",
        json={
            "name": "custom-shell",
            "agent_kind": "shell",
            "default_argv": ["bash", "-l"],
            "env_template": {"BAZ": "qux"},
            "install": None,
        },
        headers=auth,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "custom-shell"
    assert body["agent_kind"] == "shell"
    assert body["default_argv"] == ["bash", "-l"]
    assert body["env_template"] == {"BAZ": "qux"}
    assert body["install"] is None


async def test_builtin_presets_cannot_be_updated(client):
    token = await _signup(client, "preset-builtins@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    r = await client.get("/api/presets", headers=auth)
    assert r.status_code == 200
    builtin = next(p for p in r.json() if p["owner_user_id"] is None)

    r = await client.patch(
        f"/api/presets/{builtin['id']}",
        json={"name": "renamed"},
        headers=auth,
    )
    assert r.status_code == 404


async def test_other_users_preset_cannot_be_updated(client):
    owner_token = await _signup(client, "preset-owner-2@example.com")
    other_token = await _signup(client, "preset-other@example.com")

    r = await client.post(
        "/api/presets",
        json={"name": "private", "agent_kind": "codex", "default_argv": ["codex"]},
        headers={"Authorization": f"Bearer {owner_token}"},
    )
    assert r.status_code == 201, r.text
    preset_id = r.json()["id"]

    r = await client.patch(
        f"/api/presets/{preset_id}",
        json={"name": "stolen"},
        headers={"Authorization": f"Bearer {other_token}"},
    )
    assert r.status_code == 404


async def test_duplicate_user_preset_name_returns_conflict(client):
    token = await _signup(client, "preset-dupe@example.com")
    auth = {"Authorization": f"Bearer {token}"}
    second_id = ""

    for name in ("first", "second"):
        r = await client.post(
            "/api/presets",
            json={"name": name, "agent_kind": "codex", "default_argv": ["codex"]},
            headers=auth,
        )
        assert r.status_code == 201, r.text
        if name == "second":
            second_id = r.json()["id"]

    r = await client.patch(f"/api/presets/{second_id}", json={"name": "first"}, headers=auth)
    assert r.status_code == 409


def test_every_builtin_declares_its_autonomy_flag_explicitly():
    """`None` and "not written down" must not be the same thing.

    A preset that quietly lacks the key would hide the toggle for a tool that
    does have a flag, which is indistinguishable from a tool that does not.
    """

    from spawn_server.presets import BUILTIN_PRESETS

    for spec in BUILTIN_PRESETS:
        assert "yolo_argv" in spec, spec["name"]
        assert spec["yolo_argv"] is None or (
            isinstance(spec["yolo_argv"], list)
            and spec["yolo_argv"]
            and all(isinstance(flag, str) and flag.startswith("-") for flag in spec["yolo_argv"])
        ), spec["name"]

    by_name = {spec["name"]: spec["yolo_argv"] for spec in BUILTIN_PRESETS}
    assert by_name["claude-code"] == ["--dangerously-skip-permissions"]
    assert by_name["codex"] == ["--yolo"]
    assert by_name["aider-sonnet"] == ["--yes-always"]
    # No CLI flag exists for either: opencode is config-driven, and a shell
    # never had a permission model to skip.
    assert by_name["opencode"] is None
    assert by_name["shell"] is None


def test_compose_argv_appends_rather_than_replaces():
    from spawn_server.presets import compose_argv

    assert compose_argv(["codex"], ["--yolo"], yolo=True) == ["codex", "--yolo"]
    assert compose_argv(["codex"], ["--yolo"], yolo=False) == ["codex"]
    # The preset's own arguments survive; the flag lands after them.
    assert compose_argv(["aider", "--model", "x"], ["--yes-always"], yolo=True) == [
        "aider",
        "--model",
        "x",
        "--yes-always",
    ]
    # A preset with no flag is unchanged even when asked.
    assert compose_argv(["opencode"], None, yolo=True) == ["opencode"]
    assert compose_argv(["bash", "-l"], None, yolo=True) == ["bash", "-l"]
    # Idempotent, so a default_argv that already carries it stays clean.
    assert compose_argv(["codex", "--yolo"], ["--yolo"], yolo=True) == ["codex", "--yolo"]
    # And it never mutates the caller's list.
    default = ["codex"]
    compose_argv(default, ["--yolo"], yolo=True)
    assert default == ["codex"]


async def test_seeding_reconciles_a_corrected_builtin_onto_an_existing_deployment(client):
    """Seeding used to only ever fix `install`.

    Everything else was write-once, so a wrong `default_argv` shipped once
    would have been wrong forever on every deployment that already ran.
    """

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Preset
    from spawn_server.presets import seed_builtin_presets

    async with get_sessionmaker()() as session:
        row = (
            await session.execute(
                select(Preset).where(Preset.owner_user_id.is_(None), Preset.name == "codex")
            )
        ).scalar_one()
        row.default_argv = ["codex", "--wrong"]
        row.yolo_argv = None
        row.install = "echo nope"
        await session.commit()

        await seed_builtin_presets(session)

        corrected = (
            await session.execute(
                select(Preset).where(Preset.owner_user_id.is_(None), Preset.name == "codex")
            )
        ).scalar_one()
        assert corrected.default_argv == ["codex"]
        assert corrected.yolo_argv == ["--yolo"]
        assert corrected.install.startswith("curl -fsSL https://chatgpt.com/codex/install.sh")


async def test_a_user_preset_is_never_touched_by_seeding(client):
    """Reconciliation is scoped to built-ins, which nobody can edit anyway."""


    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Preset
    from spawn_server.presets import seed_builtin_presets

    signup = await client.post(
        "/api/auth/signup", json={"email": "preset-owner@example.com", "password": "passpasspass"}
    )
    assert signup.status_code == 200
    user_id = signup.json()["user"]["id"]

    async with get_sessionmaker()() as session:
        mine = Preset(
            owner_user_id=user_id,
            name="codex",
            agent_kind="codex",
            default_argv=["codex", "--my-flag"],
            env_template={},
            install=None,
            yolo_argv=None,
        )
        session.add(mine)
        await session.commit()
        preset_id = mine.id

        await seed_builtin_presets(session)

        untouched = await session.get(Preset, preset_id)
        assert untouched is not None
        assert untouched.default_argv == ["codex", "--my-flag"]
        assert untouched.yolo_argv is None


async def test_the_new_builtins_are_seeded_with_a_working_shape(client):
    """A wrong binary or install ships a preset that fails on every host.

    Each of these was confirmed against the vendor's current docs; this pins
    them so a later edit has to be deliberate.
    """

    token = await _signup(client, "builtin-shape@example.com")
    listed = await client.get("/api/presets", headers={"Authorization": f"Bearer {token}"})
    assert listed.status_code == 200, listed.text
    by_name = {item["name"]: item for item in listed.json()}

    hermes = by_name["hermes"]
    assert hermes["agent_kind"] == "hermes"
    assert hermes["default_argv"] == ["hermes"]
    assert hermes["install"] == (
        "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
    )
    assert hermes["yolo_argv"] == ["--yolo"]

    grok = by_name["grok"]
    assert grok["agent_kind"] == "grok"
    assert grok["default_argv"] == ["grok"]
    # The vendor-preferred install, and an npm package so the existing parser
    # can resolve a latest version without a special case.
    assert grok["install"] == "npm install -g @xai-official/grok"
    assert grok["yolo_argv"] is None

    # Neither carries credentials: each CLI handles its own login on the host.
    assert hermes["env_template"] == {}
    assert grok["env_template"] == {}


async def test_no_builtin_smuggles_credentials_into_the_server(client):
    """spawn deliberately does not manage agent provider credentials.

    Both new tools *can* read an API key from the environment, so this is the
    invariant worth pinning rather than assuming.
    """

    token = await _signup(client, "builtin-creds@example.com")
    listed = await client.get("/api/presets", headers={"Authorization": f"Bearer {token}"})
    assert listed.status_code == 200, listed.text
    for item in listed.json():
        assert item["env_template"] == {}, item["name"]
