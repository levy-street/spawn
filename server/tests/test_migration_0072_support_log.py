"""Additive SQLite round trip and PostgreSQL DDL without any network service."""

from __future__ import annotations

import importlib.util
import io
import uuid
from datetime import UTC, datetime
from pathlib import Path

import sqlalchemy as sa
from alembic.migration import MigrationContext
from alembic.operations import Operations

from tests.test_migrations import _migration_env, _run_python


def test_0072_upgrade_downgrade_and_foreign_keys(tmp_path):
    path = tmp_path / "migration.db"
    env = _migration_env(f"sqlite+aiosqlite:///{path}")
    _run_python(["-m", "alembic", "upgrade", "0071"], env=env)
    user_id, host_id, device_id, record_id = (str(uuid.uuid4()) for _ in range(4))
    survivor, survivor_host = str(uuid.uuid4()), str(uuid.uuid4())
    now = datetime.now(UTC)
    engine = sa.create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as conn:
            conn.execute(
                sa.text(
                    "INSERT INTO users (id,email,password_hash,created_at) "
                    "VALUES (:id,:email,'unused',:now)"
                ),
                dict(id=user_id, email=uuid.uuid4().hex, now=now),
            )
            conn.execute(
                sa.text(
                    "INSERT INTO hosts (id,owner_user_id,name,created_at) "
                    "VALUES (:id,:owner,'',:now)"
                ),
                dict(id=host_id, owner=user_id, now=now),
            )
            conn.execute(
                sa.text(
                    "INSERT INTO users (id,email,password_hash,created_at) "
                    "VALUES (:id,:email,'unused',:now)"
                ),
                dict(id=survivor, email=uuid.uuid4().hex, now=now),
            )
            conn.execute(
                sa.text(
                    "INSERT INTO hosts (id,owner_user_id,name,created_at) "
                    "VALUES (:id,:owner,'',:now)"
                ),
                dict(id=survivor_host, owner=survivor, now=now),
            )
        _run_python(["-m", "alembic", "upgrade", "0072"], env=env)
        with engine.begin() as conn:
            conn.execute(sa.text("PRAGMA foreign_keys=ON"))
            assert not any(conn.execute(sa.text("SELECT support_log_capable FROM hosts")).scalars())
            metadata = sa.MetaData()
            metadata.reflect(conn)
            devices = metadata.tables["browser_devices"]
            consents = metadata.tables["support_log_consents"]
            collections = metadata.tables["support_log_collections"]
            from tests.test_support_consent import VECTORS

            signed = VECTORS["positive"][0]["consent"]
            conn.execute(
                devices.insert().values(
                    id=device_id,
                    owner_user_id=user_id,
                    key_algorithm="ed25519",
                    public_key=signed["signer_public_key"],
                    created_at=now,
                )
            )
            conn.execute(
                consents.insert().values(
                    owner_user_id=user_id,
                    enabled=False,
                    issued_at_ms="18446744073709551615",
                    signer_device_id=device_id,
                    signed_device_id=device_id,
                    signer_public_key=signed["signer_public_key"],
                    signature=signed["signature"],
                    carried_endorsements=[],
                    updated_at=now,
                )
            )
            conn.execute(
                collections.insert().values(
                    id=record_id,
                    owner_user_id=user_id,
                    host_id=host_id,
                    host_name="",
                    state="requested",
                    reason="Connection diagnosis",
                    requested_by="operator",
                    window_seconds=60,
                    requested_at=now,
                )
            )
            conn.execute(devices.delete())
            stored = conn.execute(sa.select(consents)).mappings().one()
            assert stored["signer_device_id"] is None and stored["signed_device_id"] == device_id
            assert stored["issued_at_ms"] == "18446744073709551615"
            conn.execute(
                metadata.tables["hosts"].delete().where(metadata.tables["hosts"].c.id == host_id)
            )
            assert conn.execute(sa.select(collections.c.host_id)).scalar_one() is None
            conn.execute(
                metadata.tables["users"].delete().where(metadata.tables["users"].c.id == user_id)
            )
            assert conn.execute(sa.select(consents)).first() is None
            assert conn.execute(sa.select(collections)).first() is None
        _run_python(["-m", "alembic", "downgrade", "0071"], env=env)
        with engine.connect() as conn:
            assert conn.execute(sa.text("SELECT id FROM hosts")).scalar_one() == survivor_host
            assert conn.execute(sa.text("SELECT id FROM users")).scalar_one() == survivor
        inspector = sa.inspect(engine)
        assert "support_log_consents" not in inspector.get_table_names()
        assert "support_log_collections" not in inspector.get_table_names()
        assert "support_log_capable" not in {c["name"] for c in inspector.get_columns("hosts")}
    finally:
        engine.dispose()


def test_0072_postgres_ddl_offline():
    path = Path(__file__).resolve().parents[1] / "alembic/versions/0072_support_log_store.py"
    spec = importlib.util.spec_from_file_location("support_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    output = io.StringIO()
    context = MigrationContext.configure(
        url="postgresql://",
        opts={
            "as_sql": True,
            "output_buffer": output,
        },
    )
    with Operations.context(context):
        migration.upgrade()
        migration.downgrade()
    ddl = output.getvalue()
    assert "support_log_capable BOOLEAN DEFAULT false NOT NULL" in ddl
    assert "ON DELETE CASCADE" in ddl and "ON DELETE SET NULL" in ddl
    assert "DROP TABLE support_log_collections" in ddl
    assert "DROP COLUMN support_log_capable" in ddl
