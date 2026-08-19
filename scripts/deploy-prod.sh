#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-prod.sh [ssh-host]

Deploy the remote version of the current branch to a production host.

The script uses the caller's SSH config, so [ssh-host] can be an alias from
~/.ssh/config. It refuses to deploy if the local checkout is dirty or if the
current branch has commits that have not been pushed to the configured remote.

Environment:
  SPAWN_DEPLOY_HOST       SSH host alias/name. Overridden by [ssh-host].
  SPAWN_DEPLOY_PATH       Repo path on the remote host. Default: /opt/spawn
  SPAWN_DEPLOY_REMOTE     Git remote to deploy from. Default: origin
  SPAWN_DEPLOY_SERVICES   Space-separated systemd services to restart.
                          Default: spawn-server spawn-web
  SPAWN_DEPLOY_SUDO       Command prefix for systemctl. Default: sudo -n
                          Set to empty when the SSH user can manage services.
  SPAWN_DEPLOY_BUILD      Run dependency sync/build/migrations. Default: 1
                          Set to 0 to only pull and restart.
EOF
}

die() {
  printf 'deploy-prod: %s\n' "$*" >&2
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

command -v git >/dev/null 2>&1 || die "git is required"
command -v ssh >/dev/null 2>&1 || die "ssh is required"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run from inside the spawn repo"
cd "$repo_root"

branch="$(git branch --show-current)"
[[ -n "$branch" ]] || die "detached HEAD is not deployable"

remote="${SPAWN_DEPLOY_REMOTE:-origin}"
remote_ref="$remote/$branch"

[[ -z "$(git status --porcelain)" ]] || die "local checkout has uncommitted changes"

git fetch --prune "$remote" "$branch"
git rev-parse --verify --quiet "$remote_ref" >/dev/null || die "remote branch $remote_ref does not exist"

read -r remote_only local_only < <(git rev-list --left-right --count "$remote_ref...HEAD")
if [[ "$local_only" != "0" ]]; then
  die "current branch has $local_only unpushed commit(s); push before deploying"
fi

if [[ "$remote_only" != "0" ]]; then
  printf 'deploy-prod: local branch is behind %s by %s commit(s); deploying %s\n' \
    "$remote_ref" "$remote_only" "$remote_ref"
fi

remote_path="${SPAWN_DEPLOY_PATH:-/opt/spawn}"
services="${SPAWN_DEPLOY_SERVICES:-spawn-server spawn-web}"
sudo_cmd="${SPAWN_DEPLOY_SUDO-sudo -n}"
run_build="${SPAWN_DEPLOY_BUILD:-1}"
# Baked into the web build: Next stores the API proxy target in the routes
# manifest at build time. The wrapper (scripts/next-with-proxy-target.mjs)
# refuses to bake a silent default, so it must be set explicitly. Prod's server
# listens on 127.0.0.1:8001; override for a host whose API is elsewhere.
api_proxy_target="${SPAWN_API_PROXY_TARGET:-http://127.0.0.1:8001}"

printf 'deploy-prod: deploying %s to %s:%s\n' "$remote_ref" "$host" "$remote_path"

env_prefix="$(
  quote_env SPAWN_DEPLOY_PATH "$remote_path"
  quote_env SPAWN_DEPLOY_BRANCH "$branch"
  quote_env SPAWN_DEPLOY_REMOTE "$remote"
  quote_env SPAWN_DEPLOY_SERVICES "$services"
  quote_env SPAWN_DEPLOY_SUDO "$sudo_cmd"
  quote_env SPAWN_DEPLOY_BUILD "$run_build"
  quote_env SPAWN_API_PROXY_TARGET "$api_proxy_target"
)"

ssh "$host" "${env_prefix}bash -se" <<'REMOTE'
set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/.bun/bin:$HOME/.cargo/bin:$PATH"

die() {
  printf 'remote deploy: %s\n' "$*" >&2
  exit 1
}

run_systemctl() {
  if [[ -n "${SPAWN_DEPLOY_SUDO:-}" ]]; then
    read -r -a sudo_parts <<< "$SPAWN_DEPLOY_SUDO"
    "${sudo_parts[@]}" systemctl "$@"
  else
    systemctl "$@"
  fi
}

cd "$SPAWN_DEPLOY_PATH" || die "cannot cd to $SPAWN_DEPLOY_PATH"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$SPAWN_DEPLOY_PATH is not a git repo"

[[ -z "$(git status --porcelain)" ]] || die "remote checkout has uncommitted changes"

git fetch --prune "$SPAWN_DEPLOY_REMOTE" "$SPAWN_DEPLOY_BRANCH"
target="$SPAWN_DEPLOY_REMOTE/$SPAWN_DEPLOY_BRANCH"
git rev-parse --verify --quiet "$target" >/dev/null || die "remote branch $target does not exist"

if git show-ref --verify --quiet "refs/heads/$SPAWN_DEPLOY_BRANCH"; then
  read -r _ local_only < <(git rev-list --left-right --count "$target...$SPAWN_DEPLOY_BRANCH")
  if [[ "$local_only" != "0" ]]; then
    die "production branch has $local_only commit(s) not present in $target"
  fi
fi

old_rev="$(git rev-parse --short HEAD)"
git checkout -B "$SPAWN_DEPLOY_BRANCH" "$target"
new_rev="$(git rev-parse --short HEAD)"
printf 'remote deploy: updated %s from %s to %s\n' "$SPAWN_DEPLOY_BRANCH" "$old_rev" "$new_rev"

if [[ "$SPAWN_DEPLOY_BUILD" != "0" ]]; then
  # Pin the Next buildId to the deployed commit. Without this the buildId
  # defaults to the constant "spawn", so /_next/static/spawn/*.js is a stable URL
  # with changing content across deploys — and because the service worker caches
  # /_next/static/* cache-first with no revalidation, clients keep a stale build
  # (and any one-time poisoned response there persists) indefinitely. A per-commit
  # buildId gives every deploy fresh, content-addressed asset URLs. Verifiers must
  # pass the same SPAWN_BUILD_ID (see scripts/verify-served-client.sh).
  build_id="$(git rev-parse HEAD)"
  printf 'remote deploy: pinning SPAWN_BUILD_ID=%s\n' "$build_id"

  if command -v uv >/dev/null 2>&1; then
    (cd server && uv sync --frozen && uv run alembic upgrade head)
  else
    die "uv is required for server dependency sync and migrations"
  fi

  if command -v bun >/dev/null 2>&1; then
    # V8 caps its own heap well below this host's RAM+swap, so a growing app
    # eventually dies with "Reached heap limit" on a machine that still has
    # memory to give. Raise the cap explicitly rather than discovering it
    # again as a failed deploy.
    (cd web && bun install --frozen-lockfile && NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}" SPAWN_API_PROXY_TARGET="$SPAWN_API_PROXY_TARGET" SPAWN_BUILD_ID="$build_id" bun run build)
  else
    die "bun is required for web dependency sync and build"
  fi

  if [[ -f daemon/Cargo.toml ]]; then
    if command -v cargo >/dev/null 2>&1; then
      (cd daemon && cargo build --release --locked)
    else
      die "cargo is required to build the hosted spawnd binary"
    fi
  fi
fi

for service in $SPAWN_DEPLOY_SERVICES; do
  printf 'remote deploy: restarting %s\n' "$service"
  run_systemctl restart "$service"
done

for service in $SPAWN_DEPLOY_SERVICES; do
  run_systemctl --no-pager --full status "$service" >/dev/null
done

printf 'remote deploy: complete\n'
REMOTE

# Publish CI-built prebuilt daemon binaries to the host. Every supported target
# is built + checksummed by CI (.github/workflows/prebuilt.yml) into the rolling
# `prebuilt-latest` release; we pull it HERE — the deploy invoker is already
# GitHub-authed, so prod needs no gh/token — verify it against SHA256SUMS, and
# scp the bytes into the server's prebuilt dir. The server serves prebuilts over
# the source-build fallback, so what CI built is exactly what prod hands out
# (verify with scripts/verify-prebuilts.sh). Best-effort: a miss leaves the
# from-source fallback intact, and the server reads prebuilts live (no restart).
#
# Map of install.py's friendly target name -> release-asset triple. The prebuilt
# dir uses the friendly name; the release assets use the triple.
PREBUILT_TARGETS=(
  "darwin-aarch64:aarch64-apple-darwin"
  "darwin-x86_64:x86_64-apple-darwin"
  "linux-x86_64:x86_64-unknown-linux-gnu"
  "linux-aarch64:aarch64-unknown-linux-gnu"
)
publish_prebuilts() {
  command -v gh >/dev/null 2>&1 || {
    printf 'deploy-prod: gh not found locally; skipping prebuilt publish\n'
    return 0
  }
  local tmp
  tmp="$(mktemp -d)"
  if ! gh release download prebuilt-latest --repo levy-street/spawn --dir "$tmp" --clobber >/dev/null 2>&1; then
    printf 'deploy-prod: no prebuilt-latest release; skipping prebuilt publish\n'
    rm -rf "$tmp"
    return 0
  fi
  if ! (cd "$tmp" && sha256sum -c SHA256SUMS >/dev/null 2>&1); then
    printf 'deploy-prod: prebuilt checksum verification failed; not publishing\n' >&2
    rm -rf "$tmp"
    return 0
  fi
  local pair target triple dest
  for pair in "${PREBUILT_TARGETS[@]}"; do
    target="${pair%%:*}"
    triple="${pair##*:}"
    dest="$remote_path/daemon/target/prebuilt/$target"
    if [[ -f "$tmp/spawnd-$triple" && -f "$tmp/spawn-worker-$triple" ]]; then
      ssh "$host" "mkdir -p '$dest'"
      scp -q "$tmp/spawnd-$triple" "$host:$dest/spawnd"
      scp -q "$tmp/spawn-worker-$triple" "$host:$dest/spawn-worker"
      ssh "$host" "chmod 755 '$dest/spawnd' '$dest/spawn-worker'"
      printf 'deploy-prod: published %s prebuilt to %s\n' "$target" "$host"
    else
      printf 'deploy-prod: no %s binaries in prebuilt-latest; skipping\n' "$target"
    fi
  done
  rm -rf "$tmp"
}
publish_prebuilts || true
