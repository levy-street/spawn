#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# `scripts/dev.sh --onboarding` (or `npm run dev --onboarding`, which npm turns
# into npm_config_onboarding=true) starts from a machine that has never heard
# of SPAWN D: every daemon instance and installed binary wiped, the local
# database recreated, Redis flushed, signed prebuilts staged for the local
# installer, and sign-up open (no invite). It prints the command for a throwaway
# browser profile rather than launching one: a fresh profile is the right way to
# walk this (device identity and host approvals start empty too), but opening it
# uninvited seizes the screen on every run. No dev daemon is built, started or
# watched either — you install it yourself from the one-liner the web app hands
# you, exactly as a new user does.
#
# Onboarding also starts Metro, because signing up and connecting a host is only
# half the flow — the other half is picking that session up on a phone. The
# native app derives its dev API URL from the Metro host it connected to (see
# mobile/src/data/api/config.ts), so a LAN Metro is what points Expo Go at this
# machine rather than at production. `--mobile` starts it without the reset;
# SPAWN_DEV_MOBILE=0 leaves it out of an onboarding run.
onboarding=0
mobile=0
for arg in "$@"; do
  case "$arg" in
    --onboarding) onboarding=1 ;;
    --mobile) mobile=1 ;;
    *) printf 'spawn dev: unknown argument %s\n' "$arg" >&2; exit 2 ;;
  esac
done
[[ "${npm_config_onboarding:-}" == "true" ]] && onboarding=1
[[ "${npm_config_mobile:-}" == "true" ]] && mobile=1
[[ "$onboarding" == "1" ]] && mobile=1
[[ "${SPAWN_DEV_MOBILE:-}" == "0" ]] && mobile=0

web_port="${SPAWN_DEV_WEB_PORT:-3000}"
api_port="${SPAWN_DEV_API_PORT:-8010}"
# Bind host for the API. Defaults to loopback; set to 0.0.0.0 to reach the dev
# server from another device on the LAN (the native mobile app in Expo Go).
api_host="${SPAWN_DEV_API_HOST:-127.0.0.1}"
public_url="http://localhost:${web_port}"
api_url="http://127.0.0.1:${api_port}"
metro_port="${SPAWN_DEV_METRO_PORT:-8081}"
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
  local hint="${3:-}"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'spawn dev: %s port %s is already in use:\n' "$label" "$port" >&2
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2
    [[ -n "$hint" ]] && printf '%s\n' "$hint" >&2
    printf 'stop that process, then run `npm run dev` again\n' >&2
    exit 1
  fi
}

# Refusing here rather than quietly skipping Metro is deliberate. A Metro left
# over from `scripts/update-mobile-prod.sh` runs with EXPO_PUBLIC_API_URL set to
# production — so carrying on without ours would hand you a QR code that points
# the phone at the live service while every other process here is local. That
# reads as a working test right up until it registers a real host.
metro_port_must_be_free() {
  port_must_be_free "$metro_port" "Metro" \
    'a Metro is already running — if it was started for production, the phone would reach that, not this machine'
}

# The phone reaches this machine by address, never by "localhost" — that word
# means the phone. Everything handed to Expo Go is built from this.
lan_address() {
  local candidate
  if [[ "$(uname -s)" == "Darwin" ]]; then
    for interface in en0 en1 en2 en3; do
      candidate="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
      [[ -n "$candidate" ]] && { printf '%s' "$candidate"; return 0; }
    done
  fi
  candidate="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  [[ -n "$candidate" ]] && printf '%s' "$candidate"
}

port_must_be_free "$web_port" "web"
port_must_be_free "$api_port" "API"
[[ "$mobile" == "1" ]] && metro_port_must_be_free

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
# The phone talks to this machine by address, and a browser opened there is a
# different origin from localhost. Allowing both costs nothing and saves a
# confusing CORS failure; the native app sends no Origin at all.
lan_ip=""
if [[ "$mobile" == "1" ]]; then
  lan_ip="$(lan_address)"
fi
cors_origins="$public_url"
[[ -n "$lan_ip" ]] && cors_origins="$cors_origins,http://${lan_ip}:${web_port}"
export SPAWN_CORS_ORIGINS="${SPAWN_CORS_ORIGINS:-$cors_origins}"
export SPAWN_REQUIRE_EMAIL_VERIFICATION="${SPAWN_REQUIRE_EMAIL_VERIFICATION:-false}"
if [[ "$onboarding" == "1" ]]; then
  export SPAWN_INVITE_ONLY="${SPAWN_INVITE_ONLY:-false}"
fi
export SPAWN_API_PROXY_TARGET="${SPAWN_API_PROXY_TARGET:-$api_url}"
export SPAWN_CONFIG_DIR="$daemon_config_dir"
export SPAWND_WORKER_DIR="$daemon_worker_dir"

if [[ "$onboarding" == "1" ]]; then
  printf '%s\n' '== onboarding: resetting this machine, the database, and Redis =='
  scripts/dev-reset.sh
fi
printf '%s\n' '== preparing server =='
(cd server && uv sync --frozen && uv run alembic upgrade head)

printf '%s\n' '== preparing web =='
(cd web && "${bun_command[@]}" install --frozen-lockfile)

if [[ "$mobile" == "1" ]]; then
  printf '%s\n' '== preparing mobile =='
  # `npm ci` is the reproducible install but it deletes node_modules every time,
  # which is a minute of an Expo tree for nothing. Run it only when there is
  # something to reconcile.
  if [[ ! -d mobile/node_modules || mobile/package-lock.json -nt mobile/node_modules ]]; then
    (cd mobile && npm ci --no-audit --no-fund)
  else
    printf '%s\n' 'mobile/node_modules is current'
  fi
  # Fail here, where the reason is obvious, rather than inside a supervised
  # subshell whose exec error scrolls past with the API and web logs.
  [[ -x mobile/node_modules/.bin/expo ]] || {
    printf 'spawn dev: mobile/node_modules/.bin/expo is missing after install\n' >&2
    printf 'run `cd mobile && npm ci`, then try again\n' >&2
    exit 1
  }
fi

# Onboarding installs the daemon from the signed prebuilts the local server
# serves, exactly as a new user does, so the dev debug build is not just wasted
# work — having it there invites reaching for the wrong binary.
if [[ "$onboarding" != "1" ]]; then
  printf '%s\n' '== preparing daemon =='
  (cd daemon && cargo build --locked --bin spawnd --bin spawn-worker)
fi

# Check again after preparation so a concurrent process cannot make Next
# silently choose a different port while dependencies are being prepared.
port_must_be_free "$web_port" "web"
port_must_be_free "$api_port" "API"
[[ "$mobile" == "1" ]] && metro_port_must_be_free

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

if [[ "$mobile" == "1" ]]; then
  printf '== starting Metro on port %s ==\n' "$metro_port"
  # EXPO_PUBLIC_API_URL is cleared deliberately. Set, it becomes the app's
  # compiled default and outranks the LAN address derived from this Metro — so
  # a shell that once published a production build would silently point the
  # phone at production while every other service here is local.
  # No CI=1 here, tempting as it is for a supervised process: it turns off
  # watch mode, so every JS edit would need Metro restarted by hand. Expo copes
  # with having no controlling terminal on its own — it just drops the keypress
  # menu, which nothing here was going to press anyway.
  launch_group "$repo_root/mobile" \
    env -u EXPO_PUBLIC_API_URL \
    "$repo_root/mobile/node_modules/.bin/expo" start --lan --port "$metro_port"
  child_pids+=("$launched_pid")
  child_labels+=("Metro")
fi

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
# Deliberately not opened for you. A throwaway profile is the right way to walk
# this as a new user, but launching one uninvited takes over the screen every
# run — including the runs where you already had a browser open on it.
if [[ "$onboarding" == "1" ]]; then
  printf '== onboarding: sign up in a fresh browser profile ==\n'
  printf 'open %s/signup — a private window, or a throwaway profile:\n' "$public_url"
  printf '  open -na "Google Chrome" --args --user-data-dir="$(mktemp -d)" --no-first-run %s/signup\n' \
    "$public_url"
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

if [[ "$onboarding" == "1" ]]; then
  printf '%s\n' '== onboarding: install SPAWN D the way a new user does =='
  printf 'sign up in the fresh browser window, then run the command the web app shows you:\n'
  printf '  curl -fsSL %s/install.sh | sh\n' "$public_url"
  printf 'it installs the signed prebuilts this server is serving into ~/.local/bin\n'
  printf 'and registers a launchd service that spawnd manages itself.\n'
  printf 'Rust changes are deliberately not watched here — restart with plain\n'
  printf '`npm run dev` when you want the dev daemon back.\n'
  if [[ "$mobile" == "1" ]]; then
    printf '\nthen pick the same account up on your phone:\n'
    if [[ -n "${lan_ip:-}" ]]; then
      printf '  open Expo Go and enter  exp://%s:%s\n' "$lan_ip" "$metro_port"
      printf '  the app derives its API from that address, so it talks to this machine\n'
    else
      printf '  no LAN address found for this machine — find it with\n'
      printf '    ipconfig getifaddr en0\n'
      printf '  and open  exp://<that address>:%s  in Expo Go\n' "$metro_port"
      printf '  (the app falls back to localhost otherwise, which is the phone)\n'
    fi
    printf '  the phone must be on the same network as this Mac\n'
  fi
elif SPAWN_CONFIG_DIR="$daemon_config_dir" \
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
if [[ "$mobile" == "1" && -n "${lan_ip:-}" ]]; then
  printf 'phone (Expo Go): exp://%s:%s\n' "$lan_ip" "$metro_port"
fi
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
