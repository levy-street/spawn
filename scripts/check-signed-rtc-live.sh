#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail() {
  printf 'signed RTC live guard: %s\n' "$1" >&2
  exit 1
}

adapter=web/src/lib/signed-rtc-live.ts
agent=web/src/components/terminal/useAgentSocket.ts
host=web/src/lib/hostControl.ts

for source in "$adapter" "$agent" "$host"; do
  [[ -f "$source" ]] || fail "missing production source $source"
done

grep -Fq 'const verified = await verifyRtcSignalWire(' "$adapter" \
  || fail 'live adapter must await and retain verifier output'
grep -Fq 'sdp: verified.transcript.sdp' "$adapter" \
  || fail 'live adapter must apply only verified transcript SDP'
! grep -Fq 'sdp: frame.sdp' "$adapter" \
  || fail 'untrusted outer SDP reached the live adapter consumer'

for consumer in "$agent" "$host"; do
  grep -Fq '.verifyAndApplyAnswer(' "$consumer" \
    || fail "$consumer no longer applies answers through the signed live adapter"
  grep -Fq 'new SignedRtcLiveSession(' "$consumer" \
    || fail "$consumer no longer freezes signed mode at offer creation"
done

while IFS=: read -r path _; do
  case "$path" in
    "$adapter"|"$agent"|"$host") ;;
    *) fail "unexpected production setRemoteDescription caller: $path" ;;
  esac
done < <(rg -n --glob '!*.test.*' --glob '!tests/**' '\.setRemoteDescription\(' web/src || true)

printf '%s\n' 'signed RTC live guard passed'
