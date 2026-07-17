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

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

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


POSTGRES_RESET_CODE = """
import asyncio
from sqlalchemy import text
import spawn_server.models  # noqa: F401
from spawn_server.db import Base, dispose_engine, get_engine, init_engine

async def main():
    init_engine()
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.execute(text("drop table if exists alembic_version"))
    await dispose_engine()

asyncio.run(main())
"""

POSTGRES_BINDING_CONSTRAINT_CODE = """
import asyncio
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from spawn_server.db import dispose_engine, get_engine, init_engine

INSERT = text(
    "insert into device_codes "
    "(device_code, user_code, host_name, approval_nonce, browser_device_id, "
    "browser_key_algorithm, browser_public_key, browser_key_fingerprint, status, "
    "expires_at, created_at) values "
    "(:device_code, :user_code, 'binding', :nonce, :browser_device_id, "
    ":browser_key_algorithm, :browser_public_key, :browser_key_fingerprint, "
    "'pending', '2026-07-18', '2026-07-17')"
)
FULL = {
    "browser_device_id": "00000000-0000-4000-8000-000000000099",
    "browser_key_algorithm": "ed25519",
    "browser_public_key": "C" * 43,
    "browser_key_fingerprint": "SHA256:" + "D" * 16,
}

async def expect_rejected(engine, values):
    try:
        async with engine.begin() as conn:
            await conn.execute(INSERT, values)
    except IntegrityError:
        return
    raise AssertionError(f"browser binding constraint accepted {values!r}")

async def main():
    init_engine()
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(text(
            "insert into users (id, email, password_hash, created_at) values "
            "('00000000-0000-4000-8000-000000000001', "
            "'binding@example.com', 'hash', '2026-07-17')"
        ))
        await conn.execute(text(
            "insert into browser_devices "
            "(id, owner_user_id, key_algorithm, public_key, created_at) values "
            "(:id, '00000000-0000-4000-8000-000000000001', "
            "'ed25519', :public_key, '2026-07-17')"
        ), {"id": FULL["browser_device_id"], "public_key": FULL["browser_public_key"]})
        for index, binding in enumerate(({field: None for field in FULL}, FULL)):
            await conn.execute(INSERT, {
                "device_code": f"pg-valid-{index}", "user_code": f"PGVL-000{index}",
                "nonce": "E" * 43, **binding,
            })

    for mask in range(1, (1 << len(FULL)) - 1):
        binding = {
            field: value if mask & (1 << index) else None
            for index, (field, value) in enumerate(FULL.items())
        }
        await expect_rejected(engine, {
            "device_code": f"pg-partial-{mask}", "user_code": f"PGPT-{mask:04d}",
            "nonce": "F" * 43, **binding,
        })
    for index, binding in enumerate((
        {**FULL, "browser_key_algorithm": "rsa"},
        {**FULL, "browser_public_key": "C" * 42},
        {**FULL, "browser_key_fingerprint": "SHA256:" + "D" * 15},
    )):
        await expect_rejected(engine, {
            "device_code": f"pg-invalid-{index}", "user_code": f"PGIV-000{index}",
            "nonce": "G" * 43, **binding,
        })
    await dispose_engine()

asyncio.run(main())
"""


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
        browser_device_uniques = {
            constraint["name"]
            for constraint in inspector.get_unique_constraints("browser_devices")
        }
        assert "uq_hosts_host_public_key" in host_uniques
        assert "uq_device_codes_host_public_key" not in device_uniques
        assert "uq_browser_devices_public_key" in browser_device_uniques
        device_indexes = {index["name"] for index in inspector.get_indexes("device_codes")}
        assert "ix_device_codes_host_key" in device_indexes
        device_checks = {
            constraint["name"] for constraint in inspector.get_check_constraints("device_codes")
        }
        pin_checks = {
            constraint["name"]
            for constraint in inspector.get_check_constraints("host_browser_pins")
        }
        assert "ck_device_codes_approval_nonce" in device_checks
        assert "ck_device_codes_browser_binding" in device_checks
        assert "ck_host_browser_pins_key" in pin_checks
        assert inspector.get_pk_constraint("host_browser_pins")["constrained_columns"] == [
            "host_id",
            "browser_device_id",
        ]
        assert inspector.get_pk_constraint("host_key_claims")["constrained_columns"] == [
            "host_key_algorithm",
            "host_public_key",
        ]
        claim_checks = {
            constraint["name"]
            for constraint in inspector.get_check_constraints("host_key_claims")
        }
        assert "ck_host_key_claims_ed25519_key" in claim_checks

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


def test_host_key_claim_migration_backfills_and_downgrades_fail_closed(tmp_path: Path):
    db_path = tmp_path / "spawn-host-key-claim-migration.db"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    sync_url = f"sqlite:///{db_path}"
    env = _migration_env(async_url)
    public_key = "A" * 43
    _run_python(["-m", "alembic", "upgrade", "0019"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "insert into users (id, email, password_hash, created_at) "
                    "values ('claim-owner', 'claim-owner@example.com', 'hash', '2026-07-17')"
                )
            )
            conn.execute(
                text(
                    "insert into hosts "
                    "(id, owner_user_id, name, host_key_algorithm, host_public_key, "
                    "status, created_at) values "
                    "('claimed-host', 'claim-owner', 'claimed', 'ed25519', :key, "
                    "'offline', '2026-07-17')"
                ),
                {"key": public_key},
            )
    finally:
        engine.dispose()

    _run_python(["-m", "alembic", "upgrade", "head"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            claim = conn.execute(
                text(
                    "select host_key_algorithm, host_public_key, owner_user_id, created_at "
                    "from host_key_claims"
                )
            ).one()
            assert claim[:3] == ("ed25519", public_key, "claim-owner")
            assert str(claim.created_at).startswith("2026-07-17")
    finally:
        engine.dispose()

    # A clean downgrade/re-upgrade is deterministic while every claim is still
    # represented by its live Host and can therefore be backfilled again.
    _run_python(["-m", "alembic", "downgrade", "0019"], env=env)
    _run_python(["-m", "alembic", "upgrade", "head"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            conn.execute(text("delete from hosts where id = 'claimed-host'"))
            retained = conn.execute(
                text("select owner_user_id from host_key_claims where host_public_key = :key"),
                {"key": public_key},
            ).scalar_one()
            assert retained == "claim-owner"
    finally:
        engine.dispose()

    with pytest.raises(subprocess.CalledProcessError) as exc_info:
        _run_python(["-m", "alembic", "downgrade", "0019"], env=env)
    assert "cannot downgrade 0020 while retained host key ownership claims exist" in (
        exc_info.value.stderr
    )

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            assert conn.execute(text("select version_num from alembic_version")).scalar_one() == (
                "0020"
            )
            assert conn.execute(
                text("select owner_user_id from host_key_claims where host_public_key = :key"),
                {"key": public_key},
            ).scalar_one() == "claim-owner"
    finally:
        engine.dispose()


def test_browser_pair_migration_preserves_interrupted_codes_as_explicitly_unapproved(
    tmp_path: Path,
):
    db_path = tmp_path / "spawn-browser-pair-migration.db"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    sync_url = f"sqlite:///{db_path}"
    env = _migration_env(async_url)
    _run_python(["-m", "alembic", "upgrade", "0018"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "insert into device_codes "
                    "(device_code, user_code, host_name, host_key_algorithm, host_public_key, "
                    "status, expires_at, created_at) values "
                    "('interrupted', 'PAIR-OLD1', 'legacy', 'ed25519', :key, "
                    "'pending', '2026-07-18', '2026-07-17')"
                ),
                {"key": "A" * 43},
            )
    finally:
        engine.dispose()

    _run_python(["-m", "alembic", "upgrade", "head"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            row = conn.execute(
                text(
                    "select approval_nonce, browser_device_id, browser_key_algorithm, "
                    "browser_public_key, browser_key_fingerprint from device_codes "
                    "where device_code = 'interrupted'"
                )
            ).one()
            assert row == (None, None, None, None, None)
            assert conn.execute(text("select count(*) from host_browser_pins")).scalar_one() == 0
    finally:
        engine.dispose()


def test_browser_pair_downgrade_reconciles_duplicate_ephemeral_codes_and_reupgrades(
    tmp_path: Path,
):
    db_path = tmp_path / "spawn-browser-pair-downgrade.db"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    sync_url = f"sqlite:///{db_path}"
    env = _migration_env(async_url)
    _run_python(["-m", "alembic", "upgrade", "head"], env=env)

    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            for device_code, user_code in (
                ("z-duplicate", "DOWN-Z001"),
                ("a-survivor", "DOWN-A001"),
            ):
                conn.execute(
                    text(
                        "insert into device_codes "
                        "(device_code, user_code, host_name, host_key_algorithm, "
                        "host_public_key, approval_nonce, status, expires_at, created_at) "
                        "values (:device_code, :user_code, 'duplicate', 'ed25519', :key, "
                        ":nonce, 'pending', '2026-07-18', '2026-07-17')"
                    ),
                    {
                        "device_code": device_code,
                        "user_code": user_code,
                        "key": "A" * 43,
                        "nonce": "B" * 43,
                    },
                )
    finally:
        engine.dispose()

    _run_python(["-m", "alembic", "downgrade", "0018"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        assert {
            constraint["name"]
            for constraint in inspect(engine).get_unique_constraints("device_codes")
        } >= {"uq_device_codes_host_public_key"}
        with engine.begin() as conn:
            survivors = conn.execute(
                text(
                    "select device_code from device_codes "
                    "where host_public_key = :key order by device_code"
                ),
                {"key": "A" * 43},
            ).scalars().all()
            assert survivors == ["a-survivor"]
    finally:
        engine.dispose()

    _run_python(["-m", "alembic", "upgrade", "head"], env=env)
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            survivor = conn.execute(
                text(
                    "select device_code, approval_nonce, browser_device_id, "
                    "browser_key_algorithm, browser_public_key, browser_key_fingerprint "
                    "from device_codes where host_public_key = :key"
                ),
                {"key": "A" * 43},
            ).one()
            assert survivor == ("a-survivor", None, None, None, None, None)
    finally:
        engine.dispose()


def test_browser_pair_migration_rejects_every_partial_browser_binding(tmp_path: Path):
    db_path = tmp_path / "spawn-browser-binding-constraint.db"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    sync_url = f"sqlite:///{db_path}"
    _run_python(["-m", "alembic", "upgrade", "head"], env=_migration_env(async_url))
    engine = create_engine(sync_url, future=True)
    insert = text(
        "insert into device_codes "
        "(device_code, user_code, host_name, approval_nonce, browser_device_id, "
        "browser_key_algorithm, browser_public_key, browser_key_fingerprint, status, "
        "expires_at, created_at) values "
        "(:device_code, :user_code, 'binding', :nonce, :browser_device_id, "
        ":browser_key_algorithm, :browser_public_key, :browser_key_fingerprint, "
        "'pending', '2026-07-18', '2026-07-17')"
    )
    full = {
        "browser_device_id": "00000000-0000-4000-8000-000000000099",
        "browser_key_algorithm": "ed25519",
        "browser_public_key": "C" * 43,
        "browser_key_fingerprint": "SHA256:" + "D" * 16,
    }
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "insert into users (id, email, password_hash, created_at) values "
                    "('00000000-0000-4000-8000-000000000001', "
                    "'binding@example.com', 'hash', '2026-07-17')"
                )
            )
            conn.execute(
                text(
                    "insert into browser_devices "
                    "(id, owner_user_id, key_algorithm, public_key, created_at) values "
                    "(:id, '00000000-0000-4000-8000-000000000001', "
                    "'ed25519', :public_key, '2026-07-17')"
                ),
                {"id": full["browser_device_id"], "public_key": full["browser_public_key"]},
            )
            for index, binding in enumerate(({field: None for field in full}, full)):
                conn.execute(
                    insert,
                    {
                        "device_code": f"valid-{index}",
                        "user_code": f"VALD-000{index}",
                        "nonce": "E" * 43,
                        **binding,
                    },
                )

        for mask in range(1, (1 << len(full)) - 1):
            binding = {
                field: value if mask & (1 << index) else None
                for index, (field, value) in enumerate(full.items())
            }
            with pytest.raises(IntegrityError):
                with engine.begin() as conn:
                    conn.execute(
                        insert,
                        {
                            "device_code": f"partial-{mask}",
                            "user_code": f"PART-{mask:04d}",
                            "nonce": "F" * 43,
                            **binding,
                        },
                    )

        for index, binding in enumerate(
            (
                {**full, "browser_key_algorithm": "rsa"},
                {**full, "browser_public_key": "C" * 42},
                {**full, "browser_key_fingerprint": "SHA256:" + "D" * 15},
            )
        ):
            with pytest.raises(IntegrityError):
                with engine.begin() as conn:
                    conn.execute(
                        insert,
                        {
                            "device_code": f"invalid-{index}",
                            "user_code": f"INVL-000{index}",
                            "nonce": "G" * 43,
                            **binding,
                        },
                    )
    finally:
        engine.dispose()


@pytest.mark.skipif(
    os.environ.get("SPAWN_TEST_EXTERNAL_SERVICES") != "1",
    reason="requires a disposable PostgreSQL test database",
)
def test_postgresql_browser_pair_downgrade_reconciles_duplicates_and_reupgrades():
    database_url = os.environ["SPAWN_DATABASE_URL"]
    assert database_url.startswith("postgresql+asyncpg://")
    env = _migration_env(database_url)
    insert_code = """
import asyncio
from sqlalchemy import text
from spawn_server.db import dispose_engine, get_engine, init_engine

async def main():
    init_engine()
    engine = get_engine()
    async with engine.begin() as conn:
        for device_code, user_code in (("z-duplicate", "PGDN-Z001"), ("a-survivor", "PGDN-A001")):
            await conn.execute(text(
                "insert into device_codes "
                "(device_code, user_code, host_name, host_key_algorithm, host_public_key, "
                "approval_nonce, status, expires_at, created_at) values "
                "(:device_code, :user_code, 'duplicate', 'ed25519', :key, :nonce, "
                "'pending', '2026-07-18', '2026-07-17')"
            ), {"device_code": device_code, "user_code": user_code, "key": "A" * 43, "nonce": "B" * 43})
    await dispose_engine()

asyncio.run(main())
"""
    inspect_0018_code = """
import asyncio
import json
from sqlalchemy import text
from spawn_server.db import dispose_engine, get_engine, init_engine

async def main():
    init_engine()
    engine = get_engine()
    async with engine.connect() as conn:
        rows = (await conn.execute(text(
            "select device_code from device_codes where host_public_key = :key order by device_code"
        ), {"key": "A" * 43})).scalars().all()
        constraints = (await conn.execute(text(
            "select conname from pg_constraint where conrelid = 'device_codes'::regclass "
            "and contype = 'u' order by conname"
        ))).scalars().all()
    print(json.dumps({"rows": rows, "constraints": constraints}))
    await dispose_engine()

asyncio.run(main())
"""
    inspect_0019_code = """
import asyncio
import json
from sqlalchemy import text
from spawn_server.db import dispose_engine, get_engine, init_engine

async def main():
    init_engine()
    engine = get_engine()
    async with engine.connect() as conn:
        row = (await conn.execute(text(
            "select device_code, approval_nonce, browser_device_id, browser_key_algorithm, "
            "browser_public_key, browser_key_fingerprint from device_codes "
            "where host_public_key = :key"
        ), {"key": "A" * 43})).one()
    print(json.dumps(list(row)))
    await dispose_engine()

asyncio.run(main())
"""

    _run_python(["-c", POSTGRES_RESET_CODE], env=env)
    try:
        _run_python(["-m", "alembic", "upgrade", "head"], env=env)
        _run_python(["-c", POSTGRES_BINDING_CONSTRAINT_CODE], env=env)
        _run_python(["-c", insert_code], env=env)
        _run_python(["-m", "alembic", "downgrade", "0018"], env=env)
        downgraded = json.loads(_run_python(["-c", inspect_0018_code], env=env).stdout)
        assert downgraded["rows"] == ["a-survivor"]
        assert "uq_device_codes_host_public_key" in downgraded["constraints"]

        _run_python(["-m", "alembic", "upgrade", "head"], env=env)
        reupgraded = json.loads(_run_python(["-c", inspect_0019_code], env=env).stdout)
        assert reupgraded == ["a-survivor", None, None, None, None, None]
    finally:
        _run_python(["-c", POSTGRES_RESET_CODE], env=env)


def test_host_identity_migration_rejects_both_partial_null_key_permutations(tmp_path: Path):
    db_path = tmp_path / "spawn-host-identity-partial-null.db"
    async_url = f"sqlite+aiosqlite:///{db_path}"
    sync_url = f"sqlite:///{db_path}"
    _run_python(["-m", "alembic", "upgrade", "head"], env=_migration_env(async_url))

    public_key = "A" * 43
    engine = create_engine(sync_url, future=True)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "insert into users (id, email, password_hash, created_at) "
                    "values ('partial-owner', 'partial@example.com', 'hash', '2026-07-17')"
                )
            )

        cases = [
            (
                "insert into hosts "
                "(id, owner_user_id, name, host_key_algorithm, host_public_key, status, "
                "daemon_generation, daemon_generation_counter, created_at) "
                "values ('host-algorithm-only', 'partial-owner', 'partial', 'ed25519', NULL, "
                "'offline', 0, 0, '2026-07-17')",
                {},
            ),
            (
                "insert into hosts "
                "(id, owner_user_id, name, host_key_algorithm, host_public_key, status, "
                "daemon_generation, daemon_generation_counter, created_at) "
                "values ('host-key-only', 'partial-owner', 'partial', NULL, :public_key, "
                "'offline', 0, 0, '2026-07-17')",
                {"public_key": public_key},
            ),
            (
                "insert into device_codes "
                "(device_code, user_code, host_name, host_key_algorithm, host_public_key, "
                "status, expires_at, created_at) "
                "values ('device-algorithm-only', 'ALG1-ONLY', 'partial', 'ed25519', NULL, "
                "'pending', '2026-07-18', '2026-07-17')",
                {},
            ),
            (
                "insert into device_codes "
                "(device_code, user_code, host_name, host_key_algorithm, host_public_key, "
                "status, expires_at, created_at) "
                "values ('device-key-only', 'KEY1-ONLY', 'partial', NULL, :public_key, "
                "'pending', '2026-07-18', '2026-07-17')",
                {"public_key": public_key},
            ),
        ]
        for statement, parameters in cases:
            with pytest.raises(IntegrityError):
                with engine.begin() as conn:
                    conn.execute(text(statement), parameters)
    finally:
        engine.dispose()
