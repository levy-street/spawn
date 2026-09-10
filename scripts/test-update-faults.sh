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
  python3 scripts/fault-proxy.py --self-test
  if python3 scripts/fault-proxy.py \
    --listen 0.0.0.0:1234 --upstream 127.0.0.1:1235 hang >/dev/null 2>&1; then
    printf '%s\n' "test-update-faults: non-local proxy listen guard failed" >&2
    return 1
  fi
  printf '%s\n' "test-update-faults: self-test ok"
}

if [[ "${1:-}" == "--self-test" ]]; then
  [[ "$#" == "1" ]] || { printf '%s\n' "usage: scripts/test-update-faults.sh [--self-test]" >&2; exit 2; }
  self_test
  exit 0
fi
[[ "$#" == "0" ]] || { printf '%s\n' "usage: scripts/test-update-faults.sh [--self-test]" >&2; exit 2; }

started_at=$SECONDS
update_test_init update-faults

cleanup() {
  local status=$?
  trap - EXIT
  update_test_cleanup_all "$status" || status=$?
  exit "$status"
}
trap cleanup EXIT

update_test_build_identities

run_failure_case() {
  local label="$1"
  local daemon_source="$2"
  local match_path="$3"
  local expected_error="$4"
  shift 4

  update_test_write_manifest \
    "$UPDATE_TREE_B" "$UPDATE_COUNTER_B" "$daemon_source" "$UPDATE_ARTIFACTS/new/spawn-worker"
  update_test_new_fixture "$label"
  update_test_prepare_database
  update_test_start_server 0
  update_test_start_proxy "$match_path" "$@"
  update_test_mint_credentials "$UPDATE_PROXY_URL"
  update_test_start_daemon "$UPDATE_PROXY_URL"
  update_test_wait_online "$UPDATE_TREE_A"
  update_test_post_update '{}'
  [[ "$UPDATE_HTTP_STATUS" == "202" ]] \
    || update_test_die "$label update returned $UPDATE_HTTP_STATUS: $UPDATE_HTTP_BODY"
  update_test_wait_host "$UPDATE_TREE_A" failed "$expected_error" 45 >/dev/null
  update_test_installed_is old \
    || update_test_die "$label changed the release the instance is pointed at"
  # A failed download or verification publishes nothing: the store holds the
  # adopted old pair and no staging directory.
  [[ "$(update_test_release_count)" == "1" ]] \
    || update_test_die "$label left $(update_test_release_count) releases in the store"
  ! find "$UPDATE_RELEASES" -mindepth 1 -maxdepth 1 -name '.staging-*' | grep -q . \
    || update_test_die "$label left a staging directory behind"
  kill -0 "$UPDATE_DAEMON_PID" 2>/dev/null \
    || update_test_die "$label stopped the registered old daemon"
  python3 -c 'import json,sys; h=json.load(sys.stdin); assert h["status"] == "online"' \
    <<<"$(update_test_host_json)"
  printf 'test-update-faults: PASS %s -> %s\n' "$label" "$expected_error"
  update_test_cleanup_fixture
}

# The production daemon exposes no runtime override for DOWNLOAD_TIMEOUT. A
# literal hang therefore takes the full five-minute budget, which is too slow
# for the unconditional local CI subset. Keep this visible and exact: D4 needs
# a test-only budget override before this assertion can become a normal case.
printf '%s\n' \
  "test-update-faults: SKIP hang -> download (needs: test-only SPAWND_UPDATE_DOWNLOAD_TIMEOUT_MS override; production budget is fixed at 300s)"

run_failure_case truncate "$UPDATE_ARTIFACTS/new/spawnd" \
  '/api/install/spawnd/*' 'verify:' truncate --bytes 100000

run_failure_case flip-binary "$UPDATE_ARTIFACTS/new/spawnd" \
  '/api/install/spawnd/*' 'verify:' flip --at 1000

# An in-transit manifest flip must fail the digest pinned in daemon.update
# before signature verification.
run_failure_case flip-manifest "$UPDATE_ARTIFACTS/new/spawnd" \
  '/api/install/manifest.json' 'manifest mismatch' flip --at 1

# To pin manifest_bad_signature separately, append valid JSON whitespace after
# signing but before the server advertises its digest. The daemon therefore
# receives exactly the advertised bytes while the detached signature remains
# a signature over the original manifest.
printf '%s\n' "test-update-faults: flipped signed manifest bytes"
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
python3 - "$UPDATE_PREBUILT/manifest.json" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
path.write_bytes(path.read_bytes() + b" ")
PY
update_test_new_fixture manifest-bad-signature
update_test_prepare_database
update_test_start_server 0
update_test_start_proxy '/never' latency --ms 0
update_test_mint_credentials "$UPDATE_PROXY_URL"
update_test_start_daemon "$UPDATE_PROXY_URL"
update_test_wait_online "$UPDATE_TREE_A"
update_test_post_update '{}'
[[ "$UPDATE_HTTP_STATUS" == "202" ]] \
  || update_test_die "manifest signature update returned $UPDATE_HTTP_STATUS: $UPDATE_HTTP_BODY"
update_test_wait_host "$UPDATE_TREE_A" failed 'manifest bad signature' 45 >/dev/null
update_test_installed_is old \
  || update_test_die "manifest signature failure changed the installed daemon"
printf '%s\n' "test-update-faults: PASS manifest_bad_signature"
update_test_cleanup_fixture

printf '%s\n' "test-update-faults: trickled binary remains atomic"
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
update_test_new_fixture trickle
update_test_prepare_database
update_test_start_server 0
update_test_start_proxy '/api/install/spawnd/*' trickle \
  --rate "${SPAWN_TEST_TRICKLE_RATE:-25000000}"
update_test_mint_credentials "$UPDATE_PROXY_URL"
update_test_start_daemon "$UPDATE_PROXY_URL"
update_test_wait_online "$UPDATE_TREE_A"
update_test_post_update '{}'
[[ "$UPDATE_HTTP_STATUS" == "202" ]] \
  || update_test_die "trickle update returned $UPDATE_HTTP_STATUS: $UPDATE_HTTP_BODY"
set +e
trickle_host="$(update_test_wait_host "$UPDATE_TREE_B" current "" 120 2>/dev/null)"
trickle_status=$?
set -e
if [[ "$trickle_status" == "0" ]]; then
  update_test_wait_installed new 10 \
    || update_test_die "trickle reported current without installing v-new"
  printf '%s\n' "test-update-faults: PASS trickle -> completed"
else
  host="$(update_test_host_json)"
  python3 -c '
import json
import sys

host = json.load(sys.stdin)
update = host["update"]
if update["state"] != "failed" or not str(update.get("error") or "").startswith(("download:", "verify:")):
    raise SystemExit(f"trickle neither completed nor failed cleanly: {host!r}")
' <<<"$host"
  update_test_installed_is old \
    || update_test_die "failed trickle changed the old daemon"
  printf '%s\n' "test-update-faults: PASS trickle -> clean failure"
fi
update_test_cleanup_fixture

fake_dir="$UPDATE_SCRATCH/fake-binaries"
mkdir -p "$fake_dir"
cat >"$fake_dir/version-exit" <<'SH'
#!/usr/bin/env sh
if [ "${1:-}" = "--version" ]; then exit 1; fi
exit 1
SH
cat >"$fake_dir/version-wrong" <<'SH'
#!/usr/bin/env sh
if [ "${1:-}" = "--version" ]; then printf '%s\n' 'spawnd 99.0.0+gwrongwrongwr'; exit 0; fi
exit 1
SH
cat >"$fake_dir/version-sleep" <<'SH'
#!/usr/bin/env sh
if [ "${1:-}" = "--version" ]; then sleep 20; printf '%s\n' 'spawnd late'; exit 0; fi
exit 1
SH
chmod 755 "$fake_dir/version-exit" "$fake_dir/version-wrong" "$fake_dir/version-sleep"

# These cases still use one proxied origin; the selector deliberately matches
# no updater path so the candidate's --version behavior is the injected fault.
run_failure_case version-exit "$fake_dir/version-exit" \
  '/never' 'verify:' latency --ms 0
run_failure_case version-wrong "$fake_dir/version-wrong" \
  '/never' 'verify:' latency --ms 0
run_failure_case version-timeout "$fake_dir/version-sleep" \
  '/never' 'verify:' latency --ms 0

printf 'test-update-faults: passed in %ss (1 explicit SKIP)\n' "$((SECONDS - started_at))"
