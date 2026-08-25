#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

web_port="${SPAWN_DEV_WEB_PORT:-3000}"
api_port="${SPAWN_DEV_API_PORT:-8010}"
# Bind host for the API. Defaults to loopback; set to 0.0.0.0 to reach the dev
# server from another device on the LAN (the native mobile app in Expo Go).
api_host="${SPAWN_DEV_API_HOST:-127.0.0.1}"
public_url="http://localhost:${web_port}"
api_url="http://127.0.0.1:${api_port}"
daemon_config_dir="${SPAWN_DEV_DAEMON_CONFIG_DIR:-$repo_root/.spawn/local-daemon}"
daemon_worker_dir="${SPAWN_DEV_WORKER_DIR:-/tmp/spawn-dev-$(id -u)/workers}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'spawn dev: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need cargo
need curl
need lsof
need npm
need npx
need pg_isready
need python3
need redis-cli
need uv

if command -v bun >/dev/null 2>&1; then
  bun_command=(bun)
else
  bun_command=(npx --yes bun@1.3.14)
fi

port_must_be_free() {
  local port="$1"
  local label="$2"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'spawn dev: %s port %s is already in use:\n' "$label" "$port" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2
    printf 'stop that process, then run `npm run dev` again\n' >&2
    exit 1
  fi
}

port_must_be_free "$web_port" "web"
port_must_be_free "$api_port" "API"

if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  printf '%s\n' 'spawn dev: PostgreSQL is not ready on 127.0.0.1:5432' >&2
  exit 1
fi
if [[ "$(redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null || true)" != "PONG" ]]; then
  printf '%s\n' 'spawn dev: Redis is not ready on 127.0.0.1:6379' >&2
  exit 1
fi

# These defaults are deliberately localhost-only. Explicit caller values win.
export SPAWN_DATABASE_URL="${SPAWN_DATABASE_URL:-postgresql+asyncpg://spawn:spawn@127.0.0.1:5432/spawn}"
export SPAWN_REDIS_URL="${SPAWN_REDIS_URL:-redis://127.0.0.1:6379/0}"
export SPAWN_JWT_SECRET="${SPAWN_JWT_SECRET:-spawn-local-dev-only-secret-change-before-production}"
export SPAWN_PUBLIC_URL="${SPAWN_PUBLIC_URL:-$public_url}"
export SPAWN_WEB_URL="${SPAWN_WEB_URL:-$public_url}"
export SPAWN_CORS_ORIGINS="${SPAWN_CORS_ORIGINS:-$public_url}"
export SPAWN_REQUIRE_EMAIL_VERIFICATION="${SPAWN_REQUIRE_EMAIL_VERIFICATION:-false}"
export SPAWN_API_PROXY_TARGET="${SPAWN_API_PROXY_TARGET:-$api_url}"
export SPAWN_CONFIG_DIR="$daemon_config_dir"
export SPAWND_WORKER_DIR="$daemon_worker_dir"

printf '%s\n' '== preparing server =='
(cd server && uv sync --frozen && uv run alembic upgrade head)

printf '%s\n' '== preparing web =='
(cd web && "${bun_command[@]}" install --frozen-lockfile)

printf '%s\n' '== preparing daemon =='
(cd daemon && cargo build --locked --bin spawnd --bin spawn-worker)

# Check again after preparation so a concurrent process cannot make Next
# silently choose a different port while dependencies are being prepared.
port_must_be_free "$web_port" "web"
port_must_be_free "$api_port" "API"

child_pids=()
child_labels=()
launched_pid=""

launch_group() {
  local workdir="$1"
  shift
  (
    cd "$workdir"
    exec python3 -c \
      'import os, sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])' \
      "$@"
  ) &
  launched_pid="$!"
}

stop_group() {
  local pid="$1"
  local attempt

  # The short-lived launcher may exit before its descendants, but setsid(2)
  # leaves them in the private group named by its PID. Check the group itself
  # instead of treating a missing leader as proof that cleanup is complete.
  if kill -0 -- "-$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for ((attempt = 0; attempt < 50; attempt++)); do
      kill -0 -- "-$pid" 2>/dev/null || return 0
      sleep 0.1
    done
    printf 'spawn dev: process group %s did not stop after TERM; sending KILL\n' "$pid" >&2
    kill -KILL -- "-$pid" 2>/dev/null || true
  elif kill -0 "$pid" 2>/dev/null; then
    # Fail narrow if setsid did not establish the private group.
    kill -TERM "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local status="$?"
  local index
  local pid
  # npm forwards the terminal interrupt after bash has already received it.
  # Ignore repeats while cleanup runs so a second signal cannot strand the
  # later service groups.
  trap - EXIT
  trap '' INT TERM
  printf '\n%s\n' '== stopping spawn dev services =='
  for index in "${!child_pids[@]}"; do
    pid="${child_pids[$index]}"
    printf 'stopping %s (process group %s)\n' "${child_labels[$index]}" "$pid"
    stop_group "$pid"
  done
  for pid in "${child_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '== starting API at %s ==\n' "$api_url"
launch_group "$repo_root/server" \
  uv run uvicorn spawn_server.main:app --reload --host "$api_host" --port "$api_port" \
  --ws websockets-sansio
child_pids+=("$launched_pid")
child_labels+=("API")

printf '== starting web at %s ==\n' "$public_url"
launch_group "$repo_root/web" \
  "$repo_root/web/node_modules/.bin/next" dev -H 0.0.0.0 -p "$web_port"
child_pids+=("$launched_pid")
child_labels+=("web")

wait_for_web() {
  local attempt
  for ((attempt = 0; attempt < 120; attempt++)); do
    if curl -fsS "$public_url/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

if ! wait_for_web; then
  printf 'spawn dev: web/API did not become healthy at %s\n' "$public_url" >&2
  exit 1
fi

daemon_fingerprint() {
  {
    find "$repo_root/daemon/src" -type f -name '*.rs' -exec cksum {} \;
    cksum "$repo_root/daemon/Cargo.toml" "$repo_root/daemon/Cargo.lock"
  } | sort | cksum
}

daemon_watch() {
  local daemon_pid=""
  local current_fingerprint
  local next_fingerprint

  stop_daemon() {
    [[ -n "$daemon_pid" ]] || return 0
    stop_group "$daemon_pid"
    wait "$daemon_pid" 2>/dev/null || true
  }

  trap 'stop_daemon; exit 0' INT TERM
  current_fingerprint="$(daemon_fingerprint)"
  launch_group "$repo_root/daemon" \
    "$repo_root/daemon/target/debug/spawnd" --server "$public_url" run
  daemon_pid="$launched_pid"

  while kill -0 "$daemon_pid" 2>/dev/null; do
    sleep 1
    next_fingerprint="$(daemon_fingerprint)"
    [[ "$next_fingerprint" == "$current_fingerprint" ]] && continue
    current_fingerprint="$next_fingerprint"
    printf '%s\n' '== daemon source changed; rebuilding =='
    if (cd "$repo_root/daemon" && cargo build --locked --bin spawnd --bin spawn-worker); then
      stop_daemon
      launch_group "$repo_root/daemon" \
        "$repo_root/daemon/target/debug/spawnd" --server "$public_url" run
      daemon_pid="$launched_pid"
    else
      printf '%s\n' 'spawn dev: daemon rebuild failed; keeping web and API alive' >&2
    fi
  done
  wait "$daemon_pid"
}

if SPAWN_CONFIG_DIR="$daemon_config_dir" \
  daemon/target/debug/spawnd --server "$public_url" status --json 2>/dev/null \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if any(i.get("signed_in") for i in d.get("instances", [])) else 1)'; then
  printf '%s\n' '== starting isolated local daemon (Rust changes are watched) =='
  daemon_watch &
  child_pids+=("$!")
  child_labels+=("daemon")
else
  printf '%s\n' '== local daemon is not paired; web and API are running =='
  printf 'pair it in another terminal with:\n  SPAWN_CONFIG_DIR=%q daemon/target/debug/spawnd --server %q login\n' \
    "$daemon_config_dir" "$public_url"
fi

printf '\nspawn dev is ready: %s\n' "$public_url"
printf '%s\n' 'press Ctrl+C to stop the dev supervisors'

while :; do
  for index in "${!child_pids[@]}"; do
    pid="${child_pids[$index]}"
    if ! kill -0 "$pid" 2>/dev/null; then
      set +e
      wait "$pid"
      status="$?"
      set -e
      printf 'spawn dev: %s exited with status %s\n' "${child_labels[$index]}" "$status" >&2
      exit "$status"
    fi
  done
  sleep 0.5
done
