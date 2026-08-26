#!/usr/bin/env bash
set -euo pipefail

# Put this machine back to "never had SPAWN D" so a local run of dev.sh can be
# walked exactly the way a new production user walks it: every spawnd instance
# on the device is stopped and wiped (services, credentials, workers, the
# installed binaries), the local database is dropped and recreated, Redis is
# flushed, and daemon/target/prebuilt/ is re-staged with a release build and a
# manifest signed by the local release key so the install one-liner served by
# the local server installs verified prebuilts instead of building from source.
#
# Usage: scripts/dev-reset.sh            (dev.sh --onboarding runs this)
#        scripts/dev-reset.sh --self-test
#
# This never talks to any server. A host row on spawnd.dev for a daemon wiped
# here stays until it is removed under Hosts in the web app.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

say() { printf 'dev-reset: %s\n' "$*"; }

# A long step's heartbeat. cargo prints a progress bar while it walks the
# dependency graph, but that bar goes *static* once it is down to linking one
# crate — and spawnd's final thin-LTO link is minutes on its own. Without a
# clock ticking, that window is indistinguishable from a hang.
_ticker_pid=""
start_ticker() {
  [[ -t 1 ]] || return 0
  local label="$1" started="$SECONDS"
  (
    while :; do
      sleep 20
      printf 'dev-reset:   %s — %dm%02ds elapsed\n' \
        "$label" "$(((SECONDS - started) / 60))" "$(((SECONDS - started) % 60))"
    done
  ) &
  _ticker_pid="$!"
}
stop_ticker() {
  [[ -n "$_ticker_pid" ]] || return 0
  kill "$_ticker_pid" 2>/dev/null || true
  wait "$_ticker_pid" 2>/dev/null || true
  _ticker_pid=""
}
elapsed_since() { printf '%dm%02ds' "$(((SECONDS - $1) / 60))" "$(((SECONDS - $1) % 60))"; }
trap stop_ticker EXIT INT TERM
sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi; }

if [[ "${1:-}" == "--self-test" ]]; then
  [[ "$#" -eq 1 ]] || { say "--self-test takes no other arguments" >&2; exit 1; }
  bash -n "${BASH_SOURCE[0]}"
  # The launchd label filter must never match anything but spawnd units.
  grep -q 'app\.spawn\.spawnd' "${BASH_SOURCE[0]}"
  # The daemon build must stay visible: silencing it reads as a hang. This
  # exact form only holds while the build runs unredirected into a status
  # check, so re-silencing it fails here rather than in a confused terminal.
  grep -q 'cargo build --locked --release --bin spawnd --bin spawn-worker) || build_status' \
    "${BASH_SOURCE[0]}"
  say "self-test ok"
  exit 0
fi

uid="$(id -u)"
db_url="${SPAWN_DATABASE_URL:-postgresql+asyncpg://spawn:spawn@127.0.0.1:5432/spawn}"
redis_url="${SPAWN_REDIS_URL:-redis://127.0.0.1:6379/0}"
daemon_config_dir="${SPAWN_DEV_DAEMON_CONFIG_DIR:-$repo_root/.spawn/local-daemon}"
daemon_worker_dir="${SPAWN_DEV_WORKER_DIR:-/tmp/spawn-dev-$uid/workers}"
install_roots=("$HOME/.local" "$HOME/.local-spawn-test")
config_base="$HOME/Library/Application Support/spawn"
[[ "$(uname -s)" == "Darwin" ]] || config_base="${XDG_CONFIG_HOME:-$HOME/.config}/spawn"

# Never silence this. It is the longest step in the script by a wide margin,
# and a swallowed build turns it into a dead terminal for minutes.
build_started="$SECONDS"
say "building the daemon that knows how to reset"
say "  release build; the final link of spawnd alone takes minutes on a cold cache"
start_ticker "still building"
build_status=0
(cd daemon && cargo build --locked --release --bin spawnd --bin spawn-worker) || build_status="$?"
stop_ticker
if [[ "$build_status" -ne 0 ]]; then
  say "the release build failed (output above); nothing has been reset" >&2
  exit "$build_status"
fi
say "built in $(elapsed_since "$build_started")"
spawnd="$repo_root/daemon/target/release/spawnd"

# 1. Every instance under the default base, then the dev.sh instance. `reset`
#    stops the service, terminates workers, and wipes the directories without
#    contacting a server; --yes skips the confirmation.
say "wiping every spawnd instance on this machine"
if [[ -d "$config_base" ]]; then
  SPAWN_DISABLE_KEYRING=1 "$spawnd" reset --yes 2>&1 | sed 's/^/  /' || true
fi
if [[ -d "$daemon_config_dir" ]]; then
  SPAWN_DISABLE_KEYRING=1 SPAWN_CONFIG_DIR="$daemon_config_dir" "$spawnd" reset --yes 2>&1 | sed 's/^/  /' || true
fi

# 2. Belt and braces for anything a reset could not reach: launchd units,
#    stray processes, worker dirs, the installed binaries.
if [[ "$(uname -s)" == "Darwin" ]]; then
  for plist in "$HOME"/Library/LaunchAgents/app.spawn.spawnd*.plist; do
    [[ -f "$plist" ]] || continue
    label="$(basename "$plist" .plist)"
    launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
    rm -f "$plist"
    say "removed launchd unit $label"
  done
fi
pkill -u "$uid" -f '(^|/)spawn-worker( |$)' >/dev/null 2>&1 || true
pkill -u "$uid" -f '(^|/)spawnd( |$)' >/dev/null 2>&1 || true
sleep 1
pkill -9 -u "$uid" -f '(^|/)spawn-worker( |$)' >/dev/null 2>&1 || true
pkill -9 -u "$uid" -f '(^|/)spawnd( |$)' >/dev/null 2>&1 || true
rm -rf "$config_base" "$daemon_config_dir" "$daemon_worker_dir" /tmp/spawn-"$uid"* /tmp/spawn-dev-"$uid"
for root in "${install_roots[@]}"; do
  for bin in spawnd spawn-worker; do
    if [[ -e "$root/bin/$bin" ]]; then
      rm -f "$root/bin/$bin" "$root/bin/$bin.prev" "$root/bin/spawnd.updating"
      say "removed $root/bin/$bin"
    fi
  done
done

# 3. Database and Redis. Only the local dev database is ever dropped.
if [[ "$db_url" == postgresql* ]]; then
  db_name="${db_url##*/}"; db_name="${db_name%%\?*}"
  rest="${db_url#*://}"; creds="${rest%%@*}"; hostport="${rest#*@}"; hostport="${hostport%%/*}"
  db_user="${creds%%:*}"; db_pass="${creds#*:}"
  db_host="${hostport%%:*}"; db_port="${hostport##*:}"; [[ "$db_port" == "$db_host" ]] && db_port=5432
  case "$db_host" in 127.0.0.1|localhost|::1) ;; *) say "refusing to drop a non-local database at $db_host" >&2; exit 1 ;; esac
  # Prove the role can create a database *before* dropping one. Without this a
  # role that owns $db_name but lacks CREATEDB drops it and then fails, leaving
  # the machine with no database at all and no way for this script to make one.
  can_create="$(PGPASSWORD="$db_pass" psql -h "$db_host" -p "$db_port" -U "$db_user" \
    -d postgres -tAc 'select rolcreatedb or rolsuper from pg_roles where rolname = current_user' \
    2>/dev/null || true)"
  if [[ "$can_create" != "t" ]]; then
    say "role $db_user cannot create databases (or postgres is unreachable at $db_host:$db_port)" >&2
    say "not dropping $db_name — that would strand this machine without one" >&2
    say "grant it once, as a superuser:  psql -d postgres -c 'ALTER ROLE $db_user CREATEDB;'" >&2
    exit 1
  fi
  say "dropping and recreating database $db_name"
  PGPASSWORD="$db_pass" dropdb --if-exists -h "$db_host" -p "$db_port" -U "$db_user" "$db_name"
  PGPASSWORD="$db_pass" createdb -h "$db_host" -p "$db_port" -U "$db_user" "$db_name"
else
  say "database url is not postgres; leaving it alone ($db_url)"
fi
if command -v redis-cli >/dev/null 2>&1; then
  redis-cli -u "$redis_url" FLUSHDB >/dev/null && say "flushed redis"
fi

# 4. Signed prebuilts for the local installer (the production path).
say "staging signed prebuilts under daemon/target/prebuilt"
# shellcheck source=release-lib.sh
source "$repo_root/scripts/release-lib.sh"
prebuilt="$repo_root/daemon/target/prebuilt"
target="darwin-aarch64"
case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64) target="darwin-x86_64" ;;
  Linux-aarch64|Linux-arm64) target="linux-aarch64" ;;
  Linux-x86_64) target="linux-x86_64" ;;
esac
rm -rf "$prebuilt"
mkdir -p "$prebuilt/$target"
cp "$repo_root/daemon/target/release/spawnd" "$repo_root/daemon/target/release/spawn-worker" "$prebuilt/$target/"
commit="$(git rev-parse HEAD)"
tree="$(git rev-parse HEAD:daemon)"
if ! git diff --quiet HEAD -- daemon; then
  say "daemon/ is dirty: the built daemon reports a -dirty tree and will not match this manifest (commit first for the production path)"
fi
if release_signing_key_readable; then
  version="0.1.0+g${commit:0:12}"
  counter="$(release_counter_for_commit "$commit")"
  pub="$(release_signing_public_key)"
  kid="$(release_signing_key_id "$pub")"
  sd="$(sha256_file "$prebuilt/$target/spawnd" | cut -c1-64)"
  sw="$(sha256_file "$prebuilt/$target/spawn-worker" | cut -c1-64)"
  render_prebuilt_manifest "$commit" "$tree" "$version" "$counter" "$kid" "$target:$sd:$sw" > "$prebuilt/manifest.json"
  sign_prebuilt_manifest "$prebuilt/manifest.json" "$prebuilt/manifest.json.sig"
  verify_prebuilt_manifest_signature "$prebuilt/manifest.json" "$prebuilt/manifest.json.sig" "$pub"
  say "manifest signed (key $kid, tree ${tree:0:12})"
else
  rm -rf "$prebuilt"
  say "no release signing key at $(release_signing_key_path); the local installer will build from source"
fi

say "this machine has never heard of SPAWN D. Any host it registered before still shows under Hosts on that server — remove it there."
