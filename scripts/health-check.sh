#!/usr/bin/env bash
# Check that this deployment is actually healthy, and say so loudly in the
# journal when it is not.
#
# Deliberately answers the questions that stay silent until a user complains:
# is the API up, is the web app up, is Redis up, is the disk filling, are
# backups still being taken. A service that is "active" but returning 502, or
# a backup timer that has quietly produced nothing for a week, both look fine
# from `systemctl status` alone.
#
# Exits non-zero on any failure so the unit shows in `systemctl --failed`,
# which is the one place an operator looks without being told to.
set -uo pipefail

API_URL="${SPAWN_HEALTH_API_URL:-http://127.0.0.1:8001/healthz}"
WEB_URL="${SPAWN_HEALTH_WEB_URL:-http://127.0.0.1:3001/}"
# /healthz on the WEB port is served by the API through the web app's rewrite.
# Set empty to skip on a host with no proxied /healthz.
WEB_API_URL="${SPAWN_HEALTH_WEB_API_URL:-http://127.0.0.1:3001/healthz}"
BACKUP_DIR="${SPAWN_BACKUP_DIR:-/opt/spawn-backups}"
DISK_PATH="${SPAWN_HEALTH_DISK_PATH:-/}"
DISK_WARN_PCT="${SPAWN_HEALTH_DISK_WARN_PCT:-85}"
BACKUP_MAX_AGE_HOURS="${SPAWN_HEALTH_BACKUP_MAX_AGE_HOURS:-36}"
UNITS="${SPAWN_HEALTH_UNITS:-spawn-server spawn-web redis-server}"
# Set to a URL to POST failures somewhere (Slack, ntfy, healthchecks.io…).
# Left empty, this script only records; nothing pages anyone.
WEBHOOK="${SPAWN_HEALTH_WEBHOOK:-}"

problems=()
note() { echo "health: $*"; }
fail() { echo "health: FAIL $*" >&2; problems+=("$*"); }

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
