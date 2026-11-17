"""The registration mark is one nullable column on the existing table."""

import io
import uuid

import pytest
import sqlalchemy as sa
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alembic.script import ScriptDirectory

from tests.test_migrations import _migration_env, _run_python


@pytest.mark.parametrize(
    ("dialect", "column_type"),
    [("sqlite", "DATETIME"), ("postgresql", "TIMESTAMP WITH TIME ZONE")],
)
def test_0073_ddl(dialect, column_type):
    revision = ScriptDirectory.from_config(Config("alembic.ini")).get_revision("0073")
    assert revision.down_revision == "0072"
    output = io.StringIO()
    ctx = MigrationContext.configure(
        url=f"{dialect}://", opts={"as_sql": True, "output_buffer": output}
    )
    with Operations.context(ctx):
        revision.module.upgrade()
        revision.module.downgrade()
    assert (
        output.getvalue().split()
        == (
            f"ALTER TABLE sessions ADD COLUMN ended_by_host_restart_at {column_type}; "
            "ALTER TABLE sessions DROP COLUMN ended_by_host_restart_at;"
        ).split()
    )


def test_0073_preserves_existing_rows_in_place(tmp_path):
    path = tmp_path / "migration.db"
    env = _migration_env(f"sqlite+aiosqlite:///{path}")
    _run_python(["-m", "alembic", "upgrade", "0072"], env=env)
    engine = sa.create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as conn:
            conn.exec_driver_sql("PRAGMA foreign_keys=ON")
            owner, host, sid = (str(uuid.uuid4()) for _ in range(3))
            conn.exec_driver_sql(
                "INSERT INTO users(id, email, password_hash, created_at) VALUES (?, ?, '', CURRENT_TIMESTAMP)",
                (owner, uuid.uuid4().hex),
            )
            conn.exec_driver_sql(
                "INSERT INTO hosts(id, owner_user_id, name, created_at) VALUES (?, ?, '', CURRENT_TIMESTAMP)",
                (host, owner),
            )
            conn.exec_driver_sql(
                "INSERT INTO sessions(id, owner_user_id, host_id, cwd, status, started_at) "
                "VALUES (?, ?, ?, '/', 'running', CURRENT_TIMESTAMP)",
                (sid, owner, host),
            )
            root_page = conn.exec_driver_sql(
                "SELECT rootpage FROM sqlite_master WHERE name='sessions'"
            ).scalar_one()
            before = conn.exec_driver_sql("SELECT * FROM sessions").one()
        _run_python(["-m", "alembic", "upgrade", "0073"], env=env)
        with engine.connect() as conn:
            assert conn.exec_driver_sql("SELECT * FROM sessions").one() == (*before, None)
            assert (
                conn.exec_driver_sql(
                    "SELECT rootpage FROM sqlite_master WHERE name='sessions'"
                ).scalar_one()
                == root_page
            )
        _run_python(["-m", "alembic", "downgrade", "0072"], env=env)
        with engine.connect() as conn:
            assert conn.exec_driver_sql("SELECT * FROM sessions").one() == before
    finally:
        engine.dispose()
