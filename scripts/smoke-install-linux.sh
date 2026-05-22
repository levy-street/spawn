#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke-install-linux.sh

Runs a lightweight installer smoke in ubuntu:24.04. The test uses fake runtime
and build prerequisite commands so it does not install packages or build the
daemon; it verifies prebuilt target detection for Linux/macOS/WSL-like shells,
native Windows rejection, and the OTP 27+ source-build guard before cloning.

Environment:
  SPAWN_SMOKE_BASE_URL       Web origin. Default: http://localhost:3002
  SPAWN_LINUX_SMOKE_IMAGE    Docker image. Default: ubuntu:24.04
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

die() {
  printf 'smoke-install-linux: %s\n' "$*" >&2
  exit 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  die "run from inside the spawn repo"
cd "$repo_root"

base_url="${SPAWN_SMOKE_BASE_URL:-http://localhost:3002}"
image="${SPAWN_LINUX_SMOKE_IMAGE:-ubuntu:24.04}"

command -v docker >/dev/null 2>&1 || die "docker is required"
docker image inspect "$image" >/dev/null 2>&1 || die "docker image is not available locally: $image"

tmpdir="$(mktemp -d /tmp/spawn-install-linux.XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

install_script="$tmpdir/install.sh"
fake_bin="$tmpdir/bin"
state_dir="$tmpdir/state"
mkdir -p "$fake_bin" "$state_dir"

curl -fsSL "$base_url/install.sh" -o "$install_script" ||
  die "$base_url/install.sh is not reachable"
sh -n "$install_script" || die "install.sh has invalid shell syntax"

cat > "$fake_bin/erl" <<'EOF'
#!/bin/sh
printf 25
EOF

cat > "$fake_bin/git" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> /state/git.log
if [ "${1:-}" = "clone" ]; then
  printf 'git clone should not run before OTP guard\n' >&2
  exit 99
fi
exit 0
EOF

for cmd in curl tar rebar3 cc; do
  cat > "$fake_bin/$cmd" <<'EOF'
#!/bin/sh
exit 0
EOF
done
chmod 755 "$fake_bin"/*

set +e
output="$(
  docker run --rm \
    -v "$install_script:/install.sh:ro" \
    -v "$fake_bin:/fake-bin:ro" \
    -v "$state_dir:/state" \
    "$image" \
    /bin/sh -c 'PATH=/fake-bin:/usr/bin:/bin HOME=/tmp SPAWN_INSTALL_ROOT=/tmp/spawn-root sh /install.sh --server http://spawn.invalid --build-from-source --no-login --no-start' \
    2>&1
)"
status=$?
set -e

[[ "$status" -ne 0 ]] || die "installer unexpectedly succeeded with fake OTP 25"
grep -Fq "Erlang/OTP 27+ is required for --build-from-source" <<<"$output" ||
  die "installer did not explain the OTP 27+ requirement: $output"
grep -Fq "this host has OTP 25" <<<"$output" ||
  die "installer did not report the fake OTP version: $output"
if [[ -f "$state_dir/git.log" ]] && grep -Fq "clone" "$state_dir/git.log"; then
  die "installer attempted git clone before rejecting OTP 25"
fi

artifact_root="$tmpdir/artifact-root"
mkdir -p "$artifact_root/spawnd/bin"

cat > "$artifact_root/spawnd/bin/spawnd" <<'EOF'
#!/bin/sh
case "$*" in
  "escript spawnd_cli --version"|"--version")
    printf 'spawnd 0.2.0-smoke\n'
    exit 0
    ;;
esac
printf 'unexpected fake spawnd args: %s\n' "$*" >&2
exit 64
EOF

cat > "$artifact_root/spawnd/spawnd_cli" <<'EOF'
fake smoke CLI marker
EOF

chmod 755 "$artifact_root/spawnd/bin/spawnd"
COPYFILE_DISABLE=1 tar -czf "$state_dir/spawnd.tar.gz" -C "$artifact_root" spawnd

run_prebuilt_case() {
  case_name=$1
  uname_s=$2
  uname_m=$3
  expected_target=$4

  case_bin="$tmpdir/$case_name-bin"
  case_state="$tmpdir/$case_name-state"
  mkdir -p "$case_bin" "$case_state"
  cp "$state_dir/spawnd.tar.gz" "$case_state/spawnd.tar.gz"

  cat > "$case_bin/uname" <<EOF
#!/bin/sh
case "\${1:-}" in
  -s) printf '$uname_s\n' ;;
  -m) printf '$uname_m\n' ;;
  *) printf '$uname_s\n' ;;
esac
EOF

  cat > "$case_bin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> /state/curl.log
out=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o)
      shift
      out=${1:-}
      ;;
  esac
  shift || break
done
[ -n "$out" ] || exit 65
cp /state/spawnd.tar.gz "$out"
EOF

  chmod 755 "$case_bin"/*

  case_root="/tmp/spawn-root-$case_name"
  set +e
  case_output="$(
    docker run --rm \
      -v "$install_script:/install.sh:ro" \
      -v "$case_bin:/fake-bin:ro" \
      -v "$case_state:/state" \
      "$image" \
      /bin/sh -c "PATH=/fake-bin:/usr/bin:/bin HOME=/tmp SPAWN_INSTALL_ROOT=$case_root sh /install.sh --server http://spawn.invalid --no-login --no-start" \
      2>&1
  )"
  case_status=$?
  set -e

  [[ "$case_status" -eq 0 ]] || die "$case_name prebuilt install failed: $case_output"
  grep -Fq "installing prebuilt spawnd for $expected_target" <<<"$case_output" ||
    die "$case_name did not report target $expected_target: $case_output"
  grep -Fq "installed spawnd 0.2.0-smoke" <<<"$case_output" ||
    die "$case_name did not install the fake prebuilt release: $case_output"
  grep -Fq "/install/spawnd/$expected_target.tar.gz" "$case_state/curl.log" ||
    die "$case_name did not request the expected artifact target; curl log: $(cat "$case_state/curl.log" 2>/dev/null || true)"
}

run_prebuilt_case linux_x86_64 Linux x86_64 linux-x86_64
run_prebuilt_case linux_arm64 Linux aarch64 linux-arm64
run_prebuilt_case wsl_like_linux Linux x86_64 linux-x86_64
run_prebuilt_case darwin_x86_64 Darwin x86_64 darwin-x86_64
run_prebuilt_case darwin_arm64 Darwin arm64 darwin-arm64

windows_fake_bin="$tmpdir/windows-bin"
mkdir -p "$windows_fake_bin"

cat > "$windows_fake_bin/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in
  -s) printf 'MINGW64_NT-10.0\n' ;;
  -m) printf 'x86_64\n' ;;
  *) printf 'MINGW64_NT-10.0\n' ;;
esac
EOF

for cmd in curl tar; do
  cat > "$windows_fake_bin/$cmd" <<'EOF'
#!/bin/sh
exit 0
EOF
done
chmod 755 "$windows_fake_bin"/*

set +e
windows_output="$(
  docker run --rm \
    -v "$install_script:/install.sh:ro" \
    -v "$windows_fake_bin:/fake-bin:ro" \
    "$image" \
    /bin/sh -c 'PATH=/fake-bin:/usr/bin:/bin HOME=/tmp SPAWN_INSTALL_ROOT=/tmp/spawn-root sh /install.sh --server http://spawn.invalid --no-login --no-start' \
    2>&1
)"
windows_status=$?
set -e

[[ "$windows_status" -ne 0 ]] || die "installer unexpectedly accepted a native Windows shell"
grep -Fq "native Windows shells are not supported" <<<"$windows_output" ||
  die "installer did not explain native Windows/WSL requirement: $windows_output"
grep -Fq "inside WSL" <<<"$windows_output" ||
  die "installer did not point Windows users to WSL: $windows_output"

printf 'smoke-install-linux: ok\n'
