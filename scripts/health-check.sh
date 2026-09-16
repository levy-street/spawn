#!/usr/bin/env bash
# Check that this deployment is actually healthy, and say so loudly in the
# journal when it is not.
#
# Deliberately answers the questions that stay silent until a user complains:
# is the API up, is the web app up, does the public WebSocket proxy upgrade,
# does configured TURN answer and is its relay pool exhausted, is Redis up, is
# the disk filling, are backups still being taken. A service that is "active"
# but returning 502, or a backup timer that has quietly produced nothing for a
# week, both look fine from `systemctl status` alone.
#
# Exits non-zero on any failure so the unit shows in `systemctl --failed`,
# which is the one place an operator looks without being told to.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
connection_probe="$script_dir/connection-probe.py"

problems=()
note() { echo "health: $*"; }
warn() { echo "health: WARN $*" >&2; }
fail() { echo "health: FAIL $*" >&2; problems+=("$*"); }

units_with_turn() {
  local units="$1"
  local turn_urls="$2"
  if [[ -n "$turn_urls" && " $units " != *" coturn "* ]]; then
    units="$units coturn"
  fi
  printf '%s\n' "$units"
}

# The relay's two failure signatures, counted over one journal window read
# from stdin, and the verdict on them: prints "<ok|fail> <exhaustions>
# <rejections>". Pure — a function over text — so the self-test can feed it
# fixtures and the real run can feed it journalctl.
#
# `create_relay_ioa_sockets: no available ports` means the relay port pool is
# full and a new relayed connection just failed: any is a failure. `check_stun_auth:
# Cannot find credentials of user` is coturn refusing an expired credential; a
# client that reconnects with one the relay expired a moment ago produces a
# handful an hour, while a client presenting expired credentials on every
# reconnect — the shape of #71, a loop every 20–50 s — produces well over the
# threshold. docs/NETWORK.md, "Relay credential and allocation lifetimes".
coturn_journal_verdict() {
  local max_rejections="$1"
  local text exhaustions rejections verdict=ok
  text="$(cat)"
  exhaustions="$(printf '%s\n' "$text" | grep -c 'no available ports')" || true
  rejections="$(printf '%s\n' "$text" | grep -c 'Cannot find credentials')" || true
  if [[ "$exhaustions" -gt 0 || "$rejections" -gt "$max_rejections" ]]; then
    verdict=fail
  fi
  printf '%s %s %s\n' "$verdict" "$exhaustions" "$rejections"
}

# journalctl exits 0 whether or not it could see the system journal: a user
# outside adm/systemd-journal gets its own (empty) journal plus a hint on
# stderr, and a unit with no entries prints "-- No entries --". So the
# verdict above is only meaningful when stderr (given here as text) carries
# none of systemd's access warnings.
journal_access_denied() {
  local stderr_text="$1"
  [[ "$stderr_text" == *"not seeing messages"* ||
    "$stderr_text" == *"insufficient permissions"* ||
    "$stderr_text" == *"No journal files"* ||
    "$stderr_text" == *"Permission denied"* ]]
}

# The relay-pool row runs wherever coturn is: named in the unit list (which
# SPAWN_TURN_URLS or SPAWN_HEALTH_UNITS does), or simply installed on this
# host. A health timer whose environment carries neither still has the
# journal, and the journal is where the storm shows.
relay_row_applies() {
  local units="$1"
  local coturn_unit_present="$2"
  [[ " $units " == *" coturn "* || "$coturn_unit_present" == yes ]]
}

# Returns 2, rather than failing the deployment, when this host lacks the
# dependency-free Python probe. A real handshake/TLS/protocol failure is 1.
run_connection_probe() {
  local kind="$1"
  local target="$2"
  local output
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 is unavailable; cannot run the $kind connection probe"
    return 2
  fi
  if [[ ! -r "$connection_probe" ]]; then
    warn "$connection_probe is unavailable; cannot run the $kind connection probe"
    return 2
  fi
  if output="$(python3 "$connection_probe" "$kind" "$target" 2>&1)"; then
    note "$output"
    return 0
  fi
  fail "$output"
  return 1
}

if [[ "${1:-}" == "--self-test" ]]; then
  [[ "$#" -eq 1 ]] || {
    echo "usage: scripts/health-check.sh --self-test" >&2
    exit 2
  }
  command -v python3 >/dev/null 2>&1 || {
    echo "health: python3 is required for --self-test" >&2
    exit 1
  }
  python3 "$connection_probe" --self-test || exit 1
  [[ "$(units_with_turn 'spawn-server spawn-web redis-server' '')" == \
    "spawn-server spawn-web redis-server" ]] || exit 1
  [[ "$(units_with_turn 'spawn-server spawn-web redis-server' 'turn:example:3478')" == \
    "spawn-server spawn-web redis-server coturn" ]] || exit 1
  [[ "$(units_with_turn 'spawn-server coturn' 'turn:example:3478')" == \
    "spawn-server coturn" ]] || exit 1
  exhausted='Sep 06 07:22:01 relay turnserver[812]: 0: : ERROR: create_relay_ioa_sockets: no available ports'
  rejected='Sep 06 07:22:02 relay turnserver[812]: 0: : check_stun_auth: Cannot find credentials of user <1757000000:user>'
  benign='Sep 06 07:22:03 relay turnserver[812]: 0: : session 000000000000000001: realm <spawnd.dev> user <1757600000:user>: incoming packet ALLOCATE processed, success'
  journal_lines() {
    local line="$1" count="$2"
    local i
    for ((i = 0; i < count; i++)); do printf '%s\n' "$line"; done
  }
  [[ "$(printf '' | coturn_journal_verdict 30)" == "ok 0 0" ]] || exit 1
  [[ "$(journal_lines "$benign" 5 | coturn_journal_verdict 30)" == "ok 0 0" ]] || exit 1
  [[ "$(journal_lines "$exhausted" 1 | coturn_journal_verdict 30)" == "fail 1 0" ]] || exit 1
  [[ "$(journal_lines "$rejected" 30 | coturn_journal_verdict 30)" == "ok 0 30" ]] || exit 1
  [[ "$(journal_lines "$rejected" 31 | coturn_journal_verdict 30)" == "fail 0 31" ]] || exit 1
  [[ "$( (journal_lines "$exhausted" 3; journal_lines "$rejected" 2; journal_lines "$benign" 4) \
    | coturn_journal_verdict 30)" == "fail 3 2" ]] || exit 1
  journal_access_denied 'Hint: You are currently not seeing messages from other users and the system.
  Users in groups '"'"'adm'"'"', '"'"'systemd-journal'"'"' can see all messages.' || exit 1
  journal_access_denied 'No journal files were opened due to insufficient permissions.' || exit 1
  journal_access_denied 'No journal files were found.' || exit 1
  journal_access_denied 'Failed to open journal: Permission denied' || exit 1
  ! journal_access_denied '' || exit 1
  ! journal_access_denied '-- No entries --' || exit 1
  relay_row_applies 'spawn-server spawn-web redis-server coturn' no || exit 1
  relay_row_applies 'spawn-server spawn-web redis-server' yes || exit 1
  ! relay_row_applies 'spawn-server spawn-web redis-server' no || exit 1
  note "self-test ok"
  exit 0
fi

if [[ "${1:-}" == "--probe-websocket" ]]; then
  [[ "$#" -eq 2 ]] || {
    echo "usage: scripts/health-check.sh --probe-websocket PUBLIC_ORIGIN" >&2
    exit 2
  }
  run_connection_probe websocket "$2"
  probe_status=$?
  [[ "$probe_status" -eq 2 ]] && exit 0
  exit "$probe_status"
fi

[[ "$#" -eq 0 ]] || {
  echo "usage: scripts/health-check.sh [--self-test | --probe-websocket PUBLIC_ORIGIN]" >&2
  exit 2
}

API_URL="${SPAWN_HEALTH_API_URL:-http://127.0.0.1:8001/healthz}"
WEB_URL="${SPAWN_HEALTH_WEB_URL:-http://127.0.0.1:3001/}"
# /healthz on the WEB port is served by the API through the web app's rewrite.
# Set empty to skip on a host with no proxied /healthz.
WEB_API_URL="${SPAWN_HEALTH_WEB_API_URL:-http://127.0.0.1:3001/healthz}"
PUBLIC_ORIGIN="${SPAWN_HEALTH_PUBLIC_ORIGIN:-https://spawnd.dev}"
TURN_URLS="${SPAWN_TURN_URLS:-}"
# Credential rejections in the last hour above this fail the coturn row; any
# port exhaustion does regardless. See coturn_journal_verdict.
TURN_REJECTIONS_MAX="${SPAWN_HEALTH_TURN_REJECTIONS_MAX:-30}"
BACKUP_DIR="${SPAWN_BACKUP_DIR:-/opt/spawn-backups}"
DISK_PATH="${SPAWN_HEALTH_DISK_PATH:-/}"
DISK_WARN_PCT="${SPAWN_HEALTH_DISK_WARN_PCT:-85}"
BACKUP_MAX_AGE_HOURS="${SPAWN_HEALTH_BACKUP_MAX_AGE_HOURS:-36}"
UNITS="$(units_with_turn "${SPAWN_HEALTH_UNITS:-spawn-server spawn-web redis-server}" "$TURN_URLS")"
# Set to a URL to POST failures somewhere (Slack, ntfy, healthchecks.io…).
# Left empty, this script only records; nothing pages anyone.
WEBHOOK="${SPAWN_HEALTH_WEBHOOK:-}"

# --- services ---------------------------------------------------------------
for unit in $UNITS; do
  if systemctl is-active --quiet "$unit"; then
    note "$unit active"
  else
    fail "$unit is not active"
  fi
done

# --- endpoints --------------------------------------------------------------
# "active" only means the process is alive; ask it something.
# curl already prints 000 when it cannot connect; a fallback would double it.
api_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API_URL" 2>/dev/null)"
api_code="${api_code:-000}"
if [ "$api_code" = "200" ]; then
  note "api $api_code"
else
  fail "api returned $api_code (expected 200) at $API_URL"
fi

web_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$WEB_URL" 2>/dev/null)"
web_code="${web_code:-000}"
case "$web_code" in
  200 | 3??) note "web $web_code" ;;
  *) fail "web returned $web_code at $WEB_URL" ;;
esac

# 2026-08-24: API 200, web 200, and every browser request dead — the web build
# had baked a proxy target nothing listened on. The two checks above cannot see
# that; only a request THROUGH the web app's rewrite exercises the path a
# browser actually uses.
if [ -n "$WEB_API_URL" ]; then
  chain_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$WEB_API_URL" 2>/dev/null)"
  chain_code="${chain_code:-000}"
  if [ "$chain_code" = "200" ]; then
    note "web->api $chain_code"
  else
    fail "web->api returned $chain_code (expected 200) at $WEB_API_URL — the web app cannot reach the API even though each may look healthy alone"
  fi
fi

# This is intentionally anonymous. Authentication happens after the upgrade,
# so 101 followed by close 1008 proves nginx, Next, and the API all preserved
# the WebSocket handshake and selected spawn.alerts.v1.
run_connection_probe websocket "$PUBLIC_ORIGIN"
ws_probe_status=$?
if [[ "$ws_probe_status" -eq 2 ]]; then
  warn "public WebSocket path was not verified"
fi

# A STUN Binding response proves the configured UDP TURN listener and its
# network path are alive without needing or exposing SPAWN_TURN_SECRET.
if [[ -n "$TURN_URLS" ]]; then
  run_connection_probe stun "$TURN_URLS"
  stun_probe_status=$?
  if [[ "$stun_probe_status" -eq 2 ]]; then
    warn "configured TURN path was not verified"
  fi
fi

# --- relay pool ---------------------------------------------------------------
# A relay that answers STUN can still be refusing every allocation. 2026-09-04:
# 766 `no available ports` in one hour, found the next day from a user report.
coturn_unit_present=no
if systemctl cat coturn.service >/dev/null 2>&1; then
  coturn_unit_present=yes
fi
if relay_row_applies "$UNITS" "$coturn_unit_present"; then
  coturn_stderr_file="$(mktemp)"
  coturn_journal="$(journalctl -u coturn --since -1h --no-pager 2>"$coturn_stderr_file")"
  coturn_journal_status=$?
  coturn_stderr="$(cat "$coturn_stderr_file")"
  rm -f "$coturn_stderr_file"
  if [[ "$coturn_journal_status" -ne 0 ]] || journal_access_denied "$coturn_stderr"; then
    warn "coturn journal is not readable here (${coturn_stderr:-journalctl exited $coturn_journal_status}); relay exhaustion was not checked"
  else
    read -r coturn_verdict coturn_exhaustions coturn_rejections <<<"$(
      printf '%s\n' "$coturn_journal" | coturn_journal_verdict "$TURN_REJECTIONS_MAX"
    )"
    coturn_summary="coturn last hour: $coturn_exhaustions 'no available ports', $coturn_rejections 'Cannot find credentials' (fails on any exhaustion or more than $TURN_REJECTIONS_MAX rejections)"
    if [[ "$coturn_verdict" == ok ]]; then
      note "$coturn_summary"
    else
      fail "$coturn_summary — the relay pool is full or a client is presenting expired credentials on a loop; docs/NETWORK.md"
    fi
  fi
fi

# --- disk -------------------------------------------------------------------
disk_pct="$(df --output=pcent "$DISK_PATH" 2>/dev/null | tail -1 | tr -dc '0-9')"
if [ -n "$disk_pct" ]; then
  if [ "$disk_pct" -ge "$DISK_WARN_PCT" ]; then
    fail "disk $DISK_PATH is ${disk_pct}% full (threshold ${DISK_WARN_PCT}%)"
  else
    note "disk ${disk_pct}%"
  fi
else
  fail "could not read disk usage for $DISK_PATH"
fi

# --- backups ----------------------------------------------------------------
# The failure that hides best: the timer still runs, the snapshots stopped.
newest="$(ls -1t "$BACKUP_DIR"/spawn-*.db.gz 2>/dev/null | head -1 || true)"
if [ -z "$newest" ]; then
  fail "no database snapshots in $BACKUP_DIR"
else
  age_hours=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
  if [ "$age_hours" -gt "$BACKUP_MAX_AGE_HOURS" ]; then
    fail "newest snapshot is ${age_hours}h old (threshold ${BACKUP_MAX_AGE_HOURS}h): $(basename "$newest")"
  else
    note "backup $(basename "$newest") ${age_hours}h old"
  fi
fi

# --- report -----------------------------------------------------------------
if [ "${#problems[@]}" -eq 0 ]; then
  note "all checks passed"
  exit 0
fi

summary="spawn health: ${#problems[@]} problem(s): $(printf '%s; ' "${problems[@]}")"
echo "$summary" >&2
if [ -n "$WEBHOOK" ]; then
  curl -s -o /dev/null --max-time 10 -X POST -H 'content-type: application/json' \
    --data "$(printf '{"text":%s}' "$(printf '%s' "$summary" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
    "$WEBHOOK" || echo "health: webhook delivery failed" >&2
fi
exit 1
