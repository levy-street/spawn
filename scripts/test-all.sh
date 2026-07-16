#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

printf '%s\n' "== server lint + tests =="
(cd server && uv run ruff check spawn_server tests && uv run pytest -q)

printf '%s\n' "== shell script syntax =="
bash -n scripts/*.sh

printf '%s\n' "== shell script metadata =="
non_executable_scripts="$(find scripts -maxdepth 1 -type f -name '*.sh' ! -perm -111 -print)"
if [[ -n "$non_executable_scripts" ]]; then
  printf '%s\n' "these scripts are not executable:" >&2
  printf '%s\n' "$non_executable_scripts" >&2
  exit 1
fi

printf '%s\n' "== worker-only daemon guard =="
scripts/check-worker-only-daemon.sh --self-test
scripts/check-worker-only-daemon.sh

printf '%s\n' "== durable protected-data decision guard =="
scripts/check-durable-data-decision.sh

printf '%s\n' "== local daemon smoke cleanup guard =="
scripts/smoke-local-daemon.sh --self-test

printf '%s\n' "== no server terminal content guard =="
scripts/check-no-server-terminal-content.sh

printf '%s\n' "== daemon tests =="
(cd daemon && cargo test --locked)

printf '%s\n' "== prebuilt installer smoke =="
scripts/smoke-install-prebuilt.sh

printf '%s\n' "== local HTTP surface smoke =="
scripts/smoke-local-http-surface.sh

printf '%s\n' "== real Redis pubsub smoke =="
scripts/smoke-redis-pubsub.sh

printf '%s\n' "== real PostgreSQL + Redis owner recovery smoke =="
if [[ -n "${SPAWN_TEST_POSTGRES_URL:-}" && -n "${SPAWN_TEST_REDIS_URL:-}" ]] \
  || { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }; then
  scripts/smoke-host-owner-recovery.sh
else
  printf '%s\n' \
    "set SPAWN_TEST_POSTGRES_URL and SPAWN_TEST_REDIS_URL, or start Docker, to run the owner recovery smoke"
fi

printf '%s\n' "== daemon login smoke =="
scripts/smoke-local-login.sh

printf '%s\n' "== local server + daemon smoke =="
scripts/smoke-local-daemon.sh

printf '%s\n' "== live browser + daemon smoke =="
scripts/smoke-local-browser-live.sh

printf '%s\n' "== service manager smoke =="
scripts/smoke-service-manager.sh

printf '%s\n' "== remote linux smoke (optional) =="
if [[ -n "${SPAWN_REMOTE_LINUX_HOST:-}" ]]; then
  scripts/smoke-remote-linux-install.sh "$SPAWN_REMOTE_LINUX_HOST"
  ssh "$SPAWN_REMOTE_LINUX_HOST" 'bash -s -- systemd-user' < scripts/smoke-service-manager.sh
  scripts/smoke-remote-linux-linger.sh "$SPAWN_REMOTE_LINUX_HOST"
else
  printf '%s\n' "set SPAWN_REMOTE_LINUX_HOST to run remote Linux install, systemd, and linger smoke tests"
fi

printf '%s\n' "== remote reboot smoke (optional) =="
if [[ -n "${SPAWN_REMOTE_REBOOT_HOST:-}" ]]; then
  scripts/smoke-remote-systemd-reboot.sh "$SPAWN_REMOTE_REBOOT_HOST"
else
  set +e
  scripts/smoke-remote-systemd-reboot.sh localhost >/dev/null 2>&1
  reboot_guard_status=$?
  set -e
  if [[ "$reboot_guard_status" == "0" ]]; then
    printf '%s\n' "remote reboot smoke guard unexpectedly allowed an ungated reboot" >&2
    exit 1
  fi
  if [[ "$reboot_guard_status" != "2" ]]; then
    printf 'remote reboot smoke guard returned %s, expected 2\n' "$reboot_guard_status" >&2
    exit 1
  fi
  printf '%s\n' "set SPAWN_ALLOW_REBOOT=1 SPAWN_REMOTE_REBOOT_HOST=host to run gated reboot persistence smoke"
fi

printf '%s\n' "== public HTTP surface smoke (optional) =="
http_smoke_url="${SPAWN_HTTP_SMOKE_URL:-${SPAWN_PROD_URL:-}}"
if [[ -n "$http_smoke_url" ]]; then
  scripts/smoke-http-surface.sh "$http_smoke_url"
else
  printf '%s\n' "set SPAWN_HTTP_SMOKE_URL=https://host to verify landing, download, installer, health, and hosted daemon binary"
fi

printf '%s\n' "== web lint + browser tests + build =="
(
  cd web
  bun run lint
  bun run test:unit
  bun run test:e2e
  SPAWN_API_PROXY_TARGET="${SPAWN_API_PROXY_TARGET:-http://127.0.0.1:8001}" bun run build
)

printf '%s\n' "== diff hygiene =="
git diff --check

printf '%s\n' "== all repeatable checks passed =="
