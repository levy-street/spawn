#!/usr/bin/env bash

# Shared, side-effect-free release contract helpers plus the local validation
# of a downloaded prebuilt-latest snapshot. This file is sourced by deploy;
# executing it directly is only supported for its self-test.

PREBUILT_TARGETS=(
  "darwin-aarch64:aarch64-apple-darwin"
  "darwin-x86_64:x86_64-apple-darwin"
  "linux-x86_64:x86_64-unknown-linux-gnu"
  "linux-aarch64:aarch64-unknown-linux-gnu"
)

is_lower_hex() {
  local value="$1"
  local length="$2"
  [[ "${#value}" -eq "$length" && ! "$value" =~ [^0-9a-f] ]]
}

# Each remaining argument is target:spawnd_sha256:spawn_worker_sha256.
render_prebuilt_manifest() {
  local commit="$1"
  local tree="$2"
  local version="$3"
  shift 3

  is_lower_hex "$commit" 40 || return 1
  is_lower_hex "$tree" 40 || return 1
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\+g[0-9a-f]{12}$ ]] || return 1
  [[ "${version##*+g}" == "${commit:0:12}" ]] || return 1
  [[ "$#" -gt 0 ]] || return 1

  printf '{\n'
  printf '  "commit": "%s",\n' "$commit"
  printf '  "tree": "%s",\n' "$tree"
  printf '  "version": "%s",\n' "$version"
  printf '  "targets": {\n'

  local entry target spawnd_sha worker_sha separator=""
  for entry in "$@"; do
    IFS=: read -r target spawnd_sha worker_sha <<< "$entry"
    case "$target" in
      darwin-aarch64|darwin-x86_64|linux-x86_64|linux-aarch64) ;;
      *) return 1 ;;
    esac
    is_lower_hex "$spawnd_sha" 64 || return 1
    is_lower_hex "$worker_sha" 64 || return 1
    printf '%s    "%s": {"spawnd_sha256": "%s", "spawn_worker_sha256": "%s"}' \
      "$separator" "$target" "$spawnd_sha" "$worker_sha"
    separator=$',\n'
  done
  printf '\n  }\n'
  printf '}\n'
}

# Success means the deploy must be blocked.
tree_changed_but_cannot_publish() {
  local current_tree="$1"
  local target_tree="$2"
  local can_publish="$3"
  local override="$4"
  [[ "$current_tree" != "$target_tree" && "$can_publish" != "1" && "$override" != "1" ]]
}

release_matches_expected() {
  local payload="$1"
  local expected_commit="$2"
  local expected_tree="$3"
  python3 -c '
import json
import sys

expected_commit, expected_tree = sys.argv[1:]
try:
    release = json.load(sys.stdin)
except (json.JSONDecodeError, OSError) as exc:
    print(f"invalid /api/release response: {exc}", file=sys.stderr)
    raise SystemExit(1)

actual_commit = (release.get("server") or {}).get("commit")
if actual_commit != expected_commit:
    print(
        f"server.commit mismatch: expected {expected_commit}, got {actual_commit!r}",
        file=sys.stderr,
    )
    raise SystemExit(1)

if expected_tree:
    actual_tree = (release.get("daemon") or {}).get("tree")
    if actual_tree != expected_tree:
        print(
            f"daemon.tree mismatch: expected {expected_tree}, got {actual_tree!r}",
            file=sys.stderr,
        )
        raise SystemExit(1)
' "$expected_commit" "$expected_tree" <<< "$payload"
}

manifest_tree_from_json() {
  python3 -c '
import json
import sys

try:
    value = json.load(sys.stdin).get("tree")
except (AttributeError, json.JSONDecodeError):
    raise SystemExit(1)
if not isinstance(value, str):
    raise SystemExit(1)
print(value)
' <<< "$1"
}

prebuilt_manifest_matches_daemon() {
  local release_dir="$1"
  local target_ref="$2"
  local prebuilt_commit prebuilt_tree commit_tree target_tree

  [[ -f "$release_dir/COMMIT" ]] || return 1
  prebuilt_commit="$(tr -d '\r\n' < "$release_dir/COMMIT")"
  is_lower_hex "$prebuilt_commit" 40 || return 1
  git cat-file -e "$prebuilt_commit^{commit}" 2>/dev/null || return 1

  if [[ -f "$release_dir/TREE" ]]; then
    prebuilt_tree="$(tr -d '\r\n' < "$release_dir/TREE")"
    is_lower_hex "$prebuilt_tree" 40 || return 1
    commit_tree="$(git rev-parse "$prebuilt_commit:daemon" 2>/dev/null)" || return 1
    target_tree="$(git rev-parse "$target_ref:daemon" 2>/dev/null)" || return 1
    [[ "$prebuilt_tree" == "$commit_tree" && "$prebuilt_tree" == "$target_tree" ]]
    return
  fi

  git diff --quiet "$prebuilt_commit" "$target_ref" -- daemon
}

verify_release_checksums() {
  local release_dir="$1"
  [[ -f "$release_dir/SHA256SUMS" ]] || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$release_dir" && sha256sum -c SHA256SUMS >/dev/null 2>&1)
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$release_dir" && shasum -a 256 -c SHA256SUMS >/dev/null 2>&1)
  else
    return 1
  fi
}

checksum_for_asset() {
  local release_dir="$1"
  local asset="$2"
  awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1; exit }' \
    "$release_dir/SHA256SUMS"
}

# Mutates the prebuilt_* and release_* globals initialised by deploy-prod.sh.
prepare_prebuilt_release() {
  if ! command -v scp >/dev/null 2>&1; then
    prebuilt_reason="scp is not installed locally"
    return
  fi
  if ! command -v gh >/dev/null 2>&1; then
    prebuilt_reason="gh is not installed locally"
    return
  fi
  if ! gh release download prebuilt-latest --repo levy-street/spawn \
    --dir "$prebuilt_tmp" --clobber >/dev/null 2>&1; then
    prebuilt_reason="prebuilt-latest could not be downloaded"
    return
  fi
  if ! prebuilt_manifest_matches_daemon "$prebuilt_tmp" "$remote_ref"; then
    prebuilt_reason="prebuilt-latest COMMIT/TREE is stale or invalid"
    prebuilt_stale=1
    return
  fi
  if ! verify_release_checksums "$prebuilt_tmp"; then
    prebuilt_reason="prebuilt-latest SHA256SUMS verification failed"
    return
  fi
  if [[ ! -f "$prebuilt_tmp/TREE" || ! -f "$prebuilt_tmp/VERSION" ]]; then
    prebuilt_reason="prebuilt-latest lacks TREE or VERSION"
    return
  fi

  release_commit="$(tr -d '\r\n' < "$prebuilt_tmp/COMMIT")"
  release_tree="$(tr -d '\r\n' < "$prebuilt_tmp/TREE")"
  release_version="$(tr -d '\r\n' < "$prebuilt_tmp/VERSION")"
  is_lower_hex "$release_commit" 40 || {
    prebuilt_reason="prebuilt-latest COMMIT is invalid"
    return
  }
  is_lower_hex "$release_tree" 40 || {
    prebuilt_reason="prebuilt-latest TREE is invalid"
    return
  }
  [[ "$release_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\+g[0-9a-f]{12}$ ]] || {
    prebuilt_reason="prebuilt-latest VERSION is invalid"
    return
  }
  if [[ "${release_version##*+g}" != "${release_commit:0:12}" ]]; then
    prebuilt_reason="prebuilt-latest VERSION does not match COMMIT"
    return
  fi

  local pair target triple spawnd_asset worker_asset spawnd_sha worker_sha
  for pair in "${PREBUILT_TARGETS[@]}"; do
    target="${pair%%:*}"
    triple="${pair##*:}"
    spawnd_asset="spawnd-$triple"
    worker_asset="spawn-worker-$triple"
    if [[ ! -f "$prebuilt_tmp/$spawnd_asset" || ! -f "$prebuilt_tmp/$worker_asset" ]]; then
      continue
    fi
    spawnd_sha="$(checksum_for_asset "$prebuilt_tmp" "$spawnd_asset")"
    worker_sha="$(checksum_for_asset "$prebuilt_tmp" "$worker_asset")"
    if ! is_lower_hex "$spawnd_sha" 64 || ! is_lower_hex "$worker_sha" 64; then
      prebuilt_reason="SHA256SUMS lacks a valid checksum for $target"
      return
    fi
    prebuilt_entries+=("$target:$spawnd_sha:$worker_sha")
  done
  if [[ "${#prebuilt_entries[@]}" -eq 0 ]]; then
    prebuilt_reason="prebuilt-latest contains no complete target pair"
    return
  fi

  prebuilt_ready=1
  prebuilt_reason="verified"
}

release_contract_self_test() {
  local commit="1111111111111111111111111111111111111111"
  local tree="2222222222222222222222222222222222222222"
  local spawnd_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  local worker_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  local manifest release
  manifest="$(render_prebuilt_manifest \
    "$commit" "$tree" "0.1.0+g111111111111" \
    "darwin-aarch64:$spawnd_sha:$worker_sha")" || return 1
  [[ "$(manifest_tree_from_json "$manifest")" == "$tree" ]] || return 1
  grep -q '"spawn_worker_sha256": "bbbbbbbb' <<< "$manifest" || return 1
  tree_changed_but_cannot_publish "$commit" "$tree" 0 0 || return 1
  ! tree_changed_but_cannot_publish "$tree" "$tree" 0 0 || return 1
  ! tree_changed_but_cannot_publish "$commit" "$tree" 1 0 || return 1
  ! tree_changed_but_cannot_publish "$commit" "$tree" 0 1 || return 1

  release="{\"server\":{\"commit\":\"$commit\"},\"daemon\":{\"tree\":\"$tree\"}}"
  release_matches_expected "$release" "$commit" "$tree" || return 1
  ! release_matches_expected "$release" "$tree" "$tree" 2>/dev/null || return 1
  ! release_matches_expected "$release" "$commit" "$commit" 2>/dev/null || return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" != "--self-test" || "$#" -ne 1 ]]; then
    printf 'usage: scripts/release-lib.sh --self-test\n' >&2
    exit 2
  fi
  command -v python3 >/dev/null 2>&1 || {
    printf 'release-lib: python3 is required\n' >&2
    exit 1
  }
  release_contract_self_test || {
    printf 'release-lib: self-test failed\n' >&2
    exit 1
  }
  printf 'release-lib: self-test ok\n'
fi
