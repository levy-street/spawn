#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/verify-release.sh [--ref GIT_REF] [--skip-mobile] <server-url>

Read-only proof that a deployed SPAWN D release matches a git ref.

Checks:
  - /api/release server.commit matches the ref's commit
  - /api/release daemon.tree matches the ref's daemon/ tree
  - every advertised daemon binary hashes to its advertised sha256
  - the production Expo manifest carries the ref's mobile/ tree

Options:
  --ref GIT_REF  Expected git ref. Default: origin/master.
  --skip-mobile  Skip the u.expo.dev manifest probe.
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
      expected_hash="$(json_get "$release_file" "daemon.targets.$target.$hash_field" 2>/dev/null || true)"
      binary_file="$tmp_dir/$target-$kind"
      if [[ -z "$expected_hash" ]]; then
        print_row "daemon.$target.$kind" "advertised sha256" "<null>" "FAIL"
        fail=1
      elif curl -fsS --max-time 60 "$server/api/install/$kind/$target" -o "$binary_file"; then
        actual_hash="$(sha256_file "$binary_file")"
        check_row "daemon.$target.$kind" "$expected_hash" "$actual_hash"
      else
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
