#!/usr/bin/env bash
set -euo pipefail

# Two daemon instances under one OS user, one release store. The proof for the
# 2026-09-09 incident: installing a second account — of the *other* variant —
# while the first has a live session must not touch the first daemon's pair,
# each instance must update on its own, and the pair every instance runs must
# stay the pair it was built with.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export NO_COLOR=1
unset FORCE_COLOR CLICOLOR CLICOLOR_FORCE 2>/dev/null || true

# shellcheck source=update-test-lib.sh
source "$repo_root/scripts/update-test-lib.sh"

self_test() {
  update_test_lib_self_test
  if update_test_is_local_url "https://spawnd.dev"; then
    printf '%s\n' "test-instance-releases: production URL guard failed" >&2
    return 1
  fi
  printf '%s\n' "test-instance-releases: self-test ok"
}

if [[ "${1:-}" == "--self-test" ]]; then
  [[ "$#" == "1" ]] || { printf '%s\n' "usage: scripts/test-instance-releases.sh [--self-test]" >&2; exit 2; }
  self_test
  exit 0
fi
[[ "$#" == "0" ]] || { printf '%s\n' "usage: scripts/test-instance-releases.sh [--self-test]" >&2; exit 2; }

started_at=$SECONDS
update_test_init instance-releases

cleanup() {
  local status=$?
  trap - EXIT
  # The second daemon is ours to stop; the library only knows the first.
  if [[ -n "${SECOND_DAEMON_PID:-}" ]]; then
    update_test_stop_process second-daemon SECOND_DAEMON_PID || true
  fi
  update_test_cleanup_all "$status" || status=$?
  exit "$status"
}
trap cleanup EXIT

update_test_build_identities
update_test_build_variant_identities
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"

exe_of() { readlink "/proc/$1/exe"; }
release_count() { update_test_release_count; }
pair_matches_at() { # daemon-path
  local daemon="$1" worker="${1%/*}/spawn-worker" dv wv
  dv="$("$daemon" --version | awk '{print $2}')"
  wv="$("$worker" --version | awk '{print $2}')"
  [[ "$dv" == "$wv" ]]
}

printf '%s\n' "test-instance-releases: a first account with a live session"
update_test_new_fixture two-accounts
update_test_prepare_database
update_test_start_server 0
update_test_mint_credentials
first_config="$UPDATE_CONFIG_DIR"
first_home="$UPDATE_DAEMON_HOME"
update_test_start_daemon
update_test_wait_online "$UPDATE_TREE_A"
first_pid="$UPDATE_DAEMON_PID"
first_token="$UPDATE_TOKEN"
first_host="$UPDATE_HOST_ID"
update_test_installed_is old \
  || update_test_die "the first daemon did not adopt its legacy pair into the store"
first_release="$(update_test_selected_release)"
[[ "$(exe_of "$first_pid")" == "$first_release/spawnd" ]] \
  || update_test_die "the first daemon is not running from its release"
update_test_create_session
first_session="$UPDATE_SESSION_ID"
first_worker_socket="$UPDATE_WORKER_DIR/$first_session.sock"
update_test_wait_file "$first_worker_socket" 20
printf '%s\n' "test-instance-releases: PASS first instance in the store with a live session"

printf '%s\n' "test-instance-releases: installing the diagnostics variant as a second account"
# What install.sh does after downloading: hand the pair to spawnd itself.
stage="$UPDATE_FIXTURE/download"
mkdir -p "$stage"
cp "$UPDATE_ARTIFACTS/old-diagnostics/spawnd" "$UPDATE_ARTIFACTS/old-diagnostics/spawn-worker" "$stage/"
chmod 755 "$stage/spawnd" "$stage/spawn-worker"
# A unit that still starts from the legacy pair keeps the installer's hands
# off bin/ — the first daemon's own pair, had it not moved into the store.
mkdir -p "$first_home/.config/systemd/user"
printf 'ExecStart="%s" run\n' "$UPDATE_BIN_DIR/spawnd" >"$first_home/.config/systemd/user/spawn-legacy.service"
publish_out="$(HOME="$first_home" "$stage/spawnd" __publish-release --install-root "$UPDATE_FIXTURE")"
printf '%s\n' "$publish_out"
grep -q "was left as it is" <<<"$publish_out" \
  || update_test_die "the installer replaced a pair a daemon still starts from"
cmp -s "$UPDATE_BIN_DIR/spawnd" "$UPDATE_ARTIFACTS/old/spawnd" \
  || update_test_die "bin/spawnd was rewritten under a unit that names it"
rm "$first_home/.config/systemd/user/spawn-legacy.service"
publish_out="$(HOME="$first_home" "$stage/spawnd" __publish-release --install-root "$UPDATE_FIXTURE")"
printf '%s\n' "$publish_out"
grep -q "now runs this release" <<<"$publish_out" \
  || update_test_die "the installer did not point bin/ at the new release once nothing launched from it"
diagnostics_release="$(sed -n 's/^spawn: published .* to //p' <<<"$publish_out" | head -n 1)"
[[ -d "$diagnostics_release" && "$diagnostics_release" != "$first_release" ]] \
  || update_test_die "the diagnostics pair did not get its own release directory"
[[ "$(release_count)" == "2" ]] || update_test_die "expected two releases, found $(release_count)"
[[ -L "$UPDATE_BIN_DIR/spawnd" && "$(readlink -f "$UPDATE_BIN_DIR/spawnd")" == "$diagnostics_release/spawnd" ]] \
  || update_test_die "bin/spawnd is not a link to the newly published release"
# The incident's assertion: the first daemon's release is untouched, it still
# runs it, and it can still open a session.
cmp -s "$first_release/spawnd" "$UPDATE_ARTIFACTS/old/spawnd" \
  && cmp -s "$first_release/spawn-worker" "$UPDATE_ARTIFACTS/old/spawn-worker" \
  || update_test_die "publishing the second account's pair changed the first instance's release"
[[ "$(exe_of "$first_pid")" == "$first_release/spawnd" ]] \
  || update_test_die "the first daemon's executable changed"
pair_matches_at "$(exe_of "$first_pid")" || update_test_die "the first daemon's pair no longer matches"
update_test_create_session
second_session="$UPDATE_SESSION_ID"
update_test_wait_file "$UPDATE_WORKER_DIR/$second_session.sock" 20
[[ -S "$first_worker_socket" ]] || update_test_die "the first session's worker disappeared"
printf '%s\n' "test-instance-releases: PASS second account published without touching the first daemon"

printf '%s\n' "test-instance-releases: the second account's daemon runs beside the first"
# A second account instance: its own config root, its own registration, its
# own worker directory — started from the command on PATH, as possess would.
second_home="$UPDATE_FIXTURE/second-home"
second_config="$second_home/.config/spawn"
second_workers="$(mktemp -d "$(SPAWN_UPDATE_TEST_ROOT=/tmp SPAWN_UPDATE_TMP_ROOT= TMPDIR= update_test_resolve_scratch_root)/su.XXXXXX")"
mkdir -p "$second_config"
chmod 700 "$second_config"
saved_home="$UPDATE_DAEMON_HOME"
UPDATE_DAEMON_HOME="$second_home"
update_test_mint_credentials "$UPDATE_DAEMON_URL" second
UPDATE_DAEMON_HOME="$saved_home"
second_token="$UPDATE_TOKEN"
second_host="$UPDATE_HOST_ID"
second_log="$UPDATE_FIXTURE/second-daemon.log"
(
  cd "$UPDATE_FIXTURE" \
    && exec env -u SPAWN_SERVER_URL -u XDG_CONFIG_HOME \
      HOME="$second_home" \
      SPAWN_DISABLE_KEYRING=1 \
      SPAWN_CONFIG_DIR="$second_config" \
      SPAWND_WORKER_DIR="$second_workers" \
      SHELL="$UPDATE_SHELL" \
      NO_COLOR=1 \
      "$UPDATE_BIN_DIR/spawnd" --server "$UPDATE_DAEMON_URL" run
) >>"$second_log" 2>&1 &
SECOND_DAEMON_PID=$!
update_test_wait_online "$UPDATE_TREE_A"
[[ "$(exe_of "$SECOND_DAEMON_PID")" == "$diagnostics_release/spawnd" ]] \
  || update_test_die "the second daemon is not running the diagnostics release: $(exe_of "$SECOND_DAEMON_PID")"
pair_matches_at "$(exe_of "$SECOND_DAEMON_PID")" || update_test_die "the second daemon's pair does not match"
[[ "$("$(exe_of "$SECOND_DAEMON_PID")" --version | awk '{print $2}')" == "$UPDATE_VARIANT_VERSION" ]] \
  || update_test_die "the second daemon is not the diagnostics build"
second_instance="$UPDATE_STORE/instances/$(update_test_instance_tag "$second_config")"
[[ "$second_instance" != "$UPDATE_INSTANCE" ]] || update_test_die "both instances share one pointer"
# Both heartbeats say what they run, and neither reports a mismatch.
python3 - "$first_config/state.json" "$second_config/state.json" "$first_release/spawnd" "$diagnostics_release/spawnd" <<'PY'
import json
import sys

first, second, first_exe, second_exe = sys.argv[1:]
a = json.load(open(first, encoding="utf-8"))
b = json.load(open(second, encoding="utf-8"))
assert a["exe"] == first_exe, a
assert b["exe"] == second_exe, b
assert not a.get("worker_mismatch") and not b.get("worker_mismatch"), (a, b)
assert a["release"] != b["release"], (a["release"], b["release"])
PY
printf '%s\n' "test-instance-releases: PASS standard and diagnostics daemons coexist"

printf '%s\n' "test-instance-releases: status and doctor describe each instance, not the command"
status_json="$(
  cd "$UPDATE_FIXTURE" && env -u SPAWN_SERVER_URL HOME="$first_home" SPAWN_DISABLE_KEYRING=1 \
    SPAWN_CONFIG_DIR="$second_config" \
    "$UPDATE_ARTIFACTS/old/spawnd" --config-dir "$second_config" status --json
)"
python3 - "$UPDATE_VARIANT_VERSION" "$UPDATE_VERSION" "$diagnostics_release" "$status_json" <<'PY'
import json
import sys

variant_version, release_version, diagnostics_release, raw = sys.argv[1:]
status = json.loads(raw)["instances"][0]
# The release build of spawnd reports the diagnostics instance as what it is.
assert status["version"] == variant_version, status["version"]
assert status["cli_version"] == release_version, status["cli_version"]
assert status["running"]["exe"] == diagnostics_release + "/spawnd", status["running"]
assert status["pair"] == "matches", status["pair"]
assert status["launch"] == "release store", status["launch"]
PY
# An unreachable --server keeps doctor's websocket probe off the second
# daemon's live control connection; the local checks are what this proves.
doctor_json="$(
  cd "$UPDATE_FIXTURE" && env -u SPAWN_SERVER_URL HOME="$first_home" SPAWN_DISABLE_KEYRING=1 \
    SPAWN_CONFIG_DIR="$second_config" \
    "$UPDATE_ARTIFACTS/old/spawnd" --server http://127.0.0.1:1 --config-dir "$second_config" doctor --json 2>/dev/null || true
)"
python3 - "$doctor_json" <<'PY'
import json
import sys

checks = {check["name"]: check for check in json.loads(sys.argv[1])["checks"]}
worker = checks["worker binary"]
assert worker["status"] == "ok", worker
assert "matches the running spawnd" in worker["detail"], worker
layout = checks["install layout"]
assert layout["status"] == "warn", layout
assert "without a selection" in layout["detail"], layout
PY
printf '%s\n' "test-instance-releases: PASS status/doctor judge the instance"

printf '%s\n' "test-instance-releases: each instance updates on its own"
update_test_post_update '{}'
[[ "$UPDATE_HTTP_STATUS" == "202" ]] \
  || update_test_die "second-account update returned $UPDATE_HTTP_STATUS: $UPDATE_HTTP_BODY"
# The library's host variables point at the second account after minting.
update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
[[ "$(exe_of "$SECOND_DAEMON_PID")" == "$UPDATE_RELEASES"/*/spawnd ]] \
  || update_test_die "the updated second daemon is not running from the store"
cmp -s "$(exe_of "$SECOND_DAEMON_PID")" "$UPDATE_ARTIFACTS/new-diagnostics/spawnd" \
  || update_test_die "the diagnostics instance did not update to the diagnostics pair"
# The first instance is exactly where it was.
[[ "$(exe_of "$first_pid")" == "$first_release/spawnd" ]] \
  || update_test_die "updating the second instance moved the first"
update_test_installed_is old || update_test_die "updating the second instance repointed the first"
[[ -S "$first_worker_socket" ]] || update_test_die "the first session's worker died during the second update"
# Now the first: back to its own host on the server.
UPDATE_TOKEN="$first_token"
UPDATE_HOST_ID="$first_host"
update_test_post_update '{}'
[[ "$UPDATE_HTTP_STATUS" == "202" ]] \
  || update_test_die "first-account update returned $UPDATE_HTTP_STATUS: $UPDATE_HTTP_BODY"
update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
update_test_wait_installed new 15
kill -0 "$first_pid" 2>/dev/null || update_test_die "the first daemon's PID changed across its update"
cmp -s "$(exe_of "$first_pid")" "$UPDATE_ARTIFACTS/new/spawnd" \
  || update_test_die "the first instance did not update to the release pair"
[[ -S "$first_worker_socket" ]] || update_test_die "the first session's worker died across the first update"
update_test_wait_session_running "$first_session"
cmp -s "$(exe_of "$SECOND_DAEMON_PID")" "$UPDATE_ARTIFACTS/new-diagnostics/spawnd" \
  || update_test_die "updating the first instance disturbed the second"
pair_matches_at "$(exe_of "$first_pid")" && pair_matches_at "$(exe_of "$SECOND_DAEMON_PID")" \
  || update_test_die "a pair stopped matching after the updates"
# Collection: the two releases the instances moved off stay through the grace
# period, then go on the next pass — except the one the command on PATH still
# resolves to, which must keep working. The two live releases remain.
[[ "$(release_count)" == "4" ]] \
  || update_test_die "expected four releases before collection: $(ls "$UPDATE_RELEASES")"
update_test_age_release "$first_release"
update_test_age_release "$diagnostics_release"
update_test_run_update_cli
[[ ! -d "$first_release" ]] || update_test_die "the aged previous release of the first instance survived collection"
[[ -d "$diagnostics_release" ]] || update_test_die "the release bin/spawnd resolves to was collected"
[[ "$(release_count)" == "3" ]] \
  || update_test_die "expected three releases after collection: $(ls "$UPDATE_RELEASES")"
[[ -d "$(dirname "$(exe_of "$first_pid")")" && -d "$(dirname "$(exe_of "$SECOND_DAEMON_PID")")" ]] \
  || update_test_die "a live release was collected"
printf '%s\n' "test-instance-releases: PASS independent updates, sessions intact, store collected"

# The second daemon is stopped here so the library's cleanup, which only knows
# the first, does not trip over its worker.
update_test_stop_process second-daemon SECOND_DAEMON_PID
UPDATE_TOKEN="$second_token"
UPDATE_HOST_ID="$second_host"
rm -rf "$second_workers"
UPDATE_TOKEN="$first_token"
UPDATE_HOST_ID="$first_host"
update_test_cleanup_fixture

printf 'test-instance-releases: passed in %ss\n' "$((SECONDS - started_at))"
