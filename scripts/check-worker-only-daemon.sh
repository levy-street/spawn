#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [[ -e daemon/src/tmux.rs ]]; then
  printf '%s\n' "worker-only guard: daemon/src/tmux.rs must not exist" >&2
  exit 1
fi

# Historical documents under docs/ may discuss the retired backend. Runtime
# code, tests, metadata, top-level documentation, and operational fixtures may
# not reintroduce it.
forbidden='tmux|tmux_session|agent\.rename|SPAWND_SESSION_BACKEND|BackendKind|ExactReplayBuffer'
matches="$(rg -n -i "$forbidden" \
  daemon/src daemon/tests daemon/Cargo.toml daemon/Cargo.lock \
  server/spawn_server server/tests \
  web/src web/tests \
  README.md daemon/README.md proto/README.md \
  .github \
  scripts \
  --glob '!check-worker-only-daemon.sh' || true)"
if [[ -n "$matches" ]]; then
  printf '%s\n' "worker-only guard: retired backend surface found:" >&2
  printf '%s\n' "$matches" >&2
  exit 1
fi

printf '%s\n' "worker-only daemon guard passed"
