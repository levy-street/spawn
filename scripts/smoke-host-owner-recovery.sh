#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

tmp_dir="$(mktemp -d)"
postgres_container=""
redis_container=""

cleanup() {
  local status=$?
  if [[ -n "$postgres_container" ]]; then
    docker rm -f "$postgres_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$redis_container" ]]; then
    docker rm -f "$redis_container" >/dev/null 2>&1 || true
  fi
  if [[ "$status" != "0" ]]; then
    for log in "$tmp_dir"/*.log; do
      if [[ -f "$log" ]]; then
        tail -200 "$log" >&2 || true
      fi
    done
  fi
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT

free_port() {
  python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

database_url="${SPAWN_TEST_POSTGRES_URL:-}"
redis_url="${SPAWN_TEST_REDIS_URL:-}"

if [[ -z "$database_url" || -z "$redis_url" ]]; then
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    printf '%s\n' \
      "smoke-host-owner-recovery: set SPAWN_TEST_POSTGRES_URL and SPAWN_TEST_REDIS_URL, or start Docker" >&2
    exit 2
  fi

  postgres_port="$(free_port)"
  redis_port="$(free_port)"
  postgres_container="spawn-owner-postgres-$$"
  redis_container="spawn-owner-redis-$$"
  docker run --detach --rm \
    --name "$postgres_container" \
    -e POSTGRES_USER=spawn \
    -e POSTGRES_PASSWORD=spawn \
    -e POSTGRES_DB=spawn \
    -p "127.0.0.1:$postgres_port:5432" \
    postgres:16-alpine >"$tmp_dir/postgres.log"
  docker run --detach --rm \
    --name "$redis_container" \
    -p "127.0.0.1:$redis_port:6379" \
    redis:7-alpine >"$tmp_dir/redis.log"
  database_url="postgresql+asyncpg://spawn:spawn@127.0.0.1:$postgres_port/spawn"
  redis_url="redis://127.0.0.1:$redis_port/0"
fi

printf '%s\n' "smoke-host-owner-recovery: waiting for PostgreSQL and Redis"
services_ready=0
for _ in {1..120}; do
  if (
    cd server
    SPAWN_DATABASE_URL="$database_url" \
      SPAWN_REDIS_URL="$redis_url" \
      uv run python - <<'PY'
import asyncio

import asyncpg
import redis.asyncio as redis

from spawn_server.config import get_settings


async def main() -> None:
    settings = get_settings()
    pg_url = settings.database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    connection = await asyncpg.connect(pg_url)
    await connection.close()
    client = redis.from_url(settings.redis_url)
    try:
        await client.ping()
    finally:
        await client.aclose()


asyncio.run(main())
PY
  ) >/dev/null 2>&1; then
    services_ready=1
    break
  fi
  sleep 0.25
done
if [[ "$services_ready" != "1" ]]; then
  printf '%s\n' "smoke-host-owner-recovery: services did not become ready" >&2
  exit 1
fi

printf '%s\n' "smoke-host-owner-recovery: running crash and race gates"
(
  cd server
  SPAWN_DATABASE_URL="$database_url" \
    SPAWN_REDIS_URL="$redis_url" \
    SPAWN_USE_INPROCESS_PUBSUB=0 \
    SPAWN_TEST_EXTERNAL_SERVICES=1 \
    SPAWN_JWT_SECRET=host-owner-recovery-test-secret-32 \
    uv run pytest -q \
      tests/test_ws_daemon.py::test_registration_repairs_db_b_redis_a_with_successor_c \
      tests/test_ws_daemon.py::test_delayed_c_recovery_cannot_overwrite_successor_d \
      tests/test_ws_broker.py::test_committed_owner_promotion_repairs_older_cache_but_never_overwrites_successor \
      tests/test_ws_broker.py::test_distributed_result_rejects_owner_when_successor_is_pending \
      tests/test_ws_broker.py::test_host_rtc_replacement_blocks_stale_publish_and_preserves_binding
)

printf '%s\n' "smoke-host-owner-recovery: passed"
