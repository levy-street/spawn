"""The archive migrations preserve every existing row.

Archive is a soft-delete, so the migrations that introduce it must be the
least eventful in the chain: nullable columns, no backfill, and every
workspace that existed before comes out the other side active and byte-for-
byte unchanged. 0038 added `archived_at` and `archived_shape`; 0040 dropped
the shape again when archiving became suspend-in-place, so `head` carries the
timestamp alone. The downgrade has to be equally quiet — internal users are on
this branch, so a rollback cannot cost anyone their layouts.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from sqlalchemy import create_engine, inspect, text

from tests.test_migrations_overhaul import _alembic, _migration_env

USER_ID = "22222222-2222-4222-8222-222222222222"
LAYOUT = {
    "version": 3,
    "active_tab": "tab-1",
    "tabs": [
        {
            "id": "tab-1",
            "name": "Tab 1",
            "layout": {"version": 3, "tiles": [{"session_id": "s", "x": 0, "y": 0, "w": 24, "h": 24}]},
        }
    ],
}


def _seed(conn) -> str:
    conn.execute(
        text(
            "INSERT INTO users (id, email, password_hash, created_at)"
            " VALUES (:id, :email, 'x', :now)"
        ),
        {"id": USER_ID, "email": "archive@example.com", "now": "2026-01-01 00:00:00"},
    )
    workspace_id = str(uuid.uuid4())
    conn.execute(
        text(
            "INSERT INTO workspaces (id, owner_user_id, name, cwd, layout, position,"
            " created_at, updated_at)"
            " VALUES (:id, :owner, 'before', '/repo', :layout, 3, :now, :now)"
        ),
        {
            "id": workspace_id,
            "owner": USER_ID,
            "layout": json.dumps(LAYOUT),
            "now": "2026-01-01 00:00:00",
        },
    )
    return workspace_id


def _row(conn, workspace_id: str, columns: str):
    return conn.execute(
        text(f"SELECT {columns} FROM workspaces WHERE id = :id"), {"id": workspace_id}
    ).one()


def test_0038_adds_nullable_archive_columns_without_touching_existing_rows(tmp_path: Path):
    db_path = tmp_path / "spawn-archive.db"
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0037"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            workspace_id = _seed(conn)
            assert "archived_at" not in {c["name"] for c in inspect(conn).get_columns("workspaces")}
    finally:
        engine.dispose()

    _alembic(["upgrade", "head"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            columns = {c["name"] for c in inspect(conn).get_columns("workspaces")}
            assert "archived_at" in columns
            # 0040 took the snapshot column away again: an archived workspace
            # keeps its own layout now, so there is nothing to snapshot.
            assert "archived_shape" not in columns
            name, cwd, layout, position, archived_at = _row(
                conn,
                workspace_id,
                "name, cwd, layout, position, archived_at",
            )
            # Everything that was there is still there, and the workspace is
            # active — nothing is archived by the act of making archiving possible.
            assert (name, cwd, position) == ("before", "/repo", 3)
            assert json.loads(layout) == LAYOUT
            assert archived_at is None
    finally:
        engine.dispose()


def test_0038_downgrade_drops_the_columns_and_keeps_the_workspaces(tmp_path: Path):
    db_path = tmp_path / "spawn-archive-down.db"
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0037"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            workspace_id = _seed(conn)
    finally:
        engine.dispose()

    _alembic(["upgrade", "head"], env=env)
    # An archived workspace on a database that is about to roll back: the
    # columns go, the workspace stays. It comes back as an ordinary row.
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE workspaces SET archived_at = :now WHERE id = :id"),
                {"now": "2026-02-01 00:00:00", "id": workspace_id},
            )
    finally:
        engine.dispose()

    _alembic(["downgrade", "0037"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            columns = {c["name"] for c in inspect(conn).get_columns("workspaces")}
            assert "archived_at" not in columns
            assert "archived_shape" not in columns
            name, layout = _row(conn, workspace_id, "name, layout")
            assert name == "before"
            assert json.loads(layout) == LAYOUT
    finally:
        engine.dispose()
