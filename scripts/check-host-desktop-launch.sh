#!/usr/bin/env bash
# `desktop.open` hands a file on the user's machine to another program, and the
# same control channel already offers `fs.write.begin`. Write-then-open is
# therefore one frame away from arbitrary code execution, and the only thing
# standing between them is that the daemon builds argv entirely from its own
# constants plus a path it resolved itself.
#
# This gate pins that property in the source, so it cannot be relaxed quietly:
#
#   1. The only programs these modules may launch are /usr/bin/open and
#      /usr/bin/qlmanage, named by absolute path so a hijacked PATH cannot
#      choose the binary.
#   2. No shell, no `-c`, and none of open(1)'s application-selecting flags
#      (`-a`, `-b`, `--args`) may appear — with them, a launch could be steered
#      at a program of someone else's choosing.
#   3. Neither module may read the request payload at all. Payload parsing lives
#      in host_control.rs, so argv cannot be fed from a client-supplied key by
#      construction rather than by review.
#   4. Ambient authority is consumed at exactly two sites: the home root and the
#      private preview staging directory. A third would be a new escape from
#      the capability sandbox.
#
# Deliberately a literal-source check, per docs/GUARD_POLICY.md: it greps for
# markers, never prose.
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_root="${HOST_DESKTOP_LAUNCH_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$repo_root"

DESKTOP="daemon/src/host_desktop.rs"
PREVIEW="daemon/src/host_preview.rs"

fail() {
  printf 'host-desktop-launch: %s\n' "$1" >&2
  exit 1
}

for file in "$DESKTOP" "$PREVIEW"; do
  [[ -f "$file" ]] || fail "missing launch module: $file"
done

# 1. Exactly two launchable binaries, both absolute.
commands="$(grep -ho 'Command::new([^)]*)' "$DESKTOP" "$PREVIEW" | sort -u || true)"
expected='Command::new(OPEN_BINARY)
Command::new(QLMANAGE)'
if [[ "$commands" != "$expected" ]]; then
  printf 'host-desktop-launch: unexpected Command::new targets:\n%s\n' "$commands" >&2
  fail "only the two reviewed launch constants may be spawned"
fi

for binding in 'OPEN_BINARY: &str = "/usr/bin/open"' 'QLMANAGE: &str = "/usr/bin/qlmanage"'; do
  grep -qF "$binding" "$DESKTOP" "$PREVIEW" || fail "missing absolute binary constant: $binding"
done

# 2. No shell, no argument-injection surface, no inherited stdio or environment.
forbidden=(
  '"bash"'
  '"sh"'
  '"-c"'
  '"--args"'
  '"-a"'
  '"-b"'
  'Stdio::inherit'
  '.envs('
)
for marker in "${forbidden[@]}"; do
  if grep -qF -- "$marker" "$DESKTOP" "$PREVIEW"; then
    fail "forbidden launch marker present: $marker"
  fi
done

# The environment is cleared before every launch, so nothing this daemon holds
# is inherited by an application LaunchServices starts on the user's behalf.
for file in "$DESKTOP" "$PREVIEW"; do
  grep -qF 'env_clear()' "$file" || fail "launch in $file does not clear its environment"
done

# 3. Payload parsing stays in the dispatcher.
if grep -qF 'payload_string(' "$DESKTOP" "$PREVIEW"; then
  fail "launch modules must not read request payloads"
fi

# 4. Ambient authority is consumed at exactly two reviewed sites.
ambient="$(grep -rho 'open_ambient_dir' daemon/src --include='*.rs' | wc -l | tr -d ' ')"
if [[ "$ambient" != "2" ]]; then
  fail "expected exactly 2 open_ambient_dir sites in daemon/src, found $ambient"
fi

# 5. The gates on `desktop.open` are all still present.
for gate in 'not_file' 'open_not_permitted' 'launch_rate_limited' '0o111'; do
  grep -qF "$gate" "$DESKTOP" || fail "missing open gate: $gate"
done

self_test() {
  local fixture
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' RETURN

  mkdir -p "$fixture/daemon/src"
  cp "$DESKTOP" "$PREVIEW" "$fixture/daemon/src/"
  # The real tree has two; the fixture only copies the two launch modules, so
  # stand in a file carrying both ambient sites.
  printf '%s\n%s\n' 'open_ambient_dir' 'open_ambient_dir' >"$fixture/daemon/src/roots.rs"
  # host_preview.rs already contains one; drop the fixture's extra.
  printf '%s\n' 'open_ambient_dir' >"$fixture/daemon/src/roots.rs"

  HOST_DESKTOP_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null ||
    fail "self-test: an unmodified copy did not pass"

  local original
  original="$(cat "$fixture/daemon/src/host_desktop.rs")"

  printf '%s\n' 'let _ = Command::new("bash");' >>"$fixture/daemon/src/host_desktop.rs"
  if HOST_DESKTOP_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: a shell launch passed"
  fi
  printf '%s\n' "$original" >"$fixture/daemon/src/host_desktop.rs"

  printf '%s\n' 'let app = "-a";' >>"$fixture/daemon/src/host_desktop.rs"
  if HOST_DESKTOP_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: an application-selecting flag passed"
  fi
  printf '%s\n' "$original" >"$fixture/daemon/src/host_desktop.rs"

  printf '%s\n' 'let p = payload_string(payload, "path");' >>"$fixture/daemon/src/host_desktop.rs"
  if HOST_DESKTOP_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: payload parsing in a launch module passed"
  fi
  printf '%s\n' "$original" >"$fixture/daemon/src/host_desktop.rs"

  # Removing a gate must fail closed.
  grep -v '0o111' "$fixture/daemon/src/host_desktop.rs" >"$fixture/stripped"
  mv "$fixture/stripped" "$fixture/daemon/src/host_desktop.rs"
  if HOST_DESKTOP_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: a removed execute-bit gate passed"
  fi
  printf '%s\n' "$original" >"$fixture/daemon/src/host_desktop.rs"

  printf '%s\n' 'open_ambient_dir' >>"$fixture/daemon/src/roots.rs"
  if HOST_DESKTOP_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: a third ambient-authority site passed"
  fi

  printf '%s\n' "host-desktop-launch self-test passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

printf '%s\n' "host-desktop-launch: passed"
