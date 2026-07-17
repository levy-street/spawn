#!/usr/bin/env bash
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_root="${WORKER_ONLY_GUARD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$repo_root"

forbidden='tmux|tmux_session|agent\.rename|SPAWND_SESSION_BACKEND|BackendKind|ExactReplayBuffer'

guard_paths=(
  daemon
  server
  web
  README.md
  daemon/README.md
  server/README.md
  web/README.md
  proto/README.md
  .env.example
  .github
  infra
  scripts
)

run_guard() {
  if [[ -e daemon/src/tmux.rs ]]; then
    printf '%s\n' "worker-only guard: daemon/src/tmux.rs must not exist" >&2
    return 1
  fi

  local existing_paths=()
  local path
  for path in "${guard_paths[@]}"; do
    [[ -e "$path" ]] && existing_paths+=("$path")
  done

  # In a worktree, scan tracked files plus non-ignored new source. This keeps
  # generated runtime data (notably server/data transcripts) out of the source
  # boundary without allowing a newly added, not-yet-staged source file to
  # evade the guard. Source archives without Git metadata use the same path
  # inventory with explicit generated-data exclusions below.
  local scan_paths=()
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    mapfile -d '' scan_paths < <(
      git ls-files -z --cached --others --exclude-standard -- "${existing_paths[@]}"
    )
    local filtered_paths=()
    local scan_path
    for scan_path in "${scan_paths[@]}"; do
      [[ "$scan_path" == "scripts/check-worker-only-daemon.sh" ]] || \
        filtered_paths+=("$scan_path")
    done
    scan_paths=("${filtered_paths[@]}")
  else
    scan_paths=("${existing_paths[@]}")
  fi

  # Scan every Rust source under daemon, including examples and any future
  # production-ish bin/build/bench trees. Also scan the server, browser,
  # generated-installer source, protocol tests, CI, and operational smokes.
  local matches
  matches="$(rg -n -i "$forbidden" \
    "${scan_paths[@]}" \
    --glob '!target/**' \
    --glob '!daemon/target/**' \
    --glob '!node_modules/**' \
    --glob '!web/node_modules/**' \
    --glob '!.next/**' \
    --glob '!web/.next/**' \
    --glob '!.venv/**' \
    --glob '!server/.venv/**' \
    --glob '!.pytest_cache/**' \
    --glob '!server/.pytest_cache/**' \
    --glob '!.ruff_cache/**' \
    --glob '!server/.ruff_cache/**' \
    --glob '!server/data/**' \
    --glob '!test-results/**' \
    --glob '!web/test-results/**' \
    --glob '!check-worker-only-daemon.sh' || true)"
  if [[ -n "$matches" ]]; then
    printf '%s\n' "worker-only guard: retired backend surface found:" >&2
    printf '%s\n' "$matches" >&2
    return 1
  fi
}

self_test() {
  local fixture
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' RETURN
  mkdir -p \
    "$fixture/daemon/src" \
    "$fixture/daemon/examples" \
    "$fixture/server/spawn_server/routes" \
    "$fixture/web/scripts" \
    "$fixture/scripts"
  printf '%s\n' 'fn main() {}' >"$fixture/daemon/src/main.rs"
  git -C "$fixture" init -q
  printf '%s\n' 'server/data/' >"$fixture/.gitignore"

  WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null

  # Ignored runtime transcripts are historical data, not a production source
  # surface. They must neither fail the guard nor produce unbounded output.
  mkdir -p "$fixture/server/data/transcripts"
  local retired_word='t'
  retired_word+='mux'
  printf '%s\n' "$retired_word capture-pane" \
    >"$fixture/server/data/transcripts/runtime.log"
  WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null

  local surfaces=(
    daemon/examples/rtc_probe.rs
    server/spawn_server/routes/install.py
    web/scripts/protocol.mjs
    scripts/smoke-protocol.sh
  )
  local surface
  for surface in "${surfaces[@]}"; do
    printf '%s\n' "$retired_word" >"$fixture/$surface"
    if WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
      printf 'worker-only guard self-test: failed to reject %s\n' "$surface" >&2
      return 1
    fi
    rm "$fixture/$surface"
  done

  printf '%s\n' "worker-only daemon guard self-test passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

# Historical documents under docs/ may discuss the retired backend. Runtime
# code, tests, metadata, top-level documentation, and operational fixtures may
# not reintroduce it.
run_guard

printf '%s\n' "worker-only daemon guard passed"
