#!/usr/bin/env bash
#
# signed RTC live guard — pins the browser's WebRTC RemoteDescription and
# RTCPeerConnection surface so a hostile change to the signed-signaling path is
# visible in review. See docs/TRUST.md "endpoint identity and signed signaling"
# and docs/TRUST_PHASE3_F2_INVENTORY.md.
#
# PREREQUISITE: ripgrep (rg) must be on PATH. The guard fails closed with a
# clear error when rg is missing, and treats an rg execution error as fatal; it
# never silently passes when rg is absent or errors. ripgrep is therefore a
# prerequisite for scripts/test-all.sh (which runs this guard).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

fail() {
  printf 'signed RTC live guard: %s\n' "$1" >&2
  return 1
}

require_rg() {
  command -v rg >/dev/null 2>&1 || {
    fail 'ripgrep (rg) is required but was not found on PATH; install ripgrep (https://github.com/BurntSushi/ripgrep) — it is a prerequisite for scripts/test-all.sh'
    return 1
  }
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
  require_rg || return 1
  local adapter=web/src/lib/signed-rtc-live.ts
  local session=web/src/components/terminal/useSessionSocket.ts
  local host=web/src/lib/hostControl.ts
  # Known test files that legitimately exercise the RemoteDescription capability.
  # They are allowlisted explicitly rather than excluded by a `*.test.*` glob, so
  # a NEW .test-named file — even one imported into production — still appears in
  # the inventory below and must be reviewed instead of being silently skipped.
  local adapter_test=web/src/lib/signed-rtc-live.test.ts
  local host_test=web/src/lib/hostControl.test.ts
  local source

  for source in "$adapter" "$session" "$host" "$adapter_test" "$host_test"; do
    [[ -f "$root/$source" ]] || { fail "missing production source $source"; return 1; }
  done

  # Inventory the whole RemoteDescription capability family, not merely direct
  # dot calls. This catches aliases, bind/copy, destructuring, bracket access,
  # and the ordinary split-string computed form while remaining grep-level.
  # --hidden also scans dotfiles (rg skips them by default); test files are
  # inventoried, not excluded, and reconciled against the explicit allowlist.
  local actual_files expected_files rg_status
  set +e
  actual_files="$(cd "$root" && rg -l --hidden 'setRemote|RemoteDescription' web/src | sort)"
  rg_status=$?
  set -e
  if (( rg_status > 1 )); then
    fail "RemoteDescription file inventory scan failed (rg exit $rg_status)"
    return 1
  fi
  expected_files="$(printf '%s\n' \
    "$session" "$host" "$adapter" "$adapter_test" "$host_test" | sort)"
  [[ "$actual_files" == "$expected_files" ]] \
    || { fail 'production RemoteDescription capability file inventory changed'; return 1; }

  # Pin the RTCPeerConnection construction surface too. Exactly two non-test
  # sites build the peer; the common adapter only receives a Pick<> of it and
  # never constructs one, so it is deliberately absent from this inventory.
  local actual_pc expected_pc pc_status
  set +e
  actual_pc="$(cd "$root" && rg -l --hidden 'new RTCPeerConnection' web/src | sort)"
  pc_status=$?
  set -e
  if (( pc_status > 1 )); then
    fail "RTCPeerConnection inventory scan failed (rg exit $pc_status)"
    return 1
  fi
  expected_pc="$(printf '%s\n' "$session" "$host" | sort)"
  [[ "$actual_pc" == "$expected_pc" ]] \
    || { fail 'production RTCPeerConnection construction inventory changed'; return 1; }

  require_count "$root" "$adapter" 'setRemote' 2 || return 1
  require_count "$root" "$adapter" 'RemoteDescription' 2 || return 1
  require_count "$root" "$session" 'setRemote' 1 || return 1
  require_count "$root" "$session" 'RemoteDescription' 1 || return 1
  require_count "$root" "$host" 'setRemote' 1 || return 1
  require_count "$root" "$host" 'RemoteDescription' 1 || return 1
  require_count "$root" "$session" 'new RTCPeerConnection' 1 || return 1
  require_count "$root" "$host" 'new RTCPeerConnection' 1 || return 1

  require_count "$root" "$adapter" \
    'Pick<RTCPeerConnection, "close" | "setRemoteDescription">' 1 || return 1
  require_count "$root" "$adapter" 'await peer.setRemoteDescription({' 1 || return 1
  require_count "$root" "$adapter" 'sdp: verified.transcript.sdp' 1 || return 1
  require_count "$root" "$session" \
    '.setRemoteDescription({ type: "answer", sdp: msg.sdp })' 1 || return 1
  require_count "$root" "$host" \
    '.setRemoteDescription({ type: "answer", sdp: message.sdp })' 1 || return 1

  local dyn_status
  set +e
  ( cd "$root" && rg -q --hidden '"set"[[:space:]]*\+[[:space:]]*"Remote"' web/src )
  dyn_status=$?
  set -e
  if (( dyn_status == 0 )); then
    fail 'production code dynamically reconstructs the RemoteDescription capability name'
    return 1
  elif (( dyn_status > 1 )); then
    fail "RemoteDescription dynamic-reconstruction scan failed (rg exit $dyn_status)"
    return 1
  fi

  require_count "$root" "$adapter" 'const verified = await verifyRtcSignalWire(' 2 || return 1
  require_count "$root" "$session" '.verifyAndApplyAnswer(' 1 || return 1
  require_count "$root" "$host" '.verifyAndApplyAnswer(' 1 || return 1
  require_count "$root" "$session" 'new SignedRtcLiveSession(' 1 || return 1
  require_count "$root" "$host" 'new SignedRtcLiveSession(' 1 || return 1

  if grep -Fq 'sdp: frame.sdp' "$root/$adapter"; then
    fail 'untrusted outer SDP reached the signed live adapter consumer'
    return 1
  fi
}

run_self_test() {
  require_rg || return 1
  local fixture
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' RETURN
  mkdir -p \
    "$fixture/web/src/lib" \
    "$fixture/web/src/components/terminal"
  cp "$repo_root/web/src/lib/signed-rtc-live.ts" "$fixture/web/src/lib/"
  cp "$repo_root/web/src/lib/hostControl.ts" "$fixture/web/src/lib/"
  # The allowlisted test files are part of the pinned inventory, so the
  # known-good fixture must contain them.
  cp "$repo_root/web/src/lib/signed-rtc-live.test.ts" "$fixture/web/src/lib/"
  cp "$repo_root/web/src/lib/hostControl.test.ts" "$fixture/web/src/lib/"
  cp "$repo_root/web/src/components/terminal/useSessionSocket.ts" \
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
  cp "$pristine" "$host"

  # A newly added .test-named file carrying the RemoteDescription capability
  # must trip the inventory rather than be skipped by a test glob (the former
  # `!*.test.*` bypass, e.g. a .test file imported into production).
  local stray_test="$fixture/web/src/lib/injected.test.ts"
  printf '%s\n' 'peer.setRemoteDescription({ type: "answer", sdp: frame.sdp });' >"$stray_test"
  if check_tree "$fixture" >/dev/null 2>&1; then
    fail 'self-test accepted a new .test-named RemoteDescription file'
    return 1
  fi
  rm -f "$stray_test"

  # A second RTCPeerConnection construction site must trip the PC inventory.
  local stray_pc="$fixture/web/src/lib/extraPeer.ts"
  printf '%s\n' 'export const p = new RTCPeerConnection({});' >"$stray_pc"
  if check_tree "$fixture" >/dev/null 2>&1; then
    fail 'self-test accepted a new RTCPeerConnection construction site'
    return 1
  fi
  rm -f "$stray_pc"

  # Fail closed when ripgrep is broken or absent. A stub rg that exits non-zero
  # (an rg execution error) must never let the guard pass open. Mirrors the
  # rg-missing self-test in scripts/check-no-server-agent-upload.sh.
  mkdir -p "$fixture/bin"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 2' >"$fixture/bin/rg"
  chmod +x "$fixture/bin/rg"
  if PATH="$fixture/bin:$PATH" "$script_path" >/dev/null 2>&1; then
    fail 'self-test accepted a broken ripgrep (rg exit 2) instead of failing closed'
    return 1
  fi

  printf '%s\n' 'signed RTC live guard self-test passed'
}

if [[ "${1:-}" == "--self-test" ]]; then
  run_self_test
  exit 0
fi
[[ $# == 0 ]] || { fail 'usage: check-signed-rtc-live.sh [--self-test]'; exit 2; }
check_tree "$repo_root"
printf '%s\n' 'signed RTC live guard passed'
