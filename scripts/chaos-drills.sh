#!/usr/bin/env bash
set -euo pipefail

# Local connection-chaos ritual. Expected observations:
#
# - SIGSTOP: GET /api/hosts/{id}.status becomes offline within the server's
#   90-second derived-presence window; SIGCONT returns it online; the server
#   log contains zero close-4000 supersessions.
# - Uvicorn SIGKILL: the worker socket and shell survive, no rtc.close is
#   generated merely because signalling vanished, and the daemon registers
#   again after restart. A live browser binding should then report
#   rtc.status=rebound (MANUAL until the harness has a reusable RTC observer).
# - Scoped TCP pfctl block for 30 seconds: daemon watchdog reconnects and a
#   live terminal resumes without reload (MANUAL; never prompts for sudo).
# - UDP 50000:50100 block: an available UDP TURN relay wins; blocking TURN UDP
#   too produces the explicit cannot-use-TURN-TCP warning (MANUAL).
# - Network Link Conditioner "Very Bad Network" while `yes` streams produces
#   pacing/pty_gap recovery, never DataChannel death (MANUAL).
# - Two-minute lid close or Wi-Fi toggle uses ICE restart and returns inside
#   the ten-second restart budget, without rebuilding the terminal (MANUAL).

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

export NO_COLOR=1
unset FORCE_COLOR CLICOLOR CLICOLOR_FORCE 2>/dev/null || true

# shellcheck source=update-test-lib.sh
source "$repo_root/scripts/update-test-lib.sh"

chaos_sudo_allowed() {
  [[ "${SPAWN_ALLOW_SUDO:-0}" == "1" ]] || return 1
  sudo -n true >/dev/null 2>&1
}

self_test() {
  update_test_lib_self_test
  local saved="${SPAWN_ALLOW_SUDO-__unset__}"
  unset SPAWN_ALLOW_SUDO
  if chaos_sudo_allowed; then
    printf '%s\n' "chaos-drills: sudo guard allowed an ungated invocation" >&2
    return 1
  fi
  if [[ "$saved" != "__unset__" ]]; then export SPAWN_ALLOW_SUDO="$saved"; fi
  printf '%s\n' "chaos-drills: self-test ok"
}

if [[ "${1:-}" == "--self-test" ]]; then
  [[ "$#" == "1" ]] || { printf '%s\n' "usage: scripts/chaos-drills.sh [--self-test]" >&2; exit 2; }
  self_test
  exit 0
fi
[[ "$#" == "0" ]] || { printf '%s\n' "usage: scripts/chaos-drills.sh [--self-test]" >&2; exit 2; }

started_at=$SECONDS
update_test_init chaos-drills

cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "${UPDATE_DAEMON_PID:-}" ]]; then
    kill -CONT "$UPDATE_DAEMON_PID" >/dev/null 2>&1 || true
  fi
  update_test_cleanup_all "$status" || status=$?
  exit "$status"
}
trap cleanup EXIT

update_test_build_identities
update_test_write_manifest "$UPDATE_TREE_B" "$UPDATE_COUNTER_B"
update_test_new_fixture chaos
cp "$UPDATE_ARTIFACTS/new/spawnd" "$UPDATE_BIN_DIR/spawnd"
cp "$UPDATE_ARTIFACTS/new/spawn-worker" "$UPDATE_BIN_DIR/spawn-worker"
chmod 755 "$UPDATE_BIN_DIR/spawnd" "$UPDATE_BIN_DIR/spawn-worker"
update_test_prepare_database
update_test_start_server 0
update_test_mint_credentials
update_test_start_daemon
update_test_wait_online "$UPDATE_TREE_B"

printf '%s\n' "chaos-drills: SIGSTOP -> derived offline -> SIGCONT"
kill -STOP "$UPDATE_DAEMON_PID"
python3 - "$UPDATE_SERVER_URL" "$UPDATE_TOKEN" "$UPDATE_HOST_ID" <<'PY'
import json
import sys
import time
import urllib.request

origin, token, host_id = sys.argv[1:]
deadline = time.monotonic() + 95
last = None
while time.monotonic() < deadline:
    request = urllib.request.Request(
        f"{origin}/api/hosts/{host_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        last = json.loads(response.read().decode())
    if last.get("status") == "offline":
        raise SystemExit(0)
    time.sleep(0.5)
raise SystemExit(f"host did not become derived-offline inside 90s: {last!r}")
PY
kill -CONT "$UPDATE_DAEMON_PID"
update_test_wait_online "$UPDATE_TREE_B" 30
supersessions="$(grep -Ec '(^|[^0-9])4000([^0-9]|$)|superseded' "$UPDATE_SERVER_LOG" || true)"
[[ "$supersessions" == "0" ]] \
  || update_test_die "SIGSTOP recovery caused $supersessions supersession close(s)"
printf '%s\n' "chaos-drills: PASS half-open recovery (4000 closes=0)"

printf '%s\n' "chaos-drills: SIGKILL uvicorn while a worker owns a PTY"
update_test_create_session
update_test_wait_file "$UPDATE_SESSION_CWD/.update-shell-ready" 20
worker_socket="$UPDATE_WORKER_DIR/$UPDATE_SESSION_ID.sock"
update_test_wait_file "$worker_socket" 20
rtc_closes_before="$(grep -c 'rtc.close' "$UPDATE_DAEMON_LOG" || true)"
registrations_before="$(grep -c 'registered with server' "$UPDATE_DAEMON_LOG" || true)"
update_test_stop_server KILL
sleep 2
[[ -S "$worker_socket" ]] || update_test_die "worker socket vanished with uvicorn"
kill -0 "$UPDATE_DAEMON_PID" 2>/dev/null || update_test_die "daemon exited with uvicorn"
rtc_closes_after="$(grep -c 'rtc.close' "$UPDATE_DAEMON_LOG" || true)"
[[ "$rtc_closes_after" == "$rtc_closes_before" ]] \
  || update_test_die "server loss emitted rtc.close"
update_test_start_server 0
deadline=$((SECONDS + 30))
while ((SECONDS < deadline)); do
  registrations_after="$(grep -c 'registered with server' "$UPDATE_DAEMON_LOG" || true)"
  ((registrations_after > registrations_before)) && break
  sleep 0.1
done
((registrations_after > registrations_before)) \
  || update_test_die "daemon did not re-register after uvicorn restart"
update_test_wait_online "$UPDATE_TREE_B" 30
update_test_wait_session_running "$UPDATE_SESSION_ID"
[[ -S "$worker_socket" ]] || update_test_die "worker was not retained after server restart"
printf '%s\n' "chaos-drills: PASS server vanish (worker retained, no rtc.close)"
printf '%s\n' \
  "chaos-drills: SKIP rtc.status rebound/live_bindings (needs: reusable headless RTC binding observer for the shell harness)"

if [[ "${SPAWN_ALLOW_SUDO:-0}" != "1" ]]; then
  printf '%s\n' \
    "chaos-drills: MANUAL TCP pfctl — refused (set SPAWN_ALLOW_SUDO=1; commands always use sudo -n)"
  printf '%s\n' \
    "chaos-drills: MANUAL UDP/TURN pfctl — refused (set SPAWN_ALLOW_SUDO=1; scope to UDP 50000:50100 and the local TURN host)"
elif ! chaos_sudo_allowed; then
  printf '%s\n' \
    "chaos-drills: MANUAL pfctl — SKIP (sudo -n is unavailable; refusing to prompt for a password)"
else
  printf '%s\n' \
    "chaos-drills: MANUAL pfctl authorized — apply a named temporary anchor scoped to 127.0.0.1:$UPDATE_SERVER_PORT for 30s, then remove it and observe watchdog reconnect + rtc.resume"
  printf '%s\n' \
    "chaos-drills: MANUAL UDP authorized — block only UDP 50000:50100, verify TURN; then include TURN UDP and verify the honest no-TURN-TCP warning; remove the anchor immediately"
fi
printf '%s\n' \
  "chaos-drills: MANUAL NLC — Very Bad Network + yes: expect pacing/pty_gap, no channel death"
printf '%s\n' \
  "chaos-drills: MANUAL sleep/Wi-Fi — expect ICE restart in <=10s, no terminal rebuild"

printf 'chaos-drills: completed in %ss\n' "$((SECONDS - started_at))"
