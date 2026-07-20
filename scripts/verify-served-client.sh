#!/usr/bin/env bash
# Verify that a server is serving the client built from this source tree.
#
# Rebuilds the web client locally and compares every served static asset against
# what the target server actually returns. A mismatch means the deployed client
# is not the code in this checkout.
#
# WHAT THIS PROVES, AND WHAT IT DOES NOT
#
# It detects broad tampering. It cannot prevent targeted tampering: a hostile
# server can serve a clean bundle to this script and a backdoored one to a
# single session, keyed on cookie, IP, or user-agent. The value is that hiding
# an attack then requires targeting, which makes mass compromise impossible to
# conceal. It does not make the tab trustworthy. See docs/TRUST.md "client
# verifiability" -- closing the rest needs an append-only transparency log.
#
# SCOPE: the served surface only -- .next/static/**, which is exactly what a
# browser can observe. The rest of .next is deliberately excluded: 20 files
# there stay nondeterministic (webpack manifest key ordering, which is upstream
# and not fixable from userland, plus draft-mode preview secrets that MUST stay
# random). None of them are served, so comparing them would produce permanent
# false positives.
#
# Both sides must use the same SPAWN_BUILD_ID (default "spawn").
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:-}"
if [[ -z "$target" ]]; then
  printf 'usage: %s https://host[:port] [--keep-build]\n' "$0" >&2
  exit 2
fi
target="${target%/}"
keep_build=""
[[ "${2:-}" == "--keep-build" ]] && keep_build=1

export SPAWN_BUILD_ID="${SPAWN_BUILD_ID:-spawn}"
proxy_target="${SPAWN_API_PROXY_TARGET:-http://127.0.0.1:18330}"

printf '== rebuilding the client (SPAWN_BUILD_ID=%s) ==\n' "$SPAWN_BUILD_ID"
build_dir="$(mktemp -d)"
cleanup() { [[ -n "$keep_build" ]] || rm -rf "$build_dir"; }
trap cleanup EXIT

(
  cd "$repo_root/web"
  SPAWN_API_PROXY_TARGET="$proxy_target" bun run build >"$build_dir/build.log" 2>&1 || {
    printf 'build failed; see %s\n' "$build_dir/build.log" >&2
    exit 1
  }
)

static_root="$repo_root/web/.next/static"
if [[ ! -d "$static_root" ]]; then
  printf 'no build output at %s\n' "$static_root" >&2
  exit 1
fi

printf '== comparing served assets against %s ==\n' "$target"
checked=0
missing=0
mismatched=0

while IFS= read -r local_file; do
  rel="${local_file#"$static_root"/}"
  url="$target/_next/static/$rel"

  served="$build_dir/served.bin"
  code="$(curl -sS -o "$served" -w '%{http_code}' --max-time 30 "$url" || echo 000)"
  if [[ "$code" != "200" ]]; then
    printf 'MISSING  %s (HTTP %s)\n' "$rel" "$code"
    missing=$((missing + 1))
    continue
  fi

  local_hash="$(sha256sum "$local_file" | cut -d' ' -f1)"
  served_hash="$(sha256sum "$served" | cut -d' ' -f1)"
  if [[ "$local_hash" != "$served_hash" ]]; then
    printf 'MISMATCH %s\n         local  %s\n         served %s\n' "$rel" "$local_hash" "$served_hash"
    mismatched=$((mismatched + 1))
  fi
  checked=$((checked + 1))
done < <(find "$static_root" -type f | sort)

printf '\n== result ==\n'
printf 'checked:    %s\n' "$checked"
printf 'mismatched: %s\n' "$mismatched"
printf 'missing:    %s\n' "$missing"

if [[ "$mismatched" -ne 0 || "$missing" -ne 0 ]]; then
  printf '\nthe served client does NOT match this source tree\n' >&2
  exit 1
fi
if [[ "$checked" -eq 0 ]]; then
  printf '\nnothing was compared; refusing to report success\n' >&2
  exit 1
fi
printf '\nevery served asset matches a local build of this source tree\n'
