#!/usr/bin/env bash
# Build Linux ARM64 outputs on Minivac's x64 builder and execute them under QEMU.
set -euo pipefail
[[ "$(uname -s)/$(uname -m)" == Linux/x86_64 ]] || { echo 'Requires the Linux x64 builder' >&2; exit 1; }
[[ "${SPAWN_RUNNER_ISOLATION:-}" == container && "$(id -u)" == 1001 && -f /.dockerenv ]] || {
  echo 'Requires the unprivileged disposable CI container' >&2; exit 1;
}
[[ ! -S /var/run/docker.sock ]] || { echo 'Host Docker socket must not be exposed' >&2; exit 1; }
[[ "$(getconf GNU_LIBC_VERSION)" == 'glibc 2.35' ]] || { echo 'Ubuntu 22.04 ABI floor required' >&2; exit 1; }
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
[[ "$(git rev-parse HEAD)" == "${GITHUB_SHA:?Exact candidate SHA is required}" ]] || exit 1

# Packages and target sysroot are installed only inside this disposable container.
sudo apt-get update
sudo apt-get install -y --no-install-recommends gcc-aarch64-linux-gnu libc6-dev-arm64-cross qemu-user file
rustup target add aarch64-unknown-linux-gnu
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
export AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-3}"
rustc -vV
aarch64-linux-gnu-gcc --version
qemu-aarch64 --version
(cd daemon && cargo build --release --locked --target aarch64-unknown-linux-gnu --bin spawnd --bin spawn-worker)

mkdir -p out
printf '%s\n' 'Built on Minivac Linux x64; ARM64 execution verified with QEMU user emulation.' > out/verification.txt
for binary in spawnd spawn-worker; do
  source="daemon/target/aarch64-unknown-linux-gnu/release/$binary"
  file "$source" | tee -a out/verification.txt
  readelf -h "$source" | grep -E 'Machine:.*AArch64'
  qemu-aarch64 -L /usr/aarch64-linux-gnu "$source" --version | tee -a out/verification.txt
  cp "$source" "out/$binary-aarch64-unknown-linux-gnu"
done
printf '%s\n' "$GITHUB_SHA" > out/source-sha.txt
(cd out && sha256sum *-aarch64-unknown-linux-gnu > SHA256SUMS)
git diff --exit-code
