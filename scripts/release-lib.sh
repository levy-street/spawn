#!/usr/bin/env bash

# Shared release contract, signing, and downloaded-prebuilt validation helpers.
# This file is sourced by deploy; executing it directly is only supported for
# its self-test.

PREBUILT_TARGETS=(
  "darwin-aarch64:aarch64-apple-darwin"
  "darwin-x86_64:x86_64-apple-darwin"
  "linux-x86_64:x86_64-unknown-linux-gnu"
  "linux-aarch64:aarch64-unknown-linux-gnu"
  "windows-x86_64:x86_64-pc-windows-msvc"
)

# A target listed here may never disappear silently from an otherwise valid
# release. Windows belonged here in anticipation of a launch that has not
# happened: until it has a signing identity it publishes nothing, and a hard
# requirement on it blocks every Mac and Linux release too. Its absence is not
# silent — the daemon manifest omits the target, and both frontends read that
# and offer WSL instead of a native Windows install. Put it back the day it
# launches; that is what makes the promise real rather than aspirational.
PREBUILT_REQUIRED_TARGETS=()

# Alternative builds of the same release: cut from the same tree at the same
# counter, published beside the release pair under a suffixed asset name
# (`spawnd-<triple>.<variant>`, `.exe` last on Windows), served from
# `prebuilt/<target>/<variant>/`, and listed in the signed manifest under
# `variants`. A daemon follows the variant it was built as, so a host that
# runs one keeps running it across updates. Today there is one, `diagnostics`:
# release codegen with symbols kept and debug logging on by default. See
# "The diagnostics variant" in docs/RELEASE.md.
PREBUILT_VARIANTS=(diagnostics)

# variant:public-target pairs a release may never silently lose. dream runs
# the diagnostics variant permanently, and a release without its build for
# that target would strand it on whatever it last installed — loudly, since
# the daemon refuses the release pair with `variant_unavailable`, but stranded.
PREBUILT_REQUIRED_VARIANT_TARGETS=("diagnostics:linux-x86_64")

prebuilt_binary_suffix() { # public-target
  if [[ "$1" == windows-* ]]; then
    printf '%s\n' ".exe"
  else
    printf '\n'
  fi
}

prebuilt_asset_name() { # public-target, rust-triple, kind
  printf '%s-%s%s\n' "$3" "$2" "$(prebuilt_binary_suffix "$1")"
}

prebuilt_variant_asset_name() { # public-target, rust-triple, kind, variant
  printf '%s-%s.%s%s\n' "$3" "$2" "$4" "$(prebuilt_binary_suffix "$1")"
}

prebuilt_installed_name() { # public-target, kind
  printf '%s%s\n' "$2" "$(prebuilt_binary_suffix "$1")"
}

prebuilt_variant_is_known() { # variant
  local known
  for known in "${PREBUILT_VARIANTS[@]}"; do
    [[ "$1" == "$known" ]] && return 0
  done
  return 1
}

prebuilt_variant_target_is_required() { # variant, public-target
  local required
  [[ "${#PREBUILT_REQUIRED_VARIANT_TARGETS[@]}" -eq 0 ]] && return 1
  for required in "${PREBUILT_REQUIRED_VARIANT_TARGETS[@]}"; do
    [[ "$1:$2" == "$required" ]] && return 0
  done
  return 1
}

# The version a variant binary reports: the release version with the variant
# as one more build-metadata segment, exactly as daemon/build.rs stamps it.
# The manifest carries it and the updater refuses a binary that says
# anything else, so the workflow proves the built binary agrees before it is
# published.
prebuilt_variant_version() { # release-version, variant
  printf '%s.%s\n' "$1" "$2"
}

prebuilt_file_mode() { # public-target; payloads are read by the Linux API host
  if [[ "$1" == windows-* ]]; then
    printf '%s\n' "0644"
  else
    printf '%s\n' "0755"
  fi
}

prebuilt_target_is_required() { # public-target
  local required
  # An empty array under `set -u` is an error to expand on bash 3.2, which is
  # still what /bin/bash is on a Mac.
  [[ "${#PREBUILT_REQUIRED_TARGETS[@]}" -eq 0 ]] && return 1
  for required in "${PREBUILT_REQUIRED_TARGETS[@]}"; do
    [[ "$1" == "$required" ]] && return 0
  done
  return 1
}

is_lower_hex() {
  local value="$1"
  local length="$2"
  [[ "${#value}" -eq "$length" && ! "$value" =~ [^0-9a-f] ]]
}

release_counter_for_commit() {
  local commit="$1"
  local counter
  counter="$(git show -s --format=%ct "$commit" 2>/dev/null)" || return 1
  [[ "$counter" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$counter"
}

# The counter a deployed daemon manifest should carry. A daemon release is
# identified by its daemon/ tree, so a deploy that changed nothing under
# daemon/ keeps the release built at an earlier commit, and that commit's
# committer timestamp is the counter — not the ref's. Given the ref's commit
# and daemon tree and the commit the manifest names, this prints the counter
# of the manifest's commit when that commit's daemon/ is the ref's tree, and
# the ref's counter otherwise (where the tree row fails alongside).
release_counter_expected_for_deploy() {
  local ref_commit="$1"
  local ref_daemon_tree="$2"
  local manifest_commit="$3"
  local manifest_tree
  if is_lower_hex "$manifest_commit" 40 &&
    manifest_tree="$(git rev-parse "$manifest_commit:daemon" 2>/dev/null)" &&
    [[ "$manifest_tree" == "$ref_daemon_tree" ]]; then
    release_counter_for_commit "$manifest_commit"
    return
  fi
  release_counter_for_commit "$ref_commit"
}

release_signing_key_path() {
  printf '%s\n' "${SPAWN_RELEASE_SIGNING_KEY:-$HOME/.config/spawn/release-signing.key}"
}

release_signing_key_readable() {
  local keyfile="${1:-$(release_signing_key_path)}"
  [[ -f "$keyfile" && -r "$keyfile" ]]
}

# The release key helpers deliberately use the server project's Python. It is
# the one release environment that already pins cryptography, and keeps private
# key material out of command arguments and shell output.
release_signing_public_key() {
  local keyfile="${1:-$(release_signing_key_path)}"
  release_signing_key_readable "$keyfile" || return 1
  UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/spawn-release-uv-cache}" \
    uv run --project "$(cd "$(dirname "${BASH_SOURCE[0]}")/../server" && pwd)" --frozen python - "$keyfile" <<'PY'
import base64
import re
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def decode_unpadded(value: str, length: int) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value) or "=" in value:
        raise ValueError("not unpadded base64url")
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(raw) != length or base64.urlsafe_b64encode(raw).decode().rstrip("=") != value:
        raise ValueError("wrong length or non-canonical encoding")
    return raw


try:
    lines = Path(sys.argv[1]).read_text(encoding="ascii").splitlines()
    if len(lines) != 1:
        raise ValueError("the signing seed must be exactly one line")
    seed = decode_unpadded(lines[0], 32)
    public = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
except (OSError, UnicodeError, ValueError) as exc:
    print(f"invalid release signing key file: {exc}", file=sys.stderr)
    raise SystemExit(1)

print(base64.urlsafe_b64encode(public).decode().rstrip("="))
PY
}

release_signing_key_id() {
  local public_key="$1"
  python3 - "$public_key" <<'PY'
import base64
import hashlib
import re
import sys

value = sys.argv[1]
try:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value) or "=" in value:
        raise ValueError
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode().rstrip("=") != value:
        raise ValueError
except ValueError:
    raise SystemExit(1)
print(hashlib.sha256(raw).hexdigest()[:8])
PY
}

sign_prebuilt_manifest() {
  local manifest="$1"
  local signature_out="$2"
  local keyfile="${3:-$(release_signing_key_path)}"
  [[ -f "$manifest" && -r "$manifest" ]] || return 1
  release_signing_key_readable "$keyfile" || return 1
  UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/spawn-release-uv-cache}" \
    uv run --project "$(cd "$(dirname "${BASH_SOURCE[0]}")/../server" && pwd)" --frozen python - \
      "$manifest" "$signature_out" "$keyfile" <<'PY'
import base64
import re
import sys
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def decode_seed(path: str) -> bytes:
    lines = Path(path).read_text(encoding="ascii").splitlines()
    if len(lines) != 1:
        raise ValueError("the signing seed must be exactly one line")
    value = lines[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value) or "=" in value:
        raise ValueError("the signing seed is not unpadded base64url")
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(raw) != 32 or base64.urlsafe_b64encode(raw).decode().rstrip("=") != value:
        raise ValueError("the signing seed has the wrong length or encoding")
    return raw


try:
    manifest = Path(sys.argv[1]).read_bytes()
    seed = decode_seed(sys.argv[3])
    signature = Ed25519PrivateKey.from_private_bytes(seed).sign(manifest)
    encoded = base64.urlsafe_b64encode(signature).decode().rstrip("=")
    Path(sys.argv[2]).write_text(encoded + "\n", encoding="ascii")
except (OSError, UnicodeError, ValueError) as exc:
    print(f"could not sign prebuilt manifest: {exc}", file=sys.stderr)
    raise SystemExit(1)
PY
}

verify_prebuilt_manifest_signature() {
  local manifest="$1"
  local signature="$2"
  local public_key="$3"
  [[ -f "$manifest" && -r "$manifest" && -f "$signature" && -r "$signature" ]] || return 1
  UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/spawn-release-uv-cache}" \
    uv run --project "$(cd "$(dirname "${BASH_SOURCE[0]}")/../server" && pwd)" --frozen python - \
      "$manifest" "$signature" "$public_key" <<'PY'
import base64
import re
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def decode_unpadded(value: str, length: int) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value) or "=" in value:
        raise ValueError
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(raw) != length or base64.urlsafe_b64encode(raw).decode().rstrip("=") != value:
        raise ValueError
    return raw


try:
    signature_lines = Path(sys.argv[2]).read_text(encoding="ascii").splitlines()
    if len(signature_lines) != 1:
        raise ValueError
    signature = decode_unpadded(signature_lines[0], 64)
    public = decode_unpadded(sys.argv[3], 32)
    Ed25519PublicKey.from_public_bytes(public).verify(
        signature, Path(sys.argv[1]).read_bytes()
    )
except (InvalidSignature, OSError, UnicodeError, ValueError):
    raise SystemExit(1)
PY
}

# Extract unpadded base64url-encoded 32-byte public keys from the daemon's
# release-key source. Keeping the parser encoding-based makes it tolerate a
# singular constant today and the rotation list the daemon contract requires.
release_public_keys_from_rust_file() {
  local source_file="$1"
  [[ -f "$source_file" && -r "$source_file" ]] || return 1
  python3 - "$source_file" <<'PY'
import base64
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
found = []
for value in re.findall(r'["\u0027]([A-Za-z0-9_-]{43})["\u0027]', text):
    try:
        raw = base64.urlsafe_b64decode(value + "=")
    except ValueError:
        continue
    if len(raw) == 32 and value not in found:
        found.append(value)
if not found:
    raise SystemExit(1)
print("\n".join(found))
PY
}

prebuilt_target_is_known() { # public-target
  case "$1" in
    darwin-aarch64|darwin-x86_64|linux-x86_64|linux-aarch64|windows-x86_64) return 0 ;;
    *) return 1 ;;
  esac
}

# Each remaining argument is one pair: target:spawnd_sha256:spawn_worker_sha256
# for the release, or variant:target:spawnd_sha256:spawn_worker_sha256 for a
# variant build. The variant entries land under `variants`, keyed by variant,
# each with the version that build reports and its own per-target hashes. A
# variant may only name a target whose release pair is also listed — they are
# one tree and one counter, and the daemon holds the server's claim to the
# release hashes before it reads a variant. At least one release pair is
# required; `variants` is always present, empty when nothing was built.
render_prebuilt_manifest() {
  local commit="$1"
  local tree="$2"
  local version="$3"
  local release_counter="$4"
  local signing_key_id="$5"
  shift 5

  is_lower_hex "$commit" 40 || return 1
  is_lower_hex "$tree" 40 || return 1
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+\+g[0-9a-f]{12}$ ]] || return 1
  [[ "${version##*+g}" == "${commit:0:12}" ]] || return 1
  [[ "$release_counter" =~ ^[0-9]+$ ]] || return 1
  is_lower_hex "$signing_key_id" 8 || return 1
  [[ "$#" -gt 0 ]] || return 1

  # Validate everything before printing anything, so a bad entry produces no
  # partial manifest on stdout.
  local entry first second third fourth
  local release_targets=() release_lines=()
  local variant_names=() variant_lines=()
  local target spawnd_sha worker_sha variant
  for entry in "$@"; do
    IFS=: read -r first second third fourth <<< "$entry"
    if [[ -z "$fourth" ]]; then
      target="$first"
      spawnd_sha="$second"
      worker_sha="$third"
      prebuilt_target_is_known "$target" || return 1
      is_lower_hex "$spawnd_sha" 64 || return 1
      is_lower_hex "$worker_sha" 64 || return 1
      release_targets+=("$target")
      release_lines+=("$(printf '"%s": {"spawnd_sha256": "%s", "spawn_worker_sha256": "%s"}' \
        "$target" "$spawnd_sha" "$worker_sha")")
    fi
  done
  [[ "${#release_targets[@]}" -gt 0 ]] || return 1
  for entry in "$@"; do
    IFS=: read -r first second third fourth <<< "$entry"
    [[ -n "$fourth" ]] || continue
    variant="$first"
    target="$second"
    spawnd_sha="$third"
    worker_sha="$fourth"
    prebuilt_variant_is_known "$variant" || return 1
    prebuilt_target_is_known "$target" || return 1
    is_lower_hex "$spawnd_sha" 64 || return 1
    is_lower_hex "$worker_sha" 64 || return 1
    local has_release=0 listed
    for listed in "${release_targets[@]}"; do
      [[ "$listed" == "$target" ]] && has_release=1
    done
    [[ "$has_release" == "1" ]] || return 1
    variant_names+=("$variant")
    variant_lines+=("$(printf '%s|"%s": {"spawnd_sha256": "%s", "spawn_worker_sha256": "%s"}' \
      "$variant" "$target" "$spawnd_sha" "$worker_sha")")
  done

  printf '{\n'
  printf '  "commit": "%s",\n' "$commit"
  printf '  "tree": "%s",\n' "$tree"
  printf '  "version": "%s",\n' "$version"
  printf '  "release_counter": %s,\n' "$release_counter"
  printf '  "signing_key_id": "%s",\n' "$signing_key_id"
  printf '  "targets": {\n'
  local line separator=""
  for line in "${release_lines[@]}"; do
    printf '%s    %s' "$separator" "$line"
    separator=$',\n'
  done
  printf '\n  },\n'
  printf '  "variants": {'
  if [[ "${#variant_names[@]}" -eq 0 ]]; then
    printf '}\n'
  else
    printf '\n'
    local variant_separator=""
    for variant in "${PREBUILT_VARIANTS[@]}"; do
      local present=0 name
      for name in "${variant_names[@]}"; do
        [[ "$name" == "$variant" ]] && present=1
      done
      [[ "$present" == "1" ]] || continue
      printf '%s    "%s": {\n' "$variant_separator" "$variant"
      printf '      "version": "%s",\n' "$(prebuilt_variant_version "$version" "$variant")"
      printf '      "targets": {\n'
      separator=""
      for line in "${variant_lines[@]}"; do
        [[ "${line%%|*}" == "$variant" ]] || continue
        printf '%s        %s' "$separator" "${line#*|}"
        separator=$',\n'
      done
      printf '\n      }\n'
      printf '    }'
      variant_separator=$',\n'
    done
    printf '\n  }\n'
  fi
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
    spawnd_asset="$(prebuilt_asset_name "$target" "$triple" spawnd)"
    worker_asset="$(prebuilt_asset_name "$target" "$triple" spawn-worker)"
    if [[ ! -f "$prebuilt_tmp/$spawnd_asset" || ! -f "$prebuilt_tmp/$worker_asset" ]]; then
      if prebuilt_target_is_required "$target"; then
        prebuilt_reason="prebuilt-latest lacks the required $target spawnd.exe/spawn-worker.exe pair"
        return
      fi
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

  # The variant pairs, gathered the same way. A variant is only ever cut
  # beside its release pair, so one without it means a release assembled by
  # hand from mismatched runs, and that is refused rather than published.
  local variant listed has_release
  for variant in "${PREBUILT_VARIANTS[@]}"; do
    for pair in "${PREBUILT_TARGETS[@]}"; do
      target="${pair%%:*}"
      triple="${pair##*:}"
      spawnd_asset="$(prebuilt_variant_asset_name "$target" "$triple" spawnd "$variant")"
      worker_asset="$(prebuilt_variant_asset_name "$target" "$triple" spawn-worker "$variant")"
      if [[ ! -f "$prebuilt_tmp/$spawnd_asset" || ! -f "$prebuilt_tmp/$worker_asset" ]]; then
        if prebuilt_variant_target_is_required "$variant" "$target"; then
          prebuilt_reason="prebuilt-latest lacks the required $variant variant pair for $target"
          return
        fi
        continue
      fi
      has_release=0
      for listed in "${prebuilt_entries[@]}"; do
        [[ "${listed%%:*}" == "$target" ]] && has_release=1
      done
      if [[ "$has_release" != "1" ]]; then
        prebuilt_reason="prebuilt-latest has a $variant variant pair for $target but no release pair"
        return
      fi
      spawnd_sha="$(checksum_for_asset "$prebuilt_tmp" "$spawnd_asset")"
      worker_sha="$(checksum_for_asset "$prebuilt_tmp" "$worker_asset")"
      if ! is_lower_hex "$spawnd_sha" 64 || ! is_lower_hex "$worker_sha" 64; then
        prebuilt_reason="SHA256SUMS lacks a valid checksum for the $variant variant of $target"
        return
      fi
      prebuilt_variant_entries+=("$variant:$target:$spawnd_sha:$worker_sha")
    done
  done

  prebuilt_ready=1
  prebuilt_reason="verified"
}

release_contract_self_test() (
  local commit="1111111111111111111111111111111111111111"
  local tree="2222222222222222222222222222222222222222"
  local spawnd_sha="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  local worker_sha="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  local tmp key wrong_key public_key wrong_public key_id manifest_file signature_file
  local flipped_file manifest release
  tmp="$(mktemp -d)" || return 1
  trap 'rm -rf -- "$tmp"' EXIT
  key="$tmp/release-signing.key"
  wrong_key="$tmp/wrong-release-signing.key"
  python3 - "$key" "$wrong_key" <<'PY' || return 1
import base64
import os
import sys
from pathlib import Path

for name in sys.argv[1:]:
    Path(name).write_text(
        base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=") + "\n",
        encoding="ascii",
    )
    Path(name).chmod(0o600)
PY
  public_key="$(release_signing_public_key "$key")" || return 1
  wrong_public="$(release_signing_public_key "$wrong_key")" || return 1
  key_id="$(release_signing_key_id "$public_key")" || return 1
  manifest_file="$tmp/manifest.json"
  signature_file="$tmp/manifest.json.sig"
  render_prebuilt_manifest \
    "$commit" "$tree" "0.1.0+g111111111111" 1700000000 "$key_id" \
    "darwin-aarch64:$spawnd_sha:$worker_sha" \
    "windows-x86_64:$spawnd_sha:$worker_sha" > "$manifest_file" || return 1
  manifest="$(<"$manifest_file")"
  [[ "$(manifest_tree_from_json "$manifest")" == "$tree" ]] || return 1
  grep -q '"release_counter": 1700000000' <<< "$manifest" || return 1
  grep -q "\"signing_key_id\": \"$key_id\"" <<< "$manifest" || return 1
  grep -q '"spawn_worker_sha256": "bbbbbbbb' <<< "$manifest" || return 1
  grep -q '"windows-x86_64"' <<< "$manifest" || return 1
  # `variants` is always present, and empty when nothing was built.
  python3 - "$manifest_file" <<'PY' || return 1
import json
import sys

manifest = json.load(open(sys.argv[1], encoding="utf-8"))
assert manifest["variants"] == {}, manifest["variants"]
assert set(manifest["targets"]) == {"darwin-aarch64", "windows-x86_64"}
PY

  # The variant entries: the version the diagnostics binary reports, its own
  # hashes under its own targets, and the release pair untouched beside it.
  local diag_spawnd="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  local diag_worker="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  local variant_manifest_file="$tmp/manifest-variants.json"
  render_prebuilt_manifest \
    "$commit" "$tree" "0.1.0+g111111111111" 1700000000 "$key_id" \
    "linux-x86_64:$spawnd_sha:$worker_sha" \
    "darwin-aarch64:$spawnd_sha:$worker_sha" \
    "diagnostics:linux-x86_64:$diag_spawnd:$diag_worker" > "$variant_manifest_file" || return 1
  python3 - "$variant_manifest_file" "$spawnd_sha" "$worker_sha" "$diag_spawnd" "$diag_worker" \
    <<'PY' || return 1
import json
import sys

path, spawnd_sha, worker_sha, diag_spawnd, diag_worker = sys.argv[1:]
manifest = json.load(open(path, encoding="utf-8"))
assert list(manifest) == [
    "commit", "tree", "version", "release_counter", "signing_key_id", "targets", "variants"
], list(manifest)
assert manifest["targets"] == {
    "linux-x86_64": {"spawnd_sha256": spawnd_sha, "spawn_worker_sha256": worker_sha},
    "darwin-aarch64": {"spawnd_sha256": spawnd_sha, "spawn_worker_sha256": worker_sha},
}, manifest["targets"]
assert manifest["variants"] == {
    "diagnostics": {
        "version": "0.1.0+g111111111111.diagnostics",
        "targets": {
            "linux-x86_64": {"spawnd_sha256": diag_spawnd, "spawn_worker_sha256": diag_worker}
        },
    }
}, manifest["variants"]
PY
  # A variant needs its release pair, a known name, and valid hashes; a
  # refusal prints nothing rather than half a manifest.
  local refused
  for refused in \
    "diagnostics:darwin-x86_64:$diag_spawnd:$diag_worker" \
    "debug:linux-x86_64:$diag_spawnd:$diag_worker" \
    "diagnostics:linux-x86_64:short:$diag_worker" \
    "diagnostics:linux-x86_64:$diag_spawnd:$diag_worker:extra"; do
    if render_prebuilt_manifest \
      "$commit" "$tree" "0.1.0+g111111111111" 1700000000 "$key_id" \
      "linux-x86_64:$spawnd_sha:$worker_sha" "$refused" > "$tmp/refused.json" 2>/dev/null; then
      return 1
    fi
    [[ ! -s "$tmp/refused.json" ]] || return 1
  done
  # Variants alone are not a release.
  ! render_prebuilt_manifest \
    "$commit" "$tree" "0.1.0+g111111111111" 1700000000 "$key_id" \
    "diagnostics:linux-x86_64:$diag_spawnd:$diag_worker" > /dev/null 2>&1 || return 1

  [[ "$(prebuilt_asset_name windows-x86_64 x86_64-pc-windows-msvc spawnd)" == \
    "spawnd-x86_64-pc-windows-msvc.exe" ]] || return 1
  [[ "$(prebuilt_asset_name linux-x86_64 x86_64-unknown-linux-gnu spawn-worker)" == \
    "spawn-worker-x86_64-unknown-linux-gnu" ]] || return 1
  [[ "$(prebuilt_variant_asset_name linux-x86_64 x86_64-unknown-linux-gnu spawnd diagnostics)" == \
    "spawnd-x86_64-unknown-linux-gnu.diagnostics" ]] || return 1
  [[ "$(prebuilt_variant_asset_name windows-x86_64 x86_64-pc-windows-msvc spawn-worker diagnostics)" == \
    "spawn-worker-x86_64-pc-windows-msvc.diagnostics.exe" ]] || return 1
  [[ "$(prebuilt_variant_version 0.1.0+g111111111111 diagnostics)" == \
    "0.1.0+g111111111111.diagnostics" ]] || return 1
  prebuilt_variant_is_known diagnostics || return 1
  ! prebuilt_variant_is_known release || return 1
  # The variant names live in three places — this list, the server's
  # SUPPORTED_DAEMON_VARIANTS, and the daemon's ReleaseVariant::from_name —
  # and a name the server does not know voids every manifest that carries
  # it, so a release with a new variant is refused here before it can be
  # published ahead of the server that would have to serve it.
  python3 - "$(dirname "${BASH_SOURCE[0]}")/.." "${PREBUILT_VARIANTS[@]}" <<'PY' || return 1
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
lib = set(sys.argv[2:])
server_source = (root / "server" / "spawn_server" / "release.py").read_text(encoding="utf-8")
server_match = re.search(r"SUPPORTED_DAEMON_VARIANTS = \((.*?)\)", server_source, re.S)
server = set(re.findall(r'"([a-z0-9-]+)"', server_match.group(1))) if server_match else set()
daemon_source = (root / "daemon" / "src" / "update.rs").read_text(encoding="utf-8")
daemon = set(re.findall(r'"([a-z0-9-]+)" => Some\(Self::', daemon_source)) - {"release"}
if not (lib == server == daemon):
    print(f"variant lists disagree: lib={sorted(lib)} server={sorted(server)} daemon={sorted(daemon)}", file=sys.stderr)
    raise SystemExit(1)
PY
  ! prebuilt_variant_is_known debug || return 1
  prebuilt_variant_target_is_required diagnostics linux-x86_64 || return 1
  ! prebuilt_variant_target_is_required diagnostics darwin-aarch64 || return 1
  ! prebuilt_variant_target_is_required debug linux-x86_64 || return 1
  [[ "$(prebuilt_installed_name windows-x86_64 spawn-worker)" == \
    "spawn-worker.exe" ]] || return 1
  [[ "$(prebuilt_file_mode windows-x86_64)" == "0644" ]] || return 1
  [[ "$(prebuilt_file_mode darwin-aarch64)" == "0755" ]] || return 1
  # Nothing is required while Windows is pre-launch; the day it launches this
  # becomes `prebuilt_target_is_required windows-x86_64 || return 1` again.
  ! prebuilt_target_is_required windows-x86_64 || return 1
  ! prebuilt_target_is_required linux-aarch64 || return 1

  sign_prebuilt_manifest "$manifest_file" "$signature_file" "$key" || return 1
  verify_prebuilt_manifest_signature \
    "$manifest_file" "$signature_file" "$public_key" || return 1
  # The signature covers the variant hashes like everything else: sign the
  # manifest that carries them, then alter one variant hash byte.
  sign_prebuilt_manifest "$variant_manifest_file" "$tmp/variants.sig" "$key" || return 1
  verify_prebuilt_manifest_signature \
    "$variant_manifest_file" "$tmp/variants.sig" "$public_key" || return 1
  sed 's/cccccccccccccccc/ccccccccccccccce/' "$variant_manifest_file" > "$tmp/variants-flipped.json"
  ! cmp -s "$variant_manifest_file" "$tmp/variants-flipped.json" || return 1
  ! verify_prebuilt_manifest_signature \
    "$tmp/variants-flipped.json" "$tmp/variants.sig" "$public_key" || return 1
  flipped_file="$tmp/manifest-flipped.json"
  python3 - "$manifest_file" "$flipped_file" <<'PY' || return 1
import sys
from pathlib import Path

data = bytearray(Path(sys.argv[1]).read_bytes())
data[10] ^= 1
Path(sys.argv[2]).write_bytes(data)
PY
  ! verify_prebuilt_manifest_signature \
    "$flipped_file" "$signature_file" "$public_key" || return 1
  ! verify_prebuilt_manifest_signature \
    "$manifest_file" "$signature_file" "$wrong_public" || return 1
  release_signing_key_readable "$key" || return 1
  ! release_signing_key_readable "$tmp/missing.key" || return 1

  tree_changed_but_cannot_publish "$commit" "$tree" 0 0 || return 1
  ! tree_changed_but_cannot_publish "$tree" "$tree" 0 0 || return 1
  ! tree_changed_but_cannot_publish "$commit" "$tree" 1 0 || return 1
  ! tree_changed_but_cannot_publish "$commit" "$tree" 0 1 || return 1

  release="{\"server\":{\"commit\":\"$commit\"},\"daemon\":{\"tree\":\"$tree\"}}"
  release_matches_expected "$release" "$commit" "$tree" || return 1
  ! release_matches_expected "$release" "$tree" "$tree" 2>/dev/null || return 1
  ! release_matches_expected "$release" "$commit" "$commit" 2>/dev/null || return 1

  # The expected counter follows the daemon release, not the ref: three
  # commits, the second touching nothing under daemon/, the third changing it.
  local repo="$tmp/repo" built_at moved_on changed_daemon
  git init -q "$repo" || return 1
  git -C "$repo" config commit.gpgsign false
  git -C "$repo" config core.hooksPath /dev/null
  git -C "$repo" config user.name t
  git -C "$repo" config user.email t@t
  mkdir -p "$repo/daemon" && printf 'a\n' > "$repo/daemon/a" && printf 'r\n' > "$repo/README"
  git -C "$repo" add -A >/dev/null &&
    GIT_COMMITTER_DATE='2026-01-01T00:00:00Z' git -C "$repo" commit -q -m one || return 1
  built_at="$(git -C "$repo" rev-parse HEAD)"
  printf 'r2\n' > "$repo/README"
  GIT_COMMITTER_DATE='2026-01-02T00:00:00Z' git -C "$repo" commit -q -am two || return 1
  moved_on="$(git -C "$repo" rev-parse HEAD)"
  printf 'b\n' > "$repo/daemon/a"
  GIT_COMMITTER_DATE='2026-01-03T00:00:00Z' git -C "$repo" commit -q -am three || return 1
  changed_daemon="$(git -C "$repo" rev-parse HEAD)"
  (
    cd "$repo" || exit 1
    # A deploy of the second commit keeps the daemon built at the first.
    [[ "$(release_counter_expected_for_deploy "$moved_on" "$(git rev-parse "$moved_on:daemon")" "$built_at")" == \
      "$(git show -s --format=%ct "$built_at")" ]] || exit 1
    # A deploy of the third, with a manifest still naming the first, is stale: expect the ref's.
    [[ "$(release_counter_expected_for_deploy "$changed_daemon" "$(git rev-parse "$changed_daemon:daemon")" "$built_at")" == \
      "$(git show -s --format=%ct "$changed_daemon")" ]] || exit 1
    # No manifest commit at all, or one that is not a commit id, falls back to the ref.
    [[ "$(release_counter_expected_for_deploy "$moved_on" "$(git rev-parse "$moved_on:daemon")" "")" == \
      "$(git show -s --format=%ct "$moved_on")" ]] || exit 1
    [[ "$(release_counter_expected_for_deploy "$moved_on" "$(git rev-parse "$moved_on:daemon")" "HEAD")" == \
      "$(git show -s --format=%ct "$moved_on")" ]] || exit 1
  ) || return 1
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" != "--self-test" || "$#" -ne 1 ]]; then
    printf 'usage: scripts/release-lib.sh --self-test\n' >&2
    exit 2
  fi
  command -v python3 >/dev/null 2>&1 || {
    printf 'release-lib: python3 is required\n' >&2
    exit 1
  }
  command -v uv >/dev/null 2>&1 || {
    printf 'release-lib: uv is required\n' >&2
    exit 1
  }
  release_contract_self_test || {
    printf 'release-lib: self-test failed\n' >&2
    exit 1
  }
  printf 'release-lib: self-test ok\n'
fi
