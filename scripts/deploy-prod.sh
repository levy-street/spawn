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

printf 'deploy-prod: deploying %s to %s:%s\n' "$remote_ref" "$host" "$remote_path"

env_prefix="$(
  quote_env SPAWN_DEPLOY_PATH "$remote_path"
  quote_env SPAWN_DEPLOY_BRANCH "$branch"
  quote_env SPAWN_DEPLOY_REMOTE "$remote"
  quote_env SPAWN_DEPLOY_SERVICES "$services"
  quote_env SPAWN_DEPLOY_SUDO "$sudo_cmd"
  quote_env SPAWN_DEPLOY_BUILD "$run_build"
)"

ssh "$host" "${env_prefix}bash -se" <<'REMOTE'
set -euo pipefail

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
  if command -v uv >/dev/null 2>&1; then
    (cd server && uv sync --frozen && uv run alembic upgrade head)
  else
    die "uv is required for server dependency sync and migrations"
  fi

  if command -v bun >/dev/null 2>&1; then
    (cd web && bun install --frozen-lockfile && bun run build)
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
