"""Wire and SQLite driver transcript recorded with origin/master at 238184b5."""

import json
import re
import uuid
from datetime import UTC, datetime, timedelta
from email.utils import formatdate
from itertools import count, groupby
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import aiosqlite
import pytest
from sqlalchemy import event

from spawn_server import auth, main
from spawn_server.config import get_settings
from spawn_server.db import configure_sqlite_connections, get_engine, get_sessionmaker
from spawn_server.models import (
    AuthIdentity,
    BrowserDevice,
    HostBrowserPin,
    RevokedBrowserKey,
    User,
    _utcnow,
)
from spawn_server.routes import browser_devices
from spawn_server.ws import daemon
from tests.test_support_consent import seed_statement
from tests.test_ws_daemon import FakeDaemonWebSocket, _create_host, _create_session_row

pytestmark = pytest.mark.usefixtures("inprocess_pubsub")


@pytest.mark.parametrize("unusable", [False, True])
async def test_disabled_lifecycle(app, file_sqlite_client, tmp_path, monkeypatch, unusable, sansio_launch):
    settings = get_settings()
    configured = tmp_path / "unusable"
    configured.touch()
    monkeypatch.setattr(settings, "support_log_dir", str(configured) if unusable else None)
    monkeypatch.setattr(settings, "prebuilt_dir", tmp_path / "prebuilt")
    # Run the lifespan readiness check, retaining the isolated file DB and broker.
    monkeypatch.setattr(main, "init_engine", Mock())
    monkeypatch.setattr(main, "dispose_engine", AsyncMock())
    async with main.lifespan(app):
        assert getattr(app.state, "support_log_store", None) is None
        trace = await lifecycle_trace(app, file_sqlite_client, monkeypatch)
    baseline = Path(__file__).with_name("support_log_disabled_master.txt")
    assert trace == baseline.read_text()


async def lifecycle_trace(app, client, monkeypatch):
    statement, _ = await seed_statement()
    owner, device, key = (
        statement[k] for k in ("account_id", "signer_device_id", "signer_public_key")
    )
    host = await _create_host(owner, name="")
    worker = await _create_session_row(owner, host, name="")
    fingerprint = uuid.uuid4().hex[:23]
    revoked = uuid.uuid4().hex + uuid.uuid4().hex[:11]
    async with get_sessionmaker()() as db:
        user = await db.get(User, owner)
        (await db.get(BrowserDevice, device)).created_at = datetime(2000, 1, 1, tzinfo=UTC)
        db.add_all(
            [
                AuthIdentity(
                    user_id=owner,
                    provider="test",
                    provider_user_id=uuid.uuid4().hex,
                    email=user.email,
                ),
                HostBrowserPin(
                    host_id=host,
                    browser_device_id=device,
                    browser_key_algorithm="ed25519",
                    browser_public_key=key,
                    browser_key_fingerprint=fingerprint,
                ),
                RevokedBrowserKey(
                    owner_user_id=owner,
                    public_key=revoked,
                    key_algorithm="ed25519",
                    revoked_at=_utcnow(),
                ),
            ]
        )
        await db.commit()

    now = auth._now()
    monkeypatch.setattr(auth, "_now", lambda: now)
    with monkeypatch.context() as m:
        m.setattr(get_settings(), "jwt_daemon_ttl_days", 1)
        token = auth.issue_daemon_token(host, owner)
    rotated = auth.issue_daemon_token(host, owner)
    assert rotated != token
    replacements = {
        host: "<host>",
        owner: "<account>",
        device: "<device>",
        worker: "<worker>",
        key: "<public-key>",
        fingerprint: "<fingerprint>",
        revoked: "<revoked-key>",
        rotated: "<rotated-token>",
    }
    # The disconnect writes two successive clock reads. A real clock can
    # return either one or two distinct microseconds for those calls.
    ticks = count(1)

    def daemon_clock():
        tick = next(ticks)
        value = now + timedelta(microseconds=tick)
        sql_value = value.replace(tzinfo=None).isoformat(sep=" ", timespec="microseconds")
        replacements[sql_value] = f"<daemon-time-{tick}>"
        return value

    monkeypatch.setattr(daemon, "_utcnow", daemon_clock)
    allocation = daemon._allocate_host_generation

    async def capture_id(session, host_id, connection_id, **kwargs):
        replacements[connection_id] = "<connection>"
        return await allocation(session, host_id, connection_id, **kwargs)

    monkeypatch.setattr(daemon, "_allocate_host_generation", capture_id)
    events = []
    started = _utcnow()
    engine = get_engine()
    configure_sqlite_connections(engine)
    await engine.dispose()

    def observe(dbapi, _record):
        dbapi.run_async(lambda conn: conn.set_trace_callback(events.append))

    event.listen(engine.sync_engine, "connect", observe, insert=True)

    def driver_call(method):
        original = getattr(aiosqlite.Connection, method)

        async def traced(conn):
            events.append("driver " + method)
            return await original(conn)

        monkeypatch.setattr(aiosqlite.Connection, method, traced)

    driver_call("commit")
    driver_call("rollback")
    class TracedSocket(FakeDaemonWebSocket):
        async def accept(self, subprotocol=None):
            events.append("accept " + subprotocol)
            await super().accept(subprotocol)

        async def receive(self):
            message = await super().receive()
            events.append(message["type"] + " " + message.get("text", str(message.get("code"))))
            return message

        async def send_text(self, wire):
            events.append("wire " + wire)
            await super().send_text(wire)

    ws = TracedSocket()
    ws.scope["app"] = app
    ws.queue_text({"type": "register", "existing_sessions": [worker], "supports_support_log": True})
    ws.queue_text({"type": "host.heartbeat"})
    ws.queue_disconnect()

    try:
        events.append("[register, heartbeat and disconnect]")
        await daemon.daemon_ws(ws, token=token)
        assert not ws.sent_bytes and not ws.close_calls
        assert ws.sent_text == [entry[5:] for entry in events if entry.startswith("wire ")]
        assert rotated in ws.sent_text[0] and key in ws.sent_text[0] and revoked in ws.sent_text[0]
        assert ws.sent_text[-1] == '{"type": "host.heartbeat"}'
        headers = {"authorization": f"Bearer {auth.issue_access_token(owner)}"}
        # Pin only the removal and cookie clocks to compare the actual HTTP
        # payloads and every Set-Cookie attribute with the master capture.
        revoked_at = _utcnow()

        class RemovalClock(datetime):
            @classmethod
            def now(cls, tz):
                return revoked_at

        monkeypatch.setattr(browser_devices, "datetime", RemovalClock)
        replacements[revoked_at.replace(tzinfo=None).isoformat(timespec="microseconds")] = (
            "<revoked-at>"
        )
        monkeypatch.setattr("http.cookies._getdate", lambda offset: formatdate(offset, usegmt=True))

        def http_result(response):
            return json.dumps(
                [response.status_code, response.text, response.headers.get_list("set-cookie")]
            )

        events.append("[remove device]")
        response = await client.post(
            f"/api/browser-devices/{device}/revoke",
            headers=headers,
            json={"expected_public_key": key},
        )
        assert response.status_code == 200
        events.append(http_result(response))
        events.append("[delete account]")
        response = await client.post(
            "/api/account/delete", headers=headers, json={"confirm_email": user.email}
        )
        assert response.status_code == 204
        events.append(http_result(response))
    finally:
        event.remove(engine.sync_engine, "connect", observe)

    # Keep serialized frames byte-for-byte. SQLite reports actual bound values
    # and each execution, including triggers. Fold adjacent repetitions only.
    finished = _utcnow()
    timestamps = {}

    def clock_value(match):
        stamp = datetime.fromisoformat(match[0]).replace(tzinfo=UTC)
        if started <= stamp <= finished:
            return timestamps.setdefault(stamp, f"<time-{len(timestamps) + 1}>")
        return match[0]

    normalized = []
    for entry in events:
        for value, label in replacements.items():
            entry = entry.replace(value, label)
        entry = re.sub(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}", clock_value, entry)
        normalized.append(entry)
    lines = []
    for entry, occurrences in groupby(normalized):
        repeats = len(list(occurrences))
        lines.append((f"{repeats} x " if repeats > 1 else "") + entry)
    return "\n".join(lines) + "\n"
