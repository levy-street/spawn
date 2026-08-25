#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export NO_COLOR=1
unset FORCE_COLOR CLICOLOR CLICOLOR_FORCE 2>/dev/null || true

# shellcheck source=update-test-lib.sh
source "$repo_root/scripts/update-test-lib.sh"

self_test() {
  update_test_lib_self_test
  if update_test_is_local_url "https://spawnd.dev"; then
    printf '%s\n' "test-update-e2e: production URL guard failed" >&2
    return 1
  fi
  printf '%s\n' "test-update-e2e: self-test ok"
}

file_inode() {
  if stat -f '%i' "$1" >/dev/null 2>&1; then
    stat -f '%i' "$1"
  else
    stat -c '%i' "$1"
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  [[ "$#" == "1" ]] || { printf '%s\n' "usage: scripts/test-update-e2e.sh [--self-test]" >&2; exit 2; }
  self_test
  exit 0
fi
[[ "$#" == "0" ]] || { printf '%s\n' "usage: scripts/test-update-e2e.sh [--self-test]" >&2; exit 2; }

started_at=$SECONDS
update_test_init update-e2e

cleanup() {
  local status=$?
  trap - EXIT
  update_test_cleanup_all "$status" || status=$?
  exit "$status"
}
trap cleanup EXIT

update_test_build_identities
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"

printf '%s\n' "test-update-e2e: auto-update, same-PID exec, and worker adoption"
update_test_new_fixture auto
update_test_prepare_database
update_test_start_server 0
update_test_mint_credentials
update_test_start_daemon "$UPDATE_DAEMON_URL"
update_test_wait_online "$UPDATE_TREE_A"
old_pid="$UPDATE_DAEMON_PID"
update_test_create_session

worker_socket="$UPDATE_WORKER_DIR/$UPDATE_SESSION_ID.sock"
update_test_wait_file "$worker_socket" 20
worker_socket_inode="$(file_inode "$worker_socket")"
worker_pid="$(sed -n "s/.*session_id=$UPDATE_SESSION_ID worker_pid=\([0-9][0-9]*\).*/\1/p" \
  "$UPDATE_DAEMON_LOG" | tail -1)"
[[ "$worker_pid" =~ ^[1-9][0-9]*$ ]] \
  || update_test_die "could not discover worker PID for $UPDATE_SESSION_ID"
kill -0 "$worker_pid" 2>/dev/null || update_test_die "session worker was not alive before update"
[[ -f "$UPDATE_SESSION_CWD/.update-shell-ready" ]] \
  || update_test_die "PTY command did not start before update"

watch_file="$UPDATE_FIXTURE/previous-observation.json"
python3 - "$UPDATE_FIXTURE/spawn.db" "$UPDATE_HOST_ID" "$UPDATE_BIN_DIR" \
  "$UPDATE_TREE_B" "$watch_file" <<'PY' &
import json
import sqlite3
import sys
import time
from pathlib import Path

database, host_id, bin_dir, tree, output = sys.argv[1:]
daemon_prev = Path(bin_dir) / "spawnd.prev"
worker_prev = Path(bin_dir) / "spawn-worker.prev"
seen = False
deadline = time.monotonic() + 60
connection = sqlite3.connect(database)
while time.monotonic() < deadline:
    both = daemon_prev.is_file() and worker_prev.is_file()
    seen = seen or both
    row = connection.execute("SELECT daemon_tree FROM hosts WHERE id = ?", (host_id,)).fetchone()
    if row and row[0] == tree:
        Path(output).write_text(json.dumps({"seen": seen, "present_at_register": both}))
        raise SystemExit(0)
    time.sleep(0.002)
Path(output).write_text(json.dumps({"seen": seen, "present_at_register": False, "timeout": True}))
raise SystemExit(1)
PY
previous_watcher_pid=$!

# Hold the first registration with auto-update off so the PTY worker exists
# before the update. Re-enabling the cohort on the same local origin makes the
# next daemon registration exercise the server's automatic push.
update_test_stop_server
update_test_start_server 1
update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
wait "$previous_watcher_pid"
python3 - "$watch_file" <<'PY'
import json
import sys

observed = json.load(open(sys.argv[1], encoding="utf-8"))
if observed != {"seen": True, "present_at_register": True}:
    raise SystemExit(f"previous-pair lifetime was not observed: {observed!r}")
PY

kill -0 "$old_pid" 2>/dev/null || update_test_die "daemon PID changed across exec"
kill -0 "$worker_pid" 2>/dev/null || update_test_die "session worker died across daemon exec"
[[ -S "$worker_socket" ]] || update_test_die "worker socket disappeared across daemon exec"
[[ "$(file_inode "$worker_socket")" == "$worker_socket_inode" ]] \
  || update_test_die "worker socket was replaced instead of adopted"
update_test_wait_session_running "$UPDATE_SESSION_ID"
[[ -f "$UPDATE_SESSION_CWD/.update-shell-ready" ]] \
  || update_test_die "PTY command state disappeared across update"
[[ ! -e "$UPDATE_BIN_DIR/spawnd.prev" && ! -e "$UPDATE_BIN_DIR/spawn-worker.prev" ]] \
  || update_test_die "previous pair survived healthy registration"
[[ ! -e "$UPDATE_BIN_DIR/spawnd.updating" ]] \
  || update_test_die "probation marker survived healthy registration"
cmp -s "$UPDATE_BIN_DIR/spawnd" "$UPDATE_ARTIFACTS/new/spawnd" \
  || update_test_die "installed daemon is not v-new"
cmp -s "$UPDATE_BIN_DIR/spawn-worker" "$UPDATE_ARTIFACTS/new/spawn-worker" \
  || update_test_die "installed worker is not v-new"
python3 - "$UPDATE_DAEMON_LOG" <<'PY'
import sys

text = open(sys.argv[1], encoding="utf-8").read()
positions = []
for stage in ("precondition", "download", "verify", "swap", "exec"):
    marker = f'stage="{stage}"'
    position = text.find(marker, positions[-1] + 1 if positions else 0)
    if position < 0:
        raise SystemExit(f"missing ordered updater stage {stage}")
    positions.append(position)
PY

printf '%s\n' \
  "test-update-e2e: SKIP PTY bytes/no client reconnect (needs: reusable non-browser RTC DataChannel observer for the cargo+python CI fixture)"
update_test_post_update '{}'
[[ "$UPDATE_HTTP_STATUS" == "200" ]] \
  || update_test_die "same-tree idempotent POST returned $UPDATE_HTTP_STATUS: $UPDATE_HTTP_BODY"
python3 -c 'import json,sys; assert json.load(sys.stdin)["update"]["state"] == "current"' \
  <<<"$UPDATE_HTTP_BODY"
printf '%s\n' "test-update-e2e: PASS auto-update/worker-adoption/idempotence"
update_test_cleanup_fixture

printf '%s\n' "test-update-e2e: manual update and 429 request window"
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
update_test_new_fixture manual
update_test_prepare_database
update_test_start_server 0
update_test_mint_credentials
update_test_start_daemon
update_test_wait_online "$UPDATE_TREE_A"
update_test_post_update '{}'
[[ "$UPDATE_HTTP_STATUS" == "202" ]] \
  || update_test_die "manual update returned $UPDATE_HTTP_STATUS: $UPDATE_HTTP_BODY"
update_test_post_update '{}'
[[ "$UPDATE_HTTP_STATUS" == "429" ]] \
  || update_test_die "second manual request returned $UPDATE_HTTP_STATUS, expected 429"
update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
printf '%s\n' "test-update-e2e: PASS manual/429"
update_test_cleanup_fixture

printf '%s\n' "test-update-e2e: disabled and unwritable preconditions"
update_test_new_fixture disabled
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials
update_test_start_daemon "$UPDATE_DAEMON_URL" SPAWND_NO_SELF_UPDATE=1
update_test_wait_host "$UPDATE_TREE_A" unsupported disabled 30 >/dev/null
printf '%s\n' "test-update-e2e: PASS blocked: disabled"
update_test_cleanup_fixture

update_test_new_fixture unwritable
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials
chmod 555 "$UPDATE_BIN_DIR"
update_test_start_daemon
update_test_wait_host "$UPDATE_TREE_A" unsupported "not writable" 30 >/dev/null
chmod 755 "$UPDATE_BIN_DIR"
printf '%s\n' "test-update-e2e: PASS unsupported: unwritable"
update_test_cleanup_fixture

printf '%s\n' "test-update-e2e: monotonic downgrade guard and operator override"
update_test_write_manifest "$UPDATE_TREE_B" 500
update_test_new_fixture downgrade
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials
update_test_start_daemon
update_test_wait_host "$UPDATE_TREE_A" failed downgrade 30 >/dev/null
cmp -s "$UPDATE_BIN_DIR/spawnd" "$UPDATE_ARTIFACTS/old/spawnd" \
  || update_test_die "downgrade refusal changed the old binary"
update_test_post_update '{"allow_downgrade":true}'
[[ "$UPDATE_HTTP_STATUS" == "202" ]] \
  || update_test_die "allow_downgrade returned $UPDATE_HTTP_STATUS: $UPDATE_HTTP_BODY"
update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
printf '%s\n' "test-update-e2e: PASS downgrade/allow_downgrade"
update_test_cleanup_fixture

printf 'test-update-e2e: passed in %ss (1 explicit SKIP)\n' "$((SECONDS - started_at))"
