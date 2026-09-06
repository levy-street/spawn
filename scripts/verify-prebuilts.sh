#!/usr/bin/env bash
set -euo pipefail

# Verify the server's daemon manifest signature, then prove the handed-out
# binaries are byte-identical to the rolling `prebuilt-latest` release. For
# every supported target this downloads /api/install/{spawnd,spawn-worker},
# hashes it, and compares against CI's SHA256SUMS; every variant pair the
# release carries (/api/install/{spawnd,spawn-worker}/<target>/<variant>) is
# proven the same way against the manifest's `variants` map.
#
# Usage: scripts/verify-prebuilts.sh [server-url]
#   server-url  Base URL of the spawn server. Default: https://spawnd.dev
# Env:
#   SPAWN_REPO  owner/name for the release. Default: levy-street/spawn

SERVER="${1:-https://spawnd.dev}"
SERVER="${SERVER%/}"
REPO="${SPAWN_REPO:-levy-street/spawn}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-lib.sh
source "$script_dir/release-lib.sh"

die() {
  printf 'verify-prebuilts: %s\n' "$*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || die "gh is required to fetch the reference SHA256SUMS"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v git >/dev/null 2>&1 || die "git is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
command -v uv >/dev/null 2>&1 || die "uv is required"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  die "run from inside the spawn repo"

manifest="$tmp/manifest.json"
signature="$tmp/manifest.json.sig"
manifest_signature_ok=0
manifest_key_id=""
release_public_keys=()
release_key_source="$repo_root/daemon/src/release_key.rs"
if [[ -f "$release_key_source" ]]; then
  while IFS= read -r public_key; do
    [[ -n "$public_key" ]] && release_public_keys+=("$public_key")
  done < <(release_public_keys_from_rust_file "$release_key_source" 2>/dev/null || true)
else
  release_key_source="SPAWN_RELEASE_PUBLIC_KEY fallback"
  if [[ -n "${SPAWN_RELEASE_PUBLIC_KEY:-}" ]]; then
    IFS=, read -r -a release_public_keys <<< "$SPAWN_RELEASE_PUBLIC_KEY"
  fi
fi

if curl -fsSL "$SERVER/api/install/manifest.json" -o "$manifest" &&
  curl -fsSL "$SERVER/api/install/manifest.json.sig" -o "$signature"; then
  manifest_key_id="$(python3 - "$manifest" <<'PY' 2>/dev/null || true
import json
import sys

value = json.load(open(sys.argv[1], encoding="utf-8")).get("signing_key_id")
if isinstance(value, str):
    print(value)
PY
)"
  for public_key in "${release_public_keys[@]}"; do
    if verify_prebuilt_manifest_signature \
      "$manifest" "$signature" "$public_key" 2>/dev/null; then
      verified_key_id="$(release_signing_key_id "$public_key" 2>/dev/null || true)"
      if [[ -n "$verified_key_id" && "$verified_key_id" == "$manifest_key_id" ]]; then
        manifest_signature_ok=1
        break
      fi
    fi
  done
fi

if [[ "$manifest_signature_ok" == "1" ]]; then
  printf 'verify-prebuilts: manifest signature OK (key %s; %s)\n' \
    "$manifest_key_id" "$release_key_source"
else
  printf 'verify-prebuilts: manifest signature FAIL (key %s; %s)\n' \
    "${manifest_key_id:-unknown}" "$release_key_source" >&2
fi

printf 'verify-prebuilts: fetching reference SHA256SUMS from %s (%s)\n' "$REPO" prebuilt-latest
gh release download prebuilt-latest --repo "$REPO" --pattern SHA256SUMS --dir "$tmp" --clobber \
  >/dev/null 2>&1 || die "could not download prebuilt-latest SHA256SUMS from $REPO"

# Look up the reference hash for a release-asset filename from SHA256SUMS.
ref_hash() {
  awk -v f="$1" '$2 == f || $2 == "*"f { print $1; exit }' "$tmp/SHA256SUMS"
}

# The hash the signed manifest advertises for one binary: the release pair's
# under `targets`, or a variant's under `variants.<variant>.targets`.
manifest_hash() { # target, kind, [variant]
  python3 - "$manifest" "$1" "$2" "${3:-}" <<'PY'
import json
import sys

path, target, kind, variant = sys.argv[1:]
field = "spawnd_sha256" if kind == "spawnd" else "spawn_worker_sha256"
try:
    manifest = json.load(open(path, encoding="utf-8"))
    if variant:
        value = manifest["variants"][variant]["targets"][target][field]
    else:
        value = manifest["targets"][target][field]
except (KeyError, OSError, TypeError, json.JSONDecodeError):
    raise SystemExit(1)
if not isinstance(value, str):
    raise SystemExit(1)
print(value)
PY
}

printf '\n%-34s %-14s %s\n' TARGET BINARY RESULT
printf -- '---------------------------------------------------------------------------\n'

fail=0
[[ "$manifest_signature_ok" == "1" ]] || fail=1
checked=0

# One binary: the asset must be in SHA256SUMS (or be an optional one and
# absent), the signed manifest must advertise that same hash, and the bytes
# the server hands out under the installed name must hash to it.
verify_served_binary() { # target, triple, kind, variant ("" for the release pair)
  local target="$1" triple="$2" kind="$3" variant="$4"
  local label asset required url out headers advertised want got installed_name
  if [[ -n "$variant" ]]; then
    label="$target ($variant)"
    asset="$(prebuilt_variant_asset_name "$target" "$triple" "$kind" "$variant")"
    url="$SERVER/api/install/$kind/$target/$variant"
    required=0
    prebuilt_variant_target_is_required "$variant" "$target" && required=1
  else
    label="$target"
    asset="$(prebuilt_asset_name "$target" "$triple" "$kind")"
    url="$SERVER/api/install/$kind/$target"
    required=0
    prebuilt_target_is_required "$target" && required=1
  fi
  want="$(ref_hash "$asset" || true)"
  if [[ -z "$want" ]]; then
    if [[ "$required" == "1" ]]; then
      printf '%-34s %-14s %s\n' "$label" "$kind" \
        "FAIL (required asset $asset is not in SHA256SUMS)"
      fail=1
    else
      printf '%-34s %-14s %s\n' "$label" "$kind" "SKIP (not in release)"
    fi
    return
  fi
  advertised="$(manifest_hash "$target" "$kind" "$variant" 2>/dev/null || true)"
  if [[ "$advertised" != "$want" ]]; then
    printf '%-34s %-14s %s\n' "$label" "$kind" \
      "FAIL (signed manifest hash does not match $asset)"
    fail=1
    return
  fi
  out="$tmp/$asset.served"
  headers="$tmp/$asset.headers"
  if ! curl -fsSL -D "$headers" "$url" -o "$out"; then
    printf '%-34s %-14s %s\n' "$label" "$kind" "FAIL (server 404/again: $url)"
    fail=1
    return
  fi
  installed_name="$(prebuilt_installed_name "$target" "$kind")"
  if ! tr -d '\r' < "$headers" |
    grep -Eiq "^content-disposition:.*filename=\"?${installed_name//./\\.}\"?([;[:space:]]|$)"; then
    printf '%-34s %-14s %s\n' "$label" "$kind" \
      "FAIL (response filename is not $installed_name)"
    fail=1
    return
  fi
  got="$(sha256sum "$out" | awk '{print $1}')"
  checked=$((checked + 1))
  if [[ "$got" == "$want" ]]; then
    printf '%-34s %-14s %s\n' "$label" "$kind" "OK   ${got:0:12}…"
  else
    printf '%-34s %-14s %s\n' "$label" "$kind" "MISMATCH"
    printf '    want %s\n    got  %s\n' "$want" "$got"
    fail=1
  fi
}

for pair in "${PREBUILT_TARGETS[@]}"; do
  target="${pair%%:*}"
  triple="${pair##*:}"
  for kind in spawnd spawn-worker; do
    verify_served_binary "$target" "$triple" "$kind" ""
  done
  for variant in "${PREBUILT_VARIANTS[@]}"; do
    for kind in spawnd spawn-worker; do
      verify_served_binary "$target" "$triple" "$kind" "$variant"
    done
  done
done

printf -- '---------------------------------------------------------------------------\n'
if [[ "$fail" != 0 ]]; then
  die "the manifest signature or one or more served binaries failed verification — see above"
fi
[[ "$checked" -gt 0 ]] || die "nothing verified (no matching assets served)"
printf 'verify-prebuilts: all %d served binaries match CI (%s)\n' "$checked" "$SERVER"
