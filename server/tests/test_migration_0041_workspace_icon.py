"""Migration 0041 (workspace icon) adds the pair without disturbing a row.

The columns are additive and nullable, and null on both is exactly the state
that asks the browser to go looking — so every workspace that already exists
comes through unlooked, and everything else about it is untouched.

Pinned to revision 0041 rather than head for the same reason the neighbouring
migration tests are: what is under test is this step.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from tests.test_migrations_overhaul import _alembic, _migration_env

USER_ID = "66666666-6666-4666-8666-666666666666"
NOW = "2026-01-01 00:00:00"
LAYOUT = {
    "version": 3,
    "active_tab": "tab-1",
    "tabs": [
        {
            "id": "tab-1",
            "name": "Tab 1",
            "host_id": None,
            "cwd": None,
            "layout": {"version": 3, "tiles": []},
        }
    ],
}


def _seed(conn) -> tuple[str, str]:
    conn.execute(
        text(
            "INSERT INTO users (id, email, password_hash, created_at)"
            " VALUES (:id, :email, 'x', :now)"
        ),
        {"id": USER_ID, "email": "icon-migration@example.com", "now": NOW},
    )
    workspace = str(uuid.uuid4())
    conn.execute(
        text(
            "INSERT INTO workspaces (id, owner_user_id, name, cwd, layout, position,"
            " created_at, updated_at)"
            " VALUES (:id, :owner, 'spawn', '/repo/spawn', :layout, 0, :now, :now)"
        ),
        {"id": workspace, "owner": USER_ID, "layout": json.dumps(LAYOUT), "now": NOW},
    )
    template = str(uuid.uuid4())
    conn.execute(
        text(
            "INSERT INTO workspace_templates (id, owner_user_id, name, spec,"
            " created_at, updated_at)"
            " VALUES (:id, :owner, 'pair', :spec, :now, :now)"
        ),
        {
            "id": template,
            "owner": USER_ID,
            "spec": json.dumps({"version": 2, "tabs": [{"name": "Tab 1", "tiles": []}]}),
            "now": NOW,
        },
    )
    return workspace, template


def test_0041_leaves_every_existing_row_unlooked(tmp_path: Path):
    db_path = tmp_path / "spawn-workspace-icon.db"
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0040"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            workspace, template = _seed(conn)
    finally:
        engine.dispose()

    _alembic(["upgrade", "0041"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            row = conn.execute(
                text("SELECT name, cwd, icon, icon_source FROM workspaces WHERE id = :id"),
                {"id": workspace},
            ).one()
            assert tuple(row) == ("spawn", "/repo/spawn", None, None)
            saved = conn.execute(
                text("SELECT icon, icon_source FROM workspace_templates WHERE id = :id"),
                {"id": template},
            ).one()
            assert tuple(saved) == (None, None)
    finally:
        engine.dispose()


def test_0041_downgrade_drops_the_pair_from_both_tables(tmp_path: Path):
    db_path = tmp_path / "spawn-workspace-icon-down.db"
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0040"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            workspace, _ = _seed(conn)
    finally:
        engine.dispose()

    _alembic(["upgrade", "0041"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE workspaces SET icon_source = 'none' WHERE id = :id"),
                {"id": workspace},
            )
    finally:
        engine.dispose()

    _alembic(["downgrade", "0040"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        for table in ("workspaces", "workspace_templates"):
            columns = {column["name"] for column in inspect(engine).get_columns(table)}
            assert {"icon", "icon_source"} & columns == set()
        with engine.begin() as conn:
            # The rest of the row survives the round trip.
            assert (
                conn.execute(
                    text("SELECT name FROM workspaces WHERE id = :id"), {"id": workspace}
                ).scalar_one()
                == "spawn"
            )
    finally:
        engine.dispose()
