#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'signed RTC live guard: %s\n' "$1" >&2
  return 1
}

count_fixed() {
  local needle="$1"
  local path="$2"
  (grep -Fo -- "$needle" "$path" || true) | wc -l | tr -d ' '
}

require_count() {
  local root="$1"
  local path="$2"
  local needle="$3"
  local expected="$4"
  local actual
  actual="$(count_fixed "$needle" "$root/$path")"
  [[ "$actual" == "$expected" ]] \
    || fail "$path expected $expected occurrence(s) of [$needle], found $actual"
}

check_tree() {
  local root="$1"
  local adapter=web/src/lib/signed-rtc-live.ts
  local agent=web/src/components/terminal/useAgentSocket.ts
  local host=web/src/lib/hostControl.ts
  local source

  for source in "$adapter" "$agent" "$host"; do
    [[ -f "$root/$source" ]] || { fail "missing production source $source"; return 1; }
  done

  # Inventory the whole RemoteDescription capability family, not merely direct
  # dot calls. This catches aliases, bind/copy, destructuring, bracket access,
  # and the ordinary split-string computed form while remaining grep-level.
  local actual_files expected_files
  actual_files="$(
    cd "$root"
    rg -l --glob '!*.test.*' --glob '!tests/**' 'setRemote|RemoteDescription' web/src | sort
  )"
  expected_files="$(printf '%s\n' "$agent" "$host" "$adapter" | sort)"
  [[ "$actual_files" == "$expected_files" ]] \
    || { fail 'production RemoteDescription capability file inventory changed'; return 1; }

  require_count "$root" "$adapter" 'setRemote' 2 || return 1
  require_count "$root" "$adapter" 'RemoteDescription' 2 || return 1
  require_count "$root" "$agent" 'setRemote' 1 || return 1
  require_count "$root" "$agent" 'RemoteDescription' 1 || return 1
  require_count "$root" "$host" 'setRemote' 1 || return 1
  require_count "$root" "$host" 'RemoteDescription' 1 || return 1

  require_count "$root" "$adapter" \
    'Pick<RTCPeerConnection, "close" | "setRemoteDescription">' 1 || return 1
  require_count "$root" "$adapter" 'await peer.setRemoteDescription({' 1 || return 1
  require_count "$root" "$adapter" 'sdp: verified.transcript.sdp' 1 || return 1
  require_count "$root" "$agent" \
    '.setRemoteDescription({ type: "answer", sdp: msg.sdp })' 1 || return 1
  require_count "$root" "$host" \
    '.setRemoteDescription({ type: "answer", sdp: message.sdp })' 1 || return 1

  if (
    cd "$root"
    rg -q --glob '!*.test.*' --glob '!tests/**' \
      '"set"[[:space:]]*\+[[:space:]]*"Remote"' web/src
  ); then
    fail 'production code dynamically reconstructs the RemoteDescription capability name'
    return 1
  fi

  require_count "$root" "$adapter" 'const verified = await verifyRtcSignalWire(' 2 || return 1
  require_count "$root" "$agent" '.verifyAndApplyAnswer(' 1 || return 1
  require_count "$root" "$host" '.verifyAndApplyAnswer(' 1 || return 1
  require_count "$root" "$agent" 'new SignedRtcLiveSession(' 1 || return 1
  require_count "$root" "$host" 'new SignedRtcLiveSession(' 1 || return 1

  if grep -Fq 'sdp: frame.sdp' "$root/$adapter"; then
    fail 'untrusted outer SDP reached the signed live adapter consumer'
    return 1
  fi
}

run_self_test() {
  local fixture
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' RETURN
  mkdir -p \
    "$fixture/web/src/lib" \
    "$fixture/web/src/components/terminal"
  cp "$repo_root/web/src/lib/signed-rtc-live.ts" "$fixture/web/src/lib/"
  cp "$repo_root/web/src/lib/hostControl.ts" "$fixture/web/src/lib/"
  cp "$repo_root/web/src/components/terminal/useAgentSocket.ts" \
    "$fixture/web/src/components/terminal/"
  check_tree "$fixture" >/dev/null \
    || { fail 'known-good inventory failed its self-test'; return 1; }

  local host="$fixture/web/src/lib/hostControl.ts"
  local pristine="$fixture/hostControl.pristine.ts"
  cp "$host" "$pristine"
  local variants=(
    'peer.setRemoteDescription({ type: "answer", sdp: frame.sdp });'
    'const rawAlias = peer.setRemoteDescription; rawAlias({ type: "answer", sdp: frame.sdp });'
    'const rawBind = peer.setRemoteDescription.bind(peer); rawBind({ type: "answer", sdp: frame.sdp });'
    'const { setRemoteDescription: rawDestructure } = peer; rawDestructure({ type: "answer", sdp: frame.sdp });'
    'peer["setRemoteDescription"]({ type: "answer", sdp: frame.sdp });'
    'const rawDynamic = "set" + "Remote" + "Description"; peer[rawDynamic]({ type: "answer", sdp: frame.sdp });'
    'const rawCopy = { apply: peer.setRemoteDescription }; rawCopy.apply({ type: "answer", sdp: frame.sdp });'
  )
  local variant
  for variant in "${variants[@]}"; do
    cp "$pristine" "$host"
    printf '\n%s\n' "$variant" >> "$host"
    if check_tree "$fixture" >/dev/null 2>&1; then
      fail "self-test accepted RemoteDescription bypass: $variant"
      return 1
    fi
  done
  printf '%s\n' 'signed RTC live guard self-test passed'
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi
[[ $# == 0 ]] || { fail 'usage: check-signed-rtc-live.sh [--self-test]'; exit 2; }
check_tree "$repo_root"
printf '%s\n' 'signed RTC live guard passed'
