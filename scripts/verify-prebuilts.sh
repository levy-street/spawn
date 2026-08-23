#!/usr/bin/env bash
set -euo pipefail

# Verify that the daemon binaries a spawn server hands out are byte-identical to
# the ones GitHub CI built and published to the rolling `prebuilt-latest`
# release. For every supported target this downloads what the server serves at
# /api/install/{spawnd,spawn-worker}/<target>, hashes it, and compares against
# CI's SHA256SUMS. No trust in the server required — the release SHA256SUMS is
# the reference, the served bytes are the subject.
#
# Usage: scripts/verify-prebuilts.sh [server-url]
#   server-url  Base URL of the spawn server. Default: https://spawnd.dev
# Env:
#   SPAWN_REPO  owner/name for the release. Default: levy-street/spawn

SERVER="${1:-https://spawnd.dev}"
SERVER="${SERVER%/}"
REPO="${SPAWN_REPO:-levy-street/spawn}"

die() {
  printf 'verify-prebuilts: %s\n' "$*" >&2
  exit 1
}

command -v gh >/dev/null 2>&1 || die "gh is required to fetch the reference SHA256SUMS"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"

# install.py's friendly target name -> release-asset triple.
TARGETS=(
  "darwin-aarch64:aarch64-apple-darwin"
  "darwin-x86_64:x86_64-apple-darwin"
  "linux-x86_64:x86_64-unknown-linux-gnu"
  "linux-aarch64:aarch64-unknown-linux-gnu"
)

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf 'verify-prebuilts: fetching reference SHA256SUMS from %s (%s)\n' "$REPO" prebuilt-latest
gh release download prebuilt-latest --repo "$REPO" --pattern SHA256SUMS --dir "$tmp" --clobber \
  >/dev/null 2>&1 || die "could not download prebuilt-latest SHA256SUMS from $REPO"

# Look up the reference hash for a release-asset filename from SHA256SUMS.
ref_hash() {
  awk -v f="$1" '$2 == f || $2 == "*"f { print $1; exit }' "$tmp/SHA256SUMS"
}

printf '\n%-22s %-14s %s\n' TARGET BINARY RESULT
printf -- '---------------------------------------------------------------\n'

fail=0
checked=0
for pair in "${TARGETS[@]}"; do
  target="${pair%%:*}"
  triple="${pair##*:}"
  for kind in spawnd spawn-worker; do
    asset="$kind-$triple"
    want="$(ref_hash "$asset" || true)"
    if [[ -z "$want" ]]; then
      printf '%-22s %-14s %s\n' "$target" "$kind" "SKIP (not in release)"
      continue
    fi
    url="$SERVER/api/install/$kind/$target"
    out="$tmp/$asset.served"
    if ! curl -fsSL "$url" -o "$out"; then
      printf '%-22s %-14s %s\n' "$target" "$kind" "FAIL (server 404/again: $url)"
      fail=1
      continue
    fi
    got="$(sha256sum "$out" | awk '{print $1}')"
    checked=$((checked + 1))
    if [[ "$got" == "$want" ]]; then
      printf '%-22s %-14s %s\n' "$target" "$kind" "OK   ${got:0:12}…"
    else
      printf '%-22s %-14s %s\n' "$target" "$kind" "MISMATCH"
      printf '    want %s\n    got  %s\n' "$want" "$got"
      fail=1
    fi
  done
done

printf -- '---------------------------------------------------------------\n'
if [[ "$fail" != 0 ]]; then
  die "one or more served binaries do not match CI — see above"
fi
[[ "$checked" -gt 0 ]] || die "nothing verified (no matching assets served)"
printf 'verify-prebuilts: all %d served binaries match CI (%s)\n' "$checked" "$SERVER"
