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
# Every manifest below carries the diagnostics variant beside the release
# pair, the way a published release does, so each release-daemon cell also
# proves that a release daemon ignores the variant next to it.
update_test_build_variant_identities
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
update_test_manifest_has_variant diagnostics \
  || update_test_die "the written manifest does not carry the diagnostics variant"

printf '%s\n' "test-update-e2e: auto-update, same-PID exec, and worker adoption"
update_test_new_fixture auto
update_test_prepare_database
update_test_start_server 0
update_test_mint_credentials
update_test_start_daemon "$UPDATE_DAEMON_URL"
update_test_wait_online "$UPDATE_TREE_A"
old_pid="$UPDATE_DAEMON_PID"
# The pair was installed the old way, as a bare pair in bin/. Its first start
# adopted it into the store as a release, pointed the instance at it, and
# re-executed from there — same PID — before connecting.
update_test_installed_is old \
  || update_test_die "the first start did not adopt the legacy pair into the store"
old_release="$(update_test_selected_release)"
[[ "$old_release" == "$UPDATE_RELEASES"/* ]] \
  || update_test_die "the adopted release is not in the store: $old_release"
[[ "$(readlink "/proc/$old_pid/exe")" == "$old_release/spawnd" ]] \
  || update_test_die "the daemon did not re-execute from its release: $(readlink "/proc/$old_pid/exe")"
marker_path="$(update_test_probation_marker)"
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

# The previous release must stay on disk, and the probation marker must
# exist, right up to the moment the new daemon registers: that is what a
# failed probation reverts to. Both are observed from outside.
watch_file="$UPDATE_FIXTURE/previous-observation.json"
python3 - "$UPDATE_FIXTURE/spawn.db" "$UPDATE_HOST_ID" "$old_release" "$marker_path" \
  "$UPDATE_TREE_B" "$watch_file" <<'PY' &
import json
import sqlite3
import sys
import time
from pathlib import Path

database, host_id, old_release, marker, tree, output = sys.argv[1:]
old_pair = Path(old_release)
marker_seen = False
deadline = time.monotonic() + 60
connection = sqlite3.connect(database)
while time.monotonic() < deadline:
    previous_present = (old_pair / "spawnd").is_file() and (old_pair / "spawn-worker").is_file()
    marker_seen = marker_seen or Path(marker).is_file()
    row = connection.execute("SELECT daemon_tree FROM hosts WHERE id = ?", (host_id,)).fetchone()
    if row and row[0] == tree:
        Path(output).write_text(
            json.dumps({"marker_seen": marker_seen, "previous_at_register": previous_present})
        )
        raise SystemExit(0)
    time.sleep(0.002)
Path(output).write_text(json.dumps({"marker_seen": marker_seen, "previous_at_register": False, "timeout": True}))
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
if observed != {"marker_seen": True, "previous_at_register": True}:
    raise SystemExit(f"previous-release lifetime was not observed: {observed!r}")
PY

kill -0 "$old_pid" 2>/dev/null || update_test_die "daemon PID changed across exec"
kill -0 "$worker_pid" 2>/dev/null || update_test_die "session worker died across daemon exec"
[[ -S "$worker_socket" ]] || update_test_die "worker socket disappeared across daemon exec"
[[ "$(file_inode "$worker_socket")" == "$worker_socket_inode" ]] \
  || update_test_die "worker socket was replaced instead of adopted"
update_test_wait_session_running "$UPDATE_SESSION_ID"
[[ -f "$UPDATE_SESSION_CWD/.update-shell-ready" ]] \
  || update_test_die "PTY command state disappeared across update"
[[ ! -e "$marker_path" ]] \
  || update_test_die "probation marker survived healthy registration"
update_test_installed_is new \
  || update_test_die "the instance is not pointed at v-new"
! update_test_installed_is new-diagnostics \
  || update_test_die "a release daemon installed the diagnostics variant"
[[ "$(readlink "/proc/$old_pid/exe")" == "$(update_test_selected_release)/spawnd" ]] \
  || update_test_die "the daemon is not running the release it is pointed at"
# The release it moved off stays through the collector's grace period —
# another installer could be between publishing and selecting that very
# release — and goes on the next pass once the record is old enough. The pair
# it was installed from in bin/ is not this daemon's to touch and is intact.
[[ -d "$old_release" ]] \
  || update_test_die "the previous release was collected inside its grace period"
[[ "$(update_test_release_count)" == "2" ]] \
  || update_test_die "expected the new release beside the previous one: $(ls "$UPDATE_RELEASES")"
update_test_age_release "$old_release"
update_test_run_update_cli
grep -q "update not applied for .* (current)." "$UPDATE_DAEMON_LOG" \
  || update_test_die "spawnd update on the current tree did not report current"
[[ ! -d "$old_release" ]] || update_test_die "the aged previous release survived collection"
[[ "$(update_test_release_count)" == "1" ]] \
  || update_test_die "expected one release after collection: $(ls "$UPDATE_RELEASES")"
cmp -s "$UPDATE_BIN_DIR/spawnd" "$UPDATE_ARTIFACTS/old/spawnd" \
  && cmp -s "$UPDATE_BIN_DIR/spawn-worker" "$UPDATE_ARTIFACTS/old/spawn-worker" \
  || update_test_die "the update wrote into the legacy bin/ pair"
grep -q 'variant="release"' "$UPDATE_DAEMON_LOG" \
  || update_test_die "the release daemon did not log the variant it follows"
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
# The store, not bin/, is what an update needs to write. With it read-only the
# first start cannot adopt the legacy pair either, and says so, and runs on.
mkdir -p "$UPDATE_RELEASES" "$UPDATE_STORE/instances"
chmod 555 "$UPDATE_RELEASES" "$UPDATE_STORE/instances"
update_test_start_daemon
update_test_wait_host "$UPDATE_TREE_A" unsupported "not writable" 30 >/dev/null
grep -q "could not move this instance into the release store" "$UPDATE_DAEMON_LOG" \
  || update_test_die "the daemon did not report the store it could not write"
chmod 755 "$UPDATE_RELEASES" "$UPDATE_STORE/instances"
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
update_test_installed_is old \
  || update_test_die "downgrade refusal changed the old binary"
# The server may ask for a downgrade; only the host may consent. Asking alone
# is refused, because a compromised control plane must not be able to roll the
# fleet back to a known-vulnerable release (docs/TRUST.md).
update_test_post_update '{"allow_downgrade":true}'
[[ "$UPDATE_HTTP_STATUS" == "202" ]] \
  || update_test_die "allow_downgrade returned $UPDATE_HTTP_STATUS: $UPDATE_HTTP_BODY"
update_test_wait_host "$UPDATE_TREE_A" failed downgrade 30 >/dev/null
update_test_installed_is old \
  || update_test_die "an unconsented downgrade changed the binary"
printf '%s\n' "test-update-e2e: PASS downgrade refused without local consent"
update_test_cleanup_fixture

# With consent proven on the host, the same request proceeds. A fresh fixture
# because the manual-update window would 429 a second request.
printf '%s\n' "test-update-e2e: downgrade with local operator consent"
update_test_new_fixture downgrade-consent
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials
update_test_start_daemon
update_test_wait_host "$UPDATE_TREE_A" failed downgrade 30 >/dev/null
touch "$UPDATE_DAEMON_HOME/.config/spawn/allow-downgrade"
update_test_post_update '{"allow_downgrade":true}'
[[ "$UPDATE_HTTP_STATUS" == "202" ]] \
  || update_test_die "consented allow_downgrade returned $UPDATE_HTTP_STATUS: $UPDATE_HTTP_BODY"
update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
printf '%s\n' "test-update-e2e: PASS downgrade/allow_downgrade with consent"
update_test_cleanup_fixture

# The variant cells. A diagnostics daemon is installed as the old identity
# and the served release carries both pairs; what lands on disk afterwards
# is the whole question.
installed_version() {
  "$(update_test_installed_spawnd)" --version | awk 'NR == 1 {print $2}'
}

printf '%s\n' "test-update-e2e: a diagnostics daemon follows the diagnostics variant"
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
update_test_new_fixture variant-sticky old-diagnostics
[[ "$(installed_version)" == "$UPDATE_VARIANT_VERSION" ]] \
  || update_test_die "the installed daemon is not the diagnostics identity"
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials
update_test_start_daemon
update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
update_test_wait_installed new-diagnostics 10 \
  || update_test_die "the diagnostics daemon did not install the diagnostics variant"
! update_test_installed_is new \
  || update_test_die "the diagnostics daemon downgraded itself to the release variant"
[[ "$(installed_version)" == "$UPDATE_VARIANT_VERSION" ]] \
  || update_test_die "the updated daemon does not report the diagnostics version"
grep -q 'variant="diagnostics"' "$UPDATE_DAEMON_LOG" \
  || update_test_die "the diagnostics daemon did not log the variant it follows"
[[ ! -e "$(update_test_probation_marker)" ]] \
  || update_test_die "probation marker survived the variant's healthy registration"
printf '%s\n' "test-update-e2e: PASS diagnostics daemon -> diagnostics variant"
update_test_cleanup_fixture

printf '%s\n' "test-update-e2e: a diagnostics daemon refuses a release without its variant"
variant_dir="$UPDATE_VARIANT_DIR"
UPDATE_VARIANT_DIR=""
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
UPDATE_VARIANT_DIR="$variant_dir"
! update_test_manifest_has_variant diagnostics \
  || update_test_die "the variant-less manifest still carries the diagnostics variant"
update_test_new_fixture variant-missing old-diagnostics
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials
update_test_start_daemon
update_test_wait_host "$UPDATE_TREE_A" failed "variant unavailable" 45 >/dev/null
update_test_installed_is old-diagnostics \
  || update_test_die "a refused variant update changed the installed pair"
kill -0 "$UPDATE_DAEMON_PID" 2>/dev/null \
  || update_test_die "the diagnostics daemon exited after refusing the release pair"
python3 -c 'import json,sys; h=json.load(sys.stdin); assert h["status"] == "online"' \
  <<<"$(update_test_host_json)"
# The server pushed the release pair; the daemon must not have fetched it.
# The manifest fetch proves the access log is there to be searched.
grep -q "GET /api/install/manifest.json " "$UPDATE_SERVER_LOG" \
  || update_test_die "the server access log does not show the manifest fetch"
! grep -q "GET /api/install/spawnd/$UPDATE_TARGET " "$UPDATE_SERVER_LOG" \
  || update_test_die "the diagnostics daemon downloaded the release pair"
printf '%s\n' "test-update-e2e: PASS diagnostics daemon refuses the release variant"
update_test_cleanup_fixture

printf '%s\n' "test-update-e2e: SPAWND_RELEASE_VARIANT overrides the build's own variant"
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
update_test_new_fixture variant-override-up
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials
update_test_start_daemon "$UPDATE_DAEMON_URL" SPAWND_RELEASE_VARIANT=diagnostics
update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
update_test_wait_installed new-diagnostics 10 \
  || update_test_die "a release daemon told to follow diagnostics did not install it"
[[ "$(installed_version)" == "$UPDATE_VARIANT_VERSION" ]] \
  || update_test_die "the overridden daemon does not report the diagnostics version"
printf '%s\n' "test-update-e2e: PASS release daemon -> diagnostics when told"
update_test_cleanup_fixture

update_test_new_fixture variant-override-down old-diagnostics
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials
update_test_start_daemon "$UPDATE_DAEMON_URL" SPAWND_RELEASE_VARIANT=release
update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
update_test_wait_installed new 10 \
  || update_test_die "a diagnostics daemon told to follow release did not install it"
[[ "$(installed_version)" == "$UPDATE_VERSION" ]] \
  || update_test_die "the overridden daemon does not report the release version"
printf '%s\n' "test-update-e2e: PASS diagnostics daemon -> release when told"
update_test_cleanup_fixture

update_test_new_fixture variant-invalid
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials
update_test_start_daemon "$UPDATE_DAEMON_URL" SPAWND_RELEASE_VARIANT=debug
update_test_wait_host "$UPDATE_TREE_A" unsupported "SPAWND_RELEASE_VARIANT" 30 >/dev/null
update_test_installed_is old \
  || update_test_die "an unknown variant name changed the installed daemon"
printf '%s\n' "test-update-e2e: PASS unsupported: invalid variant"
update_test_cleanup_fixture

# The switch an operator makes on a host that is already on the current
# tree: the server has nothing to push (same tree is "current"), so it is
# `spawnd update` that moves the pair, reading SPAWND_RELEASE_VARIANT from
# its own environment — not from the unit's. This is the one step a host
# whose daemon predates the variant-aware updater needs after its first
# update lands it on the release pair.
printf '%s\n' "test-update-e2e: the same-tree variant switch through spawnd update"
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
update_test_new_fixture variant-same-tree new
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials
update_test_start_daemon
update_test_wait_host "$UPDATE_TREE_B" current "" 30 >/dev/null
# Without the variable the CLI is current on this tree and touches nothing,
# whatever the daemon's own environment says.
# The command on PATH is the release build here, judging a release instance:
# nothing to do.
update_test_run_update_cli
grep -q "SPAWN D daemon update not applied for .* (current)." "$UPDATE_DAEMON_LOG" \
  || update_test_die "spawnd update without a variant did not report current"
update_test_installed_is new \
  || update_test_die "spawnd update without a variant changed the installed daemon"
update_test_run_update_cli SPAWND_RELEASE_VARIANT=diagnostics
grep -q "Restart the daemon to run it" "$UPDATE_DAEMON_LOG" \
  || update_test_die "spawnd update with the variant did not report the switch"
update_test_installed_is new-diagnostics \
  || update_test_die "the same-tree switch did not point the instance at the diagnostics pair"
[[ -e "$(update_test_probation_marker)" ]] \
  || update_test_die "the same-tree switch left no probation marker for the restart"
# The running daemon is untouched until it restarts: still the release build.
[[ "$(readlink "/proc/$UPDATE_DAEMON_PID/exe")" == */spawnd ]] \
  && cmp -s "$(readlink "/proc/$UPDATE_DAEMON_PID/exe")" "$UPDATE_ARTIFACTS/new/spawnd" \
  || update_test_die "the CLI switch disturbed the running daemon"
# No service manager here, so the restart the CLI asks for is ours. The unit
# would name the instance's constant launch path; here the legacy bin/ path
# starts it, and it redirects itself to the selected release before it
# connects — exactly what a stale launchd plist would see.
update_test_stop_daemon
update_test_start_daemon
update_test_wait_online "$UPDATE_TREE_B"
[[ "$(installed_version)" == "$UPDATE_VARIANT_VERSION" ]] \
  || update_test_die "the switched daemon does not report the diagnostics version"
cmp -s "$(readlink "/proc/$UPDATE_DAEMON_PID/exe")" "$UPDATE_ARTIFACTS/new-diagnostics/spawnd" \
  || update_test_die "the restarted daemon did not redirect to the selected release"
deadline=$((SECONDS + 30))
while [[ -e "$(update_test_probation_marker)" ]] && ((SECONDS < deadline)); do sleep 0.2; done
[[ ! -e "$(update_test_probation_marker)" ]] \
  || update_test_die "probation marker survived the switched daemon's registration"
printf '%s\n' "test-update-e2e: PASS same-tree switch via spawnd update"
update_test_cleanup_fixture

printf 'test-update-e2e: passed in %ss (1 explicit SKIP)\n' "$((SECONDS - started_at))"
