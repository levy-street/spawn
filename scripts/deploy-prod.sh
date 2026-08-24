#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-prod.sh [ssh-host] [--api-proxy-target URL]

Deploy the remote version of the current branch to a production host.

The script uses the caller's SSH config, so [ssh-host] can be an alias from
~/.ssh/config. It refuses to deploy if the local checkout is dirty or if the
current branch has commits that have not been pushed to the configured remote.

Options:
  --api-proxy-target URL  Where the deployed web app proxies /api and /ws.
                          Default: http://127.0.0.1:8001. This is baked into
                          the build, so it MUST be passed as a flag -- an
                          inherited SPAWN_API_PROXY_TARGET is refused, not
                          used. See "The proxy target" below.

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
  SPAWN_DEPLOY_WEB_ORIGIN Origin the post-deploy smoke check probes on the
                          host. Default: derived from web/package.json.
  SPAWN_DEPLOY_SMOKE      Post-deploy smoke check. Default: 1. Set to 0 only
                          when the host has no proxied /healthz to probe.

The proxy target:

  Next bakes rewrites into .next/routes-manifest.json at BUILD time, so the
  value used here is frozen into the production bundle. A dev shell in this
  repo exports SPAWN_API_PROXY_TARGET=http://127.0.0.1:8010 (scripts/dev.sh),
  and on 2026-08-24 that ambient value was inherited and shipped: prod served
  every /api/* and /ws/* into a dead port while the API itself was healthy.

  So an inherited SPAWN_API_PROXY_TARGET is now a hard error. Pass the flag
  when you mean it:

    scripts/deploy-prod.sh spawnd-prod --api-proxy-target http://127.0.0.1:8001

  After the build, and before anything restarts, the baked manifest is
  compared against the requested target -- a mismatch aborts the deploy with
  the old build still serving.
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

host=""
proxy_target_flag=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --api-proxy-target)
      [[ $# -ge 2 ]] || die "--api-proxy-target needs a URL"
      proxy_target_flag="$2"
      shift 2
      ;;
    --api-proxy-target=*)
      proxy_target_flag="${1#*=}"
      shift
      ;;
    --)
      shift
      ;;
    -*)
      die "unknown option $1 (try --help)"
      ;;
    *)
      [[ -z "$host" ]] || die "unexpected extra argument $1"
      host="$1"
      shift
      ;;
  esac
done

host="${host:-${SPAWN_DEPLOY_HOST:-}}"
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
# manifest at BUILD time, so whatever is used here is frozen into the shipped
# bundle. Prod's server listens on 127.0.0.1:8001.
#
# This deliberately does NOT read SPAWN_API_PROXY_TARGET from the environment.
# A dev shell in this repo exports http://127.0.0.1:8010 (scripts/dev.sh), and
# an inherited value is indistinguishable from an intended one -- on 2026-08-24
# that shipped a production build proxying every /api/* and /ws/* into a dead
# port, while the API itself stayed healthy and gave nothing away. A flag can
# only arrive on purpose, so the flag is the channel.
readonly DEFAULT_API_PROXY_TARGET="http://127.0.0.1:8001"

if [[ -n "$proxy_target_flag" ]]; then
  api_proxy_target="$proxy_target_flag"
elif [[ -n "${SPAWN_API_PROXY_TARGET:-}" ]]; then
  die "refusing to bake SPAWN_API_PROXY_TARGET=${SPAWN_API_PROXY_TARGET} from the environment.
  It is baked into the build, and an inherited dev value ships a broken production
  bundle. Pass it on purpose instead:
    scripts/deploy-prod.sh $host --api-proxy-target ${SPAWN_API_PROXY_TARGET}
  or, for the standard production target:
    env -u SPAWN_API_PROXY_TARGET scripts/deploy-prod.sh $host"
else
  api_proxy_target="$DEFAULT_API_PROXY_TARGET"
fi

case "$api_proxy_target" in
  http://*|https://*) ;;
  *) die "--api-proxy-target must be an http(s) URL, got: $api_proxy_target" ;;
esac
# Trailing slashes survive into the baked destination and break the manifest
# comparison below, so normalise before anything depends on the string.
api_proxy_target="${api_proxy_target%/}"

smoke="${SPAWN_DEPLOY_SMOKE:-1}"
web_origin="${SPAWN_DEPLOY_WEB_ORIGIN:-}"

printf 'deploy-prod: deploying %s to %s:%s\n' "$remote_ref" "$host" "$remote_path"
printf 'deploy-prod: baking API proxy target %s\n' "$api_proxy_target"

env_prefix="$(
  quote_env SPAWN_DEPLOY_PATH "$remote_path"
  quote_env SPAWN_DEPLOY_BRANCH "$branch"
  quote_env SPAWN_DEPLOY_REMOTE "$remote"
  quote_env SPAWN_DEPLOY_SERVICES "$services"
  quote_env SPAWN_DEPLOY_SUDO "$sudo_cmd"
  quote_env SPAWN_DEPLOY_BUILD "$run_build"
  quote_env SPAWN_API_PROXY_TARGET "$api_proxy_target"
  quote_env SPAWN_DEPLOY_SMOKE "$smoke"
  quote_env SPAWN_DEPLOY_WEB_ORIGIN "$web_origin"
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

  # The build is only as good as the target it baked. Read it back out of the
  # manifest and compare: this runs BEFORE any restart, so a wrong target aborts
  # the deploy while the previous build is still the one being served.
  manifest="web/.next/routes-manifest.json"
  [[ -f "$manifest" ]] || die "no $manifest after the web build"
  baked="$(grep -o '"destination": *"https\?://[^/"]*' "$manifest" | sed 's/.*"//' | sort -u)"
  if [[ -z "$baked" ]]; then
    die "no absolute rewrite destinations in $manifest.
  The app proxies /api and /ws through Next to stay single-origin, so this
  should never be empty. Check web/next.config.ts before deploying again."
  fi
  if [[ "$baked" != "$SPAWN_API_PROXY_TARGET" ]]; then
    die "the web build baked the wrong API proxy target.
  requested: $SPAWN_API_PROXY_TARGET
  baked:     $(echo "$baked" | tr '\n' ' ')
  Nothing has been restarted; the previous build is still serving."
  fi
  printf 'remote deploy: verified baked proxy target %s\n' "$baked"

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

# A unit that is "active" only means the process is up. /healthz is served by
# the API and reached THROUGH the web app's rewrite, so a 200 here is the one
# check that exercises the whole chain the browser uses -- nginx aside -- and
# the only one that would have caught the 2026-08-24 dead-port build.
if [[ "${SPAWN_DEPLOY_SMOKE:-1}" != "0" ]] && command -v curl >/dev/null 2>&1; then
  origin="${SPAWN_DEPLOY_WEB_ORIGIN:-}"
  if [[ -z "$origin" ]]; then
    # Whatever port the start script binds is the port to probe, so read it
    # from there rather than hardcoding a second copy that can drift.
    web_port="$(grep -o -- '-p [0-9]\{2,\}' web/package.json | head -1 | grep -o '[0-9]\{2,\}' || true)"
    origin="http://127.0.0.1:${web_port:-3000}"
  fi
  code=""
  for _ in $(seq 1 20); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$origin/healthz" || true)"
    [[ "$code" == "200" ]] && break
    sleep 2
  done
  if [[ "$code" != "200" ]]; then
    die "post-deploy smoke check failed: GET $origin/healthz returned ${code:-no response}.
  /healthz is proxied to the API, so this usually means the web app is pointed
  at the wrong API target or the API did not come back up. The services HAVE
  been restarted. Roll back with:
    cd $SPAWN_DEPLOY_PATH && git checkout -B $SPAWN_DEPLOY_BRANCH $old_rev
  then re-run the deploy once the cause is fixed.
  Set SPAWN_DEPLOY_SMOKE=0 if this host genuinely has no proxied /healthz."
  fi
  printf 'remote deploy: smoke check ok (%s/healthz -> 200)\n' "$origin"
fi

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
  if [[ "${SPAWN_DEPLOY_PREBUILTS:-1}" != "1" ]]; then
    printf 'deploy-prod: prebuilt publish disabled (SPAWN_DEPLOY_PREBUILTS=0)\n'
    return 0
  fi
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
