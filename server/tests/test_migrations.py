"""Alembic migration smoke tests.

Most API tests use `Base.metadata.create_all` for speed. These tests exercise
the migration path used by deploy, then verify the migrated schema still
matches the ORM surface that the app expects.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text

from spawn_server.db import Base

SERVER_ROOT = Path(__file__).resolve().parents[1]


def _current_migration_head() -> str:
    config = Config()
    config.set_main_option("script_location", str(SERVER_ROOT / "alembic"))
    return ScriptDirectory.from_config(config).get_current_head()


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


def _run_python(args: list[str], *, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, *args],
        cwd=SERVER_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=True,
    )


def test_alembic_upgrade_head_matches_current_orm_schema_and_startup_seed(tmp_path: Path):
    db_path = tmp_path / "spawn-migrations.db"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    sync_url = f"sqlite:///{db_path}"
    env = _migration_env(async_url)

    _run_python(["-m", "alembic", "upgrade", "head"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
        expected_tables = set(Base.metadata.tables)
        assert expected_tables <= tables

        for table_name, table in Base.metadata.tables.items():
            migrated_columns = {column["name"] for column in inspector.get_columns(table_name)}
            orm_columns = {column.name for column in table.columns}
            assert orm_columns <= migrated_columns, table_name

        host_uniques = {
            constraint["name"] for constraint in inspector.get_unique_constraints("hosts")
        }
        device_uniques = {
            constraint["name"] for constraint in inspector.get_unique_constraints("device_codes")
        }
        assert "uq_hosts_host_public_key" in host_uniques
        assert "uq_device_codes_host_public_key" in device_uniques

        with engine.begin() as conn:
            version = conn.execute(text("select version_num from alembic_version")).scalar_one()
            assert version == _current_migration_head()

            preset_rows = conn.execute(
                text("select name, default_argv, install from presets")
            ).mappings()
            presets = {row["name"]: row for row in preset_rows}
            assert {"claude-code", "codex", "opencode", "aider-sonnet", "shell"} <= set(presets)
            assert json.loads(presets["codex"]["default_argv"]) == ["codex"]
            assert presets["codex"]["install"] is None
            conn.execute(
                text(
                    "update presets set install = 'npm install -g @openai/codex' "
                    "where owner_user_id is null and name = 'codex'"
                )
            )
    finally:
        engine.dispose()

    # App startup runs this seed hook after migrations. Prove it can load the
    # migrated rows and backfill fields added after the initial preset seed.
    seed_code = """
import asyncio

from spawn_server.db import dispose_engine, get_sessionmaker, init_engine
from spawn_server.presets import seed_builtin_presets

async def main():
    init_engine()
    async with get_sessionmaker()() as session:
        await seed_builtin_presets(session)
    await dispose_engine()

asyncio.run(main())
"""
    _run_python(["-c", seed_code], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            install = conn.execute(
                text("select install from presets where owner_user_id is null and name = 'codex'")
            ).scalar_one()
            assert (
                install
                == "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh"
            )
            count = conn.execute(
                text("select count(*) from presets where owner_user_id is null")
            ).scalar_one()
            assert count == 5
    finally:
        engine.dispose()


def test_host_identity_migration_preserves_legacy_rows_as_explicitly_unpaired(tmp_path: Path):
    db_path = tmp_path / "spawn-host-identity-migration.db"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    sync_url = f"sqlite:///{db_path}"
    env = _migration_env(async_url)
    _run_python(["-m", "alembic", "upgrade", "0016"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "insert into users (id, email, password_hash, created_at) "
                    "values ('user', 'legacy@example.com', 'hash', '2026-07-17')"
                )
            )
            conn.execute(
                text(
                    "insert into hosts (id, owner_user_id, name, status, created_at) "
                    "values ('host', 'user', 'legacy', 'offline', '2026-07-17')"
                )
            )
            conn.execute(
                text(
                    "insert into device_codes "
                    "(device_code, user_code, host_name, status, expires_at, created_at) "
                    "values ('device', 'OLD1-CODE', 'legacy', 'pending', "
                    "'2026-07-18', '2026-07-17')"
                )
            )
    finally:
        engine.dispose()

    _run_python(["-m", "alembic", "upgrade", "head"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            host = conn.execute(
                text("select host_key_algorithm, host_public_key from hosts where id = 'host'")
            ).one()
            device = conn.execute(
                text(
                    "select host_key_algorithm, host_public_key "
                    "from device_codes where device_code = 'device'"
                )
            ).one()
            assert host == (None, None)
            assert device == (None, None)
    finally:
        engine.dispose()
