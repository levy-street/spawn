#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/update-mobile-prod.sh -m "message" [options]

Publish the mobile over-the-air update for a production release.

This script exists because of a real outage: eas.json's `env` blocks apply
to `eas build` profiles only. `eas update` re-evaluates app.config.ts with
the CALLER'S shell environment, so a bare `eas update` from a shell without
EXPO_PUBLIC_API_URL publishes a bundle with no API URL baked in — release
builds then fall back to http://localhost:3000 and every phone breaks at
sign-in. The script bakes the URL itself, proves the evaluated config carries
it and the mobile source tree BEFORE publishing, and proves the served
manifest carries both AFTER publishing.

Options:
  -m MESSAGE        Update message (required). Use the same summary as the
                    server/web deploy it accompanies.
  --api-url URL     API URL to bake. Default: https://spawnd.dev. An
                    inherited EXPO_PUBLIC_API_URL that disagrees is refused,
                    not used — the proxy-target lesson applies here too.
  --branch NAME     EAS update branch. Default: production.
  --allow-branch    Publish from a non-master git branch. Without this, only
                    master publishes: phones tracking a feature branch is
                    drift, not a release.
  --skip-verify     Skip the post-publish manifest check. For environments
                    that cannot reach u.expo.dev; the pre-publish config
                    proof still runs.

The script refuses a dirty checkout and unpushed commits for the same
reason deploy-prod.sh does: what is live must be reachable from origin.
EOF
}

die() {
  echo "update-mobile-prod: $*" >&2
  exit 1
}

message=""
api_url="https://spawnd.dev"
update_branch="production"
allow_branch=0
skip_verify=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    -m)
      [[ $# -ge 2 ]] || die "-m needs a message"
      message="$2"
      shift 2
      ;;
    -m=*)
      message="${1#*=}"
      shift
      ;;
    --api-url)
      [[ $# -ge 2 ]] || die "--api-url needs a URL"
      api_url="$2"
      shift 2
      ;;
    --api-url=*)
      api_url="${1#*=}"
      shift
      ;;
    --branch)
      [[ $# -ge 2 ]] || die "--branch needs a name"
      update_branch="$2"
      shift 2
      ;;
    --branch=*)
      update_branch="${1#*=}"
      shift
      ;;
    --allow-branch)
      allow_branch=1
      shift
      ;;
    --skip-verify)
      skip_verify=1
      shift
      ;;
    *)
      die "unknown option $1 (try --help)"
      ;;
  esac
done

[[ -n "$message" ]] || die "missing -m message; say what this update ships"
[[ "$api_url" == https://* ]] || die "--api-url must be https, got: $api_url"

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run from inside the spawn repo"
[[ -d "$repo_root/mobile" ]] || die "no mobile/ under $repo_root"

branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)"
[[ "$branch" != "HEAD" ]] || die "detached HEAD is not publishable"
if [[ "$branch" != "master" && "$allow_branch" -ne 1 ]]; then
  die "refusing to publish from branch '$branch'; phones track master. Pass --allow-branch to override"
fi

if [[ -n "$(git -C "$repo_root" status --porcelain)" ]]; then
  die "refusing to publish from a dirty checkout; commit or stash first"
fi

upstream="origin/$branch"
if git -C "$repo_root" rev-parse --verify --quiet "$upstream" >/dev/null; then
  unpushed="$(git -C "$repo_root" rev-list --count "$upstream..HEAD")"
  [[ "$unpushed" -eq 0 ]] || die "refusing to publish $unpushed unpushed commit(s); push $branch first"
else
  die "no $upstream to compare against; push the branch first"
fi

# The proxy-target lesson: a dev shell's inherited value must never leak into
# a production artifact silently. Equal is fine; different is refused.
if [[ -n "${EXPO_PUBLIC_API_URL:-}" && "${EXPO_PUBLIC_API_URL}" != "$api_url" ]]; then
  die "inherited EXPO_PUBLIC_API_URL=${EXPO_PUBLIC_API_URL} disagrees with --api-url $api_url; unset it or pass it explicitly"
fi
export EXPO_PUBLIC_API_URL="$api_url"
mobile_tree="$(git -C "$repo_root" rev-parse HEAD:mobile)"
export EXPO_PUBLIC_SPAWN_MOBILE_TREE="$mobile_tree"

# Prove the bake BEFORE publishing: evaluate app.config.ts exactly the way
# `eas update` will, and require both release inputs to come out the other end.
echo "update-mobile-prod: verifying the evaluated expo config bakes $api_url and mobile tree $mobile_tree"
evaluated="$(cd "$repo_root/mobile" && npx expo config --json 2>/dev/null)" ||
  die "npx expo config failed; cannot prove the bake, refusing to publish"
baked="$(node -e '
  const raw = require("fs").readFileSync(0, "utf8");
  const start = raw.indexOf("{");
  if (start < 0) process.exit(1);
  const config = JSON.parse(raw.slice(start));
  process.stdout.write(String(config?.extra?.apiUrl ?? ""));
' <<<"$evaluated")" || die "could not parse expo config output"
[[ "$baked" == "$api_url" ]] ||
  die "evaluated config has extra.apiUrl='${baked:-<absent>}', expected $api_url; app.config.ts wiring changed — fix that before publishing"
baked_tree="$(node -e '
  const raw = require("fs").readFileSync(0, "utf8");
  const start = raw.indexOf("{");
  if (start < 0) process.exit(1);
  const config = JSON.parse(raw.slice(start));
  process.stdout.write(String(config?.extra?.mobileTree ?? ""));
' <<<"$evaluated")" || die "could not parse expo config output"
[[ "$baked_tree" == "$mobile_tree" ]] ||
  die "evaluated config has extra.mobileTree='${baked_tree:-<absent>}', expected $mobile_tree; app.config.ts wiring changed — fix that before publishing"

eas_bin=(eas)
command -v eas >/dev/null 2>&1 || eas_bin=(npx --yes eas-cli)

echo "update-mobile-prod: publishing to branch '$update_branch'"
publish_output="$(cd "$repo_root/mobile" && "${eas_bin[@]}" update --branch "$update_branch" -m "$message" --non-interactive --json)" ||
  die "eas update failed"

published_ids="$(node -e '
  const raw = require("fs").readFileSync(0, "utf8");
  const start = raw.indexOf("[") >= 0 && (raw.indexOf("[") < raw.indexOf("{") || raw.indexOf("{") < 0)
    ? raw.indexOf("[") : raw.indexOf("{");
  if (start < 0) process.exit(1);
  const parsed = JSON.parse(raw.slice(start));
  const updates = Array.isArray(parsed) ? parsed : [parsed];
  process.stdout.write(updates.map((u) => u.id).filter(Boolean).join(" "));
' <<<"$publish_output")" || die "could not parse eas update output"
[[ -n "$published_ids" ]] || die "eas update reported no update ids; refusing to call this published"
echo "update-mobile-prod: published update(s): $published_ids"

if [[ "$skip_verify" -eq 1 ]]; then
  echo "update-mobile-prod: post-publish manifest check skipped by flag"
  exit 0
fi

# Prove the serve AFTER publishing: the manifest the phones will fetch must
# name one of the update ids just published and carry both baked identities.
read -r project_id runtime_version <<<"$(node -e '
  const app = require(process.argv[1] + "/mobile/app.json");
  const expo = app.expo ?? app;
  const projectId = expo?.extra?.eas?.projectId ?? "";
  const runtime = typeof expo.runtimeVersion === "string" ? expo.runtimeVersion : expo.version;
  process.stdout.write(projectId + " " + runtime);
' "$repo_root")"
[[ -n "$project_id" && -n "$runtime_version" ]] || die "could not read projectId/runtimeVersion from mobile/app.json"

echo "update-mobile-prod: verifying the served manifest at u.expo.dev"
verify_attempts="${SPAWN_UPDATE_VERIFY_ATTEMPTS:-5}"
verify_delay="${SPAWN_UPDATE_VERIFY_DELAY:-3}"
verified=0
for attempt in $(seq 1 "$verify_attempts"); do
  manifest="$(curl -sS --max-time 20 "https://u.expo.dev/$project_id" \
    -H "expo-channel-name: $update_branch" \
    -H "expo-runtime-version: $runtime_version" \
    -H "expo-platform: ios" \
    -H "expo-protocol-version: 1" 2>/dev/null || true)"
  if node -e '
    const raw = require("fs").readFileSync(0, "utf8");
    const start = raw.indexOf("{");
    if (start < 0) process.exit(1);
    // The body may be multipart; take the first balanced JSON object.
    let depth = 0, end = -1, inString = false, escaped = false;
    for (let i = start; i < raw.length; i++) {
      const c = raw[i];
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === "\"") inString = !inString;
      if (inString) continue;
      if (c === "{") depth++;
      if (c === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) process.exit(1);
    const manifest = JSON.parse(raw.slice(start, end + 1));
    const served = manifest?.extra?.expoClient?.extra?.apiUrl ?? "";
    const servedTree = manifest?.extra?.expoClient?.extra?.mobileTree ?? "";
    const ids = process.argv[1].split(" ");
    if (served !== process.argv[2]) {
      console.error("served apiUrl=" + (served || "<absent>") + ", expected " + process.argv[2]);
      process.exit(1);
    }
    if (servedTree !== process.argv[3]) {
      console.error("served mobileTree=" + (servedTree || "<absent>") + ", expected " + process.argv[3]);
      process.exit(1);
    }
    if (!ids.includes(manifest.id)) {
      console.error("served update " + manifest.id + " is not the one just published");
      process.exit(1);
    }
  ' "$published_ids" "$api_url" "$mobile_tree" <<<"$manifest"; then
    verified=1
    break
  fi
  echo "update-mobile-prod: manifest not consistent yet (attempt $attempt), retrying"
  sleep "$verify_delay"
done
[[ "$verified" -eq 1 ]] ||
  die "the served manifest never showed the published update with apiUrl=$api_url and mobileTree=$mobile_tree; phones may be broken — investigate before walking away"

echo "update-mobile-prod: verified — phones will fetch $api_url at mobile tree $mobile_tree"
