"""Account support routes through the ASGI app, using only a temporary database and store."""

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import DEFAULT, AsyncMock, Mock, patch

import pytest
from aiosqlite import Connection
from sqlalchemy import delete, update

from spawn_server import auth, data_events, main, support_consent, support_log_retention
from spawn_server.config import get_settings
from spawn_server.db import get_engine, get_sessionmaker
from spawn_server.models import BrowserDevice, Host, SupportLogCollection, SupportLogConsent, User
from spawn_server.redis import get_backend, user_alert_channel
from spawn_server.routes import support_log_account as route
from spawn_server.support_log import get_collection, mark_dispatched, transition
from tests.test_support_consent import VECTORS, seed_signer, seed_statement, sign
from tests.test_support_log_retention import lifespan_db as lifespan_db
from tests.test_support_log_uploads import raw_request, seed_request

STATE = "/api/support-log"
CONSENT = STATE + "/consent"


@pytest.fixture
def server(inprocess_pubsub, lifespan_db, tmp_path, monkeypatch):
    monkeypatch.setattr(get_settings(), "support_log_dir", str(tmp_path / "bundles"))
    monkeypatch.setattr(main.SupportLogPump, "run_once", AsyncMock())
    monkeypatch.setattr(support_log_retention, "sweep_once", AsyncMock())
    return main.create_app


@pytest.fixture
async def ready(server):
    app = server()
    async with main.lifespan(app):
        assert app.state.support_log_store is not None
        yield app


@pytest.fixture
def clock(monkeypatch):
    clock = Mock(return_value=datetime(2025, 1, 1, tzinfo=UTC))
    monkeypatch.setattr(route, "_utcnow", clock)
    monkeypatch.setattr(support_consent, "_utcnow", clock)
    monkeypatch.setattr(support_consent, "now_ms", lambda: int(clock().timestamp() * 1000))
    return clock


@pytest.fixture
def wake(ready):
    event = ready.state.support_log_pump.wake
    with patch.object(event, "set", wraps=event.set) as spy:
        yield spy


@pytest.fixture
def publish(monkeypatch):
    spy = AsyncMock(wraps=data_events.publish_data_changed)
    monkeypatch.setattr(data_events, "publish_data_changed", spy)
    return spy


async def request(app, owner, body=None):
    status, wire, _ = await raw_request(
        app,
        "",
        method="GET" if body is None else "PUT",
        path=STATE if body is None else CONSENT,
        token=auth.issue_session_token(owner),
        body=json.dumps(body).encode(),
        extra={"content-type": "application/json", "x-spawn-client": "app"},
    )
    return status, json.loads(wire)


async def get_state(app, owner):
    status, data = await request(app, owner)
    assert status == 200, data
    return data


async def clear_statement(owner):
    async with get_sessionmaker()() as db:
        await db.execute(delete(SupportLogConsent).where(SupportLogConsent.owner_user_id == owner))
        await db.commit()


@pytest.mark.parametrize("disabled", ["unset", "unusable", "backend"])
async def test_disabled_paths_match_master_unknown_path(server, tmp_path, monkeypatch, disabled):
    if disabled == "unset":
        monkeypatch.setattr(get_settings(), "support_log_dir", None)
    elif disabled == "unusable":
        file = tmp_path / "file"
        file.touch()
        monkeypatch.setattr(get_settings(), "support_log_dir", str(file))
    else:
        monkeypatch.setattr("sys.argv", ["server"])
    app = server()
    async with main.lifespan(app):
        assert not any("support-log" in p for p in app.openapi()["paths"])
        for method in (
            "GET",
            "HEAD",
            "POST",
            "PUT",
            "DELETE",
            "CONNECT",
            "OPTIONS",
            "TRACE",
            "PATCH",
        ):
            for suffix in ("", "/"):
                expected = await raw_request(app, "", method=method, path="/unknown" + suffix)
                assert expected == (404, b'{"detail":"Not Found"}', 0)
                for path in (STATE, CONSENT):
                    assert await raw_request(app, "", method=method, path=path + suffix) == expected


async def test_ready_routes_require_session(ready):
    paths = ready.openapi()["paths"]
    assert set(paths[STATE]) == {"get"} and set(paths[CONSENT]) == {"put"}
    for method, path in (("GET", STATE), ("PUT", CONSENT)):
        status, _, reads = await raw_request(ready, "", method=method, path=path)
        assert (status, reads) == (401, 0)


async def test_openapi_describes_consent_refusals(ready):
    spec = ready.openapi()
    responses = spec["paths"][CONSENT]["put"]["responses"]

    def resolve(schema):
        if "$ref" in schema:
            return spec["components"]["schemas"][schema["$ref"].split("/")[-1]]
        return schema

    for status in ("400", "401", "403", "408", "409", "413", "422", "429"):
        error = resolve(responses[status]["content"]["application/json"]["schema"])
        assert error["required"] == ["detail"]
        detail = resolve(error["properties"]["detail"])
        if status == "401":
            assert detail["type"] == "string"
            continue
        assert detail["type"] == "object"
        assert detail["properties"]["code"]["type"] == "string"
        field = {"409": "issued_at_ms", "429": "retry_after_seconds"}.get(status)
        assert set(detail["required"]) == ({"code", field} if field else {"code"})
        if field:
            assert detail["properties"][field]["type"] == "integer"


@pytest.mark.parametrize("method", ["GET", "PUT"])
async def test_held_response_has_returned_its_connection(ready, method):
    value, key = await seed_statement()
    off = sign({**value, "enabled": False}, key)
    started, release = asyncio.Event(), asyncio.Event()

    async def held_app(scope, receive, send):
        async def held_send(message):
            if message["type"] == "http.response.start":
                started.set()
                await release.wait()
            await send(message)

        await ready(scope, receive, held_send)

    response = asyncio.create_task(
        request(held_app, value["account_id"], off if method == "PUT" else None)
    )
    try:
        await asyncio.wait_for(started.wait(), 30)
        assert get_engine().sync_engine.pool.checkedout() == 0
    finally:
        release.set()
        status, _ = await response
    assert status == 200


async def test_only_the_owners_metadata_is_visible(ready, clock):
    value, _ = await seed_statement()
    owner = value["account_id"]
    foreign, _ = await seed_statement(enabled=False)
    async with get_sessionmaker()() as db:
        device = await db.get(BrowserDevice, value["signer_device_id"])
        device.label = "signing device"
        host = Host(owner_user_id=owner, name="", support_log_capable=True, last_seen_at=clock())
        other = Host(owner_user_id=foreign["account_id"], name="")
        db.add_all([host, other])
        await db.commit()
    async with get_sessionmaker()() as db:
        for machine in (host, other):
            db.add(
                SupportLogCollection(
                    owner_user_id=machine.owner_user_id,
                    host_id=machine.id,
                    host_name=machine.name,
                    requested_at=clock(),
                    completed_at=clock(),
                    state="declined",
                    decline_code="no_log",
                    size_bytes=None,
                    reason="connection check",
                    requested_by="private",
                    window_seconds=60,
                    digest="0" * 64,
                )
            )
        await db.commit()
    state = await get_state(ready, owner)
    stamp = clock().isoformat().replace("+00:00", "Z")
    assert set(state) == {
        "statement",
        "sharing",
        "next_issued_at_ms",
        "hosts",
        "collections",
        "retention_days",
    }
    assert state["retention_days"] == 7 and state["sharing"] == "on"
    assert state["statement"] == {
        "signer_device_id": value["signer_device_id"],
        "signer_device_name": device.label,
        "enabled": True,
        "issued_at_ms": value["issued_at_ms"],
    }
    assert state["hosts"] == [dict(id=host.id, name="", capable=True, last_seen_at=stamp)]
    (record,) = state["collections"]
    assert record == dict(
        id=record["id"],
        host_id=host.id,
        host_name="",
        state="declined",
        decline_code="no_log",
        reason="connection check",
        requested_at=stamp,
        completed_at=stamp,
        size_bytes=None,
        expires_at=None,
        deleted_at=None,
    )
    own_keys = set(state) | set(state["statement"]) | set(state["hosts"][0]) | set(record)
    assert own_keys.isdisjoint(
        {
            "signature",
            "key",
            "public_key",
            "signer_public_key",
            "carried_endorsements",
            "token",
            "access_token",
            "daemon_token",
            "digest",
            "filename",
            "file_name",
            "path",
            "requested_by",
        }
    )
    await clear_statement(owner)
    state = await get_state(ready, owner)
    assert state["sharing"] == "off" and state["statement"] is None
    assert state["next_issued_at_ms"] == support_consent.now_ms()
    state = await get_state(ready, foreign["account_id"])
    assert state["sharing"] == "off" and state["statement"]["enabled"] is False
    assert state["hosts"] == [dict(id=other.id, name="", capable=False, last_seen_at=None)]


@pytest.mark.parametrize("pruned", [False, True])
async def test_removed_signer_keeps_signed_device_and_timestamp(ready, pruned):
    value, _ = await seed_statement()
    async with get_sessionmaker()() as db:
        device = await db.get(BrowserDevice, value["signer_device_id"])
        if pruned:
            await db.delete(device)
        else:
            device.revoked_at = datetime.now(UTC)
        await db.commit()
    state = await get_state(ready, value["account_id"])
    assert state["sharing"] == "off_signer_removed"
    assert state["statement"] == dict(
        enabled=True,
        issued_at_ms=value["issued_at_ms"],
        signer_device_id=value["signer_device_id"],
        signer_device_name=None,
    )


async def test_history_limits_and_order(ready, clock):
    value, _ = await seed_statement()
    owner = value["account_id"]
    cutoff = clock() - timedelta(days=365)

    def record(stamp):
        return SupportLogCollection(
            owner_user_id=owner,
            host_name="",
            state="requested",
            reason="connection check",
            requested_by="private",
            window_seconds=60,
            requested_at=stamp,
        )

    async with get_sessionmaker()() as db:
        boundary = record(cutoff)
        db.add_all(
            [
                record(cutoff - timedelta(microseconds=1)),
                boundary,
                record(clock() + timedelta(microseconds=1)),
            ]
        )
        await db.commit()
    assert [r["id"] for r in (await get_state(ready, owner))["collections"]] == [boundary.id]
    async with get_sessionmaker()() as db:
        recent = [record(clock() - timedelta(seconds=i)) for i in range(101)]
        db.add_all(recent)
        await db.commit()
    rows = (await get_state(ready, owner))["collections"]
    assert [row["id"] for row in rows] == [r.id for r in recent[:100]]
    assert all("decline_code" not in row and row["completed_at"] is None for row in rows)


@pytest.mark.parametrize(
    ("issued", "now", "expected"),
    [
        (10, 10, 11),
        (10, 30, 30),
        (support_consent.FUTURE_MS - 1, 0, support_consent.FUTURE_MS),
        (support_consent.FUTURE_MS, 0, {"code": "future_timestamp"}),
        (support_consent.U64_MAX, support_consent.U64_MAX, {"code": "timestamp_overflow"}),
    ],
)
async def test_next_timestamp_or_typed_refusal(ready, issued, now, expected, monkeypatch):
    value, _ = await seed_statement(issued=issued)
    monkeypatch.setattr(support_consent, "now_ms", lambda: now)
    assert (await get_state(ready, value["account_id"]))["next_issued_at_ms"] == expected


@pytest.mark.parametrize("vector", VECTORS["positive"], ids=["off", "on"])
async def test_stores_the_bytes_signed_by_the_device(ready, vector, clock):
    value = vector["consent"]
    owner = value["account_id"]
    async with get_sessionmaker()() as db:
        db.add(User(id=owner, email=uuid.uuid4().hex, password_hash="unused"))
        await db.flush()
        db.add(
            BrowserDevice(
                id=value["signer_device_id"],
                owner_user_id=owner,
                key_algorithm="ed25519",
                public_key=value["signer_public_key"],
            )
        )
        await db.commit()
    status, result = await request(ready, owner, value)
    assert status == 200 and result == await get_state(ready, owner)
    stored = await support_consent.get_statement(owner)
    assert stored == value
    assert support_consent.encode_transcript(stored) == bytes.fromhex(vector["transcript_hex"])


async def test_stores_exact_carried_set_and_defaults_missing_set(ready):
    value, key = await seed_statement()
    owner = value["account_id"]
    await clear_statement(owner)
    without_edges = {k: v for k, v in value.items() if k != "carried_endorsements"}
    assert (await request(ready, owner, without_edges))[0] == 200
    assert await support_consent.get_statement(owner) == value
    edges = VECTORS["negative"][1]["consent"]["carried_endorsements"] * 64
    off = sign({**value, "enabled": False, "carried_endorsements": edges}, key)
    assert (await request(ready, owner, off))[0] == 200
    assert await support_consent.get_statement(owner) == off


@pytest.mark.parametrize("already_off", [True, False])
async def test_refusals_and_account_binding(ready, clock, already_off, wake, publish):
    value, key = await seed_statement(enabled=not already_off)
    owner = value["account_id"]
    other, other_key = await seed_statement(enabled=False)
    off = sign({**value, "enabled": False}, key)

    async def refused(body, status, code, **details):
        assert await request(ready, owner, body) == (status, {"detail": {"code": code, **details}})
        assert await support_consent.get_statement(owner) == value

    await refused(other, 403, "account_mismatch")
    await refused(sign({**other, "account_id": owner}, other_key), 403, "signer_untrusted")
    await refused(
        sign(
            {**other, "account_id": owner, "signer_device_id": value["signer_device_id"]}, other_key
        ),
        403,
        "signer_key_mismatch",
    )
    await refused({**off, "signature": other["signature"]}, 400, "invalid_signature")
    await refused(
        sign(
            {**off, "issued_at_ms": support_consent.now_ms() + support_consent.FUTURE_MS + 1}, key
        ),
        422,
        "future_timestamp",
    )
    if not already_off:
        await refused(
            sign({**off, "issued_at_ms": 0}, key),
            409,
            "stale_statement",
            issued_at_ms=value["issued_at_ms"],
        )
    async with get_sessionmaker()() as db:
        await db.execute(
            update(BrowserDevice)
            .where(BrowserDevice.owner_user_id == owner)
            .values(revoked_at=clock())
        )
        await db.commit()
    await refused(off, 403, "signer_removed")
    wake.assert_not_called()
    publish.assert_not_called()


async def test_malformed_envelopes(ready):
    value, _ = await seed_statement(enabled=False)
    owner = value["account_id"]
    edge = VECTORS["negative"][1]["consent"]["carried_endorsements"][0]
    for mutation in (
        {"extra": True},
        {"enabled": 0},
        {"version": True},
        {"issued_at_ms": -1},
        {"signature": "="},
        {"account_id": "invalid"},
        {"signer_public_key": "=" * 43},
        {"carried_endorsements": [edge] * 65},
        {"carried_endorsements": [dict(edge, extra="x")]},
        {"carried_endorsements": [dict(edge, signature="a" * 129)]},
    ):
        assert await request(ready, owner, {**value, **mutation}) == (
            422,
            {"detail": {"code": "invalid_envelope"}},
        )
    for raw in (b"{", json.dumps(value).encode()[:-1] + b', "enabled":false}', b"\xff"):
        status, body, _ = await raw_request(
            ready, "", path=CONSENT, method="PUT", token=auth.issue_session_token(owner), body=raw
        )
        assert status == 422 and json.loads(body)["detail"] == {"code": "invalid_envelope"}


@pytest.mark.parametrize("declared", [True, False])
async def test_size_refused_before_parsing(ready, monkeypatch, declared):
    value, _ = await seed_statement()
    token = auth.issue_session_token(value["account_id"])
    parser = Mock(side_effect=AssertionError)
    monkeypatch.setattr(support_consent, "strict_json", parser)
    limit = route.MAX_STATEMENT_BYTES
    status, wire, reads = await raw_request(
        ready,
        "",
        method="PUT",
        path=CONSENT,
        token=token,
        chunks=[b" " * limit, b"{"],
        extra={"content-length": str(limit + 1) if declared else None},
    )
    assert status == 413 and json.loads(wire)["detail"] == {"code": "body_too_large"}
    assert reads == (0 if declared else 2)
    parser.assert_not_called()


async def test_withdrawal_effects_and_notifications_only_after_a_write(
    ready, clock, wake, monkeypatch
):
    value, key = await seed_statement()
    owner = value["account_id"]
    async with get_sessionmaker()() as db:
        host = Host(owner_user_id=owner, name="")
        db.add(host)
        await db.commit()
    pending = await seed_request(host)
    sent = await seed_request(host)
    collected = await seed_request(host)
    assert await mark_dispatched(sent) and await mark_dispatched(collected)
    assert await transition(collected, "dispatched", "collected")

    generation = support_consent.statement_generation(owner)
    off = sign({**value, "enabled": False}, key)  # A signed off wins the timestamp tie.

    def after_commit():
        assert support_consent.statement_generation(owner) == generation + 1
        return DEFAULT

    wake.side_effect = after_commit
    publish = AsyncMock(wraps=get_backend().publish_channel)
    monkeypatch.setattr(get_backend(), "publish_channel", publish)
    status, state = await request(ready, owner, off)
    assert status == 200 and state == await get_state(ready, owner)
    assert state["sharing"] == "off"
    assert (await get_collection(pending)).state == "cancelled"
    assert (await get_collection(sent)).state == "cancelled"
    record = await get_collection(collected)
    assert record.state == "deleted" and record.deleted_at is not None
    assert await support_consent.get_statement(owner) == off
    wake.assert_called_once_with()
    publish.assert_awaited_once()
    stored_time = clock()
    clock.return_value += timedelta(seconds=5)
    # A newer signed off also leaves the timestamp floor and cooldown intact.
    assert await request(
        ready, owner, sign({**off, "issued_at_ms": off["issued_at_ms"] + 1}, key)
    ) == (
        200,
        await get_state(ready, owner),
    )
    assert await support_consent.get_statement(owner) == off
    async with get_sessionmaker()() as db:
        row = await db.get(SupportLogConsent, owner)
        assert row.updated_at.replace(tzinfo=UTC) == stored_time
    assert support_consent.statement_generation(owner) == generation + 1
    wake.assert_called_once_with()
    publish.assert_awaited_once()
    channel, raw = publish.await_args.args
    event = json.loads(raw)
    assert channel == user_alert_channel(owner)
    assert event == dict(type="data", resource="support-log", id=None, origin="app", at=event["at"])
    assert data_events.forwardable_data_frame(event) == event


async def test_cancel_during_commit_keeps_lock_and_notifies(ready, monkeypatch, wake, publish):
    value, key = await seed_statement()
    owner = value["account_id"]
    off = sign({**value, "enabled": False}, key)
    entered, release = asyncio.Event(), asyncio.Event()
    commit = Connection.commit

    async def held_commit(connection):
        entered.set()
        await release.wait()
        await commit(connection)

    monkeypatch.setattr(Connection, "commit", held_commit)
    writer = asyncio.create_task(request(ready, owner, off))
    try:
        await asyncio.wait_for(entered.wait(), 30)
        writer.cancel()
        await asyncio.sleep(0)  # Deliver cancellation while the commit is still blocked.
        assert not writer.done() and route._write_locks[owner].locked()
        wake.assert_not_called()
        publish.assert_not_called()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await writer
    assert await support_consent.get_statement(owner) == off
    wake.assert_called_once_with()
    publish.assert_awaited_once_with(owner, data_events.SUPPORT_LOG_RESOURCE, origin="app")


@pytest.mark.parametrize("failure", ["readback", "serialization"])
async def test_response_failure_preserves_commit_and_notifications(
    ready, monkeypatch, wake, publish, failure
):
    value, key = await seed_statement()
    owner = value["account_id"]
    off = sign({**value, "enabled": False}, key)
    release = asyncio.Event()

    async def held_publish(*args, **kwargs):
        await release.wait()

    publish.side_effect = held_publish

    async def fail(*args, **kwargs):
        wake.assert_called_once_with()
        publish.assert_called_once_with(owner, data_events.SUPPORT_LOG_RESOURCE, origin="app")
        assert len(route._publish_tasks) == 1
        raise RuntimeError(failure)

    if failure == "readback":
        monkeypatch.setattr(route, "account_state", fail)
    else:
        monkeypatch.setattr("fastapi.routing.serialize_response", fail)
    try:
        with pytest.raises(RuntimeError, match=failure):
            await asyncio.wait_for(request(ready, owner, off), 30)
        assert await support_consent.get_statement(owner) == off
    finally:
        release.set()
        await asyncio.gather(*route._publish_tasks)
    publish.assert_awaited_once()


async def test_pacing_before_signature(ready, clock, monkeypatch, wake, publish):
    value, key = await seed_signer(enabled=True, issued=1000)
    owner = value["account_id"]
    assert (await request(ready, owner, value))[0] == 200
    newer = sign({**value, "issued_at_ms": value["issued_at_ms"] + 1}, key)
    with monkeypatch.context() as patch:
        verifier = Mock(side_effect=AssertionError)
        patch.setattr(support_consent, "verify_statement", verifier)
        assert await request(ready, owner, newer) == (
            429,
            {"detail": {"code": "rate_limited", "retry_after_seconds": 60}},
        )
        verifier.assert_not_called()
    wake.assert_called_once_with()
    publish.assert_awaited_once()
    clock.return_value += timedelta(seconds=2)
    assert (await request(ready, owner, sign({**value, "enabled": False}, key)))[0] == 200


async def test_pacing_after_restart_with_another_current_device(server, clock):
    async with main.lifespan(server()):
        stored, _ = await seed_signer(enabled=False, issued=1000)
        owner = stored["account_id"]
        newer, key = await seed_signer(enabled=True, issued=1001, owner=owner)
        async with get_sessionmaker()() as db:
            db.add(
                SupportLogConsent(
                    owner_user_id=owner,
                    enabled=stored["enabled"],
                    issued_at_ms=stored["issued_at_ms"],
                    signer_device_id=stored["signer_device_id"],
                    signed_device_id=stored["signer_device_id"],
                    signer_public_key=stored["signer_public_key"],
                    signature=stored["signature"],
                    carried_endorsements=stored["carried_endorsements"],
                    updated_at=clock(),
                )
            )
            await db.commit()

    second_app = server()
    async with main.lifespan(second_app):
        clock.return_value += timedelta(seconds=59, milliseconds=1)
        assert await request(second_app, owner, newer) == (
            429,
            {"detail": {"code": "rate_limited", "retry_after_seconds": 1}},
        )
        clock.return_value += timedelta(milliseconds=999)
        status, result = await request(second_app, owner, newer)
        assert status == 200 and result["statement"]["signer_device_id"] == newer["signer_device_id"]
        clock.return_value += timedelta(seconds=61)
        newest = sign({**newer, "issued_at_ms": newer["issued_at_ms"] + 1}, key)
        assert (await request(second_app, owner, newest))[0] == 200
        assert await support_consent.get_statement(owner) == newest


async def test_concurrent_first_ons_share_one_cooldown(ready, monkeypatch, clock):
    value, key = await seed_statement()
    owner = value["account_id"]
    await clear_statement(owner)
    second = sign({**value, "issued_at_ms": value["issued_at_ms"] + 1}, key)
    first_at_store, second_body_read, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    store = support_consent.store_statement
    read = route.read_statement

    async def held_store(*args):
        first_at_store.set()
        await release.wait()
        return await store(*args)

    async def observe_body(request):
        raw, body = await read(request)
        if body.issued_at_ms == second["issued_at_ms"]:
            second_body_read.set()
        return raw, body

    monkeypatch.setattr(support_consent, "store_statement", held_store)
    monkeypatch.setattr(route, "read_statement", observe_body)
    first = asyncio.create_task(request(ready, owner, value))
    await first_at_store.wait()
    concurrent = asyncio.create_task(request(ready, owner, second))
    await second_body_read.wait()
    release.set()
    saved, refused = await asyncio.gather(first, concurrent)
    assert saved[0] == 200
    assert refused == (429, {"detail": {"code": "rate_limited", "retry_after_seconds": 60}})
    assert await support_consent.get_statement(owner) == value
