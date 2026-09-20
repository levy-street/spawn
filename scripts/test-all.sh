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

printf '%s\n' "== production release script self-test =="
scripts/deploy-prod.sh --self-test

printf '%s\n' "== worker-only daemon guard =="
scripts/check-worker-only-daemon.sh --self-test
scripts/check-worker-only-daemon.sh

printf '%s\n' "== durable protected-data decision guard =="
scripts/check-durable-data-decision.sh --self-test
scripts/check-durable-data-decision.sh

printf '%s\n' "== local daemon smoke cleanup guard =="
scripts/smoke-local-daemon.sh --self-test

printf '%s\n' "== daemon updater harness guards =="
scripts/update-test-lib.sh --self-test
scripts/fault-proxy.py --self-test
scripts/test-update-e2e.sh --self-test
scripts/test-update-faults.sh --self-test
scripts/test-update-probation.sh --self-test
scripts/test-instance-releases.sh --self-test
scripts/test-version-skew.sh --self-test
scripts/chaos-drills.sh --self-test
scripts/test-connection-canary.sh --self-test

printf '%s\n' "== native connection acceptance harness guards =="
uv run --project server python scripts/ci/check-hosted-runners.py
uv run --project server python scripts/ci/test-runners.py
python3 scripts/ci/test-release-hooks.py
python3 scripts/ci/test-macos-accounts.py
python3 scripts/test-udp-chaos-proxy.py
python3 scripts/test-native-acceptance.py
python3 mobile/e2e/test-compact-android-build.py
python3 mobile/e2e/test-android-disk-preflight.py
python3 mobile/e2e/test-native-runner.py
node --test mobile/e2e/instrument-worker.test.mjs
python3 scripts/test-release-acceptance.py

printf '%s\n' "== no server terminal content guard =="
scripts/check-no-server-terminal-content.sh

printf '%s\n' "== no server agent upload guard =="
scripts/check-no-server-agent-upload.sh --self-test
scripts/check-no-server-agent-upload.sh

printf '%s\n' "== signed RTC verified-SDP guard =="
scripts/check-signed-rtc-live.sh --self-test
scripts/check-signed-rtc-live.sh

printf '%s\n' "== host-control pin-gate guard =="
scripts/check-host-control-gated.sh

printf '%s\n' "== host desktop launch guard =="
scripts/check-host-desktop-launch.sh --self-test
scripts/check-host-desktop-launch.sh

printf '%s\n' "== CLAUDE.md structure guard =="
scripts/check-claude-md.sh --self-test
scripts/check-claude-md.sh

printf '%s\n' "== daemon tests =="
# The emulator's real-terminal proof drives the web workspace's xterm.js.
# Naming it makes the proof required here, where the workspace is installed,
# instead of skipped as it is wherever `cargo test` runs without one.
export SPAWN_XTERM_JS="$repo_root/web/node_modules/@xterm/xterm/lib/xterm.js"
(cd daemon && cargo test --locked)

printf '%s\n' "== daemon tests, diagnostics variant =="
# The variant dream runs is a real release build of the same tree, so a
# test that only fails with the feature on must not merge green.
(cd daemon && cargo test --locked --features diagnostics)

printf '%s\n' "== SCTP stream lifecycle regressions =="
(cd daemon && cargo test --locked -p webrtc-sctp --lib stream::stream_test::)

printf '%s\n' "== ICE route recovery regressions =="
(cd daemon && cargo test --locked -p webrtc-ice --lib agent_transport_test::)

printf '%s\n' "== daemon updater end-to-end =="
scripts/test-update-e2e.sh

printf '%s\n' "== daemon updater fault injection =="
scripts/test-update-faults.sh

printf '%s\n' "== daemon updater probation =="
scripts/test-update-probation.sh

printf '%s\n' "== two instances, one release store =="
scripts/test-instance-releases.sh

printf '%s\n' "== pre-release version skew ritual (optional) =="
if [[ -n "${SPAWN_OLD_REF:-}" ]]; then
  scripts/test-version-skew.sh
else
  printf '%s\n' "set SPAWN_OLD_REF to the last deployed commit to run the four-cell skew matrix"
fi

printf '%s\n' "== connection chaos ritual (optional) =="
if [[ "${SPAWN_ALLOW_SUDO:-0}" == "1" ]]; then
  scripts/chaos-drills.sh
else
  printf '%s\n' "set SPAWN_ALLOW_SUDO=1 to run the local connection chaos ritual (sudo remains non-interactive)"
fi

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
  scripts/verify-release.sh "$http_smoke_url"
else
  printf '%s\n' "set SPAWN_HTTP_SMOKE_URL=https://host to verify the HTTP surface and release identities"
fi

printf '%s\n' "== web lint + browser tests + build =="
(
  cd web
  bun run lint
  bun run test:unit
  bun run test:e2e --workers="${SPAWN_E2E_WORKERS:-50%}"
  SPAWN_API_PROXY_TARGET="${SPAWN_API_PROXY_TARGET:-http://127.0.0.1:8001}" bun run build
)

printf '%s\n' "== mobile typecheck + lint + tests =="
# The other frontend of the same product. Its own `npm run ci` is the contract
# (typecheck, lint, jest); running it here is what makes the root CLAUDE.md's
# claim about this script true, and what stops a change shipping to one
# frontend and not the other.
(cd mobile && npm run ci)

printf '%s\n' "== desktop typecheck + lint + tests =="
# This local lane exercises the macOS Tauri bundle and daemon linkage. Native
# Windows daemon, desktop, and PowerShell installer checks run on
# the self-hosted Windows build pool in `.github/workflows/windows.yml`.
if [[ "$(uname -s)" == "Darwin" ]]; then
  (
    cd desktop
    npx tsc --noEmit
    cd src-tauri
    cargo fmt --check
    cargo clippy --locked -- -D warnings
    cargo test --locked
  )
else
  printf '%s\n' "not macOS — native Windows checks run in .github/workflows/windows.yml"
fi

printf '%s\n' "== diff hygiene =="
git diff --check

printf '%s\n' "== all repeatable checks passed =="
