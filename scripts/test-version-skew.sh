#!/usr/bin/env bash
set -euo pipefail

# Weekly/pre-release daemon/server compatibility ritual. This script never
# contacts a public origin. It creates one detached temporary worktree, runs
# the four local cells through registration plus a real worker-backed PTY, and
# removes the worktree on every exit.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export NO_COLOR=1
unset FORCE_COLOR CLICOLOR CLICOLOR_FORCE 2>/dev/null || true

# shellcheck source=update-test-lib.sh
source "$repo_root/scripts/update-test-lib.sh"

usage() {
  printf '%s\n' "usage: SPAWN_OLD_REF=<deployed-ref> scripts/test-version-skew.sh [--old-ref REF]"
}

self_test() {
  update_test_lib_self_test
  local candidate="${SPAWN_OLD_REF:-}"
  [[ -z "$candidate" || "$candidate" != -* ]] \
    || { printf '%s\n' "test-version-skew: unsafe old ref guard failed" >&2; return 1; }
  printf '%s\n' "test-version-skew: self-test ok"
}

if [[ "${1:-}" == "--self-test" ]]; then
  [[ "$#" == "1" ]] || { usage >&2; exit 2; }
  self_test
  exit 0
fi

old_ref="${SPAWN_OLD_REF:-}"
if [[ "${1:-}" == "--old-ref" && "$#" == "2" ]]; then
  old_ref="$2"
elif [[ "$#" != "0" ]]; then
  usage >&2
  exit 2
fi
[[ -n "$old_ref" && "$old_ref" != -* ]] \
  || { printf '%s\n' "test-version-skew: SKIP (set SPAWN_OLD_REF to the last deployed commit)"; exit 0; }
git cat-file -e "$old_ref^{commit}" 2>/dev/null \
  || { printf 'test-version-skew: old ref does not resolve to a commit: %s\n' "$old_ref" >&2; exit 1; }

started_at=$SECONDS
update_test_init version-skew
old_worktree="$UPDATE_SCRATCH/old-worktree"
worktree_added=0

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  update_test_cleanup_fixture || status=1
  if [[ "$worktree_added" == "1" ]]; then
    git worktree remove --force "$old_worktree" >/dev/null 2>&1 || status=1
  fi
  if [[ "$status" != "0" ]]; then
    for log in "${UPDATE_SERVER_LOG:-}" "${UPDATE_DAEMON_LOG:-}"; do
      [[ -f "$log" ]] && { printf '%s\n' "---- $log ----" >&2; tail -160 "$log" >&2 || true; }
    done
  fi
  if [[ -n "${UPDATE_SCRATCH:-}" && -d "$UPDATE_SCRATCH" ]]; then
    rm -rf "$UPDATE_SCRATCH"
  fi
  exit "$status"
}
trap cleanup EXIT

printf 'test-version-skew: creating detached worktree for %s\n' "$old_ref"
git worktree add --detach "$old_worktree" "$old_ref" >/dev/null
worktree_added=1

update_test_build_identities
old_commit="$(git -C "$old_worktree" rev-parse HEAD)"
old_target_dir="$UPDATE_CARGO_ROOT/skew-old-$(printf '%s' "$old_commit" | cut -c1-12)"
printf '%s\n' "test-version-skew: building previous daemon with the main cache/toolchain"
env \
  CARGO_TARGET_DIR="$old_target_dir" \
  SPAWND_DAEMON_TREE_OVERRIDE="$UPDATE_TREE_A" \
  SPAWND_BUILD_COUNTER_OVERRIDE="$UPDATE_COUNTER_A" \
  SPAWND_RELEASE_PUBLIC_KEYS_OVERRIDE="$UPDATE_PUBLIC_KEY" \
  cargo build --manifest-path "$old_worktree/daemon/Cargo.toml" --locked \
    --bin spawnd --bin spawn-worker >/dev/null
mkdir -p "$UPDATE_ARTIFACTS/skew-old"
cp "$old_target_dir/debug/spawnd" "$UPDATE_ARTIFACTS/skew-old/spawnd"
cp "$old_target_dir/debug/spawn-worker" "$UPDATE_ARTIFACTS/skew-old/spawn-worker"
chmod 755 "$UPDATE_ARTIFACTS/skew-old/spawnd" "$UPDATE_ARTIFACTS/skew-old/spawn-worker"
old_version="$("$UPDATE_ARTIFACTS/skew-old/spawnd" --version | awk 'NR == 1 {print $2}')"
if [[ "$("$UPDATE_ARTIFACTS/skew-old/spawn-worker" --version)" != *"tree=$UPDATE_TREE_A" ]]; then
  printf '%s\n' \
    "test-version-skew: SKIP (needs: SPAWND_DAEMON_TREE_OVERRIDE in the selected old ref)"
  exit 0
fi

new_prebuilt="$UPDATE_SCRATCH/prebuilt-new"
old_prebuilt="$UPDATE_SCRATCH/prebuilt-old"
UPDATE_PREBUILT="$new_prebuilt"
mkdir -p "$UPDATE_PREBUILT/$UPDATE_TARGET"
# The new release carries the diagnostics variant beside its release pair,
# as a published one does. The old daemon predates the `variants` key, and
# the old/new cell is where it is proven to update from such a manifest
# regardless — the alternative is a fleet that refuses the first release
# with a variant in it.
update_test_build_variant_identities
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
update_test_manifest_has_variant diagnostics \
  || update_test_die "the new release manifest does not carry the diagnostics variant"

mkdir -p "$old_prebuilt/$UPDATE_TARGET"
cp "$UPDATE_ARTIFACTS/skew-old/spawnd" "$old_prebuilt/$UPDATE_TARGET/spawnd"
cp "$UPDATE_ARTIFACTS/skew-old/spawn-worker" "$old_prebuilt/$UPDATE_TARGET/spawn-worker"
old_daemon_sha="$(update_test_sha256 "$old_prebuilt/$UPDATE_TARGET/spawnd")"
old_worker_sha="$(update_test_sha256 "$old_prebuilt/$UPDATE_TARGET/spawn-worker")"
render_prebuilt_manifest \
  "$old_commit" "$UPDATE_TREE_A" "$old_version" "$UPDATE_COUNTER_A" "$UPDATE_KEY_ID" \
  "$UPDATE_TARGET:$old_daemon_sha:$old_worker_sha" >"$old_prebuilt/manifest.json"
sign_prebuilt_manifest "$old_prebuilt/manifest.json" "$old_prebuilt/manifest.json.sig" "$UPDATE_KEY_FILE"
mkdir -p "$old_worktree/daemon/target/prebuilt"
cp -R "$old_prebuilt/." "$old_worktree/daemon/target/prebuilt/"

matrix_old_old="PENDING"
matrix_old_new="PENDING"
matrix_new_old="PENDING"
matrix_new_new="PENDING"

run_cell() {
  local daemon_generation="$1"
  local server_generation="$2"
  local result_variable="$3"
  local daemon_dir server_root expected_tree auto_update=0
  if [[ "$daemon_generation" == "old" ]]; then
    daemon_dir="$UPDATE_ARTIFACTS/skew-old"
    expected_tree="$UPDATE_TREE_A"
  else
    daemon_dir="$UPDATE_ARTIFACTS/new"
    expected_tree="$UPDATE_TREE_B"
  fi
  if [[ "$server_generation" == "old" ]]; then
    server_root="$old_worktree"
    UPDATE_PREBUILT="$old_prebuilt"
  else
    server_root="$repo_root"
    UPDATE_PREBUILT="$new_prebuilt"
  fi

  update_test_new_fixture "${daemon_generation}-daemon-${server_generation}-server"
  cp "$daemon_dir/spawnd" "$UPDATE_BIN_DIR/spawnd"
  cp "$daemon_dir/spawn-worker" "$UPDATE_BIN_DIR/spawn-worker"
  chmod 755 "$UPDATE_BIN_DIR/spawnd" "$UPDATE_BIN_DIR/spawn-worker"
  UPDATE_SERVER_ROOT="$server_root"
  update_test_prepare_database

  if [[ "$daemon_generation:$server_generation" == "new:old" ]]; then
    # Model exactly what an old server serves: it knows the manifest route but
    # not the detached-signature route. The new daemon must stay registered.
    rm -f "$old_prebuilt/manifest.json.sig" \
      "$old_worktree/daemon/target/prebuilt/manifest.json.sig"
    auto_update=1
  fi
  update_test_start_server "$auto_update"
  update_test_mint_credentials
  update_test_start_daemon
  update_test_wait_online "$expected_tree"
  update_test_create_session
  update_test_wait_file "$UPDATE_SESSION_CWD/.update-shell-ready" 20

  if [[ "$daemon_generation:$server_generation" == "old:new" ]]; then
    # Establish the PTY first, then enable the real new-server auto cohort.
    update_test_stop_server
    update_test_start_server 1
    update_test_wait_host "$UPDATE_TREE_B" current "" 60 >/dev/null
    expected_tree="$UPDATE_TREE_B"
    # Store-aware daemons select an immutable release; bin/ can deliberately
    # retain the original pair. Verify both binaries selected by this instance.
    update_test_installed_is new \
      || update_test_die "the old daemon did not install the new release pair"
    printf -v "$result_variable" '%s' "PASS (auto-updated; manifest carried variants)"
  elif [[ "$daemon_generation:$server_generation" == "new:old" ]]; then
    update_test_wait_host "$UPDATE_TREE_B" failed "manifest unsigned" 30 >/dev/null
    stable_pid="$UPDATE_DAEMON_PID"
    sleep 5
    kill -0 "$stable_pid" 2>/dev/null \
      || update_test_die "new daemon exited against old server"
    [[ "$(update_test_host_json | python3 -c 'import json,sys; print(json.load(sys.stdin)["daemon_tree"])')" \
      == "$UPDATE_TREE_B" ]] || update_test_die "new daemon downgraded against old server"
    [[ "$(grep -c 'manifest_unsigned' "$UPDATE_DAEMON_LOG" || true)" -le 1 ]] \
      || update_test_die "new daemon entered an unsigned-update loop"
    printf -v "$result_variable" '%s' "PASS (unsigned refused)"
  else
    update_test_wait_host "$expected_tree" current "" 30 >/dev/null
    printf -v "$result_variable" '%s' "PASS"
  fi
  update_test_wait_session_running "$UPDATE_SESSION_ID"
  update_test_cleanup_fixture
}

run_cell old old matrix_old_old
run_cell old new matrix_old_new

# Restore the unsigned old-server manifest after old/new used the new prebuilt.
cp "$old_prebuilt/manifest.json" "$old_worktree/daemon/target/prebuilt/manifest.json"
run_cell new old matrix_new_old
run_cell new new matrix_new_new

printf '%s\n' "test-version-skew: matrix"
printf '%-14s | %-28s | %-28s\n' "" "old server" "new server"
printf '%-14s | %-28s | %-28s\n' "old daemon" "$matrix_old_old" "$matrix_old_new"
printf '%-14s | %-28s | %-28s\n' "new daemon" "$matrix_new_old" "$matrix_new_new"
printf 'test-version-skew: passed in %ss\n' "$((SECONDS - started_at))"
