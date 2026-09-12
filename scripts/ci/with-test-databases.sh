#!/usr/bin/env bash
# Give a command fresh loopback-only fixtures without exposing host Docker.
set -euo pipefail
[[ "${SPAWN_RUNNER_ISOLATION:-}" == container && "$EUID" != 0 ]]
[[ $# -gt 0 ]]
pg_bin=/usr/lib/postgresql/16/bin
"$pg_bin/postgres" --version
redis-server --version | grep 'v=7\.'
fixture_dir="$(mktemp -d "${RUNNER_TEMP:?}/spawnd-test-services.XXXXXXXX")"
redis_pid=""
pg_started=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$redis_pid" ]]; then
    kill "$redis_pid" 2>/dev/null || true
    wait "$redis_pid" 2>/dev/null || true
  fi
  if [[ "$pg_started" == 1 ]]; then
    "$pg_bin/pg_ctl" -D "$fixture_dir/postgres" -m immediate -w stop || status=1
  fi
  if [[ "$status" != 0 ]]; then
    for log in "$fixture_dir"/*.log; do
      [[ ! -f "$log" ]] || tail -100 "$log" >&2
    done
  fi
  rm -rf -- "$fixture_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

read -r postgres_port redis_port < <(python3 - <<'PY'
import socket
with socket.socket() as pg, socket.socket() as redis:
    pg.bind(('127.0.0.1', 0))
    redis.bind(('127.0.0.1', 0))
    print(pg.getsockname()[1], redis.getsockname()[1])
PY
)
"$pg_bin/initdb" -D "$fixture_dir/postgres" --username=spawn \
  --auth-local=trust --auth-host=trust > "$fixture_dir/initdb.log"
pg_started=1
"$pg_bin/pg_ctl" -D "$fixture_dir/postgres" -l "$fixture_dir/postgres.log" \
  -o "-h 127.0.0.1 -p $postgres_port -k $fixture_dir" -w start
"$pg_bin/createdb" -h 127.0.0.1 -p "$postgres_port" -U spawn spawn
redis-server --bind 127.0.0.1 --port "$redis_port" --save '' --appendonly no \
  --dir "$fixture_dir" --daemonize no > "$fixture_dir/redis.log" 2>&1 &
redis_pid=$!
redis_ready=0
for _ in {1..100}; do
  if redis-cli -h 127.0.0.1 -p "$redis_port" ping 2>/dev/null | grep -qx PONG; then
    redis_ready=1
    break
  fi
  kill -0 "$redis_pid"
  sleep 0.1
done
[[ "$redis_ready" == 1 ]]
export SPAWN_TEST_POSTGRES_URL="postgresql+asyncpg://spawn@127.0.0.1:$postgres_port/spawn"
export SPAWN_TEST_REDIS_URL="redis://127.0.0.1:$redis_port/0"
"$@"
