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

cleanup() {
  local status=$?
  if [[ -n "$subscriber_pid" ]]; then
    kill "$subscriber_pid" >/dev/null 2>&1 || true
    wait "$subscriber_pid" 2>/dev/null || true
  fi
  if [[ -n "$redis_container" ]]; then
    docker rm -f "$redis_container" >/dev/null 2>&1 || true
  elif [[ -n "$redis_pid" ]]; then
    kill "$redis_pid" >/dev/null 2>&1 || true
    wait "$redis_pid" 2>/dev/null || true
  fi
  if [[ "$status" != "0" ]]; then
    for log in "$tmp_dir"/redis.log "$tmp_dir"/subscriber.log "$tmp_dir"/publisher.log; do
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

from spawn_server.config import get_settings
from spawn_server.redis import get_backend

agent_id = os.environ["SPAWN_REDIS_SMOKE_AGENT_ID"]


async def main() -> None:
    get_settings.cache_clear()  # type: ignore[attr-defined]
    backend = get_backend()
    await backend.startup()
    try:
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

printf '%s\n' "smoke-redis-pubsub: passed"
