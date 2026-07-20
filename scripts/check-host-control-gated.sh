#!/usr/bin/env bash
# Every live HostControlClient must be constructed with a signed-RTC trust
# resolver, so the gate's invariant holds without exception: a pinned host is
# never reached over a raw path. An ungated construction silently opts that
# channel out of pin verification (this is how the file-transfer destination
# channel was missed), so fail closed on any new one.
#
# Deliberately a literal-source check over non-test files only.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/web/src"

status=0
while IFS= read -r line; do
  file="${line%%:*}"
  rest="${line#*:}"
  lineno="${rest%%:*}"
  # The resolver may be on the same line or in the options object just below.
  if ! sed -n "${lineno},$((lineno + 12))p" "$file" | grep -q 'resolveSignedRtcTrust'; then
    printf 'ungated HostControlClient construction: %s:%s\n' "$file" "$lineno" >&2
    status=1
  fi
done < <(grep -rn 'new HostControlClient(' . --include='*.ts' --include='*.tsx' \
  | grep -v '\.test\.' || true)

if [[ $status -ne 0 ]]; then
  printf 'each construction must pass resolveSignedRtcTrust (see signed-rtc-trust.ts)\n' >&2
  exit 1
fi
printf 'host-control gate: all live HostControlClient constructions are gated\n'
