#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/verify-release.sh [--ref GIT_REF] [--skip-mobile] [--skip-desktop] <server-url>

Read-only proof that a deployed SPAWN D release matches a git ref.

Checks:
  - /api/release server.commit matches the ref's commit
  - /api/release daemon.tree matches the ref's daemon/ tree
  - /api/install/manifest.json has a valid daemon-pinned signature
  - the signed manifest counter matches the committer timestamp of the commit
    the daemon release was built at (the ref's, unless the ref left daemon/
    untouched and the manifest names the earlier commit it kept)
  - every advertised daemon binary hashes to its advertised sha256
  - the production Expo manifest carries the ref's mobile/ tree
  - /desktop/latest.json, every artifact signature, and /api/release.desktop match

Options:
  --ref GIT_REF  Expected git ref. Default: origin/master.
  --skip-mobile  Skip the u.expo.dev manifest probe.
  --skip-desktop Skip the desktop static-manifest and identity probes.
  -h, --help     Show this help.

This command does not fetch git refs, rebuild artifacts, or change production.
EOF
}

die() {
  printf 'verify-release: %s\n' "$*" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=release-lib.sh
source "$script_dir/release-lib.sh"

supported_target() {
  local candidate="$1"
  local pair
  for pair in "${PREBUILT_TARGETS[@]}"; do
    [[ "${pair%%:*}" == "$candidate" ]] && return 0
  done
  return 1
}

git_ref="origin/master"
skip_mobile=0
skip_desktop=0
server=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --ref)
      [[ $# -ge 2 ]] || die "--ref needs a git ref"
      git_ref="$2"
      shift 2
      ;;
    --ref=*)
      git_ref="${1#*=}"
      shift
      ;;
    --skip-mobile)
      skip_mobile=1
      shift
      ;;
    --skip-desktop)
      skip_desktop=1
      shift
      ;;
    --)
      shift
      ;;
    -*)
      die "unknown option $1 (try --help)"
      ;;
    *)
      [[ -z "$server" ]] || die "unexpected extra argument $1"
      server="$1"
      shift
      ;;
  esac
done

[[ -n "$server" ]] || die "missing server URL"
case "$server" in
  http://*|https://*) ;;
  *) die "server URL must start with http:// or https://" ;;
esac
server="${server%/}"

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v git >/dev/null 2>&1 || die "git is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
command -v uv >/dev/null 2>&1 || die "uv is required"
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  die "sha256sum or shasum is required"
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run from inside the spawn repo"
cd "$repo_root"
expected_commit="$(git rev-parse "$git_ref^{commit}" 2>/dev/null)" ||
  die "cannot resolve git ref $git_ref"
expected_daemon_tree="$(git rev-parse "$git_ref:daemon" 2>/dev/null)" ||
  die "cannot resolve daemon/ at $git_ref"
expected_mobile_tree="$(git rev-parse "$git_ref:mobile" 2>/dev/null)" ||
  die "cannot resolve mobile/ at $git_ref"
if [[ "$skip_desktop" != "1" ]]; then
  expected_desktop_tree="$(git rev-parse "$git_ref:desktop" 2>/dev/null)" ||
    die "cannot resolve desktop/ at $git_ref (use --skip-desktop for a pre-desktop release)"
  expected_desktop_version="$(git show "$git_ref:desktop/src-tauri/tauri.conf.json" 2>/dev/null |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])')" ||
    die "cannot read the desktop version at $git_ref"
fi

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

json_get() {
  local file="$1"
  local path="$2"
  python3 -c '
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for part in sys.argv[2].split("."):
    if not isinstance(value, dict) or part not in value:
        raise SystemExit(1)
    value = value[part]
if value is None:
    raise SystemExit(1)
if isinstance(value, bool):
    print(str(value).lower())
elif isinstance(value, (str, int, float)):
    print(value)
else:
    raise SystemExit(1)
' "$file" "$path"
}

json_keys() {
  local file="$1"
  local path="$2"
  python3 -c '
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for part in sys.argv[2].split("."):
    if not isinstance(value, dict):
        raise SystemExit(0)
    value = value.get(part)
if isinstance(value, dict):
    for key in sorted(value):
        print(key)
' "$file" "$path"
}

json_string_list() {
  local file="$1"
  local path="$2"
  python3 -c '
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for part in sys.argv[2].split("."):
    if not isinstance(value, dict) or part not in value:
        raise SystemExit(1)
    value = value[part]
if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
    raise SystemExit(1)
print(",".join(sorted(value)))
' "$file" "$path"
}

json_key_list() {
  local file="$1"
  local path="$2"
  python3 -c '
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    value = json.load(handle)
for part in sys.argv[2].split("."):
    if not isinstance(value, dict) or part not in value:
        raise SystemExit(1)
    value = value[part]
if not isinstance(value, dict):
    raise SystemExit(1)
print(",".join(sorted(value)))
' "$file" "$path"
}

multipart_json_get() {
  local file="$1"
  local path="$2"
  python3 -c '
import json
import sys

raw = open(sys.argv[1], encoding="utf-8").read()
start = raw.find("{")
if start < 0:
    raise SystemExit(1)
value, _ = json.JSONDecoder().raw_decode(raw[start:])
for part in sys.argv[2].split("."):
    if not isinstance(value, dict) or part not in value:
        raise SystemExit(1)
    value = value[part]
if not isinstance(value, str):
    raise SystemExit(1)
print(value)
' "$file" "$path"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

verify_tauri_minisign() {
  local artifact="$1"
  local encoded_signature="$2"
  local encoded_public_key_file="$3"
  UV_CACHE_DIR="${UV_CACHE_DIR:-${TMPDIR:-/tmp}/spawn-release-uv-cache}" \
    uv run --project "$repo_root/server" --frozen python - \
      "$artifact" "$encoded_signature" "$encoded_public_key_file" <<'PY'
import base64
import hashlib
import sys
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey


def decode64(value: str) -> bytes:
    raw = base64.b64decode(value, validate=True)
    if base64.b64encode(raw).decode("ascii") != value:
        raise ValueError("non-canonical base64")
    return raw


try:
    artifact = Path(sys.argv[1]).read_bytes()
    signature_text = decode64(sys.argv[2]).decode("ascii")
    signature_lines = signature_text.splitlines()
    if len(signature_lines) != 4 or not signature_lines[0].startswith("untrusted comment: "):
        raise ValueError("invalid minisign signature box")
    if not signature_lines[2].startswith("trusted comment: "):
        raise ValueError("invalid trusted comment")
    signature_blob = decode64(signature_lines[1])
    global_signature = decode64(signature_lines[3])
    if len(signature_blob) != 74 or len(global_signature) != 64:
        raise ValueError("invalid minisign signature lengths")
    if signature_blob[:2] != b"ED":
        raise ValueError("desktop updater signatures must be prehashed")

    public_outer = Path(sys.argv[3]).read_text(encoding="ascii").strip()
    public_text = decode64(public_outer).decode("ascii")
    public_lines = public_text.splitlines()
    if len(public_lines) != 2 or not public_lines[0].startswith("untrusted comment: "):
        raise ValueError("invalid minisign public key")
    public_blob = decode64(public_lines[1])
    if len(public_blob) != 42 or public_blob[:2] != b"Ed":
        raise ValueError("invalid minisign public key body")
    if signature_blob[2:10] != public_blob[2:10]:
        raise ValueError("minisign key id mismatch")

    verifier = Ed25519PublicKey.from_public_bytes(public_blob[10:])
    verifier.verify(signature_blob[10:], hashlib.blake2b(artifact, digest_size=64).digest())
    # minisign's global signature covers the raw signature plus the trusted
    # comment text, without its "trusted comment: " label.
    trusted_comment = signature_lines[2][len("trusted comment: "):]
    verifier.verify(
        global_signature,
        signature_blob[10:] + trusted_comment.encode("ascii"),
    )
except (InvalidSignature, OSError, UnicodeError, ValueError):
    raise SystemExit(1)
PY
}

fail=0
print_row() {
  local piece="$1"
  local expected="$2"
  local actual="$3"
  local result="$4"
  printf '%-34s | %-66s | %-66s | %s\n' "$piece" "$expected" "$actual" "$result"
}

check_row() {
  local piece="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    print_row "$piece" "$expected" "$actual" "OK"
  else
    print_row "$piece" "$expected" "${actual:-<null>}" "FAIL"
    fail=1
  fi
}

printf '%-34s | %-66s | %-66s | %s\n' "PIECE" "EXPECTED" "ACTUAL" "RESULT"
printf '%s\n' \
  '-----------------------------------+--------------------------------------------------------------------+--------------------------------------------------------------------+-------'

release_file="$tmp_dir/release.json"
release_available=1
if ! curl -fsS --max-time 20 "$server/api/release" -o "$release_file"; then
  release_available=0
fi

if [[ "$release_available" == "1" ]]; then
  actual_commit="$(json_get "$release_file" server.commit 2>/dev/null || true)"
  actual_daemon_tree="$(json_get "$release_file" daemon.tree 2>/dev/null || true)"
else
  actual_commit="<fetch failed>"
  actual_daemon_tree="<fetch failed>"
fi
check_row "server.commit" "$expected_commit" "$actual_commit"
check_row "daemon.tree" "$expected_daemon_tree" "$actual_daemon_tree"

manifest_file="$tmp_dir/manifest.json"
signature_file="$tmp_dir/manifest.json.sig"
manifest_available=1
if ! curl -fsS --max-time 20 "$server/api/install/manifest.json" \
    -o "$manifest_file"; then
  manifest_available=0
fi
signature_available=1
if ! curl -fsS --max-time 20 "$server/api/install/manifest.json.sig" \
    -o "$signature_file"; then
  signature_available=0
fi

release_key_source_file="$tmp_dir/release_key.rs"
release_public_keys=()
release_key_source="daemon/src/release_key.rs at $git_ref"
if git show "$git_ref:daemon/src/release_key.rs" > "$release_key_source_file" 2>/dev/null; then
  while IFS= read -r public_key; do
    [[ -n "$public_key" ]] && release_public_keys+=("$public_key")
  done < <(release_public_keys_from_rust_file "$release_key_source_file" 2>/dev/null || true)
else
  release_key_source="SPAWN_RELEASE_PUBLIC_KEY fallback (release_key.rs absent at $git_ref)"
  if [[ -n "${SPAWN_RELEASE_PUBLIC_KEY:-}" ]]; then
    IFS=, read -r -a release_public_keys <<< "$SPAWN_RELEASE_PUBLIC_KEY"
  fi
fi

manifest_key_id=""
manifest_daemon_tree=""
manifest_commit=""
actual_release_counter=""
if [[ "$manifest_available" == "1" ]]; then
  manifest_key_id="$(json_get "$manifest_file" signing_key_id 2>/dev/null || true)"
  manifest_daemon_tree="$(json_get "$manifest_file" tree 2>/dev/null || true)"
  manifest_commit="$(json_get "$manifest_file" commit 2>/dev/null || true)"
  actual_release_counter="$(json_get "$manifest_file" release_counter 2>/dev/null || true)"
fi
# A daemon release is its tree: a ref that left daemon/ alone keeps the
# release built at an earlier commit, whose counter is that commit's.
expected_release_counter="$(release_counter_expected_for_deploy \
  "$expected_commit" "$expected_daemon_tree" "$manifest_commit")" ||
  die "cannot derive the release counter for $expected_commit"

signature_ok=0
verified_key_id=""
if [[ "$manifest_available" == "1" && "$signature_available" == "1" ]]; then
  for public_key in "${release_public_keys[@]}"; do
    if verify_prebuilt_manifest_signature \
      "$manifest_file" "$signature_file" "$public_key" 2>/dev/null; then
      candidate_key_id="$(release_signing_key_id "$public_key" 2>/dev/null || true)"
      if [[ -n "$candidate_key_id" && "$candidate_key_id" == "$manifest_key_id" ]]; then
        signature_ok=1
        verified_key_id="$candidate_key_id"
        break
      fi
    fi
  done
fi

if [[ "$signature_ok" == "1" ]]; then
  print_row "daemon manifest signature" "$release_key_source" \
    "valid (key $verified_key_id)" "OK"
else
  if [[ "$manifest_available" != "1" ]]; then
    signature_actual="<manifest fetch failed>"
  elif [[ "$signature_available" != "1" ]]; then
    signature_actual="<signature fetch failed>"
  elif [[ "${#release_public_keys[@]}" -eq 0 ]]; then
    signature_actual="<no release public keys found>"
  elif [[ -z "$manifest_key_id" ]]; then
    signature_actual="<manifest signing_key_id missing>"
  else
    signature_actual="invalid or key id mismatch ($manifest_key_id)"
  fi
  print_row "daemon manifest signature" "$release_key_source" \
    "$signature_actual" "FAIL"
  fail=1
fi
check_row "daemon release counter" "$expected_release_counter" \
  "$actual_release_counter"
check_row "daemon signed manifest tree" "$expected_daemon_tree" \
  "$manifest_daemon_tree"

advertised_targets=0
if [[ "$release_available" == "1" ]]; then
  while IFS= read -r target; do
    [[ -n "$target" ]] || continue
    advertised_targets=$((advertised_targets + 1))
    if ! supported_target "$target"; then
      print_row "daemon.$target" "supported target" "unexpected target" "FAIL"
      fail=1
      continue
    fi

    for kind in spawnd spawn-worker; do
      if [[ "$kind" == "spawnd" ]]; then
        hash_field="spawnd_sha256"
      else
        hash_field="spawn_worker_sha256"
      fi
      expected_hash="$(json_get "$manifest_file" "targets.$target.$hash_field" 2>/dev/null || true)"
      advertised_hash="$(json_get "$release_file" "daemon.targets.$target.$hash_field" 2>/dev/null || true)"
      binary_file="$tmp_dir/$target-$kind"
      if [[ -z "$expected_hash" ]]; then
        print_row "daemon.$target.$kind" "signed manifest sha256" "<null>" "FAIL"
        fail=1
      elif [[ "$advertised_hash" != "$expected_hash" ]]; then
        print_row "daemon.$target.$kind metadata" "$expected_hash" \
          "${advertised_hash:-<null>}" "FAIL"
        fail=1
      fi
      if [[ -n "$expected_hash" ]] &&
        curl -fsS --max-time 60 "$server/api/install/$kind/$target" -o "$binary_file"; then
        actual_hash="$(sha256_file "$binary_file")"
        check_row "daemon.$target.$kind" "$expected_hash" "$actual_hash"
      elif [[ -n "$expected_hash" ]]; then
        print_row "daemon.$target.$kind" "$expected_hash" "<fetch failed>" "FAIL"
        fail=1
      fi
    done
  done < <(json_keys "$release_file" daemon.targets 2>/dev/null || true)
fi
if [[ "$advertised_targets" -eq 0 ]]; then
  print_row "daemon.targets" ">=1" "0" "FAIL"
  fail=1
fi

if [[ "$skip_desktop" == "1" ]]; then
  print_row "desktop.tree" "git desktop tree" "<skipped>" "SKIP"
  print_row "desktop.latest.version" "tauri.conf.json version" "<skipped>" "SKIP"
  print_row "desktop artifact signature" "committed updater key" "<skipped>" "SKIP"
else
  desktop_public_key_file="$tmp_dir/desktop-updater.pubkey"
  if ! git show "$git_ref:desktop/updater.pubkey" > "$desktop_public_key_file" 2>/dev/null; then
    print_row "desktop artifact signature" "desktop/updater.pubkey at $git_ref" \
      "<public key missing>" "FAIL"
    fail=1
  fi

  desktop_latest_file="$tmp_dir/desktop-latest.json"
  desktop_latest_available=1
  if ! curl -fsS --max-time 20 "$server/desktop/latest.json" \
      -o "$desktop_latest_file"; then
    desktop_latest_available=0
  fi

  if [[ "$release_available" == "1" ]]; then
    actual_desktop_tree="$(json_get "$release_file" desktop.tree 2>/dev/null || true)"
    actual_desktop_release_version="$(json_get "$release_file" desktop.version 2>/dev/null || true)"
    actual_desktop_release_platforms="$(json_string_list "$release_file" desktop.platforms 2>/dev/null || true)"
  else
    actual_desktop_tree="<fetch failed>"
    actual_desktop_release_version="<fetch failed>"
    actual_desktop_release_platforms="<fetch failed>"
  fi
  check_row "desktop.tree" "$expected_desktop_tree" "$actual_desktop_tree"
  check_row "desktop.release.version" "$expected_desktop_version" \
    "$actual_desktop_release_version"

  if [[ "$desktop_latest_available" == "1" ]]; then
    actual_desktop_latest_version="$(json_get "$desktop_latest_file" version 2>/dev/null || true)"
    actual_desktop_latest_platforms="$(json_key_list "$desktop_latest_file" platforms 2>/dev/null || true)"
  else
    actual_desktop_latest_version="<fetch failed>"
    actual_desktop_latest_platforms="<fetch failed>"
  fi
  check_row "desktop.latest.version" "$expected_desktop_version" \
    "$actual_desktop_latest_version"
  # A release proves the platforms it claims, not a fixed list. The Mac pair is
  # always claimed; Windows appears here the day it launches, and until then its
  # absence is the product state every download surface already renders. What is
  # still checked hard: the two manifests agree, and everything claimed verifies.
  required_desktop_platforms="darwin-aarch64,darwin-x86_64"
  for required_desktop_platform in ${required_desktop_platforms//,/ }; do
    case ",$actual_desktop_latest_platforms," in
      *",$required_desktop_platform,"*) ;;
      *)
        print_row "desktop.latest.platforms" "must include $required_desktop_platform" \
          "$actual_desktop_latest_platforms" "FAIL"
        fail=1
        ;;
    esac
  done
  check_row "desktop.release.platforms" "$actual_desktop_latest_platforms" \
    "$actual_desktop_release_platforms"
  if [[ "$actual_desktop_latest_platforms" != *"windows-x86_64"* ]]; then
    print_row "desktop.windows" "published, or not launched yet" \
      "not in this release" "SKIP"
  fi

  # This list now comes off the wire, so it is data rather than something this
  # script chose: a name it does not recognise is a bad release to report, not
  # an internal error to abort on, and a failed fetch iterates nothing.
  verifiable_desktop_platforms=""
  if [[ "$desktop_latest_available" == "1" ]]; then
    verifiable_desktop_platforms="${actual_desktop_latest_platforms//,/ }"
  fi
  for desktop_platform in $verifiable_desktop_platforms; do
    case "$desktop_platform" in
      darwin-aarch64 | darwin-x86_64) desktop_suffix=".app.tar.gz" ;;
      windows-x86_64) desktop_suffix="-setup.exe" ;;
      *)
        print_row "desktop.$desktop_platform" "a platform this release can serve" \
          "unknown platform in latest.json" "FAIL"
        fail=1
        continue
        ;;
    esac
    expected_desktop_name="SPAWN-D_${expected_desktop_version}_${desktop_platform}${desktop_suffix}"
    expected_desktop_url="$server/desktop/$expected_desktop_name"
    desktop_artifact_url=""
    desktop_artifact_signature=""
    if [[ "$desktop_latest_available" == "1" ]]; then
      desktop_artifact_url="$(json_get "$desktop_latest_file" \
        "platforms.$desktop_platform.url" 2>/dev/null || true)"
      desktop_artifact_signature="$(json_get "$desktop_latest_file" \
        "platforms.$desktop_platform.signature" 2>/dev/null || true)"
    fi

    check_row "desktop.$desktop_platform.url" "$expected_desktop_url" \
      "$desktop_artifact_url"
    desktop_artifact_file="$tmp_dir/desktop-$desktop_platform"
    if [[ "$desktop_artifact_url" == "$expected_desktop_url" ]] &&
      curl -fsS --max-time 120 "$desktop_artifact_url" -o "$desktop_artifact_file" &&
      [[ -n "$desktop_artifact_signature" ]] &&
      [[ -s "$desktop_public_key_file" ]] &&
      verify_tauri_minisign "$desktop_artifact_file" \
        "$desktop_artifact_signature" "$desktop_public_key_file" 2>/dev/null; then
      print_row "desktop.$desktop_platform signature" \
        "desktop/updater.pubkey at $git_ref" "valid" "OK"
    else
      print_row "desktop.$desktop_platform signature" \
        "desktop/updater.pubkey at $git_ref" \
        "invalid, missing, or artifact fetch failed" "FAIL"
      fail=1
    fi
  done
  if [[ "$actual_desktop_latest_platforms" == *"windows-x86_64"* ]]; then
    print_row "desktop.windows Authenticode" "Valid inner EXE and setup EXE" \
      "verify in Windows CI/manual QA" "MANUAL"
  fi
fi

if [[ "$skip_mobile" == "1" ]]; then
  print_row "mobile.tree" "$expected_mobile_tree" "<skipped>" "SKIP"
else
  read -r project_id runtime_version < <(python3 -c '
import json
import sys

app = json.load(open(sys.argv[1], encoding="utf-8"))
expo = app.get("expo", app)
project_id = ((expo.get("extra") or {}).get("eas") or {}).get("projectId", "")
runtime = expo.get("runtimeVersion")
if not isinstance(runtime, str):
    runtime = expo.get("version", "")
print(project_id, runtime)
' "$repo_root/mobile/app.json")
  if [[ -z "$project_id" || -z "$runtime_version" ]]; then
    print_row "mobile.tree" "$expected_mobile_tree" "<app config missing>" "FAIL"
    fail=1
  else
    expo_file="$tmp_dir/expo-manifest"
    if curl -fsS --max-time 20 "https://u.expo.dev/$project_id" \
      -H "expo-channel-name: production" \
      -H "expo-runtime-version: $runtime_version" \
      -H "expo-platform: ios" \
      -H "expo-protocol-version: 1" \
      -o "$expo_file"; then
      actual_mobile_tree="$(multipart_json_get \
        "$expo_file" extra.expoClient.extra.mobileTree 2>/dev/null || true)"
      check_row "mobile.tree" "$expected_mobile_tree" "$actual_mobile_tree"
    else
      print_row "mobile.tree" "$expected_mobile_tree" "<fetch failed>" "FAIL"
      fail=1
    fi
  fi
fi

printf '%s\n' \
  '-----------------------------------+--------------------------------------------------------------------+--------------------------------------------------------------------+-------'
if [[ "$fail" != "0" ]]; then
  die "one or more release identities do not match"
fi
printf 'verify-release: SPAWN D release matches %s (%s)\n' "$git_ref" "$server"
