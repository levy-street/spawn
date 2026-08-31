"""Host capacity validation, the daily rollup, and `GET /api/profile`."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest

from spawn_server import host_capacity, legion


async def _signup(client, email: str) -> str:
    r = await client.post("/api/auth/signup", json={"email": email, "password": "passpasspass"})
    assert r.status_code == 200
    return r.json()["access_token"]


async def _user_id(email: str) -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import User

    sm = get_sessionmaker()
    async with sm() as session:
        return (await session.execute(select(User).where(User.email == email))).scalar_one().id


async def _create_host(email: str, *, name: str = "box", **columns) -> str:
    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host, User

    sm = get_sessionmaker()
    async with sm() as session:
        user = (await session.execute(select(User).where(User.email == email))).scalar_one()
        # An online fixture represents a currently connected daemon. Presence
        # serialization now also requires its heartbeat to be fresh.
        columns.setdefault("last_seen_at", datetime.now(UTC))
        host = Host(owner_user_id=user.id, name=name, status="online", **columns)
        session.add(host)
        await session.commit()
        return host.id


# ---------------------------------------------------------------- validation


def test_spec_keeps_each_good_field_and_drops_each_bad_one():
    values = host_capacity.spec_values(
        {
            "cpu_cores": 64,
            "cpu_physical_cores": 0,  # nonsense
            "cpu_model": "AMD Ryzen Threadripper",
            "memory_bytes": -1,  # nonsense
            "gpu": "2× RTX 4090",
        }
    )
    # Partial truth beats none: one bad field must not discard the good ones.
    assert values == {
        "cpu_cores": 64,
        "cpu_model": "AMD Ryzen Threadripper",
        "gpu": "2× RTX 4090",
    }


def test_spec_from_a_daemon_that_reports_nothing_writes_nothing():
    assert host_capacity.spec_values(None) == {}
    assert host_capacity.spec_values({}) == {}
    assert host_capacity.spec_values("64 cores") == {}


def test_spec_labels_are_bounded_and_stripped_of_control_characters():
    values = host_capacity.spec_values(
        {"cpu_model": "  Core i9  ", "gpu": "G" * (host_capacity.MAX_MODEL_CHARS + 40)}
    )
    assert values["cpu_model"] == "Core i9"
    assert len(values["gpu"]) == host_capacity.MAX_MODEL_CHARS


def test_spec_rejects_a_topology_no_machine_has():
    assert "cpu_cores" not in host_capacity.spec_values({"cpu_cores": 10**9})
    assert "memory_bytes" not in host_capacity.spec_values({"memory_bytes": 1 << 60})
    # `True` is an int in Python and would otherwise store as one core.
    assert "cpu_cores" not in host_capacity.spec_values({"cpu_cores": True})


def test_buckets_ride_the_heartbeat_only_when_one_is_present():
    assert host_capacity.bucket_values({"type": "host.heartbeat"}) == {}
    values = host_capacity.bucket_values({"cpu_bucket": 3, "mem_bucket": 0})
    assert values["cpu_bucket"] == 3
    assert values["mem_bucket"] == 0
    assert isinstance(values["capacity_at"], datetime)


def test_a_bucket_outside_the_meter_is_refused_rather_than_clamped():
    # Clamping would quietly render a forged 99 as a pinned machine.
    assert host_capacity.bucket_values({"cpu_bucket": 9, "mem_bucket": 2})["cpu_bucket"] is None
    assert host_capacity.bucket_values({"cpu_bucket": -1, "mem_bucket": 2})["cpu_bucket"] is None
    assert host_capacity.bucket_values({"cpu_bucket": "5"}) == {}


# -------------------------------------------------------------------- streaks


def test_streak_counts_back_from_today():
    days = ["2026-08-19", "2026-08-20", "2026-08-21"]
    assert legion.streaks(days, "2026-08-21") == (3, 3)


def test_a_streak_survives_a_today_with_no_work_in_it_yet():
    # 00:01 UTC, before the day's first session: the streak is not broken.
    days = ["2026-08-19", "2026-08-20"]
    assert legion.streaks(days, "2026-08-21") == (2, 2)


def test_a_whole_missed_day_breaks_the_current_streak_but_keeps_the_record():
    days = ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-19"]
    assert legion.streaks(days, "2026-08-21") == (0, 3)


def test_streaks_of_nothing_are_zero_not_an_error():
    assert legion.streaks([], "2026-08-21") == (0, 0)


def test_streaks_ignore_duplicate_and_unsorted_days():
    days = ["2026-08-21", "2026-08-19", "2026-08-20", "2026-08-20"]
    assert legion.streaks(days, "2026-08-21") == (3, 3)


# --------------------------------------------------------------- agent tally


def test_agent_tally_is_bounded_but_known_names_keep_counting():
    tally: dict[str, int] = {}
    for index in range(legion.MAX_AGENTS_PER_DAY + 10):
        tally = legion.merge_agent(tally, f"tool{index}")
    assert len(tally) == legion.MAX_AGENTS_PER_DAY
    # A name already in the tally is never dropped for being over the cap.
    tally = legion.merge_agent(tally, "tool0")
    assert tally["tool0"] == 2


def test_a_corrupt_tally_reads_as_empty_rather_than_failing():
    assert legion.parse_agents("not json") == {}
    assert legion.parse_agents('["claude"]') == {}
    assert legion.parse_agents(None) == {}
    # Individually bad entries are dropped; good ones survive.
    assert legion.parse_agents('{"claude": 3, "codex": "x", "aider": -1}') == {"claude": 3}


def test_utc_day_is_the_servers_day_whatever_the_offset():
    moment = datetime(2026, 8, 21, 23, 30, tzinfo=UTC) + timedelta(hours=1)
    assert legion.utc_day(moment) == "2026-08-22"
    assert legion.utc_day(datetime(2026, 8, 21, 12, 0)) == "2026-08-21"


# -------------------------------------------------------------------- profile


@pytest.mark.anyio
async def test_profile_reports_the_fleet_and_sums_only_reported_specs(client):
    token = await _signup(client, "legion@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    await _create_host(
        "legion@example.com",
        name="nightmare",
        cpu_cores=64,
        memory_bytes=256 * 1024**3,
        gpu="2× RTX 4090",
    )
    # A silent daemon: it must lower nothing and invent nothing.
    await _create_host("legion@example.com", name="quiet")

    r = await client.get("/api/profile", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["email"] == "legion@example.com"
    assert body["totals"]["hosts"] == 2
    assert body["totals"]["hosts_online"] == 2
    assert body["totals"]["cores"] == 64
    assert {host["name"] for host in body["hosts"]} == {"nightmare", "quiet"}
    assert body["today"] == legion.utc_day()


@pytest.mark.anyio
async def test_profile_of_a_new_account_is_empty_rather_than_absent(client):
    token = await _signup(client, "fresh@example.com")
    r = await client.get("/api/profile", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    body = r.json()
    assert body["totals"]["hosts"] == 0
    assert body["totals"]["current_streak"] == 0
    assert body["days"] == []
    assert body["agents"] == []
    assert body["totals"]["first_day"] is None


@pytest.mark.anyio
async def test_profile_requires_a_session(client):
    r = await client.get("/api/profile")
    assert r.status_code in (401, 403)


@pytest.mark.anyio
async def test_profile_never_shows_another_accounts_legion(client):
    mine = await _signup(client, "mine@example.com")
    await _signup(client, "theirs@example.com")
    await _create_host("theirs@example.com", name="not-mine", cpu_cores=128)

    r = await client.get("/api/profile", headers={"Authorization": f"Bearer {mine}"})
    assert r.json()["totals"]["hosts"] == 0
    assert r.json()["totals"]["cores"] == 0


@pytest.mark.anyio
async def test_rollups_accumulate_and_surface_on_the_profile(client):
    token = await _signup(client, "rollup@example.com")
    user_id = await _user_id("rollup@example.com")

    await legion.record_session_started(user_id)
    await legion.record_session_started(user_id)
    await legion.record_session_seconds(user_id, 4_000)
    await legion.record_agent(user_id, "claude")
    await legion.record_agent(user_id, "claude")
    await legion.record_agent(user_id, "codex")
    await legion.record_peaks(user_id, sessions=5, hosts_online=3)
    # A later, lower peak must not lower the high-water mark.
    await legion.record_peaks(user_id, sessions=1, hosts_online=1)

    r = await client.get("/api/profile", headers={"Authorization": f"Bearer {token}"})
    body = r.json()
    assert body["totals"]["sessions_started"] == 2
    assert body["totals"]["session_seconds"] == 4_000
    assert body["totals"]["peak_sessions"] == 5
    assert body["totals"]["peak_hosts_online"] == 3
    assert body["totals"]["active_days"] == 1
    assert body["totals"]["current_streak"] == 1
    assert body["agents"] == [{"command": "claude", "count": 2}, {"command": "codex", "count": 1}]
    assert body["days"][0]["day"] == legion.utc_day()


@pytest.mark.anyio
async def test_a_zero_length_session_books_nothing(client):
    await _signup(client, "zero@example.com")
    user_id = await _user_id("zero@example.com")
    await legion.record_session_seconds(user_id, 0)
    await legion.record_session_seconds(user_id, -30)

    from sqlalchemy import select

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import LegionDay

    sm = get_sessionmaker()
    async with sm() as session:
        rows = (
            (await session.execute(select(LegionDay).where(LegionDay.owner_user_id == user_id)))
            .scalars()
            .all()
        )
    assert rows == []


@pytest.mark.anyio
async def test_the_daily_record_outlives_the_sessions_it_counted(client):
    """The whole reason `legion_days` exists.

    Sessions are hard-deleted with their workspace, so a profile computed from
    the sessions table would show a person's history shrinking as they tidy up.
    """
    token = await _signup(client, "durable@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("durable@example.com")

    created = await client.post("/api/sessions", json={"host_id": host_id, "cwd": "/repo"}, headers=headers)
    assert created.status_code == 201
    session_id = created.json()["id"]

    before = await client.get("/api/profile", headers=headers)
    assert before.json()["totals"]["sessions_started"] == 1

    deleted = await client.delete(f"/api/sessions/{session_id}", headers=headers)
    assert deleted.status_code in (200, 204)

    after = await client.get("/api/profile", headers=headers)
    assert after.json()["totals"]["sessions_started"] == 1
    assert after.json()["totals"]["sessions_live"] == 0


@pytest.mark.anyio
async def test_a_rollup_failure_never_reaches_the_caller(client, monkeypatch):
    """Accounting must not be able to break the thing it is counting."""
    token = await _signup(client, "resilient@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    host_id = await _create_host("resilient@example.com")

    async def explode(*args, **kwargs):
        raise RuntimeError("rollup backend is down")

    monkeypatch.setattr(legion, "_day_row", explode)
    created = await client.post("/api/sessions", json={"host_id": host_id, "cwd": "/repo"}, headers=headers)
    assert created.status_code == 201


@pytest.mark.anyio
async def test_host_list_reports_capacity_and_withholds_a_dead_hosts_meter(client):
    token = await _signup(client, "meters@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    await _create_host("meters@example.com", name="live", cpu_cores=8, cpu_bucket=4, mem_bucket=2)
    await _create_host("meters@example.com", name="dead", cpu_cores=8, cpu_bucket=5, mem_bucket=5)

    from sqlalchemy import update

    from spawn_server.db import get_sessionmaker
    from spawn_server.models import Host

    sm = get_sessionmaker()
    async with sm() as session:
        await session.execute(update(Host).where(Host.name == "dead").values(status="offline"))
        await session.commit()

    rows = {host["name"]: host for host in (await client.get("/api/hosts", headers=headers)).json()}
    assert rows["live"]["cpu_bucket"] == 4
    assert rows["live"]["cpu_cores"] == 8
    # The spec is still true when a machine is off; the meter is not.
    assert rows["dead"]["cpu_bucket"] is None
    assert rows["dead"]["mem_bucket"] is None
    assert rows["dead"]["cpu_cores"] == 8


def test_legion_day_json_round_trips_through_the_column():
    tally = legion.merge_agent(legion.parse_agents(json.dumps({"claude": 4})), "codex")
    assert legion.parse_agents(json.dumps(tally)) == {"claude": 4, "codex": 1}
