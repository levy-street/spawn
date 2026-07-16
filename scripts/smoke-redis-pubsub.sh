#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-redis-pubsub: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need python3
need uv

tmp_dir="$(mktemp -d)"
redis_pid=""
redis_container=""
subscriber_pid=""
host_worker_pid=""

cleanup() {
  local status=$?
  if [[ -n "$subscriber_pid" ]]; then
    kill "$subscriber_pid" >/dev/null 2>&1 || true
    wait "$subscriber_pid" 2>/dev/null || true
  fi
  if [[ -n "$host_worker_pid" ]]; then
    kill "$host_worker_pid" >/dev/null 2>&1 || true
    wait "$host_worker_pid" 2>/dev/null || true
  fi
  if [[ -n "$redis_container" ]]; then
    docker rm -f "$redis_container" >/dev/null 2>&1 || true
  elif [[ -n "$redis_pid" ]]; then
    kill "$redis_pid" >/dev/null 2>&1 || true
    wait "$redis_pid" 2>/dev/null || true
  fi
  if [[ "$status" != "0" ]]; then
    for log in "$tmp_dir"/redis.log "$tmp_dir"/subscriber.log "$tmp_dir"/publisher.log "$tmp_dir"/host-worker.log "$tmp_dir"/host-claim.log; do
      if [[ -f "$log" ]]; then
        printf '%s\n' "---- $(basename "$log") ----" >&2
        tail -200 "$log" >&2 || true
      fi
    done
  fi
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT

redis_port="$(
  python3 - <<'PY'
import socket

s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
redis_url="redis://127.0.0.1:$redis_port/0"
agent_id="$(
  python3 - <<'PY'
import uuid

print(uuid.uuid4())
PY
)"
ready_file="$tmp_dir/subscriber.ready"
received_file="$tmp_dir/received.bin"

start_redis() {
  if command -v redis-server >/dev/null 2>&1; then
    printf 'smoke-redis-pubsub: starting redis-server on %s\n' "$redis_url"
    redis-server \
      --bind 127.0.0.1 \
      --port "$redis_port" \
      --save "" \
      --appendonly no \
      --dir "$tmp_dir" \
      >"$tmp_dir/redis.log" 2>&1 &
    redis_pid=$!
    return
  fi

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    redis_container="spawn-redis-smoke-$$"
    printf 'smoke-redis-pubsub: starting docker redis on %s\n' "$redis_url"
    docker run --rm \
      --name "$redis_container" \
      -p "127.0.0.1:$redis_port:6379" \
      redis:7-alpine \
      >"$tmp_dir/redis.log" 2>&1 &
    redis_pid=$!
    return
  fi

  printf '%s\n' "smoke-redis-pubsub: install redis-server or start Docker to run this smoke" >&2
  exit 2
}

wait_for_redis() {
  for _ in {1..120}; do
    if (
      cd server
      SPAWN_REDIS_URL="$redis_url" \
        SPAWN_USE_INPROCESS_PUBSUB=0 \
        uv run python - <<'PY'
import asyncio
import redis.asyncio as redis
from spawn_server.config import get_settings


async def main() -> None:
    get_settings.cache_clear()  # type: ignore[attr-defined]
    client = redis.from_url(get_settings().redis_url)
    try:
        await client.ping()
    finally:
        await client.aclose()


asyncio.run(main())
PY
    ) >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  printf '%s\n' "smoke-redis-pubsub: timed out waiting for Redis" >&2
  return 1
}

start_redis
wait_for_redis

printf '%s\n' "smoke-redis-pubsub: subscribing from one process"
(
  cd server
  SPAWN_REDIS_URL="$redis_url" \
    SPAWN_USE_INPROCESS_PUBSUB=0 \
    SPAWN_REDIS_SMOKE_AGENT_ID="$agent_id" \
    SPAWN_REDIS_SMOKE_READY="$ready_file" \
    SPAWN_REDIS_SMOKE_RECEIVED="$received_file" \
    uv run python - <<'PY'
import asyncio
import os
from pathlib import Path

from spawn_server.config import get_settings
from spawn_server.redis import get_backend

agent_id = os.environ["SPAWN_REDIS_SMOKE_AGENT_ID"]
ready_file = Path(os.environ["SPAWN_REDIS_SMOKE_READY"])
received_file = Path(os.environ["SPAWN_REDIS_SMOKE_RECEIVED"])


async def main() -> None:
    get_settings.cache_clear()  # type: ignore[attr-defined]
    backend = get_backend()
    await backend.startup()
    try:
        async with backend.subscribe(agent_id) as stream:
            ready_file.write_text("ready\n", encoding="utf-8")
            chunks: list[bytes] = []
            async for chunk in stream:
                chunks.append(chunk)
                body = b"".join(chunks)
                if body == b"hello redis pubsub":
                    received_file.write_bytes(body)
                    return
    finally:
        await backend.shutdown()


asyncio.run(main())
PY
) >"$tmp_dir/subscriber.log" 2>&1 &
subscriber_pid=$!

for _ in {1..80}; do
  if [[ -f "$ready_file" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -f "$ready_file" ]]; then
  printf '%s\n' "smoke-redis-pubsub: subscriber did not become ready" >&2
  exit 1
fi

printf '%s\n' "smoke-redis-pubsub: publishing from a second process"
(
  cd server
  SPAWN_REDIS_URL="$redis_url" \
    SPAWN_USE_INPROCESS_PUBSUB=0 \
    SPAWN_REDIS_SMOKE_AGENT_ID="$agent_id" \
    uv run python - <<'PY'
import asyncio
import os

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from spawn_server.config import get_settings
from spawn_server.db import Base
from spawn_server.models import Host, User
from spawn_server.redis import get_backend
from spawn_server.ws.daemon import (
    _allocate_host_generation,
    _host_activation_predecessor,
    _prepare_host_activation,
)
from spawn_server.ws.host_signal import (
    HostPresenceOwner,
    encode_host_presence_owner,
    host_pending_presence_key,
    host_presence_key,
)

agent_id = os.environ["SPAWN_REDIS_SMOKE_AGENT_ID"]


async def main() -> None:
    get_settings.cache_clear()  # type: ignore[attr-defined]
    backend = get_backend()
    await backend.startup()
    try:
        # Exercise explicit non-routable reservation followed by exact active
        # promotion against real Redis.
        inverse_host_id = "00000000-0000-4000-8000-000000000099"
        inverse_user_id = "00000000-0000-4000-8000-000000000098"
        old_owner = "a" * 32
        new_owner = "b" * 32
        inverse_owner_key = host_presence_key(inverse_host_id)
        inverse_pending_key = host_pending_presence_key(inverse_host_id)

        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with sessions() as session:
            session.add(User(id=inverse_user_id, email="inverse@example.com", password_hash="x"))
            session.add(
                Host(
                    id=inverse_host_id,
                    owner_user_id=inverse_user_id,
                    name="inverse-race",
                )
            )
            await session.commit()
        async with sessions() as session:
            old_generation = await _allocate_host_generation(
                session, inverse_host_id, old_owner
            )
        assert old_generation == 1
        old_lease = encode_host_presence_owner(HostPresenceOwner(old_owner, old_generation))
        claimed, _ = await backend.set_ephemeral_if_newer(
            inverse_pending_key, old_lease, generation=old_generation, ttl_seconds=60
        )
        assert claimed
        async with sessions() as session:
            assert await _host_activation_predecessor(
                session, inverse_host_id, old_owner, old_generation
            ) is None
            assert await _prepare_host_activation(
                session, inverse_host_id, old_owner, old_generation, {"version": "old"}
            )
            assert await backend.activate_ephemeral(
                inverse_pending_key,
                old_lease,
                inverse_owner_key,
                None,
                old_lease,
                ttl_seconds=60,
            )
            await session.commit()

        async with sessions() as session:
            new_generation = await _allocate_host_generation(
                session, inverse_host_id, new_owner
            )
        assert new_generation == 2
        new_lease = encode_host_presence_owner(
            HostPresenceOwner(new_owner, new_generation)
        )
        claimed, _ = await backend.set_ephemeral_if_newer(
            inverse_pending_key,
            new_lease,
            generation=new_generation,
            ttl_seconds=60,
        )
        assert claimed
        # Reservation is deliberately non-active: old routing remains intact.
        assert await backend.get_ephemeral(inverse_owner_key) == old_lease
        async with sessions() as session:
            assert await _host_activation_predecessor(
                session, inverse_host_id, new_owner, new_generation
            ) == HostPresenceOwner(old_owner, old_generation)
            assert await _prepare_host_activation(
                session, inverse_host_id, new_owner, new_generation, {"version": "new"}
            )
            assert await backend.activate_ephemeral(
                inverse_pending_key,
                new_lease,
                inverse_owner_key,
                old_lease,
                new_lease,
                ttl_seconds=60,
            )
            await session.commit()
        async with sessions() as session:
            durable = await session.get(Host, inverse_host_id)
            assert durable is not None
            assert durable.status == "online"
            assert durable.version == "new"
            assert durable.daemon_connection_id == new_owner
            assert durable.daemon_generation == new_generation
        assert await backend.get_ephemeral(inverse_owner_key) == new_lease
        assert await backend.refresh_ephemeral_if(
            inverse_owner_key, new_lease, ttl_seconds=60
        )
        await engine.dispose()

        owner_key = f"spawn:rtc:host:{agent_id}:owner"
        await backend.set_ephemeral(owner_key, b"old", ttl_seconds=60)
        assert await backend.swap_ephemeral(owner_key, b"new", ttl_seconds=60) == b"old"
        assert not await backend.refresh_ephemeral_if(owner_key, b"old", ttl_seconds=60)
        assert await backend.refresh_ephemeral_if(owner_key, b"new", ttl_seconds=60)
        assert await backend.get_ephemeral(owner_key) == b"new"
        assert not await backend.delete_ephemeral_if(owner_key, b"old")
        assert await backend.delete_ephemeral_if(owner_key, b"new")
        assert await backend.get_ephemeral(owner_key) is None
        await backend.publish(agent_id, b"hello ")
        await backend.publish(agent_id, b"redis ")
        await backend.publish(agent_id, b"pubsub")
    finally:
        await backend.shutdown()


asyncio.run(main())
PY
) >"$tmp_dir/publisher.log" 2>&1

for _ in {1..80}; do
  if [[ -f "$received_file" ]]; then
    break
  fi
  sleep 0.1
done
if [[ "$(cat "$received_file" 2>/dev/null || true)" != "hello redis pubsub" ]]; then
  printf '%s\n' "smoke-redis-pubsub: subscriber did not receive published payload" >&2
  exit 1
fi

wait "$subscriber_pid"
subscriber_pid=""

host_ready_file="$tmp_dir/host-worker.ready"
host_established_file="$tmp_dir/host-worker.established"
host_result_file="$tmp_dir/host-worker.result"
old_owner="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
new_owner="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
browser_route="cccccccccccccccccccccccccccccccc"
host_database_url="sqlite+aiosqlite:///$tmp_dir/host-race.db"

printf '%s\n' "smoke-redis-pubsub: starting old host-signaling worker"
(
  cd server
  SPAWN_REDIS_URL="$redis_url" \
    SPAWN_DATABASE_URL="$host_database_url" \
    SPAWN_USE_INPROCESS_PUBSUB=0 \
    SPAWN_REDIS_SMOKE_HOST_ID="$agent_id" \
    SPAWN_REDIS_SMOKE_OLD_OWNER="$old_owner" \
    SPAWN_REDIS_SMOKE_BROWSER_ROUTE="$browser_route" \
    SPAWN_REDIS_SMOKE_READY="$host_ready_file" \
    SPAWN_REDIS_SMOKE_ESTABLISHED="$host_established_file" \
    SPAWN_REDIS_SMOKE_RESULT="$host_result_file" \
    uv run python - <<'PY'
import asyncio
import json
import os
from pathlib import Path

from spawn_server.config import get_settings
from spawn_server.db import Base, dispose_engine, get_engine, get_sessionmaker
from spawn_server.models import Host, User
from spawn_server.redis import get_backend
from spawn_server.ws.broker import DaemonConn, get_broker
from spawn_server.ws.daemon import _pump_host_rtc_signals
from spawn_server.ws.host_signal import (
    HostPresenceOwner,
    browser_signal_channel,
    encode_host_presence_owner,
    host_presence_key,
)

host_id = os.environ["SPAWN_REDIS_SMOKE_HOST_ID"]
old_owner = os.environ["SPAWN_REDIS_SMOKE_OLD_OWNER"]
browser_route = os.environ["SPAWN_REDIS_SMOKE_BROWSER_ROUTE"]
ready_file = Path(os.environ["SPAWN_REDIS_SMOKE_READY"])
established_file = Path(os.environ["SPAWN_REDIS_SMOKE_ESTABLISHED"])
result_file = Path(os.environ["SPAWN_REDIS_SMOKE_RESULT"])
session_id = "redis-established-session"
user_id = "00000000-0000-4000-8000-000000000097"


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent_text: list[str] = []
        self.closed: tuple[int, str] | None = None

    async def send_text(self, value: str) -> None:
        self.sent_text.append(value)

    async def send_bytes(self, value: bytes) -> None:
        raise AssertionError(f"unexpected bytes: {len(value)}")

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = (code, reason)


async def wait_for_offer(websocket: FakeWebSocket) -> None:
    for _ in range(200):
        if any(json.loads(value).get("type") == "rtc.offer" for value in websocket.sent_text):
            return
        await asyncio.sleep(0.01)
    raise AssertionError("old worker did not receive the initial offer")


async def main() -> None:
    get_settings.cache_clear()  # type: ignore[attr-defined]
    backend = get_backend()
    await backend.startup()
    engine = get_engine()
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with get_sessionmaker()() as session:
        session.add(User(id=user_id, email="host-race@example.com", password_hash="x"))
        session.add(
            Host(
                id=host_id,
                owner_user_id=user_id,
                name="host-race",
                status="online",
                daemon_connection_id=old_owner,
                daemon_generation=1,
                daemon_generation_counter=1,
            )
        )
        await session.commit()
    broker = get_broker()
    websocket = FakeWebSocket()
    daemon = DaemonConn(
        host_id=host_id,
        user_id=user_id,
        websocket=websocket,  # type: ignore[arg-type]
        id=old_owner,
        host_generation=1,
    )
    assert await broker.accept_daemon_owner(daemon, 1)
    await backend.set_ephemeral(
        host_presence_key(host_id),
        encode_host_presence_owner(HostPresenceOwner(old_owner, 1)),
        ttl_seconds=60,
    )
    signal_ready = asyncio.Event()
    expiry_tasks: set[asyncio.Task[None]] = set()
    pump = asyncio.create_task(_pump_host_rtc_signals(daemon, signal_ready, expiry_tasks))
    response_channel = browser_signal_channel(browser_route)
    try:
        async with backend.subscribe_channel(response_channel) as responses:
            await signal_ready.wait()
            ready_file.write_text("ready\n", encoding="utf-8")
            await wait_for_offer(websocket)
            binding = await broker.rtc_session_for(session_id, daemon=daemon)
            assert binding is not None
            assert await broker.mark_rtc_session_connected(session_id, binding) is not None
            established_file.write_text("established\n", encoding="utf-8")

            await asyncio.wait_for(pump, timeout=5)
            unavailable = None
            async with asyncio.timeout(5):
                async for raw in responses:
                    value = json.loads(raw)
                    if value.get("status") == "unavailable":
                        unavailable = value
                        break

            frames = [json.loads(value) for value in websocket.sent_text]
            assert unavailable is not None
            assert unavailable["session_id"] == session_id
            assert any(
                frame.get("type") == "rtc.close" and frame.get("session_id") == session_id
                for frame in frames
            )
            assert not any(frame.get("session_id") == "redis-stale-offer" for frame in frames)
            assert websocket.closed == (4000, "superseded")
            assert await broker.rtc_session_for(session_id) is None
            result_file.write_text("passed\n", encoding="utf-8")
    finally:
        for task in list(expiry_tasks):
            task.cancel()
        if expiry_tasks:
            await asyncio.gather(*expiry_tasks, return_exceptions=True)
        pump.cancel()
        await asyncio.gather(pump, return_exceptions=True)
        await broker.unregister_daemon(daemon)
        await backend.shutdown()
        await dispose_engine()


asyncio.run(main())
PY
) >"$tmp_dir/host-worker.log" 2>&1 &
host_worker_pid=$!

for _ in {1..80}; do
  if [[ -f "$host_ready_file" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -f "$host_ready_file" ]]; then
  printf '%s\n' "smoke-redis-pubsub: old host worker did not become ready" >&2
  exit 1
fi

printf '%s\n' "smoke-redis-pubsub: racing a replacement host-signaling worker"
(
  cd server
  SPAWN_REDIS_URL="$redis_url" \
    SPAWN_DATABASE_URL="$host_database_url" \
    SPAWN_USE_INPROCESS_PUBSUB=0 \
    SPAWN_REDIS_SMOKE_HOST_ID="$agent_id" \
    SPAWN_REDIS_SMOKE_OLD_OWNER="$old_owner" \
    SPAWN_REDIS_SMOKE_NEW_OWNER="$new_owner" \
    SPAWN_REDIS_SMOKE_BROWSER_ROUTE="$browser_route" \
    SPAWN_REDIS_SMOKE_ESTABLISHED="$host_established_file" \
    uv run python - <<'PY'
import asyncio
import os
from pathlib import Path

from spawn_server.config import get_settings
from spawn_server.db import dispose_engine, get_sessionmaker
from spawn_server.redis import get_backend
from spawn_server.ws.daemon import (
    _allocate_host_generation,
    _host_activation_predecessor,
    _prepare_host_activation,
)
from spawn_server.ws.host_signal import (
    HOST_CONTROL_PROTOCOL,
    HOST_CONTROL_VERSION,
    HostOwnerRevocation,
    HostPresenceOwner,
    HostSignalEnvelope,
    browser_signal_channel,
    encode_host_presence_owner,
    host_pending_presence_key,
    host_presence_key,
    publish_host_owner_revocation,
    publish_host_signal,
)

host_id = os.environ["SPAWN_REDIS_SMOKE_HOST_ID"]
old_owner = os.environ["SPAWN_REDIS_SMOKE_OLD_OWNER"]
new_owner = os.environ["SPAWN_REDIS_SMOKE_NEW_OWNER"]
browser_route = os.environ["SPAWN_REDIS_SMOKE_BROWSER_ROUTE"]
established_file = Path(os.environ["SPAWN_REDIS_SMOKE_ESTABLISHED"])


def signal(session_id: str) -> dict[str, object]:
    return {
        "type": "rtc.offer",
        "session_id": session_id,
        "scope_type": "host",
        "scope_id": host_id,
        "protocol": HOST_CONTROL_PROTOCOL,
        "protocol_version": HOST_CONTROL_VERSION,
        "sdp": "v=0\r\n",
        "ice_servers": [],
        "ice_transport_policy": "all",
    }


async def main() -> None:
    get_settings.cache_clear()  # type: ignore[attr-defined]
    backend = get_backend()
    await backend.startup()
    route = browser_signal_channel(browser_route)
    try:
        await publish_host_signal(
            host_id,
            HostSignalEnvelope(old_owner, 1, route, signal("redis-established-session")),
        )
        for _ in range(200):
            if established_file.exists():
                break
            await asyncio.sleep(0.01)
        assert established_file.exists(), "old worker did not establish the session"

        async with get_sessionmaker()() as session:
            generation = await _allocate_host_generation(session, host_id, new_owner)
        assert generation == 2

        replacement_lease = encode_host_presence_owner(
            HostPresenceOwner(new_owner, generation)
        )
        claimed, previous = await backend.set_ephemeral_if_newer(
            host_pending_presence_key(host_id),
            replacement_lease,
            generation=generation,
            ttl_seconds=60,
        )
        assert claimed
        assert previous is None
        old_lease = encode_host_presence_owner(HostPresenceOwner(old_owner, 1))
        assert await backend.get_ephemeral(host_presence_key(host_id)) == old_lease
        async with get_sessionmaker()() as session:
            assert await _host_activation_predecessor(
                session, host_id, new_owner, generation
            ) == HostPresenceOwner(old_owner, 1)
            assert await _prepare_host_activation(
                session, host_id, new_owner, generation, {"version": "replacement"}
            )
            await session.commit()
        assert await backend.activate_ephemeral(
            host_pending_presence_key(host_id),
            replacement_lease,
            host_presence_key(host_id),
            old_lease,
            replacement_lease,
            ttl_seconds=60,
        )
        # Deliberately publish the stale offer before the revocation event. The
        # old worker must fence on the current lease generation, not event order.
        await publish_host_signal(
            host_id,
            HostSignalEnvelope(old_owner, 1, route, signal("redis-stale-offer")),
        )
        await publish_host_owner_revocation(
            host_id,
            HostOwnerRevocation(old_owner, new_owner),
        )
    finally:
        await backend.shutdown()
        await dispose_engine()


asyncio.run(main())
PY
) >"$tmp_dir/host-claim.log" 2>&1

for _ in {1..80}; do
  if [[ -f "$host_result_file" ]]; then
    break
  fi
  sleep 0.1
done
if [[ "$(cat "$host_result_file" 2>/dev/null || true)" != "passed" ]]; then
  printf '%s\n' "smoke-redis-pubsub: host owner race did not revoke cleanly" >&2
  exit 1
fi

wait "$host_worker_pid"
host_worker_pid=""

printf '%s\n' "smoke-redis-pubsub: passed"
