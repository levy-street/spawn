"""Migration 0039 (per-tab host/folder) backfills without rewriting the rest.

A tab's own default host/folder is where a window added to it opens; absent,
the tab inherits the workspace's home. The migration's whole job is to give
existing tabs the folder their windows have actually been opening in — the
first session in the tab — and to leave every other tab byte-for-byte alone,
because an absent pair already means the right thing.

Pinned to revision 0039 rather than head: later migrations reshape the
workspaces table around it, and what is under test here is this step.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from sqlalchemy import create_engine, text

from tests.test_migrations_overhaul import _alembic, _migration_env

USER_ID = "33333333-3333-4333-8333-333333333333"
HOST_ID = "44444444-4444-4444-8444-444444444444"
SESSION_ID = "55555555-5555-4555-8555-555555555555"
NOW = "2026-01-01 00:00:00"


def _tab(tab_id: str, name: str, tiles: list[dict]) -> dict:
    return {"id": tab_id, "name": name, "layout": {"version": 3, "tiles": tiles}}


def _tile(session_id: str, x: int) -> dict:
    return {"session_id": session_id, "x": x, "y": 0, "w": 12, "h": 24}


LAYOUT = {
    "version": 3,
    "active_tab": "tab-1",
    "tabs": [
        # Reading order picks the left tile, not the first one listed.
        _tab("tab-1", "Tab 1", [_tile("ghost", 12), _tile(SESSION_ID, 0)]),
        # Nothing to inherit from: this tab must come out untouched.
        _tab("tab-2", "Tab 2", []),
    ],
}
def _seed(conn) -> str:
    conn.execute(
        text(
            "INSERT INTO users (id, email, password_hash, created_at)"
            " VALUES (:id, :email, 'x', :now)"
        ),
        {"id": USER_ID, "email": "tabfolder@example.com", "now": NOW},
    )
    conn.execute(
        text(
            "INSERT INTO hosts (id, owner_user_id, name, status, created_at,"
            " daemon_generation, daemon_generation_counter)"
            " VALUES (:id, :owner, 'Mac', 'online', :now, 0, 0)"
        ),
        {"id": HOST_ID, "owner": USER_ID, "now": NOW},
    )
    conn.execute(
        text(
            "INSERT INTO sessions (id, owner_user_id, host_id, cwd, status, started_at)"
            " VALUES (:id, :owner, :host, '/repo/live', 'running', :now)"
        ),
        {"id": SESSION_ID, "owner": USER_ID, "host": HOST_ID, "now": NOW},
    )
    live = str(uuid.uuid4())
    conn.execute(
        text(
            "INSERT INTO workspaces (id, owner_user_id, name, layout, position,"
            " created_at, updated_at)"
            " VALUES (:id, :owner, 'live', :layout, 0, :now, :now)"
        ),
        {"id": live, "owner": USER_ID, "layout": json.dumps(LAYOUT), "now": NOW},
    )
    return live


def _layout(conn, workspace_id: str) -> dict:
    raw = conn.execute(
        text("SELECT layout FROM workspaces WHERE id = :id"), {"id": workspace_id}
    ).scalar_one()
    return json.loads(raw)


def test_0039_backfills_tab_folders_from_the_first_session(tmp_path: Path):
    db_path = tmp_path / "spawn-tab-folder.db"
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0038"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            live = _seed(conn)
    finally:
        engine.dispose()

    _alembic(["upgrade", "0039"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            tabs = _layout(conn, live)["tabs"]
            assert (tabs[0]["host_id"], tabs[0]["cwd"]) == (HOST_ID, "/repo/live")
            # An empty tab gains nothing, so it is left exactly as it was.
            assert tabs[1] == _tab("tab-2", "Tab 2", [])
    finally:
        engine.dispose()


def test_0039_downgrade_strips_the_pair_and_keeps_everything_else(tmp_path: Path):
    db_path = tmp_path / "spawn-tab-folder-down.db"
    env = _migration_env(f"sqlite+aiosqlite:///{db_path}")
    sync_url = f"sqlite:///{db_path}"

    _alembic(["upgrade", "0038"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            live = _seed(conn)
    finally:
        engine.dispose()

    _alembic(["upgrade", "0039"], env=env)
    _alembic(["downgrade", "0038"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            # Back to the pre-0039 shape: same tabs, same tiles, no folder keys.
            assert _layout(conn, live) == LAYOUT
    finally:
        engine.dispose()
