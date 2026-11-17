"""Upload gates, streaming bounds, races and disk/database failure boundaries."""

from __future__ import annotations

import asyncio
import hashlib
import stat
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, Mock

import pytest
import pytest_asyncio
from sqlalchemy import delete, update

from spawn_server import auth, main, support_log_retention
from spawn_server.config import get_settings
from spawn_server.db import get_sessionmaker
from spawn_server.models import BrowserDevice, Host, SupportLogCollection
from spawn_server.routes import support_log as route
from spawn_server.support_consent import store_statement
from spawn_server.support_log import create_request, get_collection, mark_dispatched, transition
from spawn_server.support_log_files import file_status, get_store
from spawn_server.support_log_retention import sweep_once
from tests.test_support_consent import seed_statement, sign

BODY = b'{"format":3}\n{"event":1}\n'


def headers(body=BODY, **overrides):
    return {
        "content-type": "application/x-ndjson",
        "x-spawn-support-log-sha256": hashlib.sha256(body).hexdigest(),
        "x-spawn-support-log-lines": "1",
        "x-spawn-support-log-from": "1",
        "x-spawn-support-log-to": "1",
        "x-spawn-support-log-truncated": "false",
        **overrides,
    }


@pytest.fixture
def storage(app):
    return get_store(app)


@pytest_asyncio.fixture
async def app(app, tmp_path, monkeypatch):
    # The shared fixture owns the database. These tests drive retention explicitly.
    monkeypatch.setattr(main, "init_engine", Mock())
    monkeypatch.setattr(main, "dispose_engine", AsyncMock())
    monkeypatch.setattr(get_settings(), "support_log_dir", str(tmp_path / "bundles"))
    monkeypatch.setattr(support_log_retention, "sweep_once", AsyncMock())
    upload_app = main.create_app()
    async with upload_app.router.lifespan_context(upload_app):
        yield upload_app
    assert not route._inflight and not route._reading


async def setup_request(*, state="dispatched", enabled=True):
    statement, key = await seed_statement(enabled=enabled)
    async with get_sessionmaker()() as session:
        host = Host(owner_user_id=statement["account_id"], name="")
        session.add(host)
        await session.commit()
    record_id = await create_request(
        owner_user_id=statement["account_id"],
        host_id=host.id,
        reason="Connection diagnosis",
        requested_by="operator",
        window_seconds=60,
    )
    if state != "requested":
        # An off-arrival test starts with a genuinely dispatched request, then withdraws.
        assert await mark_dispatched(record_id)
        if state != "dispatched":
            await transition(record_id, "dispatched", state)
    token = auth.issue_daemon_token(host.id, statement["account_id"])
    return record_id, token, statement, key, host


def url(record_id):
    return f"/api/support-log/uploads/{record_id}"


async def post(client, record_id, token, body=BODY, extra=None):
    return await client.post(
        url(record_id),
        content=body,
        headers={**headers(body), "authorization": f"Bearer {token}", **(extra or {})},
    )


async def raw_request(
    app,
    record_id,
    *,
    token=None,
    body=BODY,
    extra=None,
    chunks=None,
    receive_body=None,
    method="POST",
    path=None,
):
    wire_headers = headers(body)
    if token:
        wire_headers["authorization"] = f"Bearer {token}"
    wire_headers.update(extra or {})
    wire_headers = {key: value for key, value in wire_headers.items() if value is not None}
    scope = dict(
        type="http",
        asgi={"version": "3.0"},
        http_version="1.1",
        method=method,
        scheme="http",
        path=path or url(record_id),
        raw_path=(path or url(record_id)).encode(),
        query_string=b"",
        root_path="",
        server=None,
        client=None,
        headers=[(k.encode(), v.encode()) for k, v in wire_headers.items()],
    )
    sent, reads = [], []
    pieces = iter(chunks if chunks is not None else [body])

    async def receive():
        reads.append(True)
        if receive_body is not None:
            return await receive_body()
        chunk = next(pieces, None)
        return {"type": "http.request", "body": chunk or b"", "more_body": chunk is not None}

    async def send(message):
        sent.append(message)

    await app(scope, receive, send)
    return sent[0]["status"], b"".join(m.get("body", b"") for m in sent[1:]), len(reads)


@pytest.mark.parametrize("kind", ["missing", "invalid", "access", "deleted", "wrong_owner"])
async def test_auth_refuses_without_body_or_file_io(app, storage, kind):
    record_id, token, statement, _key, host = await setup_request()
    if kind == "missing":
        token = None
    elif kind == "invalid":
        token = "invalid"
    elif kind == "access":
        token = auth.issue_access_token(statement["account_id"])
    elif kind == "wrong_owner":
        token = auth.issue_daemon_token(host.id, str(uuid.uuid4()))
    elif kind == "deleted":
        async with get_sessionmaker()() as session:
            await session.execute(delete(Host).where(Host.id == host.id))
            await session.commit()
    status, _body, reads = await raw_request(app, record_id, token=token)
    assert status == 401
    assert reads == 0
    assert not list(storage.root.iterdir())
    assert (await get_collection(record_id)).state == "dispatched"


async def test_unknown_foreign_and_malformed_are_identical(app, storage):
    record_id, token, _statement, _key, _host = await setup_request()
    foreign_id, *_ = await setup_request()
    results = []
    for requested_id in (str(uuid.uuid4()), foreign_id, "malformed"):
        status, body, reads = await raw_request(app, requested_id, token=token)
        assert status == 404 and reads == 0
        results.append(body)
    assert results[0] == results[1] == results[2] == b'{"detail":"Not Found"}'
    assert not list(storage.root.iterdir())
    assert (await get_collection(record_id)).state == "dispatched"


@pytest.mark.parametrize(
    "state", ["requested", "collected", "declined", "failed", "expired", "cancelled", "deleted"]
)
async def test_closed_record_conflicts_without_body(app, storage, state):
    record_id, token, *_ = await setup_request()
    async with get_sessionmaker()() as session:
        await session.execute(
            update(SupportLogCollection)
            .where(SupportLogCollection.id == record_id)
            .values(state=state)
        )
        await session.commit()
    status, _body, reads = await raw_request(app, record_id, token=token)
    assert status == 409 and reads == 0
    assert not list(storage.root.iterdir())


async def test_success_modes_metadata_and_one_outcome(client, storage):
    record_id, token, *_ = await setup_request()
    before = datetime.now(UTC)
    response = await post(client, record_id, token)
    assert response.status_code == 204 and response.content == b""
    record = await get_collection(record_id)
    assert record.state == "collected"
    assert record.size_bytes == len(BODY)
    assert record.line_count == 1 and record.log_from == record.log_to == 1
    assert record.digest == hashlib.sha256(BODY).hexdigest() and not record.truncated
    assert before + timedelta(days=7) <= record.expires_at.replace(tzinfo=UTC)
    assert record.expires_at.replace(tzinfo=UTC) <= datetime.now(UTC) + timedelta(days=7)
    assert storage.path(record.id).read_bytes() == BODY
    assert stat.S_IMODE(storage.path(record.id).stat().st_mode) == 0o600
    assert stat.S_IMODE(storage.root.stat().st_mode) == 0o700
    assert await file_status(record, storage) == "present"
    assert (await post(client, record_id, token, b'{"format":3}\n{}\n')).status_code == 409
    assert storage.path(record.id).read_bytes() == BODY
    storage.path(record.id).unlink()
    assert await file_status(record, storage) == "missing"


@pytest.mark.parametrize(
    "code", ["not_consented", "signer_untrusted", "rate_limited", "no_log", "failed"]
)
async def test_typed_refusal(client, storage, code):
    record_id, token, *_ = await setup_request()
    response = await client.post(
        url(record_id), json={"declined": code}, headers={"authorization": f"Bearer {token}"}
    )
    assert response.status_code == 204
    record = await get_collection(record_id)
    assert record.state == "declined" and record.decline_code == code
    assert not list(storage.root.iterdir())
    assert (await post(client, record_id, token)).status_code == 409


@pytest.mark.parametrize(
    "body",
    [
        b"{}",
        b"[]",
        b"null",
        b'{"declined":"cancelled"}',
        b'{"declined":"failed","detail":"extra"}',
        b'{"declined":1}',
        b'{"declined":[]}',
        b'{"declined":"failed","declined":"failed"}',
        b'{"declined":NaN}',
        b"\xff",
        b"{",
    ],
)
async def test_malformed_refusal(client, storage, body):
    record_id, token, *_ = await setup_request()
    response = await post(client, record_id, token, body, {"content-type": "application/json"})
    assert response.status_code == 400
    assert (await get_collection(record_id)).state == "failed"
    assert not list(storage.root.iterdir())


@pytest.mark.parametrize(
    "body,extra",
    [
        (BODY, {"x-spawn-support-log-sha256": "0" * 64}),
        (BODY, {"x-spawn-support-log-lines": "2"}),
        (b'{"format":3}\n[]\n', {}),
        (b'{"format":3}\nnull\n', {}),
        (b"[]\n{}\n", {}),
        (b"{}\n{", {}),
        (BODY[:-1], {}),
        (b"{}\n\xff\n", {}),
        (b"{}\n\n", {}),
        (b'{}\n{"value":NaN}\n', {}),
        (b'{}\n{"x":1,"x":2}\n', {}),
    ],
)
async def test_invalid_bundles_fail_without_files(client, storage, body, extra):
    record_id, token, *_ = await setup_request()
    assert (await post(client, record_id, token, body, extra)).status_code == 400
    assert (await get_collection(record_id)).state == "failed"
    assert not list(storage.root.iterdir())


@pytest.mark.parametrize(
    "suffix,value",
    [
        ("sha256", None),
        ("lines", None),
        ("from", None),
        ("to", None),
        ("truncated", None),
        ("sha256", "A" * 64),
        ("sha256", "0" * 63),
        ("sha256", "g" * 64),
        ("lines", "-1"),
        ("lines", "+1"),
        ("lines", "1.0"),
        ("lines", str(1 << 64)),
        ("from", str(-(1 << 63) - 1)),
        ("to", str(1 << 63)),
        ("from", "2"),
        ("from", "+1"),
        ("to", "1.0"),
        ("truncated", "True"),
        ("truncated", "0"),
    ],
)
async def test_header_syntax_and_ranges(app, storage, suffix, value):
    record_id, token, *_ = await setup_request()
    status, _body, reads = await raw_request(
        app, record_id, token=token, extra={f"x-spawn-support-log-{suffix}": value}
    )
    assert status == 400 and reads == 0
    assert (await get_collection(record_id)).state == "failed"
    assert not list(storage.root.iterdir())


@pytest.mark.parametrize("length", [str(route.MAX_BUNDLE + 1), "1", None])
async def test_stream_limit_including_lying_and_absent_length(app, storage, length):
    record_id, token, *_ = await setup_request()
    status, _body, reads = await raw_request(
        app,
        record_id,
        token=token,
        extra={"content-length": length},
        chunks=[b"x" * route.MAX_BUNDLE, b"y", b"unread"],
    )
    assert status == 413
    assert reads == (0 if length == str(route.MAX_BUNDLE + 1) else 2)
    assert (await get_collection(record_id)).state == "failed"
    assert not list(storage.root.iterdir())


async def test_single_large_chunk_and_exact_bound(app, storage):
    record_id, token, *_ = await setup_request()
    status, _, reads = await raw_request(
        app, record_id, token=token, chunks=[b"x" * (route.MAX_BUNDLE * 2)]
    )
    assert status == 413 and reads == 1
    record_id, token, *_ = await setup_request()
    body = b'{}\n{"padding":"' + b"x" * (route.MAX_BUNDLE - 18) + b'"}\n'
    assert len(body) == route.MAX_BUNDLE
    status, _, _ = await raw_request(app, record_id, token=token, body=body)
    assert status == 204


@pytest.mark.parametrize("length", ["-1", "invalid", "0", str(len(BODY) + 1)])
async def test_bad_content_length(app, storage, length):
    record_id, token, *_ = await setup_request()
    status, _, _ = await raw_request(app, record_id, token=token, extra={"content-length": length})
    assert status == 400
    assert (await get_collection(record_id)).state == "failed"


async def test_refusal_body_bound_and_unsupported_type(app, storage):
    for content_type, body, expected in [
        ("application/json", b"x" * 257, 413),
        ("text/plain", BODY, 415),
        (None, BODY, 415),
        ("application/x-ndjson; charset=utf-8", BODY, 415),
    ]:
        record_id, token, *_ = await setup_request()
        status, _, _ = await raw_request(
            app, record_id, token=token, body=body, extra={"content-type": content_type}
        )
        assert status == expected
        assert (await get_collection(record_id)).state == "failed"


@pytest.mark.parametrize("off", ["signed", "removed", "missing"])
async def test_sharing_off_at_arrival_does_not_read(app, storage, off):
    record_id, token, statement, key, _host = await setup_request()
    if off == "signed":
        await store_statement(statement["account_id"], sign({**statement, "enabled": False}, key))
    else:
        async with get_sessionmaker()() as session:
            if off == "removed":
                await session.execute(update(BrowserDevice).values(revoked_at=datetime.now(UTC)))
            else:
                from spawn_server.models import SupportLogConsent

                await session.execute(delete(SupportLogConsent))
            await session.commit()
    status, _, reads = await raw_request(app, record_id, token=token)
    assert status == 409 and reads == 0
    assert (await get_collection(record_id)).state == "cancelled"
    assert not list(storage.root.iterdir())


@pytest.mark.parametrize("boundary", ["rename", "commit", "lost_race", "withdrawn"])
async def test_atomic_publication_failure(client, storage, monkeypatch, boundary):
    record_id, token, statement, key, _host = await setup_request()
    if boundary == "rename":

        def fail_rename(source, destination):
            assert source != destination and destination == storage.path(record_id)
            assert not destination.exists()
            assert stat.S_IMODE(__import__("os").stat(source).st_mode) == 0o600
            raise OSError("injected")

        monkeypatch.setattr("spawn_server.support_log_files.os.replace", fail_rename)
    else:
        real_transition = route.transition

        async def fail_transition(record_id, current, target, **kwargs):
            if target == "collected":
                assert storage.path(record_id).read_bytes() == BODY
                if boundary == "commit":
                    raise RuntimeError("injected")
                if boundary == "withdrawn":
                    await store_statement(
                        statement["account_id"], sign({**statement, "enabled": False}, key)
                    )
                else:
                    await real_transition(record_id, current, "failed")
            return await real_transition(record_id, current, target, **kwargs)

        monkeypatch.setattr(route, "transition", fail_transition)
    response = await post(client, record_id, token)
    assert response.status_code == (409 if boundary in {"lost_race", "withdrawn"} else 500)
    assert (await get_collection(record_id)).state == (
        "cancelled" if boundary == "withdrawn" else "failed"
    )
    assert not list(storage.root.iterdir())


async def test_concurrent_uploads_keep_winning_file(file_sqlite_client, storage):
    record_id, token, *_ = await setup_request()
    other = b'{"format":3}\n{"event":2}\n'
    results = await asyncio.gather(
        post(file_sqlite_client, record_id, token),
        post(file_sqlite_client, record_id, token, other),
    )
    assert sorted(result.status_code for result in results) == [204, 409]
    winner = BODY if results[0].status_code == 204 else other
    assert storage.path(record_id).read_bytes() == winner
    assert (await get_collection(record_id)).digest == hashlib.sha256(winner).hexdigest()


async def test_duplicate_headers_are_refused(client, storage):
    for duplicate in ("content-length", "x-spawn-support-log-lines"):
        record_id, token, *_ = await setup_request()
        values = {**headers(), "authorization": f"Bearer {token}", "content-length": str(len(BODY))}
        response = await client.post(
            url(record_id), content=BODY, headers=[*values.items(), (duplicate, values[duplicate])]
        )
        assert response.status_code == 400
        assert (await get_collection(record_id)).state == "failed"


@pytest.mark.parametrize(
    "count,start,end", [("0", "0", "0"), ("1", str(-(1 << 63)), str((1 << 63) - 1))]
)
async def test_header_range_boundaries(client, storage, count, start, end):
    record_id, token, *_ = await setup_request()
    body = b'{"format":3}\n' if count == "0" else BODY
    result = await post(
        client,
        record_id,
        token,
        body,
        {
            "x-spawn-support-log-lines": count,
            "x-spawn-support-log-from": start,
            "x-spawn-support-log-to": end,
            "x-spawn-support-log-truncated": "true",
        },
    )
    assert result.status_code == 204
    assert (await get_collection(record_id)).truncated


async def test_disconnect_marks_failed(app, storage):
    from starlette.requests import ClientDisconnect, Request

    record_id, token, *_ = await setup_request()
    scope = dict(
        type="http",
        app=app,
        headers=[
            (k.encode(), v.encode())
            for k, v in {
                **headers(),
                "authorization": f"Bearer {token}",
            }.items()
        ],
    )

    async def receive():
        return {"type": "http.disconnect"}

    with pytest.raises(__import__("fastapi").HTTPException) as caught:
        await route.upload(record_id, Request(scope, receive))
    assert caught.value.status_code == 400
    assert isinstance(caught.value.__context__, ClientDisconnect)
    assert (await get_collection(record_id)).state == "failed"
    assert not route._inflight and not route._reading


async def test_cancel_after_rename_finishes_commit(client, storage, monkeypatch):
    record_id, token, *_ = await setup_request()
    entered, proceed = asyncio.Event(), asyncio.Event()
    real_transition = route.transition

    async def held_transition(record_id, current, target, **metadata):
        if target == "collected":
            assert storage.path(record_id).exists()
            entered.set()
            await asyncio.wait_for(proceed.wait(), 30)
        return await real_transition(record_id, current, target, **metadata)

    monkeypatch.setattr(route, "transition", held_transition)
    task = asyncio.create_task(post(client, record_id, token))
    await asyncio.wait_for(entered.wait(), 30)
    task.cancel()
    proceed.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 30)
    assert (await get_collection(record_id)).state == "collected"
    assert storage.path(record_id).read_bytes() == BODY
    assert not route._inflight and not route._reading


async def test_oversized_length_precedes_missing_support_headers(app, storage):
    record_id, token, *_ = await setup_request()
    status, _, reads = await raw_request(
        app,
        record_id,
        token=token,
        extra={
            "content-length": "9" * 30,
            "x-spawn-support-log-sha256": None,
        },
    )
    assert status == 413 and reads == 0
    assert (await get_collection(record_id)).state == "failed"


@pytest.mark.parametrize("first_kind", ["bundle", "refusal"])
async def test_bundle_against_refusal_has_one_outcome(app, file_sqlite_client, storage, first_kind):
    record_id, token, *_ = await setup_request()
    entered, proceed = asyncio.Event(), asyncio.Event()
    refusal = b'{"declined":"no_log"}'
    first_body = BODY if first_kind == "bundle" else refusal
    first_type = "application/x-ndjson" if first_kind == "bundle" else "application/json"

    async def receive():
        entered.set()
        await asyncio.wait_for(proceed.wait(), 30)
        return {"type": "http.request", "body": first_body, "more_body": False}

    first = asyncio.create_task(
        raw_request(
            app,
            record_id,
            token=token,
            body=first_body,
            extra={"content-type": first_type},
            receive_body=receive,
        )
    )
    try:
        await asyncio.wait_for(entered.wait(), 30)
        # Admission covers both kinds for the whole request, before any second read.
        second = await raw_request(
            app,
            record_id,
            token=token,
            body=refusal if first_kind == "bundle" else BODY,
            extra={
                "content-type": "application/json"
                if first_kind == "bundle"
                else "application/x-ndjson"
            },
        )
        assert second[0] == 409 and second[2] == 0
        assert (await get_collection(record_id)).state == "dispatched"
    finally:
        proceed.set()
    result = await asyncio.wait_for(first, 30)
    assert result[0] == 204
    await sweep_once(storage, now=datetime.now(UTC) + timedelta(minutes=11))
    record = await get_collection(record_id)
    assert record.state == ("collected" if first_kind == "bundle" else "declined")
    assert set(storage.root.iterdir()) == (
        {storage.path(record_id)} if record.state == "collected" else set()
    )
    if first_kind == "bundle":
        assert storage.path(record_id).read_bytes() == BODY
    else:
        assert record.decline_code == "no_log"


async def test_four_body_reads_reject_fifth_without_touching_record(
    app, file_sqlite_client, storage
):
    records = [await setup_request() for _ in range(5)]
    entered = [asyncio.Event() for _ in range(4)]
    proceed = asyncio.Event()

    async def receive(index):
        entered[index].set()
        await asyncio.wait_for(proceed.wait(), 30)
        return {"type": "http.request", "body": BODY, "more_body": False}

    tasks = [
        asyncio.create_task(
            raw_request(
                app,
                record_id,
                token=token,
                receive_body=lambda index=index: receive(index),
            )
        )
        for index, (record_id, token, *_) in enumerate(records[:4])
    ]
    fifth_id, fifth_token, *_ = records[4]
    before = await get_collection(fifth_id)
    try:
        await asyncio.wait_for(asyncio.gather(*(event.wait() for event in entered)), 30)
        # A second app in the same process shares the receive limit.
        other_app = main.create_app()
        async with other_app.router.lifespan_context(other_app):
            status, _, reads = await raw_request(other_app, fifth_id, token=fifth_token)
        assert status == 503 and reads == 0
        after = await get_collection(fifth_id)
        assert all(
            getattr(before, column.name) == getattr(after, column.name)
            for column in SupportLogCollection.__table__.columns
        )
        assert not storage.path(fifth_id).exists()
    finally:
        proceed.set()
    results = await asyncio.wait_for(asyncio.gather(*tasks), 30)
    assert [result[0] for result in results] == [204] * 4
    assert not route._inflight and not route._reading
    assert (await raw_request(app, fifth_id, token=fifth_token))[0] == 204


@pytest.mark.parametrize("content_type", ["application/x-ndjson", "application/json"])
async def test_total_receive_deadline_fails_and_releases(app, storage, monkeypatch, content_type):
    record_id, token, *_ = await setup_request()
    entered, never = asyncio.Event(), asyncio.Event()
    deadlines = []
    timeout = asyncio.timeout

    def capture_timeout(delay):
        assert delay == 60
        deadline = timeout(None)
        deadlines.append(deadline)
        return deadline

    monkeypatch.setattr(route.asyncio, "timeout", capture_timeout)
    reads = 0

    async def receive():
        nonlocal reads
        reads += 1
        if reads == 1:
            return {"type": "http.request", "body": b"{", "more_body": True}
        entered.set()
        await asyncio.wait_for(never.wait(), 30)
        pytest.fail("deadline must interrupt the body read")

    task = asyncio.create_task(
        raw_request(
            app,
            record_id,
            token=token,
            extra={"content-type": content_type},
            receive_body=receive,
        )
    )
    await asyncio.wait_for(entered.wait(), 30)
    assert len(deadlines) == 1  # One total deadline, not a fresh budget per chunk.
    deadlines[0].reschedule(asyncio.get_running_loop().time())
    status, _, reads = await asyncio.wait_for(task, 30)
    assert status == 408 and reads == 2
    assert (await get_collection(record_id)).state == "failed"
    assert not list(storage.root.iterdir())
    assert not route._inflight and not route._reading


async def test_cancellation_during_receive_releases_slots(app, storage):
    record_id, token, *_ = await setup_request()
    entered, never = asyncio.Event(), asyncio.Event()

    async def receive():
        entered.set()
        await asyncio.wait_for(never.wait(), 30)
        pytest.fail("cancelled reader must stop")

    task = asyncio.create_task(raw_request(app, record_id, token=token, receive_body=receive))
    await asyncio.wait_for(entered.wait(), 30)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 30)
    assert not route._inflight and not route._reading
    assert (await raw_request(app, record_id, token=token))[0] == 204


async def test_sweep_waits_for_publication_between_rename_and_commit(
    file_sqlite_client, storage, monkeypatch
):
    record_id, token, *_ = await setup_request()
    renamed, proceed, sweep_waiting = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original_transition = route.transition
    original_lock = storage._try_lock
    loop = asyncio.get_running_loop()

    async def held_transition(record_id, current, target, **metadata):
        if target == "collected":
            assert storage.path(record_id).read_bytes() == BODY
            renamed.set()
            await asyncio.wait_for(proceed.wait(), 30)
        return await original_transition(record_id, current, target, **metadata)

    def observed_lock():
        fd = original_lock()
        if fd is None:
            loop.call_soon_threadsafe(sweep_waiting.set)
        return fd

    monkeypatch.setattr(route, "transition", held_transition)
    monkeypatch.setattr(storage, "_try_lock", observed_lock)
    upload = asyncio.create_task(post(file_sqlite_client, record_id, token))
    await asyncio.wait_for(renamed.wait(), 30)
    # Advance beyond orphan grace while publication owns the directory lock.
    sweep = asyncio.create_task(sweep_once(storage, now=datetime.now(UTC) + timedelta(minutes=11)))
    try:
        await asyncio.wait_for(sweep_waiting.wait(), 30)
        assert not sweep.done()
        assert (await get_collection(record_id)).state == "dispatched"
        assert storage.path(record_id).read_bytes() == BODY
    finally:
        proceed.set()
    response, _ = await asyncio.wait_for(asyncio.gather(upload, sweep), 30)
    assert response.status_code == 204
    assert (await get_collection(record_id)).state == "collected"
    assert set(storage.root.iterdir()) == {storage.path(record_id)}
    assert storage.path(record_id).read_bytes() == BODY


@pytest.mark.parametrize("boundary", ["body", "commit"])
async def test_signer_removed_during_upload_cannot_publish(
    app, file_sqlite_client, storage, monkeypatch, boundary
):
    record_id, token, statement, *_ = await setup_request()
    entered, proceed = asyncio.Event(), asyncio.Event()
    original_transition = route.transition

    async def receive():
        if boundary == "body":
            entered.set()
            await asyncio.wait_for(proceed.wait(), 30)
        return {"type": "http.request", "body": BODY, "more_body": False}

    async def held_transition(record_id, current, target, **metadata):
        if target == "collected":
            assert storage.path(record_id).exists()
            entered.set()
            await asyncio.wait_for(proceed.wait(), 30)
        return await original_transition(record_id, current, target, **metadata)

    if boundary == "commit":
        monkeypatch.setattr(route, "transition", held_transition)
    task = asyncio.create_task(raw_request(app, record_id, token=token, receive_body=receive))
    try:
        await asyncio.wait_for(entered.wait(), 30)
        assert (await get_collection(record_id)).state == "dispatched"
        async with get_sessionmaker()() as session:
            await session.execute(
                delete(BrowserDevice).where(BrowserDevice.id == statement["signer_device_id"])
            )
            await session.commit()
    finally:
        proceed.set()
    status, _, reads = await asyncio.wait_for(task, 30)
    assert status == 409 and reads == 1
    assert (await get_collection(record_id)).state == "cancelled"
    await sweep_once(storage, now=datetime.now(UTC) + timedelta(minutes=11))
    assert (await get_collection(record_id)).state == "cancelled"
    assert not list(storage.root.iterdir())


async def test_refusal_wins_against_publication_in_another_worker(
    file_sqlite_client, storage, monkeypatch
):
    from fastapi import HTTPException
    from starlette.datastructures import Headers

    record_id, token, *_ = await setup_request()
    renamed, proceed = asyncio.Event(), asyncio.Event()
    original_transition = route.transition

    async def held_transition(record_id, current, target, **metadata):
        if target == "collected":
            assert storage.path(record_id).read_bytes() == BODY
            renamed.set()
            await asyncio.wait_for(proceed.wait(), 30)
        return await original_transition(record_id, current, target, **metadata)

    monkeypatch.setattr(route, "transition", held_transition)
    # Another worker has its own admission slots; enter its publication directly
    # while retaining the production directory lock and conditional state update.
    publication = asyncio.create_task(
        route.publish(
            storage,
            await get_collection(record_id),
            BODY,
            route.bundle_metadata(Headers(headers())),
        )
    )
    try:
        await asyncio.wait_for(renamed.wait(), 30)
        response = await file_sqlite_client.post(
            url(record_id),
            json={"declined": "no_log"},
            headers={"authorization": f"Bearer {token}"},
        )
        assert response.status_code == 204
    finally:
        proceed.set()
    with pytest.raises(HTTPException) as caught:
        await asyncio.wait_for(publication, 30)
    assert caught.value.status_code == 409
    await sweep_once(storage, now=datetime.now(UTC) + timedelta(minutes=11))
    record = await get_collection(record_id)
    assert record.state == "declined" and record.decline_code == "no_log"
    assert not list(storage.root.iterdir())
