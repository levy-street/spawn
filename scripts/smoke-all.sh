#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke-all.sh

Runs the repo's verification gates in a deliberate order against the current
checkout and an already-running local spawn stack.

Default gates:
  - shell syntax and diff whitespace checks
  - daemon EUnit tests
  - daemon release and CLI escript build
  - server pytest and ruff
  - web lint
  - local daemon/API/websocket smoke
  - real browser web UI smoke
  - real provider CLI launch smoke
  - device login smoke
  - cross-worker websocket smoke
  - deploy-script fake-host smoke
  - Linux installer shell-path smoke
  - web production build

Optional gates:
  SPAWN_SMOKE_ALL_LINUX_ARTIFACTS=1
      Build and verify Linux prebuilt artifacts in Docker.
  SPAWN_SMOKE_ALL_LINUX_AMD64=1
      Also run the linux/amd64 artifact check under Docker.
  SPAWN_SMOKE_ALL_PROD_HOST=spawnd-prod
      Run read-only production readiness checks against that SSH host.

The script does not start the local server, web app, or daemon. Start those
first, then run this from the repo root. The production web build runs last
because it writes `.next`; restart `bun run dev -- -p 3002` afterward if you
want to keep using the local dev UI.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

die() {
  printf 'smoke-all: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

run_shell() {
  printf '\n==> %s\n' "$*"
  bash -c "$*"
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run from inside the spawn repo"
cd "$repo_root"

need bash
need git
need curl
need uv
need bun
need rebar3

run bash -n \
  scripts/check-prod-readiness.sh \
  scripts/deploy-prod.sh \
  scripts/package-spawnd.sh \
  scripts/smoke-all.sh \
  scripts/smoke-cross-worker.sh \
  scripts/smoke-deploy-prod.sh \
  scripts/smoke-device-login.sh \
  scripts/smoke-install-linux.sh \
  scripts/smoke-linux-artifact.sh \
  scripts/smoke-local.sh \
  scripts/smoke-provider-clis.sh \
  scripts/smoke-web-ui.sh
run sh -n web/src/app/install.sh/install-template.sh
run git diff --check

run_shell "cd daemon && rebar3 eunit"
run_shell "cd daemon && rebar3 release && rebar3 escriptize"
run_shell "cd server && uv run pytest"
run_shell "cd server && uv run ruff check spawn_server tests"
run_shell "cd web && bun run lint"

run scripts/smoke-local.sh
run scripts/smoke-web-ui.sh
run scripts/smoke-provider-clis.sh
run scripts/smoke-device-login.sh
run scripts/smoke-cross-worker.sh
run scripts/smoke-deploy-prod.sh
run scripts/smoke-install-linux.sh
run_shell "cd web && bun run build"

if [[ "${SPAWN_SMOKE_ALL_LINUX_ARTIFACTS:-0}" == "1" ]]; then
  need docker
  run scripts/smoke-linux-artifact.sh
  if [[ "${SPAWN_SMOKE_ALL_LINUX_AMD64:-0}" == "1" ]]; then
    run_shell "SPAWN_LINUX_ARTIFACT_PLATFORMS=linux/amd64 scripts/smoke-linux-artifact.sh"
  fi
fi

if [[ -n "${SPAWN_SMOKE_ALL_PROD_HOST:-}" ]]; then
  run scripts/check-prod-readiness.sh "$SPAWN_SMOKE_ALL_PROD_HOST"
fi

printf '\nsmoke-all: ok\n'
