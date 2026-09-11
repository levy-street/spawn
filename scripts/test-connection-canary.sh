#!/usr/bin/env bash
set -euo pipefail

# Isolated updater canary. Neither a production rollout nor native WebRTC
# evidence: the PTY heartbeat and intentional worker IPC checkpoints are
# labeled separately in the report. See docs/CONNECTION_CANARY.md.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/update-test-lib.sh"
helper="$repo_root/scripts/connection-canary.py"

usage() {
  printf '%s\n' 'usage: scripts/test-connection-canary.sh --baseline REF --candidate REF --output FILE [--soak-seconds 120]'
}

if [[ "${1:-}" == "--self-test" && "$#" == 1 ]]; then
  update_test_lib_self_test
  python3 "$repo_root/scripts/test-connection-canary-unit.py"
  exit 0
fi
baseline_ref="" candidate_ref="" output="" soak_seconds=120
while [[ "$#" -gt 0 ]]; do
  [[ "$#" -ge 2 ]] || { usage >&2; exit 2; }
  case "$1" in
    --baseline) baseline_ref="$2" ;;
    --candidate) candidate_ref="$2" ;;
    --output) output="$2" ;;
    --soak-seconds) soak_seconds="$2" ;;
    *) usage >&2; exit 2 ;;
  esac
  shift 2
done
[[ -n "$baseline_ref" && "$baseline_ref" != -* && -n "$candidate_ref" && "$candidate_ref" != -* && -n "$output" ]] \
  || { usage >&2; exit 2; }
[[ "$soak_seconds" =~ ^[0-9]+$ && "$soak_seconds" -ge 60 && "$soak_seconds" -le 3600 ]] \
  || update_test_die "soak must be 60..3600 seconds; a shorter/skipped rehearsal cannot pass"
baseline_commit="$(git -C "$repo_root" rev-parse --verify "$baseline_ref^{commit}")"
candidate_commit="$(git -C "$repo_root" rev-parse --verify "$candidate_ref^{commit}")"
[[ "$baseline_commit" != "$candidate_commit" ]] || update_test_die "baseline and candidate must be different commits"
output="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$output")"
[[ ! -e "$output" && ! -e "$output.artifacts" ]] || update_test_die "evidence output already exists: $output"
mkdir -p "$(dirname "$output")" "$output.artifacts"
evidence() { python3 "$helper" evidence "$1" "$output" "${@:2}"; }
evidence init "$candidate_commit" "$baseline_commit" "$(uname -s)/$(uname -m)" "$soak_seconds"

monitor_pid="" watcher_pid="" baseline_worktree="" candidate_worktree=""
UPDATE_SCRATCH=""
initialized=0
cleanup() {
  local status=$? cleanup_status=0
  trap - EXIT
  set +e
  for owned_pid in "$monitor_pid" "$watcher_pid"; do
    if [[ -n "$owned_pid" ]]; then
      kill "$owned_pid" 2>/dev/null
      wait "$owned_pid" 2>/dev/null
    fi
  done
  if [[ "$initialized" == 1 ]]; then
    if [[ -n "${UPDATE_FIXTURE:-}" ]]; then
      for log in "$UPDATE_DAEMON_LOG" "$UPDATE_SERVER_LOG"; do
        [[ ! -f "$log" ]] || cp "$log" "$output.artifacts/failed-$(basename "$log")"
      done
    fi
    update_test_cleanup_fixture || cleanup_status=1
  fi
  for owned_tree in "$baseline_worktree" "$candidate_worktree"; do
    [[ -z "$owned_tree" || ! -d "$owned_tree" ]] \
      || git -C "$repo_root" worktree remove --force "$owned_tree" >/dev/null 2>&1 \
      || cleanup_status=1
  done
  # Initialization creates its owned scratch before generating the fixture
  # key; even a dependency/key-generation failure must remove that directory.
  if [[ -n "$UPDATE_SCRATCH" && "$cleanup_status" == 0 ]]; then
    rm -rf "$UPDATE_SCRATCH" || cleanup_status=1
  fi
  evidence finalize "$status" "$cleanup_status" || status=1
  [[ "$cleanup_status" == 0 ]] || status=1
  printf 'connection-canary: evidence %s (exit %s)\n' "$output" "$status"
  exit "$status"
}
trap cleanup EXIT
update_test_init connection-canary
initialized=1
baseline_worktree="$UPDATE_SCRATCH/baseline-source"
candidate_worktree="$UPDATE_SCRATCH/candidate-source"
git -C "$repo_root" worktree add --detach "$baseline_worktree" "$baseline_commit" >/dev/null
git -C "$repo_root" worktree add --detach "$candidate_worktree" "$candidate_commit" >/dev/null
# Both generations use exact committed source, the same optimized profile,
# toolchain, and one ephemeral signing key. Fixture identities are deliberately
# distinct from the immutable source tree identities recorded below.
UPDATE_REPO_ROOT="$baseline_worktree"
update_test_build_pair old "$UPDATE_TREE_A" "$UPDATE_COUNTER_A"
UPDATE_REPO_ROOT="$candidate_worktree"
update_test_build_pair new "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
UPDATE_REPO_ROOT="$repo_root"
UPDATE_SERVER_ROOT="$candidate_worktree"
UPDATE_COMMIT="$candidate_commit"
UPDATE_VERSION="$("$UPDATE_ARTIFACTS/new/spawnd" --version | awk 'NR == 1 {print $2}')"
[[ "$UPDATE_VERSION" == *"+g${candidate_commit:0:12}" ]] || update_test_die "candidate version does not match committed source"
[[ "$("$UPDATE_ARTIFACTS/old/spawnd" --version)" == *"+g${baseline_commit:0:12}" ]] || update_test_die "baseline version does not match committed source"
for generation in baseline candidate; do
  if [[ "$generation" == baseline ]]; then
    commit="$baseline_commit" pair=old tree="$UPDATE_TREE_A" counter="$UPDATE_COUNTER_A"
  else
    commit="$candidate_commit" pair=new tree="$UPDATE_TREE_B" counter="$UPDATE_COUNTER_B"
  fi
  [[ "$("$UPDATE_ARTIFACTS/$pair/spawn-worker" --version)" == *"tree=$tree"* ]] \
    || update_test_die "$generation does not support fixture worker identity stamps"
  python3 - "$repo_root" "$commit" "$UPDATE_ARTIFACTS/$pair" "$tree" "$counter" \
    "$UPDATE_KEY_ID" "$UPDATE_PUBLIC_KEY" "$output.artifacts/$generation.json" <<'PY'
import hashlib, json, subprocess, sys
from pathlib import Path
repo, commit, pair, tree, counter, key_id, public_key, output = sys.argv[1:]
def git(expression):
    return subprocess.check_output(["git", "-C", repo, "rev-parse", expression], text=True).strip()
result = {
    "commit": commit, "source_tree": git(commit + "^{tree}"),
    "daemon_source_tree": git(commit + ":daemon"),
    "server_source_tree": git(commit + ":server"), "mobile_source_tree": git(commit + ":mobile"),
    "profile": "release", "rustc": subprocess.check_output(["rustc", "--version"], text=True).strip(),
    "fixture_identity": {"daemon_tree_override": tree, "build_counter_override": int(counter),
                         "signing_key_id": key_id, "signing_public_key": public_key,
                         "signing_scope": "ephemeral fixture only; not release signing"},
}
for binary, key in (("spawnd", "spawnd_sha256"), ("spawn-worker", "worker_sha256")):
    result[key] = hashlib.sha256((Path(pair) / binary).read_bytes()).hexdigest()
    result[binary + "_version"] = subprocess.check_output([str(Path(pair) / binary), "--version"], text=True).strip()
Path(output).write_text(json.dumps(result, indent=2) + "\n")
PY
  evidence artifact "$generation" "$output.artifacts/$generation.json"
done
python3 - "$helper" "${BASH_SOURCE[0]}" "$output.artifacts/harness.json" <<'PY'
import hashlib, json, sys
from pathlib import Path
Path(sys.argv[3]).write_text(json.dumps({Path(p).name: hashlib.sha256(Path(p).read_bytes()).hexdigest()
                                      for p in sys.argv[1:3]}, indent=2) + "\n")
PY
evidence artifact harness "$output.artifacts/harness.json"
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"

case_check() { evidence check "$case_id" "$1"; }
case_metric() { evidence metric "$case_id" "$1" "$2"; }
monotonic_ms() { python3 -c 'import time; print(time.monotonic_ns() // 1000000)'; }
registration_count() { python3 "$helper" registrations --log "$UPDATE_DAEMON_LOG" --host "$UPDATE_HOST_ID"; }
wait_registration() {
  local previous="$1" label="$2"
  python3 "$helper" registrations --log "$UPDATE_DAEMON_LOG" --host "$UPDATE_HOST_ID" \
    --after "$previous" --output "$output.artifacts/$case_id-$label-registration.json"
  case_metric "${label}_registration" "$output.artifacts/$case_id-$label-registration.json"
}
credentials_digest() {
  python3 - "$UPDATE_CONFIG_DIR/credentials.json" <<'PY'
import hashlib, json, sys
record = json.load(open(sys.argv[1]))
# Token refresh and credential generation are allowed; trust/host identity is not.
identity = {key: record[key] for key in ("host_id", "server_url", "host_private_key_seed", "browser_pins")}
print(hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest())
PY
}

start_case_daemon() {
  local witness_label="$1" previous_registration
  previous_registration="$(registration_count)"
  if [[ "$case_id" == startup_rollback ]]; then update_test_start_supervised_daemon
  else update_test_start_daemon; fi
  wait_registration "$previous_registration" "$witness_label"
  update_test_wait_online "$expected_tree"
  update_test_wait_session_running "$UPDATE_SESSION_ID"
}

checkpoint() {
  local phase="$1"
  local expected=()
  [[ "$phase" != ipc_after ]] || expected=(--expected "$output.artifacts/$case_id-ipc_before.json")
  # A worker has one supervisor. Never replace a running daemon's connection
  # with the observer; stop this disposable daemon, probe, then prove adoption.
  update_test_stop_daemon
  python3 "$helper" ipc --socket "$worker_socket" --session "$UPDATE_SESSION_ID" \
    --output "$output.artifacts/$case_id-$phase.json" ${expected[@]+"${expected[@]}"}
  case_metric "$phase" "$output.artifacts/$case_id-$phase.json"
  start_case_daemon "$phase"
}

begin_case() {
  case_id="$1" installed_pair="$2" expected_tree="$3"
  printf 'connection-canary: %s (%ss minimum active-daemon PTY soak)\n' "$case_id" "$soak_seconds"
  evidence begin "$case_id"
  update_test_new_fixture "$case_id" "$installed_pair"
  # The shell's -ic environment probe must exit without creating a heartbeat.
  python3 - "$UPDATE_SHELL" "$(command -v python3)" "$helper" <<'PY'
import shlex, sys
from pathlib import Path
path, python, helper = sys.argv[1:]
Path(path).write_text("#!/usr/bin/env sh\ncase ${1:-} in -c|-ic) exit 0;; esac\nexec "
                     + shlex.quote(python) + " " + shlex.quote(helper) + " shell\n")
Path(path).chmod(0o755)
PY
  update_test_prepare_database
  update_test_start_server 0
  update_test_mint_credentials
  identity_before="$(credentials_digest)"
  update_test_start_daemon
  update_test_wait_online "$expected_tree"
  update_test_create_session
  worker_socket="$UPDATE_WORKER_DIR/$UPDATE_SESSION_ID.sock"
  update_test_wait_file "$worker_socket" 20
  update_test_wait_file "$UPDATE_SESSION_CWD/.canary-heartbeat.json" 20
  worker_pid="$(sed -n "s/.*session_id=$UPDATE_SESSION_ID worker_pid=\([0-9][0-9]*\).*/\1/p" "$UPDATE_DAEMON_LOG" | tail -1)"
  [[ "$worker_pid" =~ ^[1-9][0-9]*$ ]] || update_test_die "could not discover fixture worker PID"
  checkpoint ipc_before
  monitor_stop="$UPDATE_FIXTURE/monitor-stop"
  python3 "$helper" monitor --heartbeat "$UPDATE_SESSION_CWD/.canary-heartbeat.json" \
    --socket "$worker_socket" --worker-pid "$worker_pid" --seconds "$soak_seconds" \
    --stop-file "$monitor_stop" --output "$output.artifacts/$case_id-monitor.json" &
  monitor_pid=$!
}

finish_case() {
  touch "$monitor_stop"
  wait "$monitor_pid"
  monitor_pid=""
  case_metric monitor "$output.artifacts/$case_id-monitor.json"
  update_test_wait_online "$expected_tree"
  update_test_wait_session_running "$UPDATE_SESSION_ID"
  case_check session_running
  update_test_installed_is "$installed_pair" || update_test_die "unexpected selected executable pair"
  case_check selected_pair
  kill -0 "$worker_pid" || update_test_die "worker died during case"
  case_check worker_alive
  checkpoint ipc_after
  case_check daemon_readopted
  [[ "$(credentials_digest)" == "$identity_before" ]] || update_test_die "fixture host identity/trust changed"
  case_check identity_preserved
  cp "$UPDATE_DAEMON_LOG" "$output.artifacts/$case_id-daemon.log"
  cp "$UPDATE_SERVER_LOG" "$output.artifacts/$case_id-server.log"
  update_test_cleanup_fixture
  case_check cleanup_complete
  evidence end "$case_id"
}

begin_case baseline_holdback old "$UPDATE_TREE_A"
case_check held_back
finish_case

begin_case candidate_soak new "$UPDATE_TREE_B"
case_check candidate_running
finish_case

begin_case update_recovery old "$UPDATE_TREE_A"
old_daemon_pid="$UPDATE_DAEMON_PID"
previous_release="$(update_test_selected_release)"
update_test_stop_server
update_test_start_server 1
update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
kill -0 "$old_daemon_pid" || update_test_die "update replaced the daemon PID"
case_check same_daemon_pid
[[ -f "$previous_release/spawnd" && -f "$previous_release/spawn-worker" ]] \
  || update_test_die "previous executable pair disappeared during update"
case_check previous_release_preserved
[[ ! -e "$(update_test_probation_marker)" ]] || update_test_die "healthy update left probation pending"
case_check probation_cleared
installed_pair=new expected_tree="$UPDATE_TREE_B"
update_test_installed_is new || update_test_die "candidate was not selected"
case_check update_applied
# Fault only this fixture's loopback API and daemon processes. Its worker
# stays alive throughout both recovery paths, checked by the heartbeat monitor.
recovery_started="$(monotonic_ms)"
previous_registration="$(registration_count)"
update_test_stop_server KILL
sleep 2
update_test_start_server 1
wait_registration "$previous_registration" server_recovery
update_test_wait_online "$expected_tree"
update_test_wait_session_running "$UPDATE_SESSION_ID"
case_check server_restart_recovered
server_recovery_ms=$(($(monotonic_ms) - recovery_started))
recovery_started="$(monotonic_ms)"
kill -KILL "$UPDATE_DAEMON_PID"
wait "$UPDATE_DAEMON_PID" 2>/dev/null || true
UPDATE_DAEMON_PID=""
start_case_daemon daemon_recovery
case_check daemon_restart_recovered
python3 - "$server_recovery_ms" "$(($(monotonic_ms) - recovery_started))" "$output.artifacts/update-recovery-times.json" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[3]).write_text(json.dumps({"server_restart_ms": int(sys.argv[1]),
                                       "daemon_restart_ms": int(sys.argv[2]),
                                       "recovery_limit_ms": 60000}) + "\n")
PY
case_metric recovery "$output.artifacts/update-recovery-times.json"
finish_case

# Signed fixture wrapper reports the real candidate version, then deliberately
# fails registration. Production probation, selection and rollback logic run
# unmodified. The wrapper and signing identity never leave this local fixture.
bad_daemon="$UPDATE_SCRATCH/bad-spawnd"
python3 - "$bad_daemon" "$UPDATE_ARTIFACTS/new/spawnd" <<'PY'
import shlex, sys
from pathlib import Path
path, candidate = sys.argv[1:]
Path(path).write_text('''#!/usr/bin/env sh
set -eu
candidate=''' + shlex.quote(candidate) + '''
if [ "${1:-}" = "--version" ]; then exec "$candidate" --version; fi
skip=0
set -- "$@" --end-of-original
for arg in "$@"; do
  shift
  if [ "$arg" = "--end-of-original" ]; then break; fi
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  if [ "$arg" = --server ]; then skip=1; continue; fi
  set -- "$@" "$arg"
done
exec "$candidate" --server http://127.0.0.1:1 "$@"
''')
Path(path).chmod(0o755)
PY
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B" "$bad_daemon" "$UPDATE_ARTIFACTS/new/spawn-worker"
begin_case startup_rollback old "$UPDATE_TREE_A"
marker="$(update_test_probation_marker)"
marker_seen="$UPDATE_FIXTURE/marker-seen"
(
  deadline=$((SECONDS + 60))
  while ((SECONDS < deadline)); do
    if [[ -f "$marker" ]]; then touch "$marker_seen"; exit 0; fi
    sleep .01
  done
  exit 1
) &
watcher_pid=$!
update_test_stop_server
update_test_start_server 1
update_test_wait_host "$UPDATE_TREE_A" failed 'health: registration failed' 60 >/dev/null
wait "$watcher_pid"
watcher_pid=""
[[ -f "$marker_seen" ]] || update_test_die "probation was never observed"
case_check probation_observed
update_test_installed_is old || update_test_die "failed candidate did not roll back"
case_check rollback_applied
stable_child="$(<"$UPDATE_DAEMON_CHILD_PID_FILE")"
[[ "$stable_child" =~ ^[1-9][0-9]*$ ]] || update_test_die "no reverted daemon child PID"
# Two complete keepalive intervals after rollback are mandatory regardless of
# the configured initial soak length. A retry loop cannot count as healthy.
no_retry_started="$(monotonic_ms)"
# Padding covers Bash SECONDS rounding; the measured monotonic duration must
# independently satisfy the full 60-second gate below.
deadline=$((SECONDS + 65))
while ((SECONDS < deadline)); do
  [[ "$(<"$UPDATE_DAEMON_CHILD_PID_FILE")" == "$stable_child" ]] || update_test_die "failed tree restarted again"
  kill -0 "$stable_child" || update_test_die "reverted daemon exited"
  [[ ! -e "$marker" ]] || update_test_die "failed tree probation was re-created"
  update_test_host_json | python3 -c '
import json,sys
h=json.load(sys.stdin); u=h.get("update") or {}
assert h.get("daemon_tree")==sys.argv[1] and h.get("status")=="online"
assert u.get("state")=="failed" and "health: registration failed" in str(u.get("error")).lower()
' "$UPDATE_TREE_A"
  sleep 1
done
python3 - "$(($(monotonic_ms) - no_retry_started))" "$(update_test_sha256 "$bad_daemon")" \
  "$(update_test_sha256 "$UPDATE_PREBUILT/manifest.json")" "$output.artifacts/startup-rollback-observation.json" <<'PY'
import json, sys
from pathlib import Path
Path(sys.argv[4]).write_text(json.dumps({"no_retry_observation_ms": int(sys.argv[1]),
                                       "fixture_fault_wrapper_sha256": sys.argv[2],
                                       "fixture_manifest_sha256": sys.argv[3]}) + "\n")
PY
case_metric rollback "$output.artifacts/startup-rollback-observation.json"
case_check no_retry_loop
case_check probation_cleared
finish_case
printf '%s\n' 'connection-canary: four measured cases complete; final evidence also requires cleanup'
