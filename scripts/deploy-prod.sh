#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/deploy-prod.sh [ssh-host] [--api-proxy-target URL] [--allow-branch]

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
  --allow-branch          Deploy the current non-master branch. Without this,
                          only master deploys: production tracking a feature
                          branch is drift, not a release.

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
  SPAWN_DEPLOY_PUBLIC_ORIGIN
                          Public nginx origin used for the WebSocket upgrade
                          smoke check. Default: https://spawnd.dev.
  SPAWN_DEPLOY_SMOKE      Post-deploy smoke check. Default: 1. Set to 0 only
                          when the host has no proxied /healthz to probe.
  SPAWN_DEPLOY_SMOKE_ATTEMPTS
                          Probes before the smoke check gives up (2s apart).
                          Default: 20.
  SPAWN_DEPLOY_MOBILE     Publish the mobile OTA when mobile/ changed.
                          Default: 1. Set to 0 to print the command instead.
  SPAWN_DEPLOY_MOBILE_CHANNEL
                          EAS channel for that OTA. Inferred as `production`
                          only for master deploys of https://spawnd.dev; any
                          other origin must name it, because publishing a dev
                          build to the production channel reaches every phone.
  SPAWN_DEPLOY_PREBUILTS Publish the verified prebuilt-latest binaries and
                          manifest. Default: 1. Set to 0 only as an explicit
                          emergency override; daemons will not auto-update.
  SPAWN_RELEASE_SIGNING_KEY
                          Ed25519 seed used to sign daemon manifests. Default:
                          ~/.config/spawn/release-signing.key. Required when
                          prebuilts are published; never copied to the host.

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

# A deploy spends whole minutes in phases that send nothing over the wire, and
# a NAT between a CI runner and the host silently drops a connection that goes
# quiet — which is how one release hung for forty minutes with the site half
# served. Keepalives make every connection either alive or loudly dead.
ssh() { command ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=8 "$@"; }
scp() { command scp -o ServerAliveInterval=15 -o ServerAliveCountMax=8 "$@"; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-lib.sh
source "$script_dir/release-lib.sh"

if [[ "${1:-}" == "--self-test" ]]; then
  [[ "$#" -eq 1 ]] || die "--self-test takes no other arguments"
  command -v python3 >/dev/null 2>&1 || die "python3 is required for --self-test"
  command -v uv >/dev/null 2>&1 || die "uv is required for --self-test"
  release_contract_self_test || die "release contract self-test failed"
  "$script_dir/health-check.sh" --self-test || die "connection probe self-test failed"
  printf 'deploy-prod: self-test ok\n'
  exit 0
fi

host=""
proxy_target_flag=""
allow_branch=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --allow-branch)
      allow_branch=1
      shift
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
command -v python3 >/dev/null 2>&1 || die "python3 is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v uv >/dev/null 2>&1 || die "uv is required"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run from inside the spawn repo"
cd "$repo_root"

branch="$(git branch --show-current)"
[[ -n "$branch" ]] || die "detached HEAD is not deployable"

# Production runs master. A branch deploy that looks routine is how prod
# drifts from the one line of history everyone reads, so any other branch
# needs the flag -- a flag can only arrive on purpose.
if [[ "$branch" != "master" && "$allow_branch" != "1" ]]; then
  die "refusing to deploy branch '$branch'; production deploys from master.
  Pass --allow-branch to deploy this branch on purpose."
fi

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
smoke_attempts="${SPAWN_DEPLOY_SMOKE_ATTEMPTS:-20}"
web_origin="${SPAWN_DEPLOY_WEB_ORIGIN:-}"
public_origin="${SPAWN_DEPLOY_PUBLIC_ORIGIN:-https://spawnd.dev}"

prebuilt_tmp="$(mktemp -d)"
cleanup_prebuilt_tmp() {
  rm -rf -- "$prebuilt_tmp"
}
trap cleanup_prebuilt_tmp EXIT

prebuilt_ready=0
prebuilt_stale=0
prebuilt_reason="not checked"
release_commit=""
release_tree=""
release_version=""
release_counter=""
release_public_key=""
release_key_id=""
release_signing_key_file="$(release_signing_key_path)"
prebuilt_entries=()

target_commit="$(git rev-parse "$remote_ref")"
target_tree="$(git rev-parse "$remote_ref:daemon")"
host_probe_env="$(quote_env SPAWN_DEPLOY_PATH "$remote_path")"
host_current_commit="$(ssh "$host" "${host_probe_env}bash -se" <<'REMOTE'
set -euo pipefail
cd "$SPAWN_DEPLOY_PATH"
git rev-parse HEAD
REMOTE
)" || die "could not read the production checkout before deployment"
host_manifest_json="$(ssh "$host" "${host_probe_env}bash -se" <<'REMOTE'
set -euo pipefail
cat "$SPAWN_DEPLOY_PATH/daemon/target/prebuilt/manifest.json" 2>/dev/null || true
REMOTE
)" || die "could not read the production prebuilt manifest before deployment"
host_manifest_tree="$(manifest_tree_from_json "$host_manifest_json" 2>/dev/null || true)"

prebuilt_setting="${SPAWN_DEPLOY_PREBUILTS:-1}"
[[ "$prebuilt_setting" == "0" || "$prebuilt_setting" == "1" ]] ||
  die "SPAWN_DEPLOY_PREBUILTS must be 0 or 1"
prebuilt_override=0
if [[ "$prebuilt_setting" == "0" ]]; then
  prebuilt_override=1
  printf '%s\n' \
    'deploy-prod: WARNING: SPAWN_DEPLOY_PREBUILTS=0 overrides the daemon release gate.' \
    'deploy-prod: WARNING: daemons will refuse unsigned manifests.' \
    'deploy-prod: WARNING: daemons will not auto-update; users may need to reinstall SPAWN D.' >&2
else
  prepare_prebuilt_release
  if [[ "$prebuilt_ready" == "1" ]]; then
    if ! release_signing_key_readable "$release_signing_key_file"; then
      prebuilt_ready=0
      prebuilt_reason="release signing key is missing or unreadable: $release_signing_key_file"
    elif ! release_public_key="$(release_signing_public_key "$release_signing_key_file")"; then
      prebuilt_ready=0
      prebuilt_reason="release signing key is invalid: $release_signing_key_file"
    elif ! release_key_id="$(release_signing_key_id "$release_public_key")"; then
      prebuilt_ready=0
      prebuilt_reason="could not derive the release signing key id"
    elif ! release_counter="$(release_counter_for_commit "$release_commit")"; then
      prebuilt_ready=0
      prebuilt_reason="could not derive the release counter for $release_commit"
    fi
  fi
  if [[ "$prebuilt_stale" == "1" ]]; then
    die "$prebuilt_reason; wait for the prebuilt workflow. To override only in an emergency, set SPAWN_DEPLOY_PREBUILTS=0; daemons will not auto-update and users must reinstall with curl -fsSL https://spawnd.dev/install.sh | sh (Unix) or irm https://spawnd.dev/install.ps1 | iex (PowerShell)"
  fi
fi

if tree_changed_but_cannot_publish \
  "$host_manifest_tree" "$target_tree" "$prebuilt_ready" "$prebuilt_override"; then
  die "daemon tree changes from ${host_manifest_tree:-<no production manifest>} to $target_tree, but prebuilts cannot be published: $prebuilt_reason.
  Wait for prebuilt-latest to contain verified COMMIT, TREE, VERSION, and
  SHA256SUMS assets, or use SPAWN_DEPLOY_PREBUILTS=0 only as an emergency
  override. Without prebuilts, daemons cannot auto-update; users must reinstall:
    curl -fsSL https://spawnd.dev/install.sh | sh
    irm https://spawnd.dev/install.ps1 | iex"
fi

if [[ "$prebuilt_setting" == "1" && "$prebuilt_ready" != "1" ]]; then
  printf 'deploy-prod: prebuilt publish unavailable (%s); daemon tree is unchanged, continuing\n' \
    "$prebuilt_reason" >&2
fi

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
  quote_env SPAWN_DEPLOY_SMOKE_ATTEMPTS "$smoke_attempts"
  quote_env SPAWN_DEPLOY_WEB_ORIGIN "$web_origin"
  quote_env SPAWN_DEPLOY_PUBLIC_ORIGIN "$public_origin"
)"

# The remote script used to be streamed to `bash -se` over stdin, so a dropped
# connection starved bash of the rest of its own script and it stopped wherever
# the stream ended — once, after the build and before the restart, with the old
# assets already gone. Deliver the whole file first: how far the script runs no
# longer depends on the connection that carried it.
remote_script="$(ssh "$host" 'mktemp /tmp/spawn-remote-deploy.XXXXXX')" ||
  die "could not stage the remote deploy script"
ssh "$host" "cat > '$remote_script'" <<'REMOTE'
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
    # The build lands in a staging directory and is swapped in just before the
    # restart. Building straight into web/.next deletes the running server's
    # own assets at build start, and every visitor gets HTML whose chunks 400
    # until the restart — which is minutes away, not milliseconds, because the
    # daemon compile below sits in between.
    #
    # The live build's generated type stubs come along too: web/tsconfig.json
    # includes both .next/types and .next.staged/types, so the staged build
    # type-checks the stubs the *previous* build wrote, and a route deleted
    # since then leaves a stub importing a file that no longer exists (the
    # 2026-09-02 release failed on trust-ux-demo exactly this way). Nothing
    # at runtime reads them, and the build that lands writes its own.
    rm -rf web/.next/types web/.next.staged
    # V8 caps its own heap well below this host's RAM+swap, so a growing app
    # eventually dies with "Reached heap limit" on a machine that still has
    # memory to give. Raise the cap explicitly rather than discovering it
    # again as a failed deploy.
    (cd web && bun install --frozen-lockfile && NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}" SPAWN_API_PROXY_TARGET="$SPAWN_API_PROXY_TARGET" SPAWN_BUILD_ID="$build_id" SPAWN_NEXT_DIST_DIR=.next.staged bun run build)
  else
    die "bun is required for web dependency sync and build"
  fi

  # The build is only as good as the target it baked. Read it back out of the
  # manifest and compare: this runs BEFORE any restart, so a wrong target aborts
  # the deploy while the previous build is still the one being served.
  manifest="web/.next.staged/routes-manifest.json"
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

  # Everything slow is done. The switch itself is two renames, so the running
  # server loses its assets for milliseconds, not for a compile. The previous
  # build stays at web/.next.prev — the rollback is one swap back.
  rm -rf web/.next.prev
  if [[ -d web/.next ]]; then
    mv web/.next web/.next.prev
  fi
  mv web/.next.staged web/.next
  printf 'remote deploy: swapped in the staged web build (previous kept at web/.next.prev)\n'
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
# check that exercises the HTTP chain the browser uses -- nginx aside -- and
# the only one that would have caught the 2026-08-24 dead-port build. The
# anonymous WebSocket probe that follows crosses public nginx as well.
if [[ "${SPAWN_DEPLOY_SMOKE:-1}" != "0" ]]; then
  if command -v curl >/dev/null 2>&1; then
    origin="${SPAWN_DEPLOY_WEB_ORIGIN:-}"
    if [[ -z "$origin" ]]; then
      # Whatever port the start script binds is the port to probe, so read it
      # from there rather than hardcoding a second copy that can drift.
      web_port="$(grep -o -- '-p [0-9]\{2,\}' web/package.json | head -1 | grep -o '[0-9]\{2,\}' || true)"
      origin="http://127.0.0.1:${web_port:-3000}"
    fi
    code=""
    for _ in $(seq 1 "${SPAWN_DEPLOY_SMOKE_ATTEMPTS:-20}"); do
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
  else
    printf 'remote deploy: WARNING: curl unavailable; HTTP smoke probe skipped\n' >&2
  fi

  if [[ -x scripts/health-check.sh ]]; then
    if ! scripts/health-check.sh --probe-websocket \
      "${SPAWN_DEPLOY_PUBLIC_ORIGIN:-https://spawnd.dev}"; then
      die "post-deploy WebSocket smoke check failed through ${SPAWN_DEPLOY_PUBLIC_ORIGIN:-https://spawnd.dev}.
  The services HAVE been restarted. Check nginx's /ws/ upgrade headers and
  Next's API proxy target, then roll back if the public socket cannot upgrade."
    fi
  else
    # Older checkouts and deliberately minimal test hosts do not have the new
    # probe. This is feature detection for a deployment peer that predates it.
    printf 'remote deploy: WARNING: scripts/health-check.sh unavailable; WebSocket smoke probe skipped\n' >&2
  fi
fi

printf 'remote deploy: services updated\n'
REMOTE
ssh "$host" "${env_prefix}bash '$remote_script'; rc=\$?; rm -f '$remote_script'; exit \$rc"

# Publish the exact release snapshot verified before deployment. Binaries land
# through temporary names. The manifest and detached signature are copied to
# temporary paths and renamed atomically, with the signature made live last.
# A reader may briefly see a manifest/signature mismatch, which is safe: the
# daemon rejects it and retries rather than trusting an unsigned identity.
prebuilts_published=0
publish_prebuilts() {
  if [[ "$prebuilt_setting" != "1" ]]; then
    printf 'deploy-prod: prebuilt publish disabled (SPAWN_DEPLOY_PREBUILTS=0)\n'
    return
  fi
  if [[ "$prebuilt_ready" != "1" ]]; then
    printf 'deploy-prod: prebuilt publish skipped (%s)\n' "$prebuilt_reason"
    return
  fi

  local pair target triple dest spawnd_asset worker_asset
  local spawnd_name worker_name spawnd_tmp worker_tmp mode
  for pair in "${PREBUILT_TARGETS[@]}"; do
    target="${pair%%:*}"
    triple="${pair##*:}"
    dest="$remote_path/daemon/target/prebuilt/$target"
    spawnd_asset="$(prebuilt_asset_name "$target" "$triple" spawnd)"
    worker_asset="$(prebuilt_asset_name "$target" "$triple" spawn-worker)"
    spawnd_name="$(prebuilt_installed_name "$target" spawnd)"
    worker_name="$(prebuilt_installed_name "$target" spawn-worker)"
    spawnd_tmp="$spawnd_name.tmp"
    worker_tmp="$worker_name.tmp"
    mode="$(prebuilt_file_mode "$target")"
    if [[ -f "$prebuilt_tmp/$spawnd_asset" && -f "$prebuilt_tmp/$worker_asset" ]]; then
      ssh "$host" "mkdir -p '$dest'"
      scp -q "$prebuilt_tmp/$spawnd_asset" "$host:$dest/$spawnd_tmp"
      scp -q "$prebuilt_tmp/$worker_asset" "$host:$dest/$worker_tmp"
      ssh "$host" "chmod '$mode' '$dest/$spawnd_tmp' '$dest/$worker_tmp' && mv '$dest/$spawnd_tmp' '$dest/$spawnd_name' && mv '$dest/$worker_tmp' '$dest/$worker_name'"
      printf 'deploy-prod: published %s prebuilt to %s\n' "$target" "$host"
    fi
  done

  local manifest="$prebuilt_tmp/manifest.json"
  local signature="$prebuilt_tmp/manifest.json.sig"
  render_prebuilt_manifest \
    "$release_commit" "$release_tree" "$release_version" \
    "$release_counter" "$release_key_id" \
    "${prebuilt_entries[@]}" > "$manifest" ||
    die "could not render the verified prebuilt manifest"
  sign_prebuilt_manifest \
    "$manifest" "$signature" "$release_signing_key_file" ||
    die "could not sign the verified prebuilt manifest"
  local prebuilt_root="$remote_path/daemon/target/prebuilt"
  ssh "$host" "mkdir -p '$prebuilt_root'"
  scp -q "$manifest" "$host:$prebuilt_root/manifest.json.tmp"
  scp -q "$signature" "$host:$prebuilt_root/manifest.json.sig.tmp"
  ssh "$host" "mv '$prebuilt_root/manifest.json.tmp' '$prebuilt_root/manifest.json' && mv '$prebuilt_root/manifest.json.sig.tmp' '$prebuilt_root/manifest.json.sig'"
  prebuilts_published=1
  printf 'deploy-prod: published signed prebuilt manifest for daemon tree %s (key %s)\n' \
    "$release_tree" "$release_key_id"
}
publish_prebuilts

# Prove that the public origin serves the exact signed pair just published.
# This checks the nginx -> web -> API route, not merely the files over SSH.
verify_published_manifest_signature() {
  local served_manifest="$prebuilt_tmp/served-manifest.json"
  local served_signature="$prebuilt_tmp/served-manifest.json.sig"
  local attempt
  for attempt in $(seq 1 "$smoke_attempts"); do
    if curl -fsS --max-time 10 "$public_origin/api/install/manifest.json" \
        -o "$served_manifest" &&
      curl -fsS --max-time 10 "$public_origin/api/install/manifest.json.sig" \
        -o "$served_signature" &&
      cmp -s "$prebuilt_tmp/manifest.json" "$served_manifest" &&
      verify_prebuilt_manifest_signature \
        "$served_manifest" "$served_signature" "$release_public_key"; then
      printf 'deploy-prod: verified public daemon manifest signature at %s (key %s)\n' \
        "$public_origin" "$release_key_id"
      return 0
    fi
    printf 'deploy-prod: public signed manifest not ready (attempt %s)\n' \
      "$attempt" >&2
    [[ "$attempt" == "$smoke_attempts" ]] || sleep 2
  done
  return 1
}

if [[ "$prebuilts_published" == "1" ]] &&
  ! verify_published_manifest_signature; then
  die "post-deploy daemon manifest signature proof failed through $public_origin.
  The services and prebuilt files HAVE been updated. Roll back with:
    ssh $host \"cd $remote_path && git checkout -B $branch $host_current_commit\"
  then restore or republish the last known-good signed daemon manifest."
fi

# Fetch /api/release through the same web origin used by the health probe. This
# happens after manifest publication because the server discovers prebuilts
# live, without a restart.
release_probe_env="$(
  quote_env SPAWN_DEPLOY_PATH "$remote_path"
  quote_env SPAWN_DEPLOY_WEB_ORIGIN "$web_origin"
  quote_env SPAWN_DEPLOY_SMOKE_ATTEMPTS "$smoke_attempts"
)"
release_json="$(ssh "$host" "${release_probe_env}bash -se" <<'REMOTE'
set -euo pipefail
cd "$SPAWN_DEPLOY_PATH"
command -v curl >/dev/null 2>&1 || {
  printf 'remote release proof: curl is required\n' >&2
  exit 1
}
origin="${SPAWN_DEPLOY_WEB_ORIGIN:-}"
if [[ -z "$origin" ]]; then
  web_port="$(grep -o -- '-p [0-9]\{2,\}' web/package.json | head -1 | grep -o '[0-9]\{2,\}' || true)"
  origin="http://127.0.0.1:${web_port:-3000}"
fi
payload=""
for attempt in $(seq 1 "${SPAWN_DEPLOY_SMOKE_ATTEMPTS:-20}"); do
  if payload="$(curl -fsS --max-time 5 "$origin/api/release" 2>/dev/null)"; then
    printf '%s' "$payload"
    exit 0
  fi
  printf 'remote release proof: /api/release not ready (attempt %s)\n' "$attempt" >&2
  sleep 2
done
printf 'remote release proof: could not fetch %s/api/release\n' "$origin" >&2
exit 1
REMOTE
)" || die "post-deploy /api/release fetch failed"

expected_daemon_tree=""
if [[ "$prebuilts_published" == "1" ]]; then
  expected_daemon_tree="$target_tree"
fi
release_matches_expected "$release_json" "$target_commit" "$expected_daemon_tree" ||
  die "post-deploy /api/release proof failed"
printf 'deploy-prod: verified /api/release server.commit=%s' "$target_commit"
if [[ -n "$expected_daemon_tree" ]]; then
  printf ' daemon.tree=%s' "$expected_daemon_tree"
fi
printf '\n'

# The phone ships with the deploy, not after someone remembers it.
#
# This used to print a reminder. A reminder is a step that gets skipped on the
# release where it mattered, and the failure is silent and asymmetric: phones
# keep running the JavaScript they were built with, so the two frontends drift
# apart while everything looks fine. Publishing it here is also the only place
# the *order* is guaranteed — the server is already up, so the bundle phones
# fetch is never newer than the API it talks to. A workflow firing on a push to
# master could not promise that.
#
# The channel is never guessed. Publishing a dev build to the production
# channel would push it to every phone in the field, so an origin this script
# does not recognise prints the command instead of running it.
if git cat-file -e "$host_current_commit^{commit}" 2>/dev/null &&
  ! git diff --quiet "$host_current_commit" "$target_commit" -- mobile; then
  mobile_channel="${SPAWN_DEPLOY_MOBILE_CHANNEL:-}"
  if [[ -z "$mobile_channel" && "$public_origin" == "https://spawnd.dev" && "$branch" == "master" ]]; then
    mobile_channel="production"
  fi
  mobile_message="$(git log -1 --format=%s "$target_commit")"
  mobile_args=(-m "$mobile_message" --api-url "$public_origin" --branch "$mobile_channel")
  [[ "$branch" == "master" ]] || mobile_args+=(--allow-branch)

  if [[ "${SPAWN_DEPLOY_MOBILE:-1}" == "0" ]]; then
    printf 'deploy-prod: mobile/ changed; publishing skipped (SPAWN_DEPLOY_MOBILE=0)\n'
    printf "  scripts/update-mobile-prod.sh %s\n" "${mobile_args[*]}"
  elif [[ -z "$mobile_channel" ]]; then
    printf 'deploy-prod: mobile/ changed, but no EAS channel is known for %s.\n' "$public_origin" >&2
    printf '  Set SPAWN_DEPLOY_MOBILE_CHANNEL, or publish it yourself:\n' >&2
    printf "    scripts/update-mobile-prod.sh -m %q --api-url %q --branch <channel>\n" \
      "$mobile_message" "$public_origin" >&2
  else
    printf 'deploy-prod: mobile/ changed — publishing the OTA to the %s channel\n' "$mobile_channel"
    if ! "$repo_root/scripts/update-mobile-prod.sh" "${mobile_args[@]}"; then
      die "the server and web app ARE deployed, but the mobile OTA failed.
  Phones are still on the previous bundle, which is the safe half of the split.
  Publish it once the cause is fixed:
    scripts/update-mobile-prod.sh ${mobile_args[*]}"
    fi
  fi
fi

printf 'deploy-prod: complete\n'
