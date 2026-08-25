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
# fails its real startup. On `run` it replaces its own installed path with the
# real v-new binary, then gives only that exec an empty credential directory.
# current_exe() is therefore the installed path: prepare_probation() sees the
# real marker, increments it, and startup exits 1 while loading credentials.
# The supervisor's next start restores the normal config, crosses the
# production two-attempt threshold, and drives the pair-atomic revert.
bad_daemon="$UPDATE_SCRATCH/bad-spawnd"
bad_config="$UPDATE_SCRATCH/missing-credentials"
mkdir -p "$bad_config"
cat >"$bad_daemon" <<SH
#!/usr/bin/env sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  exec "$UPDATE_ARTIFACTS/new/spawnd" --version
fi
self="\$0"
candidate="\${self}.candidate"
cp "$UPDATE_ARTIFACTS/new/spawnd" "\$candidate"
chmod 755 "\$candidate"
mv "\$candidate" "\$self"
SPAWN_CONFIG_DIR="$bad_config" exec "\$self" "\$@"
SH
chmod 755 "$bad_daemon"
update_test_write_manifest \
  "$UPDATE_TREE_B" "$UPDATE_COUNTER_B" "$bad_daemon" "$UPDATE_ARTIFACTS/new/spawn-worker"

update_test_new_fixture probation
update_test_prepare_database
update_test_start_server 1
update_test_mint_credentials

marker_seen="$UPDATE_FIXTURE/marker-seen"
(
  deadline=$((SECONDS + 45))
  while ((SECONDS < deadline)); do
    if [[ -f "$UPDATE_BIN_DIR/spawnd.updating" ]]; then
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

cmp -s "$UPDATE_BIN_DIR/spawnd" "$UPDATE_ARTIFACTS/old/spawnd" \
  || update_test_die "health revert did not restore the old daemon"
cmp -s "$UPDATE_BIN_DIR/spawn-worker" "$UPDATE_ARTIFACTS/old/spawn-worker" \
  || update_test_die "health revert did not restore the old worker"
[[ ! -e "$UPDATE_BIN_DIR/spawnd.prev" && ! -e "$UPDATE_BIN_DIR/spawn-worker.prev" ]] \
  || update_test_die "health revert left previous-pair backups"
[[ ! -e "$UPDATE_BIN_DIR/spawnd.updating" ]] \
  || update_test_die "health result did not clear the probation marker"

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
  [[ ! -e "$UPDATE_BIN_DIR/spawnd.updating" ]] \
    || update_test_die "server re-pushed the failed probation tree"
  [[ "$(<"$UPDATE_DAEMON_CHILD_PID_FILE")" == "$stable_child" ]] \
    || update_test_die "reverted daemon restarted during no-repush observation"
  sleep 1
done

printf 'test-update-probation: passed in %ss\n' "$((SECONDS - started_at))"
