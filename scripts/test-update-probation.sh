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
  local fixture
  fixture="$(mktemp -d)"
  printf '%s\n' '{"attempts":0,"reverted":false}' >"$fixture/spawnd.updating"
  python3 - "$fixture/spawnd.updating" <<'PY'
import json
import sys

marker = json.load(open(sys.argv[1], encoding="utf-8"))
assert marker == {"attempts": 0, "reverted": False}
PY
  rm -rf "$fixture"
  printf '%s\n' "test-update-probation: self-test ok"
}

if [[ "${1:-}" == "--self-test" ]]; then
  [[ "$#" == "1" ]] || { printf '%s\n' "usage: scripts/test-update-probation.sh [--self-test]" >&2; exit 2; }
  self_test
  exit 0
fi
[[ "$#" == "0" ]] || { printf '%s\n' "usage: scripts/test-update-probation.sh [--self-test]" >&2; exit 2; }

started_at=$SECONDS
update_test_init update-probation

cleanup() {
  local status=$?
  trap - EXIT
  update_test_cleanup_all "$status" || status=$?
  exit "$status"
}
trap cleanup EXIT

update_test_build_identities

# The downloaded wrapper has the exact candidate version but deliberately
# fails its real startup. The store publishes it as a release and points the
# instance at it, so the daemon re-executes the wrapper, which hands over to
# the real v-new binary with a `--server` that disagrees with the stored
# credentials: `run` reads its probation marker from the instance directory
# first — the same directory whatever binary is running — increments it, and
# exits 1 validating the origin. The supervisor's next start crosses the
# production two-attempt threshold and points the instance back at the
# previous release. Nothing in the release directory is ever modified.
bad_daemon="$UPDATE_SCRATCH/bad-spawnd"
cat >"$bad_daemon" <<SH
#!/usr/bin/env sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  exec "$UPDATE_ARTIFACTS/new/spawnd" --version
fi
# Replace the --server argument and keep everything else.
skip=0
set -- "\$@" --end-of-original
rewritten=""
for arg in "\$@"; do
  shift
  if [ "\$arg" = "--end-of-original" ]; then break; fi
  if [ "\$skip" = "1" ]; then skip=0; continue; fi
  if [ "\$arg" = "--server" ]; then skip=1; continue; fi
  set -- "\$@" "\$arg"
done
exec "$UPDATE_ARTIFACTS/new/spawnd" --server http://127.0.0.1:1 "\$@"
SH
chmod 755 "$bad_daemon"
update_test_write_manifest \
  "$UPDATE_TREE_B" "$UPDATE_COUNTER_B" "$bad_daemon" "$UPDATE_ARTIFACTS/new/spawn-worker"

update_test_new_fixture probation
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials

marker_seen="$UPDATE_FIXTURE/marker-seen"
marker_path="$(update_test_probation_marker)"
(
  deadline=$((SECONDS + 45))
  while ((SECONDS < deadline)); do
    if [[ -f "$marker_path" ]]; then
      printf '%s\n' "seen" >"$marker_seen"
      exit 0
    fi
    sleep 0.01
  done
  exit 1
) &
marker_watcher_pid=$!

update_test_start_supervised_daemon
update_test_wait_online "$UPDATE_TREE_A"
update_test_wait_host "$UPDATE_TREE_A" failed 'health: registration failed' 45 >/dev/null
wait "$marker_watcher_pid"
[[ -f "$marker_seen" ]] || update_test_die "probation marker was never observed"

update_test_installed_is old \
  || update_test_die "health revert did not point the instance back at the old release"
# The failed release is not deleted by the revert: it stays, unselected,
# through the collector's grace period and is removed on a later pass. The
# reverted daemon's health report clears the marker.
[[ ! -e "$marker_path" ]] \
  || update_test_die "health result did not clear the probation marker"
[[ "$(update_test_release_count)" == "2" ]] \
  || update_test_die "expected the old release beside the failed one: $(ls "$UPDATE_RELEASES")"

stable_child="$(<"$UPDATE_DAEMON_CHILD_PID_FILE")"
[[ "$stable_child" =~ ^[1-9][0-9]*$ ]] || update_test_die "supervisor did not record old daemon PID"
kill -0 "$stable_child" 2>/dev/null || update_test_die "reverted old daemon is not running"

observe_seconds="${SPAWN_TEST_PROBATION_OBSERVE_SECONDS:-65}"
[[ "$observe_seconds" =~ ^[0-9]+$ && "$observe_seconds" -ge 60 ]] \
  || update_test_die "SPAWN_TEST_PROBATION_OBSERVE_SECONDS must cover two 30s keepalive windows"
printf 'test-update-probation: observing failed tree for %ss (two keepalive windows)\n' \
  "$observe_seconds"
deadline=$((SECONDS + observe_seconds))
while ((SECONDS < deadline)); do
  host="$(update_test_host_json)"
  python3 -c '
import json,sys
h=json.load(sys.stdin)
assert h["daemon_tree"] == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
assert h["update"]["state"] == "failed"
assert "health" in str(h["update"].get("error") or "").lower()
' <<<"$host"
  [[ ! -e "$marker_path" ]] \
    || update_test_die "server re-pushed the failed probation tree"
  [[ "$(<"$UPDATE_DAEMON_CHILD_PID_FILE")" == "$stable_child" ]] \
    || update_test_die "reverted daemon restarted during no-repush observation"
  sleep 1
done

printf 'test-update-probation: passed in %ss\n' "$((SECONDS - started_at))"
