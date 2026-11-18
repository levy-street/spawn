"""Operator commands use only the configured store and database."""

import hashlib
import json
import uuid
from datetime import timedelta

import pytest
from sqlalchemy import update

from spawn_server import support_log_cli as cli
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import BrowserDevice, Host, User, _utcnow
from spawn_server.support_consent import store_statement
from spawn_server.support_log import get_collection, mark_dispatched, transition
from spawn_server.support_log_files import prepare_store
from tests.test_support_consent import seed_statement, sign
from tests.test_support_log_dispatch import capable, history, request
from tests.test_support_log_registration import no_statements
from tests.test_support_log_retention import age_record
from tests.test_support_log_uploads import BODY


@pytest.fixture
async def configured(tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "support_log_dir", str(tmp_path / "bundles"))
    store = await prepare_store()
    store.close()


def collect(owner, host):
    return ["collect", "--account", owner, "--host", host, "--reason", "Connection diagnosis"]


async def output(argv, capsys, code=0):
    assert await cli.run([*argv, "--json"]) == code
    captured = capsys.readouterr()
    assert not captured.err
    result = json.loads(captured.out)
    assert isinstance(result, dict)
    if code:
        assert set(result) == {"error"}
    return result


@pytest.mark.parametrize("bad_directory", [True, False])
async def test_all_commands_when_storage_off_do_no_query(
    app, tmp_path, monkeypatch, capsys, bad_directory
):
    directory = tmp_path / "unusable"
    directory.touch()
    monkeypatch.setattr(
        get_settings(), "support_log_dir", str(directory) if bad_directory else None
    )
    for argv in [
        ["accounts"],
        collect("", "") + ["--by", "operator"],
        ["status", ""],
        ["list"],
        ["show", ""],
        ["purge"],
    ]:
        with no_statements():
            assert "storage" in (await output(argv, capsys, 8))["error"]


async def test_collect_usage_and_private_errors(app, configured, monkeypatch, capsys):
    monkeypatch.delenv("SPAWN_SUPPORT_LOG_BY", raising=False)
    for argv in [
        collect("", ""),
        ["collect", "--account", "", "--host", "", "--by", "operator"],
        collect("", "") + ["--by", "operator", "--reason", ""],
        collect("", "") + ["--by", "operator", "--reason", "x" * 201],
        collect("", "") + ["--by", "operator", "--wait", "-1"],
        collect("", "") + ["--by", "operator", "--hours", "nan"],
        collect("", "") + ["--by", "operator", "--hours", "73"],
        collect("", "") + ["--by", "operator", "--wait", "9" * 400],
    ]:
        with no_statements():
            assert (await output(argv, capsys, 2))["error"]
    value, key = await seed_statement(enabled=False)
    owner = value["account_id"]
    host = await capable(owner)
    monkeypatch.setenv("SPAWN_SUPPORT_LOG_BY", "operator")
    assert "off" in (await output(collect(owner, host), capsys, 3))["error"]
    await store_statement(owner, sign({**value, "issued_at_ms": 1001, "enabled": True}, key))
    other, _ = await seed_statement()
    foreign = await capable(other["account_id"])
    assert (await output(collect(owner, foreign), capsys, 4)) == (
        await output(collect(owner, str(uuid.uuid4())), capsys, 4)
    )
    # Both ids and names are scoped, and errors never echo lookup text.
    async with get_sessionmaker()() as db:
        foreign_name = (await db.get(Host, foreign)).name
        await db.execute(update(Host).where(Host.id == host).values(support_log_capable=False))
        await db.commit()
    assert foreign_name not in str(await output(collect(owner, foreign_name), capsys, 4))
    assert "capability" in (await output(collect(owner, host), capsys, 5))["error"]
    missing = f"{uuid.uuid4().hex}@{uuid.uuid4().hex}.invalid"
    assert await output(collect(missing, host), capsys, 9) == {"error": "No such account."}
    assert await output(["list", "--account", missing], capsys, 9) == {"error": "No such account."}
    assert "No such collection" in (await output(["status", missing], capsys, 9))["error"]


async def test_accounts_scope_and_minimum_fields(app, configured, capsys):
    value, _ = await seed_statement()
    owner = value["account_id"]
    capable_id = await capable(owner)
    no_hosts, _ = await seed_statement()
    removed, _ = await seed_statement()
    off, _ = await seed_statement(enabled=False)
    await capable(off["account_id"])
    async with get_sessionmaker()() as db:
        await db.execute(
            update(BrowserDevice)
            .where(BrowserDevice.id == removed["signer_device_id"])
            .values(revoked_at=_utcnow())
        )
        db.add(Host(owner_user_id=owner, name="", support_log_capable=False))
        await db.commit()
    result = await output(["accounts"], capsys)
    accounts = {account["id"]: account["hosts"] for account in result["accounts"]}
    assert accounts.keys() == {owner, no_hosts["account_id"]}
    assert accounts[no_hosts["account_id"]] == []
    assert len(accounts[owner]) == 2
    for host in accounts[owner]:
        assert set(host) == {"id", "name", "capable", "last_seen_at"}
        assert host["capable"] == (host["id"] == capable_id)
    assert all(
        secret not in json.dumps(result)
        for secret in (
            value["signature"],
            value["signer_public_key"],
            value["signer_device_id"],
        )
    )


async def test_collect_lookup_status_list_and_limits(app, configured, monkeypatch, capsys):
    value, _ = await seed_statement()
    owner = value["account_id"]
    host = await capable(owner)
    async with get_sessionmaker()() as db:
        user = await db.get(User, owner)
        user.email = f"{uuid.uuid4().hex}@{uuid.uuid4().hex}.invalid"
        name = (await db.get(Host, host)).name
        await db.commit()
    monkeypatch.setenv("SPAWN_SUPPORT_LOG_BY", "from environment")
    argv = collect(user.email.upper(), name)
    made = await output([*argv, "--hours", "72", "--by", "from argument"], capsys)
    record = await get_collection(made["id"])
    assert made["state"] == "requested" and record.host_id == host and record.host_name == name
    assert record.reason == argv[-1] and record.requested_by == "from argument"
    assert record.window_seconds == 259200
    assert (await output(["status", record.id], capsys)) == made
    assert "already open" in (await output(argv, capsys, 6))["error"]
    assert await mark_dispatched(record.id)
    assert await transition(record.id, "dispatched", "declined", decline_code="no_log")
    assert "five minutes" in (await output(argv, capsys, 7))["error"]
    assert (await output(["status", record.id], capsys))["decline_code"] == "no_log"
    other, _ = await seed_statement()
    elsewhere = await request(other["account_id"], await capable(other["account_id"]))
    older = await history(owner, host, "cancelled", _utcnow() - timedelta(days=8))
    listing = await output(["list", "--account", user.email], capsys)
    assert [row["id"] for row in listing["collections"]] == [record.id]
    listing = await output(["list", "--days", "9"], capsys)
    assert {row["id"] for row in listing["collections"]} == {record.id, older, elsewhere}
    assert await cli.run(["status", record.id]) == 0
    assert "declined (no_log)" in capsys.readouterr().out


@pytest.mark.parametrize("terminal", [True, False])
async def test_collect_wait_polls_until_terminal_or_deadline(
    app, configured, monkeypatch, capsys, terminal
):
    value, _ = await seed_statement()
    host = await capable(value["account_id"])
    monkeypatch.setenv("SPAWN_SUPPORT_LOG_BY", "from environment")
    original = cli.wait_for_record
    delays = []

    async def wait(record_id, seconds):
        assert seconds == 3

        async def tick(delay):
            delays.append(delay)
            if len(delays) == 1:
                assert await mark_dispatched(record_id)
            elif terminal:
                await transition(record_id, "dispatched", "declined", decline_code="no_log")

        return await original(record_id, seconds, clock=lambda: sum(delays), sleep=tick)

    monkeypatch.setattr(cli, "wait_for_record", wait)
    result = await output(
        collect(value["account_id"], host) + ["--wait", "3", "--hours", ".001"], capsys
    )
    assert result["state"] == ("declined" if terminal else "dispatched")
    assert delays == ([1, 1] if terminal else [1, 1, 1])
    record = await get_collection(result["id"])
    assert record.window_seconds == 60 and record.requested_by == "from environment"


async def test_show_checks_record_file_expiry_and_purge(app, configured, capsys):
    value, _ = await seed_statement()
    host = await capable(value["account_id"])
    queued = await request(value["account_id"], host)
    assert "No such collection" in (await output(["show", str(uuid.uuid4())], capsys, 9))["error"]
    assert "no collected bundle" in (await output(["show", queued], capsys, 9))["error"]
    now = _utcnow()
    assert await mark_dispatched(queued)
    assert await transition(
        queued, "dispatched", "collected", expires_at=now + timedelta(days=7),
        digest=hashlib.sha256(BODY).hexdigest(), size_bytes=len(BODY), line_count=1,
    )
    assert "file is missing" in (await output(["show", queued], capsys, 9))["error"]
    store = await prepare_store()
    store.write(queued, BODY)
    assert (await output(["show", queued], capsys))["bundle"] == [{"format": 3}, {"event": 1}]
    assert await cli.run(["show", queued, "--raw"]) == 0
    assert capsys.readouterr().out.encode() == BODY
    assert await cli.run(["show", queued]) == 0
    assert capsys.readouterr().out.encode() == BODY
    await age_record(queued, expires_at=now)
    assert "expired" in (await output(["show", queued], capsys, 9))["error"]
    assert await cli.run(["purge"]) == 0
    assert "finished" in capsys.readouterr().out
    assert (await get_collection(queued)).state == "deleted" and not store.path(queued).exists()
    store.close()


@pytest.mark.parametrize(
    "damage", ["truncated", "swapped", "symlink", "oversized", "newline", "array"]
)
async def test_show_verifies_entire_file_before_output(app, configured, capsys, damage):
    from spawn_server.routes.support_log import MAX_BUNDLE

    value, _ = await seed_statement()
    owner = value["account_id"]
    record = await request(owner, await capable(owner))
    assert await mark_dispatched(record)
    store = await prepare_store()
    path = store.path(record)
    contents = BODY
    expected = BODY
    if damage == "swapped":
        other = await request(owner, await capable(owner))
        await mark_dispatched(other)
        contents = BODY.replace(b'"event":1', b'"event":2')
        await transition(
            other,
            "dispatched",
            "collected",
            size_bytes=len(contents),
            digest=hashlib.sha256(contents).hexdigest(),
            line_count=1,
            expires_at=_utcnow() + timedelta(days=1),
        )
        store.write(other, contents)
        contents = store.path(other).read_bytes()
    elif damage == "truncated":
        contents = b'{"format":3}\n'
    elif damage == "oversized":
        contents = expected = b'{"value":"' + b"x" * MAX_BUNDLE + b'"}\n'
    elif damage == "newline":
        contents = expected = BODY.rstrip(b"\n")
    elif damage == "array":
        contents = expected = b'{"format":3}\n[]\n'
    if damage == "symlink":
        target = store.root / "target"
        target.write_bytes(contents)
        path.symlink_to(target)
    else:
        path.write_bytes(contents)
    store.close()
    assert await transition(
        record,
        "dispatched",
        "collected",
        size_bytes=len(expected),
        digest=hashlib.sha256(expected).hexdigest(),
        line_count=1,
        expires_at=_utcnow() + timedelta(days=1),
    )
    for options in ([], ["--raw"]):
        assert await cli.run(["show", record, *options]) == 9
        captured = capsys.readouterr()
        assert not captured.out and captured.err == "The bundle failed verification.\n"


async def test_show_escapes_controls_and_raw_requires_redirection(
    app, configured, capsys, monkeypatch
):
    value, _ = await seed_statement()
    owner = value["account_id"]
    record = await request(owner, await capable(owner))
    event = {"event": "\x1b\n\r\t\x7f\x85\u202e"}
    body = b"{}\n" + json.dumps(event, ensure_ascii=False).encode() + b"\n"
    await mark_dispatched(record)
    await transition(
        record,
        "dispatched",
        "collected",
        size_bytes=len(body),
        digest=hashlib.sha256(body).hexdigest(),
        line_count=1,
        expires_at=_utcnow() + timedelta(days=1),
    )
    store = await prepare_store()
    store.write(record, body)
    store.close()
    assert await cli.run(["show", record]) == 0
    assert capsys.readouterr().out == "{}\n" + json.dumps(event, ensure_ascii=True) + "\n"
    monkeypatch.setattr(cli.sys.stdout, "isatty", lambda: True)
    assert await cli.run(["show", record, "--raw"]) == 2
    captured = capsys.readouterr()
    assert not captured.out and "pipe or a file" in captured.err


async def test_unrelated_directory_is_untouched_by_commands_startup_and_sweep(
    app, monkeypatch, tmp_path, capsys
):
    import os

    from spawn_server.support_log_files import SupportLogFiles
    from spawn_server.support_log_retention import sweep_once

    root = tmp_path / "unrelated"
    monkeypatch.setattr(get_settings(), "support_log_dir", str(root))
    assert await cli.run(["purge"]) == 8
    assert not root.exists()
    capsys.readouterr()
    root.mkdir(mode=0o755)
    old = root / f"{uuid.uuid4()}.ndjson"
    old.write_bytes(BODY)
    os.utime(old, (1, 1))
    before = root.stat()
    for argv in [
        ["accounts"],
        collect("", "") + ["--by", "operator"],
        ["status", ""],
        ["list"],
        ["show", ""],
        ["purge"],
    ]:
        with no_statements():
            await output(argv, capsys, 8)
    assert await prepare_store() is None
    store = SupportLogFiles(root)
    try:
        with no_statements(), pytest.raises(OSError):
            await sweep_once(store)
    finally:
        store.close()
    assert list(root.iterdir()) == [old] and old.read_bytes() == BODY
    after = root.stat()
    assert (before.st_mode, before.st_ctime_ns) == (after.st_mode, after.st_ctime_ns)
