#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/smoke-linux-artifact.sh

Builds a Linux spawnd release artifact inside an Erlang 27 Docker image, then
installs and runs it inside a plain Ubuntu runtime image. This verifies the
prebuilt Linux artifact path without relying on Erlang/rebar3 in the runtime
container.

Environment:
  SPAWN_SMOKE_BASE_URL                 Web origin for install.sh. Default: http://localhost:3002
  SPAWN_LINUX_ARTIFACT_BUILDER_IMAGE   Builder image. Default: erlang:27
  SPAWN_LINUX_ARTIFACT_RUNTIME_IMAGE   Runtime image. Default: ubuntu:24.04
  SPAWN_LINUX_ARTIFACT_PLATFORMS       Space/comma-separated Docker platforms.
                                       Default: host arch as linux/arm64 or linux/amd64.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

die() {
  printf 'smoke-linux-artifact: %s\n' "$*" >&2
  exit 1
}

default_platform() {
  case "$(uname -m 2>/dev/null || printf unknown)" in
    arm64|aarch64) printf 'linux/arm64\n' ;;
    x86_64|amd64) printf 'linux/amd64\n' ;;
    *) die "unsupported host architecture for default platform; set SPAWN_LINUX_ARTIFACT_PLATFORMS" ;;
  esac
}

target_for_platform() {
  case "$1" in
    linux/amd64|linux/x86_64) printf 'linux-x86_64\n' ;;
    linux/arm64|linux/aarch64) printf 'linux-arm64\n' ;;
    *) die "unsupported Docker platform: $1" ;;
  esac
}

copy_source() {
  local dest="$1"
  mkdir -p "$dest"
  tar \
    --exclude='.git' \
    --exclude='data' \
    --exclude='dist' \
    --exclude='daemon/_build' \
    --exclude='server/.venv' \
    --exclude='server/data' \
    --exclude='web/.next' \
    --exclude='web/node_modules' \
    -C "$repo_root" \
    -cf - . | tar -C "$dest" -xf -
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" ||
  die "run from inside the spawn repo"
cd "$repo_root"

command -v docker >/dev/null 2>&1 || die "docker is required"

base_url="${SPAWN_SMOKE_BASE_URL:-http://localhost:3002}"
builder_image="${SPAWN_LINUX_ARTIFACT_BUILDER_IMAGE:-erlang:27}"
runtime_image="${SPAWN_LINUX_ARTIFACT_RUNTIME_IMAGE:-ubuntu:24.04}"
platforms="${SPAWN_LINUX_ARTIFACT_PLATFORMS:-$(default_platform)}"

tmpdir="$(mktemp -d /tmp/spawn-linux-artifact.XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT INT TERM

install_script="$tmpdir/install.sh"
artifacts_dir="$tmpdir/artifacts"
mkdir -p "$artifacts_dir"

curl -fsSL "$base_url/install.sh" -o "$install_script" ||
  die "$base_url/install.sh is not reachable"
sh -n "$install_script" || die "install.sh has invalid shell syntax"

for platform in $(printf '%s\n' "$platforms" | tr ',' ' '); do
  [[ -n "$platform" ]] || continue
  target="$(target_for_platform "$platform")"
  src_dir="$tmpdir/src-$target"
  copy_source "$src_dir"

  printf 'smoke-linux-artifact: building %s with %s\n' "$target" "$builder_image"
  docker run --rm \
    --platform "$platform" \
    -e "SPAWN_PACKAGE_TARGET=$target" \
    -v "$src_dir:/work/spawn" \
    -v "$artifacts_dir:/out" \
    -w /work/spawn \
    "$builder_image" \
    bash -lc './scripts/package-spawnd.sh --target "$SPAWN_PACKAGE_TARGET" --out-dir /out'

  artifact="$artifacts_dir/spawnd-$target.tar.gz"
  [[ -s "$artifact" ]] || die "builder did not create artifact: $artifact"

  printf 'smoke-linux-artifact: installing and running %s in %s\n' "$target" "$runtime_image"
  docker run --rm \
    --platform "$platform" \
    -e "SPAWN_PACKAGE_TARGET=$target" \
    -v "$install_script:/install.sh:ro" \
    -v "$artifact:/artifact/spawnd-$target.tar.gz:ro" \
    "$runtime_image" \
    bash -lc '
      set -euo pipefail
      apt-get update >/dev/null
      DEBIAN_FRONTEND=noninteractive apt-get install -y \
        curl ca-certificates passwd tar util-linux >/dev/null
      useradd -m -d /tmp/spawn-home spawn
      install -d -o spawn -g spawn /tmp/spawn-root
      cat > /tmp/run-spawn-smoke.sh <<\EOF
      set -euo pipefail
      sh /install.sh \
        --server http://spawn.invalid \
        --artifact-url "file:///artifact/spawnd-$SPAWN_PACKAGE_TARGET.tar.gz" \
        --target "$SPAWN_PACKAGE_TARGET" \
        --no-login \
        --no-start
      /tmp/spawn-root/bin/spawnd --version | grep -q "spawnd 0.2.0"
      /tmp/spawn-root/bin/spawnd foreground >/tmp/spawnd.log 2>&1 &
      daemon_pid=$!
      ready=0
      for _ in $(seq 1 40); do
        if /tmp/spawn-root/bin/spawnd agents >/tmp/agents.json 2>/tmp/agents.err; then
          ready=1
          break
        fi
        if ! kill -0 "$daemon_pid" 2>/dev/null; then
          cat /tmp/spawnd.log >&2
          exit 1
        fi
        sleep 0.25
      done
      [ "$ready" = "1" ] || {
        cat /tmp/agents.err >&2
        cat /tmp/spawnd.log >&2
        exit 1
      }
      grep -q "\"agents\"" /tmp/agents.json
      /tmp/spawn-root/bin/spawnd self-test
      if /tmp/spawn-root/bin/spawnd kill 00000000-0000-0000-0000-00000000eeee >/tmp/kill.json; then
        printf "spawnd kill should fail for unknown agent\n" >&2
        exit 1
      fi
      grep -q "\"ok\":false" /tmp/kill.json
      /tmp/spawn-root/bin/spawnd stop
      wait "$daemon_pid" || true
EOF
      chown spawn:spawn /tmp/run-spawn-smoke.sh
      runuser -u spawn -- env \
        HOME=/tmp/spawn-home \
        SPAWN_INSTALL_ROOT=/tmp/spawn-root \
        SPAWND_CONTROL_PORT=18346 \
        SPAWN_PACKAGE_TARGET="$SPAWN_PACKAGE_TARGET" \
        bash /tmp/run-spawn-smoke.sh
    '
done

printf 'smoke-linux-artifact: ok\n'
