"""Overhaul migration chain (0042–0045) against representative pre-overhaul data.

Seeds a 0041-shaped database the way internal users actually had it —
split-tree layouts (deep and ratio-heavy ones), archived agents, built-in and
custom presets, host_tool_policies — then proves the chain is data-preserving
in both directions.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

from spawn_server import grid

SERVER_ROOT = Path(__file__).resolve().parents[1]


def _migration_env(db_url: str) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "SPAWN_DATABASE_URL": db_url,
            "SPAWN_USE_INPROCESS_PUBSUB": "1",
            "SPAWN_JWT_SECRET": "migration-test-secret-with-enough-length",
            "PYTHONPATH": str(SERVER_ROOT),
        }
    )
    return env


def _head_revision() -> str:
    """The chain's current head, read off the scripts rather than hard-coded —
    the point here is that the chain arrives, not which number it arrives at."""
    config = Config(str(SERVER_ROOT / "alembic.ini"))
    config.set_main_option("script_location", str(SERVER_ROOT / "alembic"))
    head = ScriptDirectory.from_config(config).get_current_head()
    assert head is not None
    return head


def _alembic(args: list[str], *, env: dict[str, str]) -> None:
    subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=SERVER_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )


def _pane(agent_id: str) -> dict:
    return {"type": "pane", "agent_id": agent_id}


def _split(direction: str, ratio: float, a: dict, b: dict) -> dict:
    return {"type": "split", "direction": direction, "ratio": ratio, "a": a, "b": b}


def _seed_pre_overhaul(conn) -> dict[str, str]:
    ids = {
        "user": str(uuid.uuid4()),
        "host1": str(uuid.uuid4()),
        "host2": str(uuid.uuid4()),
        "custom_preset": str(uuid.uuid4()),
        "skill": str(uuid.uuid4()),
    }
    conn.execute(
        text(
            "insert into users (id, email, password_hash, created_at, session_epoch, is_admin) "
            "values (:id, 'overhaul@example.com', 'hash', '2026-08-01 08:00:00', 0, 0)"
        ),
        {"id": ids["user"]},
    )
    for key, name in (("host1", "laptop"), ("host2", "server")):
        conn.execute(
            text(
                "insert into hosts (id, owner_user_id, name, status, daemon_generation, "
                "daemon_generation_counter, created_at) "
                "values (:id, :owner, :name, 'offline', 0, 0, '2026-08-01 08:00:00')"
            ),
            {"id": ids[key], "owner": ids["user"], "name": name},
        )
    conn.execute(
        text(
            "insert into presets (id, owner_user_id, name, agent_kind, default_argv, "
            "env_template, install) values (:id, :owner, 'my codex', 'codex', :argv, :env, "
            "'npm install -g codex')"
        ),
        {
            "id": ids["custom_preset"],
            "owner": ids["user"],
            "argv": json.dumps(["codex", "--yolo", "my arg"]),
            "env": json.dumps({"FOO": "bar"}),
        },
    )
    codex_preset_id = conn.execute(
        text("select id from presets where owner_user_id is null and name = 'codex'")
    ).scalar_one()
    shell_preset_id = conn.execute(
        text("select id from presets where owner_user_id is null and name = 'shell'")
    ).scalar_one()
    ids["codex_preset"] = codex_preset_id
    ids["shell_preset"] = shell_preset_id

    def add_agent(key: str, *, host: str, cwd: str, started_at: str, archived: bool = False,
                  pinned: bool = False, preset: str | None = None, name: str | None = None):
        ids[key] = str(uuid.uuid4())
        conn.execute(
            text(
                "insert into agents (id, owner_user_id, host_id, preset_id, cwd, argv, env, "
                "name, status, started_at, archived_at, pinned_at) values "
                "(:id, :owner, :host, :preset, :cwd, :argv, :env, :name, 'running', "
                ":started_at, :archived_at, :pinned_at)"
            ),
            {
                "id": ids[key],
                "owner": ids["user"],
                "host": ids[host],
                "preset": ids[preset] if preset else None,
                "cwd": cwd,
                "argv": json.dumps(["claude"]),
                "env": json.dumps({}),
                "name": name or key,
                "started_at": started_at,
                "archived_at": "2026-08-10 10:00:00" if archived else None,
                "pinned_at": "2026-08-10 10:00:00" if pinned else None,
            },
        )

    add_agent("a1", host="host1", cwd="/home/oem/proj1", started_at="2026-08-02 10:00:00",
              preset="codex_preset")
    add_agent("a2", host="host1", cwd="/home/oem/proj2", started_at="2026-08-03 10:00:00")
    add_agent("a_archived", host="host1", cwd="/home/oem/archived", archived=True,
              started_at="2026-08-18 10:00:00")
    add_agent("a_pinned", host="host2", cwd="/srv/app", pinned=True,
              started_at="2026-08-04 10:00:00")
    # Deep layout needs eight live panes on host1; also feeds the recent_dirs
    # cap (more than 8 distinct paths on host1 overall).
    for index in range(3, 11):
        add_agent(
            f"d{index}",
            host="host1",
            cwd=f"/home/oem/proj{index}",
            started_at=f"2026-08-0{min(index, 9)} 12:00:00"
            if index < 10
            else "2026-08-10 12:00:00",
        )

    conn.execute(
        text(
            "insert into skills (id, owner_user_id, name, description, content, "
            "enabled_by_default, created_at) values (:id, :owner, 'style', '', '# S', 1, "
            "'2026-08-01 08:00:00')"
        ),
        {"id": ids["skill"], "owner": ids["user"]},
    )
    for key, agent_key in (("grant_live", "a1"), ("grant_archived", "a_archived")):
        ids[key] = str(uuid.uuid4())
        conn.execute(
            text(
                "insert into agent_skill_grants (id, owner_user_id, agent_id, skill_id, "
                "created_at) values (:id, :owner, :agent, :skill, '2026-08-01 08:00:00')"
            ),
            {"id": ids[key], "owner": ids["user"], "agent": ids[agent_key],
             "skill": ids["skill"]},
        )

    def add_screen(key: str, name: str, layout: dict, *, ephemeral: bool = False,
                   pinned: bool = False):
        ids[key] = str(uuid.uuid4())
        conn.execute(
            text(
                "insert into screens (id, owner_user_id, name, layout, ephemeral, pinned_at, "
                "created_at, updated_at) values (:id, :owner, :name, :layout, :ephemeral, "
                ":pinned_at, '2026-08-01 08:00:00', '2026-08-01 08:00:00')"
            ),
            {
                "id": ids[key],
                "owner": ids["user"],
                "name": name,
                "layout": json.dumps(layout),
                "ephemeral": 1 if ephemeral else 0,
                "pinned_at": "2026-08-10 10:00:00" if pinned else None,
            },
        )

    # Even split referencing an archived pane (dropped, split collapses).
    add_screen(
        "screen_even",
        "b even",
        {
            "root": _split(
                "row",
                0.5,
                _pane(ids["a1"]),
                _split("column", 0.5, _pane(ids["a2"]), _pane(ids["a_archived"])),
            )
        },
    )
    # Ratio-heavy split that cannot round to a legal grid: falls back.
    add_screen(
        "screen_ratio",
        "a ratio",
        {"root": _split("row", 0.08, _pane(ids["a1"]), _pane(ids["a2"]))},
    )
    # Deep 8-pane tree (nested halvings produce sub-3 slivers -> fallback).
    deep = _pane(ids["d3"])
    for index in range(4, 11):
        deep = _split("row" if index % 2 else "column", 0.5, deep, _pane(ids[f"d{index}"]))
    add_screen("screen_deep", "c deep", {"root": deep})
    # Duplicate panes keep the first occurrence only.
    add_screen(
        "screen_dup",
        "d dup",
        {"root": _split("row", 0.5, _pane(ids["a1"]), _pane(ids["a1"]))},
    )
    # Empty and ephemeral/pinned rows survive as plain workspaces.
    add_screen("screen_empty", "e empty", {}, ephemeral=True, pinned=True)

    for key, preset_key in (("policy_codex", "codex_preset"), ("policy_shell", "shell_preset")):
        ids[key] = str(uuid.uuid4())
        conn.execute(
            text(
                "insert into host_tool_policies (id, owner_user_id, host_id, preset_id, "
                "auto_update) values (:id, :owner, :host, :preset, 1)"
            ),
            {"id": ids[key], "owner": ids["user"], "host": ids["host1"],
             "preset": ids[preset_key]},
        )
    return ids


def test_overhaul_chain_preserves_data_and_downgrades(tmp_path: Path):
    db_path = tmp_path / "spawn-overhaul-migrations.db"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    sync_url = f"sqlite:///{db_path}"
    env = _migration_env(async_url)

    _alembic(["upgrade", "0041"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            ids = _seed_pre_overhaul(conn)
    finally:
        engine.dispose()

    _alembic(["upgrade", "head"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
        assert {"sessions", "workspaces", "agents", "recent_dirs", "session_skill_grants",
                "host_agent_policies"} <= tables
        assert {"screens", "presets", "agent_skill_grants", "host_tool_policies"}.isdisjoint(
            tables
        )
        session_columns = {c["name"] for c in inspector.get_columns("sessions")}
        assert "foreground_command" in session_columns
        assert {"argv", "env", "preset_id", "archived_at", "pinned_at"}.isdisjoint(
            session_columns
        )
        workspace_columns = {c["name"] for c in inspector.get_columns("workspaces")}
        assert "position" in workspace_columns
        assert {"ephemeral", "pinned_at"}.isdisjoint(workspace_columns)

        with engine.begin() as conn:
            # 0042: archived agents (and their grants) are the one deletion.
            session_ids = set(conn.execute(text("select id from sessions")).scalars())
            assert ids["a_archived"] not in session_ids
            assert {ids["a1"], ids["a2"], ids["a_pinned"]} <= session_ids
            a1 = conn.execute(
                text("select cwd, name, status, foreground_command from sessions "
                     "where id = :id"),
                {"id": ids["a1"]},
            ).one()
            assert a1 == ("/home/oem/proj1", "a1", "running", None)
            grants = conn.execute(
                text("select session_id from session_skill_grants")
            ).scalars().all()
            assert grants == [ids["a1"]]

            # 0043: presets became agent definitions; shell is gone; argv
            # shell-joined into a single command with quoting.
            agents = {
                row.name: row
                for row in conn.execute(
                    text("select name, owner_user_id, kind, command, env, install from agents")
                )
            }
            assert "shell" not in agents
            custom = agents["my codex"]
            assert custom.kind == "codex"
            assert custom.command == "codex --yolo 'my arg'"
            assert json.loads(custom.env) == {"FOO": "bar"}
            assert custom.install == "npm install -g codex"
            assert agents["claude-code"].owner_user_id is None

            policies = conn.execute(
                text("select agent_id, auto_update from host_agent_policies")
            ).all()
            assert [(row.agent_id, row.auto_update) for row in policies] == [
                (ids["codex_preset"], 1)
            ]

            # 0044: split trees became valid v2 grids; positions follow name
            # order; retired flags are gone with their columns.
            workspaces = {
                row.name: row
                for row in conn.execute(
                    text("select id, name, layout, position from workspaces")
                )
            }
            assert {name: row.position for name, row in workspaces.items()} == {
                "a ratio": 0,
                "b even": 1,
                "c deep": 2,
                "d dup": 3,
                "e empty": 4,
            }

            # 0046 wraps every v2 grid into a single-tab v3 envelope.
            def first_tab_grid(row) -> dict:
                envelope = json.loads(row.layout)
                assert envelope["version"] == 3
                assert envelope["active_tab"] == "tab-1"
                assert [tab["id"] for tab in envelope["tabs"]] == ["tab-1"]
                return envelope["tabs"][0]["layout"]

            even = first_tab_grid(workspaces["b even"])
            assert grid.validate(even)
            assert even["tiles"] == [
                {"session_id": ids["a1"], "x": 0, "y": 0, "w": 12, "h": 24},
                {"session_id": ids["a2"], "x": 12, "y": 0, "w": 12, "h": 24},
            ]

            ratio = first_tab_grid(workspaces["a ratio"])
            assert grid.validate(ratio)
            assert [tile["session_id"] for tile in ratio["tiles"]] == [ids["a1"], ids["a2"]]

            deep = first_tab_grid(workspaces["c deep"])
            assert grid.validate(deep)
            assert len(deep["tiles"]) == 8

            dup = first_tab_grid(workspaces["d dup"])
            assert grid.validate(dup)
            assert dup["tiles"] == [
                {"session_id": ids["a1"], "x": 0, "y": 0, "w": 24, "h": 24}
            ]

            assert first_tab_grid(workspaces["e empty"]) == {"version": 3, "tiles": []}

            # 0045: recent dirs backfilled newest-first, capped at 8 per host,
            # and never from the deleted archived session.
            host1_dirs = conn.execute(
                text(
                    "select path from recent_dirs where host_id = :host "
                    "order by last_used_at desc"
                ),
                {"host": ids["host1"]},
            ).scalars().all()
            assert len(host1_dirs) == 8
            assert "/home/oem/archived" not in host1_dirs
            assert host1_dirs[0] == "/home/oem/proj10"
            host2_dirs = conn.execute(
                text("select path from recent_dirs where host_id = :host"),
                {"host": ids["host2"]},
            ).scalars().all()
            assert host2_dirs == ["/srv/app"]
    finally:
        engine.dispose()

    # The whole chain downgrades and re-upgrades without wedging.
    _alembic(["downgrade", "0041"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
        assert {"agents", "presets", "screens", "host_tool_policies",
                "agent_skill_grants"} <= tables
        assert "recent_dirs" not in tables
        with engine.begin() as conn:
            shell_count = conn.execute(
                text("select count(*) from presets where owner_user_id is null "
                     "and name = 'shell'")
            ).scalar_one()
            assert shell_count == 1
            layout = json.loads(
                conn.execute(
                    text("select layout from screens where id = :id"),
                    {"id": ids["screen_even"]},
                ).scalar_one()
            )
            assert layout["root"] is not None
            downgraded_agents = conn.execute(
                text("select argv, env from agents where id = :id"), {"id": ids["a1"]}
            ).one()
            assert json.loads(downgraded_agents.argv) == []
            assert json.loads(downgraded_agents.env) == {}
    finally:
        engine.dispose()

    _alembic(["upgrade", "head"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            assert conn.execute(
                text("select version_num from alembic_version")
            ).scalar_one() == _head_revision()
            envelope = json.loads(
                conn.execute(
                    text("select layout from workspaces where id = :id"),
                    {"id": ids["screen_even"]},
                ).scalar_one()
            )
            assert envelope["version"] == 3
            relayout = envelope["tabs"][0]["layout"]
            assert grid.validate(relayout)
            assert {tile["session_id"] for tile in relayout["tiles"]} == {
                ids["a1"], ids["a2"]
            }
    finally:
        engine.dispose()
