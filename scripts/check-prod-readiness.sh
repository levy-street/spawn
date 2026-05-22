#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/check-prod-readiness.sh [ssh-host]

Runs read-only readiness checks against a production host. This does not pull,
build, restart, migrate, or mutate the remote machine.

Environment:
  SPAWN_DEPLOY_HOST       SSH host alias/name. Overridden by [ssh-host].
  SPAWN_DEPLOY_PATH       Repo path on the remote host. Default: /opt/spawn
  SPAWN_DEPLOY_SERVICES   Space-separated systemd services expected active.
                          Default: spawn-server spawn-web
  SPAWN_PROD_WEB_URL      Local URL checked on the host for spawn-web.
                          Default: http://127.0.0.1:3001/
  SPAWN_PROD_API_URL      Local URL checked on the host for spawn-server auth.
                          Default: http://127.0.0.1:8001/api/me
EOF
}

die() {
  printf 'check-prod-readiness: %s\n' "$*" >&2
  exit 1
}

quote_env() {
  local name="$1"
  local value="$2"
  printf '%s=%q ' "$name" "$value"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

host="${1:-${SPAWN_DEPLOY_HOST:-}}"
[[ -n "$host" ]] || die "missing SSH host; pass one or set SPAWN_DEPLOY_HOST"

command -v ssh >/dev/null 2>&1 || die "ssh is required"

remote_path="${SPAWN_DEPLOY_PATH:-/opt/spawn}"
services="${SPAWN_DEPLOY_SERVICES:-spawn-server spawn-web}"
web_url="${SPAWN_PROD_WEB_URL:-http://127.0.0.1:3001/}"
api_url="${SPAWN_PROD_API_URL:-http://127.0.0.1:8001/api/me}"

printf 'check-prod-readiness: checking %s:%s\n' "$host" "$remote_path"

env_prefix="$(
  quote_env SPAWN_DEPLOY_PATH "$remote_path"
  quote_env SPAWN_DEPLOY_SERVICES "$services"
  quote_env SPAWN_PROD_WEB_URL "$web_url"
  quote_env SPAWN_PROD_API_URL "$api_url"
)"

ssh -o BatchMode=yes "$host" "${env_prefix}bash -se" <<'REMOTE'
set -euo pipefail

die() {
  printf 'remote readiness: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

need git
need systemctl
need curl

printf 'remote readiness: host=%s user=%s\n' "$(hostname)" "$(whoami)"

cd "$SPAWN_DEPLOY_PATH" || die "cannot cd to $SPAWN_DEPLOY_PATH"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  die "$SPAWN_DEPLOY_PATH is not a git repo"

branch="$(git branch --show-current)"
head="$(git rev-parse --short HEAD)"
dirty="$(git status --porcelain)"
[[ -z "$dirty" ]] || die "remote checkout has uncommitted changes"
printf 'remote readiness: repo=%s branch=%s head=%s dirty=no\n' "$SPAWN_DEPLOY_PATH" "$branch" "$head"

for service in $SPAWN_DEPLOY_SERVICES; do
  systemctl is-active --quiet "$service" || die "$service is not active"
  enabled="$(systemctl is-enabled "$service" 2>/dev/null || true)"
  main_pid="$(systemctl show "$service" --property=MainPID --value)"
  printf 'remote readiness: service=%s active=yes enabled=%s pid=%s\n' \
    "$service" "$enabled" "$main_pid"
done

curl -fsSI "$SPAWN_PROD_WEB_URL" >/dev/null ||
  die "web health check failed: $SPAWN_PROD_WEB_URL"
api_status="$(curl -sS -o /dev/null -w '%{http_code}' "$SPAWN_PROD_API_URL")"
case "$api_status" in
  200|401) ;;
  *) die "api health check returned HTTP $api_status for $SPAWN_PROD_API_URL" ;;
esac

printf 'remote readiness: web=%s ok\n' "$SPAWN_PROD_WEB_URL"
printf 'remote readiness: api=%s http=%s\n' "$SPAWN_PROD_API_URL" "$api_status"
printf 'remote readiness: ok\n'
REMOTE
