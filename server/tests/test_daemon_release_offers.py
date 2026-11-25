"""Offering a newly active daemon release to daemons that are already connected."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import async_object_session

from spawn_server import auth, main, release
from spawn_server import daemon_release_offers as offers_mod
from spawn_server.config import get_settings
from spawn_server.daemon_release_offers import DaemonReleaseOffers
from spawn_server.db import get_sessionmaker
from spawn_server.models import Host
from spawn_server.ws import broker as broker_mod
from spawn_server.ws import daemon as daemon_mod
from tests.test_support_log_disabled import lifecycle_trace
from tests.test_ws_daemon import FakeDaemonWebSocket, _create_host, _signup

pytestmark = pytest.mark.usefixtures("inprocess_pubsub")

OLD = "1" * 40
TREE_A = "a" * 40
TREE_B = "b" * 40
LOGGER = "spawn.daemon_release_offers"


@pytest.fixture(autouse=True)
def fresh_broker(monkeypatch):
    monkeypatch.setattr(broker_mod, "_broker", broker_mod.Broker())


class Prebuilts:
    """Immutable generations under `releases/` and an atomic `current` link."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def stage(self, name: str, tree: str, counter: int | None, *, broken: bool = False) -> None:
        generation = self.root / "releases" / name
        target = generation / "linux-x86_64"
        target.mkdir(parents=True)
        spawnd, worker = f"spawnd {name}".encode(), f"worker {name}".encode()
        (target / "spawnd").write_bytes(spawnd)
        (target / "spawn-worker").write_bytes(worker)
        claimed = b"not these bytes" if broken else spawnd
        manifest = {
            "commit": "c" * 40,
            "tree": tree,
            "version": f"0.2.{counter or 0}+g{tree[:12]}",
            "release_counter": counter,
            "targets": {
                "linux-x86_64": {
                    "spawnd_sha256": hashlib.sha256(claimed).hexdigest(),
                    "spawn_worker_sha256": hashlib.sha256(worker).hexdigest(),
                }
            },
        }
        (generation / "manifest.json").write_text(json.dumps(manifest))

    def activate(self, name: str) -> None:
        link = self.root / "current.next"
        link.symlink_to(Path("releases") / name)
        os.replace(link, self.root / "current")

    def deactivate(self) -> None:
        (self.root / "current").unlink()


@pytest.fixture
def prebuilts(tmp_path, monkeypatch):
    root = tmp_path / "prebuilt"
    root.mkdir()
    monkeypatch.setattr(get_settings(), "prebuilt_dir", root)
    monkeypatch.setattr(release, "MANIFEST_PATH", None)
    return Prebuilts(root)


class Socket(FakeDaemonWebSocket):
    """Sets `idle` once registration has finished and the next frame is awaited.

    Answers each `host.ping` as a daemon does, unless `ping` is "silent" (never
    answers), "refuse" (the write fails) or "stuck" (the write never returns;
    `ping_held` is set once it has begun).
    """

    def __init__(self, *, refuse_updates: bool = False, ping: str = "answer") -> None:
        super().__init__()
        self.idle = asyncio.Event()
        self.ping_held = asyncio.Event()
        self.refuse_updates = refuse_updates
        self.ping = ping

    async def receive(self):
        if self.receive_count:
            self.idle.set()
        return await super().receive()

    async def send_text(self, value: str) -> None:
        if self.refuse_updates and '"daemon.update"' in value:
            raise OSError("socket refused the write")
        frame = json.loads(value)
        if frame["type"] == "host.ping":
            if self.ping == "refuse":
                raise OSError("socket refused the write")
            if self.ping == "stuck":
                self.ping_held.set()
                await asyncio.Event().wait()
            if self.ping == "answer":
                self.queue_text({"type": "host.pong", "request_id": frame["request_id"]})
        await super().send_text(value)

    def sent(self, kind: str) -> list[dict]:
        frames = [json.loads(text) for text in self.sent_text]
        return [frame for frame in frames if frame["type"] == kind]

    def updates(self) -> list[dict]:
        return self.sent("daemon.update")

    def pings(self) -> list[dict]:
        return self.sent("host.ping")


class Fleet:
    def __init__(self, owner: str) -> None:
        self.owner = owner
        self.tasks: list[tuple[Socket, asyncio.Task[None]]] = []

    async def host(self) -> str:
        return await _create_host(self.owner, name=f"host-{uuid.uuid4().hex[:8]}")

    def open(self, host_id: str, *, tree: str = OLD, socket: Socket | None = None, **fields):
        ws = socket or Socket()
        ws.queue_text(
            {
                "type": "register",
                "os": "linux",
                "arch": "x86_64",
                "daemon_tree": tree,
                "self_update": True,
                **fields,
            }
        )
        task = asyncio.create_task(
            daemon_mod.daemon_ws(ws, token=auth.issue_daemon_token(host_id, self.owner))
        )
        self.tasks.append((ws, task))
        return ws, task

    async def connect(self, host_id: str | None = None, **kwargs) -> tuple[str, Socket]:
        host_id = host_id or await self.host()
        ws, _ = self.open(host_id, **kwargs)
        await asyncio.wait_for(ws.idle.wait(), 10)
        return host_id, ws

    async def close(self, ws: Socket) -> None:
        for socket, task in self.tasks:
            if socket is ws:
                socket.queue_disconnect()
                await asyncio.wait_for(task, 10)

    async def close_all(self) -> None:
        for socket, task in self.tasks:
            if not task.done():
                socket.queue_disconnect()
                await asyncio.wait_for(task, 10)


@pytest.fixture
async def fleet(client):
    owner, _ = await _signup(client, f"offers-{uuid.uuid4().hex}@example.com")
    value = Fleet(owner)
    try:
        yield value
    finally:
        await value.close_all()


class Pauses:
    def __init__(self) -> None:
        self.calls: list[float] = []
        self.hook = None

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)
        if self.hook is not None:
            await self.hook(len(self.calls))


async def host_row(host_id: str) -> Host:
    async with get_sessionmaker()() as session:
        host = await session.get(Host, host_id)
        assert host is not None
        return host


async def set_host(host_id: str, **values) -> None:
    async with get_sessionmaker()() as session:
        await session.execute(update(Host).where(Host.id == host_id).values(**values))
        await session.commit()


async def reset_update_state(*host_ids: str) -> None:
    for host_id in host_ids:
        await set_host(
            host_id,
            update_state=None,
            update_tree=None,
            update_error=None,
            update_requested_at=None,
        )


def offer_records(caplog) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == LOGGER]


@pytest.mark.parametrize("startup", ["missing", "active", "unreadable"])
async def test_startup_records_the_release_and_offers_nothing(fleet, prebuilts, startup):
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("broken", TREE_B, 200, broken=True)
    # Registered while no release is active, so registration offered nothing.
    sockets = [(await fleet.connect())[1] for _ in range(2)]
    if startup == "active":
        prebuilts.activate("a")
    elif startup == "unreadable":
        prebuilts.activate("broken")
    pauses = Pauses()
    offers = DaemonReleaseOffers(pause=pauses)

    await offers.poll_once()
    await offers.poll_once()

    assert all(ws.updates() == [] for ws in sockets)
    assert pauses.calls == []


async def test_a_new_release_is_offered_once_to_each_host_that_is_behind(
    fleet, prebuilts, caplog
):
    caplog.set_level(logging.INFO, logger=LOGGER)
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("b", TREE_B, 200)
    first, first_ws = await fleet.connect()
    current, current_ws = await fleet.connect(tree=TREE_B)
    no_self_update, no_self_update_ws = await fleet.connect(
        self_update=False, self_update_blocked="disabled"
    )
    updating, updating_ws = await fleet.connect()
    failed, failed_ws = await fleet.connect()
    mismatch, mismatch_ws = await fleet.connect(worker_mismatch=True)
    second, second_ws = await fleet.connect()
    requested = datetime.now(UTC)
    await set_host(updating, update_state="updating", update_tree=TREE_B, update_requested_at=requested)
    await set_host(failed, update_state="failed", update_tree=TREE_B, update_error="verify: hash")
    prebuilts.activate("a")
    pauses = Pauses()
    offers = DaemonReleaseOffers(pause=pauses)
    await offers.poll_once()

    prebuilts.activate("b")
    await offers.poll_once()

    for ws in (first_ws, second_ws):
        [frame] = ws.updates()
        assert frame["tree"] == TREE_B
        assert frame["target"] == "linux-x86_64"
        assert frame["spawnd"]["path"] == "/api/install/spawnd/linux-x86_64"
        assert "allow_downgrade" not in frame
    for host_id in (first, second):
        row = await host_row(host_id)
        assert (row.update_state, row.update_tree) == ("updating", TREE_B)
    for ws in (first_ws, second_ws):
        assert len(ws.pings()) == 1
    for ws in (current_ws, no_self_update_ws, updating_ws, failed_ws, mismatch_ws):
        assert ws.updates() == [] and ws.pings() == []
    still_updating = await host_row(updating)
    assert still_updating.update_state == "updating"
    assert still_updating.update_requested_at.replace(tzinfo=UTC) == requested
    still_failed = await host_row(failed)
    assert (still_failed.update_state, still_failed.update_error) == ("failed", "verify: hash")
    assert (await host_row(mismatch)).update_state is None
    # One gap, between the two offers; none for the hosts left alone.
    assert pauses.calls == [offers_mod.OFFER_GAP_SECONDS] == [2.0]
    [line] = offer_records(caplog)
    assert line.levelno == logging.INFO
    assert line.getMessage() == (
        "daemon release offer pass: 7 connections considered, 2 tried"
    )
    assert not any(
        host_id in record.getMessage()
        for record in offer_records(caplog)
        for host_id in (first, second, current, updating, failed, mismatch, no_self_update)
    )

    await offers.poll_once()
    assert len(first_ws.updates()) == len(second_ws.updates()) == 1
    assert len(offer_records(caplog)) == 1


async def test_automatic_update_off_offers_nothing(fleet, prebuilts, monkeypatch):
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("b", TREE_B, 200)
    _, ws = await fleet.connect()
    prebuilts.activate("a")
    offers = DaemonReleaseOffers(pause=Pauses())
    await offers.poll_once()
    monkeypatch.setattr(get_settings(), "daemon_auto_update", False)

    prebuilts.activate("b")
    await offers.poll_once()

    assert ws.updates() == [] and ws.pings() == []


async def test_seen_older_and_unreadable_releases_offer_nothing(fleet, prebuilts):
    for name, tree, counter in (
        ("a", TREE_A, 100),
        ("b", TREE_B, 200),
        ("older", "e" * 40, 150),
        ("d", "d" * 40, 300),
    ):
        prebuilts.stage(name, tree, counter)
    prebuilts.stage("broken", "f" * 40, 400, broken=True)
    first, first_ws = await fleet.connect()
    second, second_ws = await fleet.connect()
    prebuilts.activate("a")
    offers = DaemonReleaseOffers(pause=Pauses())
    await offers.poll_once()
    prebuilts.activate("b")
    await offers.poll_once()
    assert len(first_ws.updates()) == len(second_ws.updates()) == 1

    # From here every host would be offered anything it was asked about, so
    # each step below proves the task itself declined to ask.
    steps = (
        lambda: None,  # the same release again
        lambda: prebuilts.activate("a"),  # an earlier release coming back
        lambda: prebuilts.activate("broken"),  # unreadable
        prebuilts.deactivate,  # missing
        lambda: prebuilts.activate("b"),  # seen before
        lambda: prebuilts.activate("older"),  # never seen, older counter
    )
    for step in steps:
        await reset_update_state(first, second)
        step()
        await offers.poll_once()
        assert len(first_ws.updates()) == len(second_ws.updates()) == 1

    await reset_update_state(first, second)
    prebuilts.activate("d")
    await offers.poll_once()
    assert [frame["tree"] for frame in first_ws.updates()] == [TREE_B, "d" * 40]
    assert [frame["tree"] for frame in second_ws.updates()] == [TREE_B, "d" * 40]


@pytest.mark.parametrize("registration", ["read the old release", "holds inside its offer"])
async def test_registration_racing_the_pass_makes_one_offer(
    fleet, prebuilts, monkeypatch, registration
):
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("b", TREE_B, 200)
    _, settled_ws = await fleet.connect(tree=TREE_A)
    prebuilts.activate("a")
    pauses = Pauses()
    offers = DaemonReleaseOffers(pause=pauses)
    await offers.poll_once()

    racing = await fleet.host()
    if registration == "read the old release":
        # Registered after the last poll, while the old release was active:
        # its registration had nothing to offer.
        _, racing_ws = await fleet.connect(racing, tree=TREE_A)
        assert racing_ws.updates() == []
        prebuilts.activate("b")
    else:
        # Registered after the new release became active, and held between
        # its offer's read of the host and that offer's commit — the window in
        # which a second caller would also find the host behind.
        prebuilts.activate("b")
        in_window, resume = asyncio.Event(), asyncio.Event()
        original_mark = release.mark_update_requested
        racing_task: asyncio.Task[None] | None = None

        def mark(host, manifest, **kwargs):
            payload = original_mark(host, manifest, **kwargs)
            if asyncio.current_task() is racing_task:
                session = async_object_session(host)
                commit = session.commit

                async def held_commit():
                    in_window.set()
                    await resume.wait()
                    await commit()

                session.commit = held_commit
            return payload

        monkeypatch.setattr(release, "mark_update_requested", mark)
        racing_ws, racing_task = fleet.open(racing, tree=TREE_A)
        await asyncio.wait_for(in_window.wait(), 10)
        assert broker_mod.get_broker().get_daemon_for_host(racing) is not None

    await offers.poll_once()
    # The pass reached the settled host and left the new connection alone.
    assert [frame["tree"] for frame in settled_ws.updates()] == [TREE_B]
    assert racing_ws.updates() == []

    if registration == "holds inside its offer":
        resume.set()
        await asyncio.wait_for(racing_ws.idle.wait(), 10)
    await offers.poll_once()
    await offers.poll_once()

    assert [frame["tree"] for frame in racing_ws.updates()] == [TREE_B]
    row = await host_row(racing)
    assert (row.update_state, row.update_tree) == ("updating", TREE_B)
    assert len(settled_ws.updates()) == 1


async def test_a_host_registering_again_during_the_pass_gets_one_offer(fleet, prebuilts):
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("b", TREE_B, 200)
    _, first_ws = await fleet.connect()
    second, old_ws = await fleet.connect()
    prebuilts.activate("a")
    pauses = Pauses()
    offers = DaemonReleaseOffers(pause=pauses)
    await offers.poll_once()
    replacement = Socket()

    async def reconnect(_count):
        # The second host's daemon reconnects while the pass waits before it.
        fleet.open(second, socket=replacement)
        await asyncio.wait_for(replacement.idle.wait(), 10)

    pauses.hook = reconnect
    prebuilts.activate("b")
    await offers.poll_once()
    await offers.poll_once()

    assert [frame["tree"] for frame in first_ws.updates()] == [TREE_B]
    assert old_ws.updates() == []
    assert [frame["tree"] for frame in replacement.updates()] == [TREE_B]


async def test_pacing_failures_and_closed_connections_do_not_stop_the_pass(
    fleet, prebuilts, monkeypatch, caplog
):
    caplog.set_level(logging.INFO, logger=LOGGER)
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("b", TREE_B, 200)
    refused, _ = await fleet.connect(socket=Socket(refuse_updates=True))
    raising, raising_ws = await fleet.connect()
    closing, closing_ws = await fleet.connect()
    _, fourth_ws = await fleet.connect()
    _, fifth_ws = await fleet.connect()
    original = daemon_mod._auto_update_after_registration

    async def offer(conn):
        if conn.host_id == raising:
            raise RuntimeError(f"offer for {conn.host_id} failed")
        await original(conn)

    monkeypatch.setattr(daemon_mod, "_auto_update_after_registration", offer)
    prebuilts.activate("a")
    pauses = Pauses()

    async def close_third(count):
        if count == 2:
            await fleet.close(closing_ws)

    pauses.hook = close_third
    offers = DaemonReleaseOffers(pause=pauses)
    await offers.poll_once()
    prebuilts.activate("b")
    await offers.poll_once()

    refused_row = await host_row(refused)
    assert (refused_row.update_state, refused_row.update_error) == (
        "failed",
        "update request could not be delivered",
    )
    assert raising_ws.updates() == [] and (await host_row(raising)).update_state is None
    assert closing_ws.updates() == [] and (await host_row(closing)).update_state is None
    assert len(fourth_ws.updates()) == len(fifth_ws.updates()) == 1
    assert pauses.calls == [2.0] * 4
    messages = [record.getMessage() for record in offer_records(caplog)]
    assert messages == [
        "daemon release offer to one host failed: RuntimeError",
        "daemon release offer pass: 5 connections considered, 4 tried",
    ]
    assert not any(raising in message for message in messages)


async def test_a_daemon_that_does_not_answer_a_ping_is_left_to_registration(
    fleet, prebuilts, monkeypatch, caplog
):
    caplog.set_level(logging.INFO, logger=LOGGER)
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("b", TREE_B, 200)
    silent, silent_ws = await fleet.connect(socket=Socket(ping="silent"))
    refusing, refusing_ws = await fleet.connect(socket=Socket(ping="refuse"))
    answering, answering_ws = await fleet.connect()
    broker = broker_mod.get_broker()
    real_ping = broker.request_host_ping
    timeouts: list[float] = []

    async def ping(conn, *, timeout):
        timeouts.append(timeout)
        # The silent daemon is really asked and never answers; its wait ends
        # at once, so the test sits out no real interval.
        return await real_ping(conn, timeout=0 if conn.host_id == silent else timeout)

    monkeypatch.setattr(broker, "request_host_ping", ping)
    prebuilts.activate("a")
    pauses = Pauses()
    offers = DaemonReleaseOffers(pause=pauses)
    await offers.poll_once()

    def fields(row: Host) -> tuple:
        return (row.update_state, row.update_tree, row.update_error, row.update_requested_at)

    before = {host_id: fields(await host_row(host_id)) for host_id in (silent, refusing)}
    prebuilts.activate("b")
    await offers.poll_once()

    assert timeouts == [offers_mod.PING_SECONDS] * 3 == [2.0] * 3
    assert len(silent_ws.pings()) == 1
    for host_id, ws in ((silent, silent_ws), (refusing, refusing_ws)):
        assert ws.updates() == []
        assert fields(await host_row(host_id)) == before[host_id]
    assert [frame["tree"] for frame in answering_ws.updates()] == [TREE_B]
    row = await host_row(answering)
    assert (row.update_state, row.update_tree) == ("updating", TREE_B)
    # Nothing was offered before the answering host, so no gap was waited.
    assert pauses.calls == []
    assert [record.getMessage() for record in offer_records(caplog)] == [
        "daemon release offer to one host failed: WebSocketDisconnect",
        "daemon release offer pass: 3 connections considered, 1 tried",
    ]


async def test_a_ping_whose_send_never_returns_does_not_hold_the_pass(
    fleet, prebuilts, monkeypatch, caplog
):
    caplog.set_level(logging.INFO, logger=LOGGER)
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("b", TREE_B, 200)
    first, first_ws = await fleet.connect()
    stuck, stuck_ws = await fleet.connect(socket=Socket(ping="stuck"))
    last, last_ws = await fleet.connect()
    prebuilts.activate("a")
    pauses = Pauses()
    offers = DaemonReleaseOffers(pause=pauses)
    await offers.poll_once()

    def fields(row: Host) -> tuple:
        return (row.update_state, row.update_tree, row.update_error, row.update_requested_at)

    before = fields(await host_row(stuck))
    limit = offers_mod.PING_LIMIT_SECONDS

    async def gap(count):
        # The gap before the stuck host gives its whole ping no time at all, so
        # the test sits out no real interval; the gap after it restores the
        # real limit for the last host.
        monkeypatch.setattr(offers_mod, "PING_LIMIT_SECONDS", 0 if count == 1 else limit)

    pauses.hook = gap
    prebuilts.activate("b")
    await asyncio.wait_for(offers.poll_once(), 10)

    assert limit == 3.0
    assert stuck_ws.ping_held.is_set()
    assert stuck_ws.updates() == []
    assert fields(await host_row(stuck)) == before
    for host_id, ws in ((first, first_ws), (last, last_ws)):
        assert [frame["tree"] for frame in ws.updates()] == [TREE_B]
        row = await host_row(host_id)
        assert (row.update_state, row.update_tree) == ("updating", TREE_B)
    assert pauses.calls == [offers_mod.OFFER_GAP_SECONDS] * 2
    assert [record.getMessage() for record in offer_records(caplog)] == [
        "daemon release offer pass: 3 connections considered, 2 tried",
    ]


async def test_a_host_marked_updating_long_ago_is_left_alone(fleet, prebuilts):
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("b", TREE_B, 200)
    stale, stale_ws = await fleet.connect()
    _, other_ws = await fleet.connect()
    # Past the point where the offer function stops counting it as updating.
    requested = datetime.now(UTC) - release.DAEMON_UPDATE_TIMEOUT - timedelta(minutes=1)
    await set_host(stale, update_state="updating", update_tree=TREE_A, update_requested_at=requested)
    prebuilts.activate("a")
    offers = DaemonReleaseOffers(pause=Pauses())
    await offers.poll_once()

    prebuilts.activate("b")
    await offers.poll_once()

    assert stale_ws.updates() == [] and stale_ws.pings() == []
    row = await host_row(stale)
    assert release.host_update_state(row).state == "available"
    assert (row.update_state, row.update_tree) == ("updating", TREE_A)
    assert row.update_requested_at.replace(tzinfo=UTC) == requested
    assert [frame["tree"] for frame in other_ws.updates()] == [TREE_B]


async def test_a_release_without_a_counter_is_offered_once(fleet, prebuilts):
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("plain", TREE_B, None)
    host_id, ws = await fleet.connect()
    prebuilts.activate("a")
    offers = DaemonReleaseOffers(pause=Pauses())
    await offers.poll_once()

    prebuilts.activate("plain")
    await offers.poll_once()
    assert [frame["tree"] for frame in ws.updates()] == [TREE_B]

    await reset_update_state(host_id)
    for name in ("a", "plain"):
        prebuilts.activate(name)
        await offers.poll_once()
    assert len(ws.updates()) == 1


async def test_the_release_changing_during_a_pass_gives_each_host_one_offer(fleet, prebuilts):
    tree_d = "d" * 40
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("b", TREE_B, 200)
    prebuilts.stage("d", tree_d, 300)
    _, first_ws = await fleet.connect()
    _, second_ws = await fleet.connect()
    prebuilts.activate("a")
    pauses = Pauses()
    offers = DaemonReleaseOffers(pause=pauses)
    await offers.poll_once()

    async def newer(_count):
        prebuilts.activate("d")

    pauses.hook = newer
    prebuilts.activate("b")
    await offers.poll_once()
    pauses.hook = None
    await offers.poll_once()
    await offers.poll_once()

    # The offer function reads the active release itself, so the second host
    # got the one that became active in the gap. The next pass finds both
    # hosts updating and offers nothing more.
    assert [frame["tree"] for frame in first_ws.updates()] == [TREE_B]
    assert [frame["tree"] for frame in second_ws.updates()] == [tree_d]


async def test_stop_ends_the_pass_between_hosts(fleet, prebuilts):
    prebuilts.stage("a", TREE_A, 100)
    prebuilts.stage("b", TREE_B, 200)
    sockets = [(await fleet.connect())[1] for _ in range(3)]
    prebuilts.activate("a")
    offers = DaemonReleaseOffers()
    await offers.poll_once()
    real_wait = offers._pause

    async def stop_in_gap(seconds):
        offers.stop()
        # The default wait returns at once once stopped.
        await asyncio.wait_for(real_wait(seconds), 1)

    offers._pause = stop_in_gap
    prebuilts.activate("b")
    await offers.poll_once()

    assert [len(ws.updates()) for ws in sockets] == [1, 0, 0]


async def test_run_polls_every_fifteen_seconds_and_stops_promptly(monkeypatch):
    reads = 0
    first = asyncio.Event()

    async def read():
        nonlocal reads
        reads += 1
        first.set()
        return None

    pauses = Pauses()

    async def stop_after_two(count):
        if count == 2:
            offers.stop()

    pauses.hook = stop_after_two
    offers = DaemonReleaseOffers(read_manifest=read, pause=pauses)
    await asyncio.wait_for(offers.run(), 5)
    assert pauses.calls == [offers_mod.POLL_SECONDS] * 2 == [15.0, 15.0]
    assert reads == 2

    # With the default wait, stopping does not sit out the interval.
    reads, first = 0, asyncio.Event()
    offers = DaemonReleaseOffers(read_manifest=read)
    task = asyncio.create_task(offers.run())
    await asyncio.wait_for(first.wait(), 5)
    offers.stop()
    await asyncio.wait_for(task, 1)
    assert reads == 1


async def test_a_failed_poll_is_logged_and_the_loop_continues(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER)
    calls = 0

    async def read():
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("manifest read failed")
        offers.stop()
        return None

    offers = DaemonReleaseOffers(read_manifest=read, pause=Pauses())
    await asyncio.wait_for(offers.run(), 5)
    assert calls == 2
    assert [record.getMessage() for record in offer_records(caplog)] == [
        "daemon release offer poll failed: OSError"
    ]


@pytest.mark.parametrize("enabled", [True, False])
async def test_the_setting_starts_and_stops_the_lifespan_task(app, monkeypatch, enabled):
    monkeypatch.setattr(get_settings(), "support_log_dir", None)
    monkeypatch.setattr(get_settings(), "daemon_release_offers", enabled)
    monkeypatch.setattr(main, "init_engine", Mock())
    monkeypatch.setattr(main, "dispose_engine", AsyncMock())
    polled = asyncio.Event()

    async def poll(self):
        polled.set()

    monkeypatch.setattr(DaemonReleaseOffers, "poll_once", poll)

    async with main.lifespan(app):
        tasks = [t for t in asyncio.all_tasks() if t.get_name() == "daemon-release-offers"]
        assert len(tasks) == int(enabled)
        running = getattr(app.state, "daemon_release_offers", None)
        assert isinstance(running, DaemonReleaseOffers) is enabled
        if enabled:
            await asyncio.wait_for(polled.wait(), 5)
    # Stopping waits out no poll interval: the lifespan has already returned.
    assert not hasattr(app.state, "daemon_release_offers")
    assert all(task.done() for task in tasks)
    assert polled.is_set() is enabled


@pytest.mark.parametrize("enabled", [True, False])
async def test_registration_transcript_is_unchanged_with_the_setting_on_and_off(
    app, file_sqlite_client, tmp_path, monkeypatch, enabled
):
    settings = get_settings()
    monkeypatch.setattr(settings, "support_log_dir", None)
    monkeypatch.setattr(settings, "prebuilt_dir", tmp_path / "prebuilt")
    monkeypatch.setattr(settings, "daemon_release_offers", enabled)
    monkeypatch.setattr(main, "init_engine", Mock())
    monkeypatch.setattr(main, "dispose_engine", AsyncMock())
    async with main.lifespan(app):
        assert hasattr(app.state, "daemon_release_offers") is enabled
        trace = await lifecycle_trace(app, file_sqlite_client, monkeypatch)
    baseline = Path(__file__).with_name("support_log_disabled_master.txt")
    assert trace == baseline.read_text()


# Trying an interrupted update again (issue #170).

INTERRUPTED = offers_mod.INTERRUPTED_UPDATE_ERROR
SIX_MINUTES = offers_mod.RETRY_AFTER_SECONDS
TREE_C = "c" * 40


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class WatchedSocket(Socket):
    """Sets `offered` once a `daemon.update` has been sent."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self.offered = asyncio.Event()

    async def send_text(self, value: str) -> None:
        await super().send_text(value)
        if '"daemon.update"' in value:
            self.offered.set()


@pytest.fixture
async def owned_fleet(client):
    owner, token = await _signup(client, f"retry-{uuid.uuid4().hex}@example.com")
    value = Fleet(owner)
    try:
        yield value, token
    finally:
        await value.close_all()


def update_fields(row: Host) -> tuple:
    return (row.update_state, row.update_tree, row.update_error, row.update_requested_at)


def trees(ws: Socket) -> list[str]:
    return [frame["tree"] for frame in ws.updates()]


async def interrupted(
    fleet: Fleet, host_id: str | None = None, *, socket: Socket | None = None, **fields
) -> tuple[str, Socket]:
    """A host whose update to the active release registration recorded as
    interrupted: offered it when it registered, then registered again on its
    old build with no result in between. `socket` is the second connection."""
    host_id, first = await fleet.connect(host_id, **fields)
    assert trees(first) == [TREE_B]
    await fleet.close(first)
    _, ws = await fleet.connect(host_id, socket=socket, **fields)
    row = await host_row(host_id)
    assert (row.update_state, row.update_tree, row.update_error) == ("failed", TREE_B, INTERRUPTED)
    assert release.host_update_state(row).state == "failed"
    assert ws.updates() == []
    return host_id, ws


def retry_records(caplog) -> list[str]:
    return [
        record.getMessage()
        for record in offer_records(caplog)
        if record.getMessage().startswith("daemon update retry")
    ]


async def test_an_interrupted_update_is_tried_again_after_six_minutes_on_one_connection(
    fleet, prebuilts, monkeypatch, caplog
):
    caplog.set_level(logging.INFO, logger=LOGGER)
    prebuilts.stage("b", TREE_B, 200)
    prebuilts.activate("b")
    host_id, ws = await interrupted(fleet)
    before = update_fields(await host_row(host_id))
    original = daemon_mod._auto_update_after_registration
    seen_by_offer: list[tuple] = []

    async def offer(conn):
        seen_by_offer.append(update_fields(await host_row(conn.host_id)))
        await original(conn)

    monkeypatch.setattr(daemon_mod, "_auto_update_after_registration", offer)
    clock, pauses = Clock(), Pauses()
    offers = DaemonReleaseOffers(pause=pauses, clock=clock)
    await offers.poll_once()

    clock.now += SIX_MINUTES - 1
    await offers.poll_once()
    assert ws.pings() == [] and ws.updates() == []
    assert update_fields(await host_row(host_id)) == before

    clock.now += 1
    await offers.poll_once()
    assert len(ws.pings()) == 1
    assert trees(ws) == [TREE_B]
    # The failure was cleared, and nothing else, before the offer function
    # read the host; that function then made its ordinary offer.
    assert seen_by_offer == [(None, TREE_B, None, before[3])]
    row = await host_row(host_id)
    assert (row.update_state, row.update_tree, row.update_error) == ("updating", TREE_B, None)
    assert release.host_update_state(row).state == "updating"

    # The same connection is not used again, even if its row read as
    # interrupted once more.
    await set_host(host_id, update_state="failed", update_error=INTERRUPTED)
    clock.now += 10 * 60
    await offers.poll_once()
    await offers.poll_once()
    assert len(ws.pings()) == 1 and len(ws.updates()) == 1
    assert pauses.calls == []
    assert retry_records(caplog) == [
        "daemon update retry 1 of 3: failure cleared; handed to the offer function"
    ]
    assert not any(host_id in record.getMessage() for record in offer_records(caplog))


async def test_only_an_interrupted_update_to_the_active_release_is_tried_again(
    fleet, prebuilts
):
    prebuilts.stage("b", TREE_B, 200)
    prebuilts.activate("b")
    control, control_ws = await interrupted(fleet)
    other_text, other_text_ws = await interrupted(fleet)
    await set_host(other_text, update_error="verify: sha256 mismatch")
    older, older_ws = await interrupted(fleet)
    await set_host(older, update_tree=TREE_A)
    updating, updating_ws = await interrupted(fleet)
    await set_host(
        updating,
        update_state="updating",
        update_error=None,
        update_requested_at=datetime.now(UTC),
    )
    current, current_ws = await fleet.connect(tree=TREE_B)
    no_self_update, no_self_update_ws = await fleet.connect(
        self_update=False, self_update_blocked="disabled"
    )
    # Registration repairs a mismatched pair whatever its state: one offer.
    mismatch, mismatch_ws = await fleet.connect(worker_mismatch=True)
    assert trees(mismatch_ws) == [TREE_B]
    for host_id in (current, no_self_update, mismatch):
        await set_host(
            host_id, update_state="failed", update_tree=TREE_B, update_error=INTERRUPTED
        )
    left_alone = {
        other_text: other_text_ws,
        older: older_ws,
        updating: updating_ws,
        current: current_ws,
        no_self_update: no_self_update_ws,
        mismatch: mismatch_ws,
    }
    before = {host_id: update_fields(await host_row(host_id)) for host_id in left_alone}
    offered_before = {host_id: len(ws.updates()) for host_id, ws in left_alone.items()}
    clock, pauses = Clock(), Pauses()
    offers = DaemonReleaseOffers(pause=pauses, clock=clock)
    await offers.poll_once()

    clock.now += SIX_MINUTES
    await offers.poll_once()

    assert trees(control_ws) == [TREE_B] and len(control_ws.pings()) == 1
    for host_id, ws in left_alone.items():
        assert ws.pings() == []
        assert len(ws.updates()) == offered_before[host_id]
        assert update_fields(await host_row(host_id)) == before[host_id]
    assert pauses.calls == []


async def test_automatic_update_off_tries_nothing_again(fleet, prebuilts, monkeypatch):
    prebuilts.stage("b", TREE_B, 200)
    prebuilts.activate("b")
    host_id, ws = await interrupted(fleet)
    before = update_fields(await host_row(host_id))
    monkeypatch.setattr(get_settings(), "daemon_auto_update", False)
    clock = Clock()
    offers = DaemonReleaseOffers(pause=Pauses(), clock=clock)
    await offers.poll_once()

    clock.now += SIX_MINUTES
    await offers.poll_once()

    assert ws.pings() == [] and ws.updates() == []
    assert update_fields(await host_row(host_id)) == before


async def test_a_retry_whose_ping_fails_writes_nothing_and_the_pass_continues(
    fleet, prebuilts, monkeypatch, caplog
):
    caplog.set_level(logging.INFO, logger=LOGGER)
    prebuilts.stage("b", TREE_B, 200)
    prebuilts.activate("b")
    silent, silent_ws = await interrupted(fleet, socket=Socket(ping="silent"))
    refusing, refusing_ws = await interrupted(fleet, socket=Socket(ping="refuse"))
    answering, answering_ws = await interrupted(fleet)
    broker = broker_mod.get_broker()
    real_ping = broker.request_host_ping

    async def ping(conn, *, timeout):
        # The silent daemon is really asked and never answers; its wait ends
        # at once, so the test sits out no real interval.
        return await real_ping(conn, timeout=0 if conn.host_id == silent else timeout)

    monkeypatch.setattr(broker, "request_host_ping", ping)
    before = {host_id: update_fields(await host_row(host_id)) for host_id in (silent, refusing)}
    clock, pauses = Clock(), Pauses()
    offers = DaemonReleaseOffers(pause=pauses, clock=clock)
    await offers.poll_once()

    clock.now += SIX_MINUTES
    await offers.poll_once()

    assert len(silent_ws.pings()) == 1
    for host_id, ws in ((silent, silent_ws), (refusing, refusing_ws)):
        assert ws.updates() == []
        assert update_fields(await host_row(host_id)) == before[host_id]
    assert trees(answering_ws) == [TREE_B]
    # One host at a time: the gap before each host after the first pinged.
    assert pauses.calls == [offers_mod.OFFER_GAP_SECONDS] * 2
    assert retry_records(caplog) == [
        "daemon update retry: no answer to the ping; nothing written",
        "daemon update retry for one host failed: WebSocketDisconnect",
        "daemon update retry 1 of 3: failure cleared; handed to the offer function",
    ]

    # Each connection is pinged for a retry once, whatever the answer.
    clock.now += SIX_MINUTES
    await offers.poll_once()
    assert len(silent_ws.pings()) == 1
    assert silent_ws.updates() == [] and refusing_ws.updates() == []
    assert update_fields(await host_row(silent)) == before[silent]


@pytest.mark.parametrize("change", ["registration", "try again", "reported failure"])
async def test_a_row_that_changes_before_the_write_is_left_as_it_became(
    owned_fleet, client, prebuilts, monkeypatch, caplog, change
):
    caplog.set_level(logging.INFO, logger=LOGGER)
    fleet, token = owned_fleet
    prebuilts.stage("b", TREE_B, 200)
    prebuilts.activate("b")
    host_id, ws = await interrupted(fleet)
    broker = broker_mod.get_broker()
    conn = broker.get_daemon_for_host(host_id)
    replacement = Socket()
    activated, resume = asyncio.Event(), asyncio.Event()
    original_accept = broker.accept_daemon_owner

    async def accept(candidate, generation):
        if candidate.websocket is replacement:
            # Its activation write has committed; it is not routable yet.
            activated.set()
            await resume.wait()
        return await original_accept(candidate, generation)

    async def change_row():
        if change == "registration":
            monkeypatch.setattr(broker, "accept_daemon_owner", accept)
            fleet.open(host_id, socket=replacement)
            await asyncio.wait_for(activated.wait(), 2)
        elif change == "try again":
            response = await client.post(
                f"/api/hosts/{host_id}/update",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert response.status_code == 202, response.text
        else:
            handled = await daemon_mod._handle_daemon_update_result(
                conn,
                {
                    "type": "daemon.update_result",
                    "request_id": "earlier",
                    "ok": False,
                    "tree": TREE_B,
                    "stage": "download",
                    "error": "request_failed",
                },
            )
            assert handled is True

    real_ping = broker.request_host_ping
    pinged = 0

    async def ping(target, *, timeout):
        # Between the task's read of the host and its conditional write.
        nonlocal pinged
        answered = await real_ping(target, timeout=timeout)
        pinged += 1
        if pinged == 1:
            await change_row()
        return answered

    monkeypatch.setattr(broker, "request_host_ping", ping)
    clock = Clock()
    offers = DaemonReleaseOffers(pause=Pauses(), clock=clock)
    await offers.poll_once()
    clock.now += SIX_MINUTES
    await offers.poll_once()

    assert pinged == 1
    assert retry_records(caplog) == [
        "daemon update retry: the host changed first; nothing written"
    ]
    row = await host_row(host_id)
    if change == "registration":
        resume.set()
        await asyncio.wait_for(replacement.idle.wait(), 10)
        row = await host_row(host_id)
        assert broker.get_daemon_for_host(host_id).websocket is replacement
        assert row.daemon_connection_id == broker.get_daemon_for_host(host_id).id
        # Nothing was lost: the replacement registered on the old build, the
        # failure stands, and the replacement's own six minutes begin.
        assert (row.update_state, row.update_tree, row.update_error) == (
            "failed",
            TREE_B,
            INTERRUPTED,
        )
        assert ws.updates() == [] and replacement.updates() == []
        await offers.poll_once()
        clock.now += SIX_MINUTES
        await offers.poll_once()
        assert trees(replacement) == [TREE_B]
    elif change == "try again":
        # The owner's offer is the only one.
        assert trees(ws) == [TREE_B]
        assert (row.update_state, row.update_tree, row.update_error) == ("updating", TREE_B, None)
    else:
        assert ws.updates() == []
        assert (row.update_state, row.update_tree, row.update_error) == (
            "failed",
            TREE_B,
            "download: request failed",
        )
        # A reported failure is the owner's: not tried again on a later
        # connection either.
        await fleet.close(ws)
        _, later = await fleet.connect(host_id)
        await offers.poll_once()
        clock.now += SIX_MINUTES
        await offers.poll_once()
        assert later.pings() == [] and later.updates() == []
        row = await host_row(host_id)
        assert row.update_error == "download: request failed"


async def test_three_retries_per_host_and_release_then_a_new_release_starts_again(
    fleet, prebuilts
):
    prebuilts.stage("b", TREE_B, 200)
    prebuilts.stage("c", TREE_C, 300)
    prebuilts.activate("b")
    host_id, ws = await interrupted(fleet)
    clock, pauses = Clock(), Pauses()
    offers = DaemonReleaseOffers(pause=pauses, clock=clock)
    await offers.poll_once()

    async def interrupted_again(ws: Socket, tree: str) -> Socket:
        # The machine sleeps during the download; its daemon registers again
        # on the old build.
        await fleet.close(ws)
        _, ws = await fleet.connect(host_id)
        row = await host_row(host_id)
        assert (row.update_state, row.update_tree, row.update_error) == (
            "failed",
            tree,
            INTERRUPTED,
        )
        await offers.poll_once()
        return ws

    for _ in range(offers_mod.RETRIES_PER_RELEASE):
        clock.now += SIX_MINUTES
        await offers.poll_once()
        assert trees(ws) == [TREE_B]
        ws = await interrupted_again(ws, TREE_B)

    clock.now += 10 * SIX_MINUTES
    await offers.poll_once()
    assert offers_mod.RETRIES_PER_RELEASE == 3
    assert ws.pings() == [] and ws.updates() == []
    row = await host_row(host_id)
    assert (row.update_state, row.update_error) == ("failed", INTERRUPTED)

    # A newer release is offered by the release pass, as before, and its own
    # retries start from none.
    prebuilts.activate("c")
    await offers.poll_once()
    assert trees(ws) == [TREE_C]
    ws = await interrupted_again(ws, TREE_C)
    clock.now += SIX_MINUTES
    await offers.poll_once()
    assert trees(ws) == [TREE_C]


async def test_a_connection_that_drops_and_returns_starts_its_six_minutes_again(
    fleet, prebuilts
):
    prebuilts.stage("b", TREE_B, 200)
    prebuilts.activate("b")
    host_id, first = await interrupted(fleet)
    clock = Clock()
    offers = DaemonReleaseOffers(pause=Pauses(), clock=clock)
    await offers.poll_once()

    clock.now += SIX_MINUTES - 60
    await fleet.close(first)
    _, second = await fleet.connect(host_id)
    # Registration leaves a failed row as it is.
    assert (await host_row(host_id)).update_error == INTERRUPTED
    await offers.poll_once()
    clock.now += 120
    await offers.poll_once()
    assert first.pings() == [] and second.pings() == [] and second.updates() == []

    clock.now += SIX_MINUTES - 120
    await offers.poll_once()
    assert trees(second) == [TREE_B]


@pytest.mark.parametrize("enabled", [True, False])
async def test_the_setting_that_stops_the_task_stops_the_retry(
    app, fleet, prebuilts, monkeypatch, enabled
):
    prebuilts.stage("b", TREE_B, 200)
    prebuilts.activate("b")
    settings = get_settings()
    monkeypatch.setattr(settings, "support_log_dir", None)
    monkeypatch.setattr(settings, "daemon_release_offers", enabled)
    monkeypatch.setattr(main, "init_engine", Mock())
    monkeypatch.setattr(main, "dispose_engine", AsyncMock())
    # No real interval is sat out: each poll follows the last at once.
    monkeypatch.setattr(offers_mod, "POLL_SECONDS", 0)

    async with main.lifespan(app):
        # Connected inside the lifespan, whose start restarts the in-process
        # pub/sub that connections depend on.
        host_id, ws = await interrupted(fleet, socket=WatchedSocket())
        before = update_fields(await host_row(host_id))
        # From here a connection may be retried as soon as a poll sees it.
        monkeypatch.setattr(offers_mod, "RETRY_AFTER_SECONDS", 0)
        if enabled:
            await asyncio.wait_for(ws.offered.wait(), 10)
        else:
            assert not hasattr(app.state, "daemon_release_offers")
            assert not [t for t in asyncio.all_tasks() if t.get_name() == "daemon-release-offers"]
            for _ in range(50):
                await asyncio.sleep(0)
        await fleet.close_all()

    if enabled:
        assert trees(ws) == [TREE_B]
        assert (await host_row(host_id)).update_state == "updating"
    else:
        assert ws.pings() == [] and ws.updates() == []
        assert update_fields(await host_row(host_id)) == before
