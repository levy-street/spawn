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
#   4. Ambient directory authority is consumed at four reviewed source sites:
#      the host-file home root, the cfg-exclusive Unix/Windows upload roots, and
#      the validated private-directory platform helper used for preview staging.
#      Any other site would be a new escape from the capability sandbox.
#      The one raw openat is separately pinned through its capability anchor,
#      relative path, and flags: it only reopens an already-held directory for
#      fsync and must never become an ambient CWD-relative open.
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

# 4. Ambient authority is consumed only at the exact reviewed sites.
ambient="$(
  rg -n --color never 'open_ambient_dir' daemon/src --glob '*.rs' \
    | sed -E 's/^([^:]+):[0-9]+:/\1:/' \
    | sort
)"
expected_ambient='daemon/src/host_files.rs:        let root = Dir::open_ambient_dir(&root_capability, ambient_authority())?;
daemon/src/platform/unix.rs:    Dir::open_ambient_dir(path, ambient_authority())
daemon/src/upload.rs:        CapDir::open_ambient_dir(Path::new("/"), ambient_authority())?,
daemon/src/upload.rs:        let current = CapDir::open_ambient_dir(&root, ambient_authority())?;'
if [[ "$ambient" != "$expected_ambient" ]]; then
  printf 'host-desktop-launch: unexpected ambient directory authority sites:\n%s\n' "$ambient" >&2
  fail "ambient directory authority escaped its reviewed inventory"
fi

# cap-std holds Linux directories with O_PATH, which fsync rejects. The Unix
# platform leaf therefore reopens `.` relative to the held capability. Pin the
# complete raw openat shape as well as its inventory: changing `dir` to CWD or
# changing `.` to an ambient path would otherwise create a new authority root.
raw_directory_opens="$(
  while IFS= read -r file; do
    awk '
      /rustix::fs::openat\(/ { remaining = 6 }
      remaining > 0 { print FILENAME ":" $0; remaining-- }
    ' "$file"
  done < <(rg -l --color never 'rustix::fs::openat\(' daemon/src --glob '*.rs' | sort)
)"
expected_raw_directory_opens='daemon/src/platform/unix.rs:    let sync_handle = rustix::fs::openat(
daemon/src/platform/unix.rs:        dir,
daemon/src/platform/unix.rs:        Path::new("."),
daemon/src/platform/unix.rs:        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::DIRECTORY | rustix::fs::OFlags::CLOEXEC,
daemon/src/platform/unix.rs:        rustix::fs::Mode::empty(),
daemon/src/platform/unix.rs:    )'
if [[ "$raw_directory_opens" != "$expected_raw_directory_opens" ]]; then
  printf 'host-desktop-launch: unexpected raw directory opens:\n%s\n' "$raw_directory_opens" >&2
  fail "raw directory open escaped its reviewed capability-relative shape"
fi

# 5. The gates on `desktop.open` are all still present.
for gate in 'not_file' 'open_not_permitted' 'launch_rate_limited' '0o111'; do
  grep -qF "$gate" "$DESKTOP" || fail "missing open gate: $gate"
done

self_test() {
  local fixture
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' RETURN

  mkdir -p "$fixture/daemon/src/platform"
  cp "$DESKTOP" "$PREVIEW" "$fixture/daemon/src/"
  printf '%s\n' \
    '        let root = Dir::open_ambient_dir(&root_capability, ambient_authority())?;' \
    >"$fixture/daemon/src/host_files.rs"
  printf '%s\n' \
    '        CapDir::open_ambient_dir(Path::new("/"), ambient_authority())?,' \
    '        let current = CapDir::open_ambient_dir(&root, ambient_authority())?;' \
    >"$fixture/daemon/src/upload.rs"
  printf '%s\n' \
    '    Dir::open_ambient_dir(path, ambient_authority())' \
    '    let sync_handle = rustix::fs::openat(' \
    '        dir,' \
    '        Path::new("."),' \
    '        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::DIRECTORY | rustix::fs::OFlags::CLOEXEC,' \
    '        rustix::fs::Mode::empty(),' \
    '    )' \
    >"$fixture/daemon/src/platform/unix.rs"

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

  local original_unix
  original_unix="$(cat "$fixture/daemon/src/platform/unix.rs")"
  sed 's/^        dir,$/        rustix::fs::CWD,/' \
    "$fixture/daemon/src/platform/unix.rs" >"$fixture/unsafe-openat"
  mv "$fixture/unsafe-openat" "$fixture/daemon/src/platform/unix.rs"
  if HOST_DESKTOP_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: an ambient raw directory open passed"
  fi
  printf '%s\n' "$original_unix" >"$fixture/daemon/src/platform/unix.rs"

  # Removing a gate must fail closed.
  grep -v '0o111' "$fixture/daemon/src/host_desktop.rs" >"$fixture/stripped"
  mv "$fixture/stripped" "$fixture/daemon/src/host_desktop.rs"
  if HOST_DESKTOP_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: a removed execute-bit gate passed"
  fi
  printf '%s\n' "$original" >"$fixture/daemon/src/host_desktop.rs"

  printf '%s\n' 'open_ambient_dir' >"$fixture/daemon/src/roots.rs"
  if HOST_DESKTOP_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: an extra ambient-authority site passed"
  fi

  printf '%s\n' "host-desktop-launch self-test passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

printf '%s\n' "host-desktop-launch: passed"
