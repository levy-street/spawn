#!/usr/bin/env bash
# Check that this deployment is actually healthy, and say so loudly in the
# journal when it is not.
#
# Deliberately answers the questions that stay silent until a user complains:
# is the API up, is the web app up, does the public WebSocket proxy upgrade,
# does configured TURN answer, is Redis up, is the disk filling, are backups
# still being taken. A service that is "active" but returning 502, or a backup
# timer that has quietly produced nothing for a week, both look fine from
# `systemctl status` alone.
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

turn_udp_endpoint() {
  local urls="$1"
  local candidate endpoint host port tail
  local parts=()
  IFS=',' read -r -a parts <<< "$urls"
  for candidate in "${parts[@]}"; do
    candidate="${candidate#"${candidate%%[![:space:]]*}"}"
    candidate="${candidate%"${candidate##*[![:space:]]}"}"
    [[ "$candidate" == turn:* ]] || continue
    [[ "$candidate" == *'?transport=tcp' ]] && continue
    endpoint="${candidate#turn:}"
    endpoint="${endpoint%%\?*}"
    port=3478
    if [[ "$endpoint" == \[*\]* ]]; then
      host="${endpoint#\[}"
      host="${host%%\]*}"
      tail="${endpoint#*\]}"
      [[ -z "$tail" ]] || port="${tail#:}"
    elif [[ "$endpoint" == *:* ]]; then
      host="${endpoint%:*}"
      port="${endpoint##*:}"
    else
      host="$endpoint"
    fi
    [[ -n "$host" && "$port" =~ ^[0-9]+$ ]] || continue
    printf '%s\t%s\n' "$host" "$port"
    return 0
  done
  return 1
}

# Authenticated Allocate plus client-to-client traffic through two relay
# allocations. A STUN Binding can succeed while the cloud firewall still drops
# coturn's UDP relay range; this exercises the path users actually need.
run_turn_relay_probe() {
  local urls="$1"
  local secret="$2"
  local parsed host port username password output
  if ! command -v turnutils_uclient >/dev/null 2>&1; then
    warn "turnutils_uclient is unavailable; cannot run the TURN relay probe"
    return 2
  fi
  if ! command -v timeout >/dev/null 2>&1; then
    warn "timeout is unavailable; cannot bound the TURN relay probe"
    return 2
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 is unavailable; cannot mint a TURN relay probe credential"
    return 2
  fi
  if [[ -z "$secret" ]]; then
    fail "SPAWN_TURN_SECRET is unavailable; cannot authenticate the TURN relay probe"
    return 1
  fi
  if ! parsed="$(turn_udp_endpoint "$urls")"; then
    fail "configured TURN URLs contain no UDP turn: endpoint for the relay probe"
    return 1
  fi
  IFS=$'\t' read -r host port <<< "$parsed"

  # Put only this short-lived credential, never the static secret, in the
  # turnutils process arguments visible to ps.
  username="$(( $(date +%s) + 300 )):health-check"
  password="$(SPAWN_HEALTH_TURN_SECRET="$secret" python3 - "$username" <<'PY'
import base64
import hashlib
import hmac
import os
import sys

digest = hmac.new(
    os.environ["SPAWN_HEALTH_TURN_SECRET"].encode(),
    sys.argv[1].encode(),
    hashlib.sha1,
).digest()
print(base64.b64encode(digest).decode("ascii"))
PY
)"

  if output="$(timeout 15s turnutils_uclient -y -c -n 1 -p "$port" \
    -u "$username" -w "$password" "$host" 2>&1)"; then
    if grep -Eq 'tot_send_bytes ~ [1-9][0-9]*, tot_recv_bytes ~ [1-9][0-9]*' <<< "$output"; then
      note "turn relay $host:$port/udp allocated and relayed client-to-client traffic"
      return 0
    fi
    fail "TURN relay probe at $host:$port/udp exchanged no client-to-client traffic"
    return 1
  fi
  fail "TURN relay allocation or client-to-client traffic failed at $host:$port/udp"
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
  [[ "$(turn_udp_endpoint 'turn:relay.example:3478?transport=udp')" == \
    $'relay.example\t3478' ]] || exit 1
  [[ "$(turn_udp_endpoint 'turn:relay.example?transport=udp')" == \
    $'relay.example\t3478' ]] || exit 1
  [[ "$(turn_udp_endpoint 'turns:relay.example:443?transport=tcp, turn:[2001:db8::1]:3479')" == \
    $'2001:db8::1\t3479' ]] || exit 1
  ! turn_udp_endpoint 'turn:relay.example:3478?transport=tcp' >/dev/null || exit 1
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
TURN_SECRET="${SPAWN_TURN_SECRET:-}"
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

if [[ -n "$TURN_URLS" ]]; then
  run_turn_relay_probe "$TURN_URLS" "$TURN_SECRET"
  turn_relay_probe_status=$?
  if [[ "$turn_relay_probe_status" -eq 2 ]]; then
    warn "configured TURN relay path was not verified"
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
