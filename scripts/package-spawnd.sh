#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/package-spawnd.sh [options]

Build and package a self-contained spawnd OTP release for the current host.
Run this on each OS/architecture you want to publish as a prebuilt artifact.

Options:
  --target TARGET       Expected target name. Default: detected host target.
                        Supported names: linux-x86_64, linux-arm64,
                        darwin-x86_64, darwin-arm64.
  --out-dir DIR         Artifact output directory.
                        Default: $SPAWN_DAEMON_ARTIFACT_DIR or dist/spawnd.
  --skip-build          Package the existing daemon/_build release.
  -h, --help            Show this help.
EOF
}

die() {
  printf 'package-spawnd: %s\n' "$*" >&2
  exit 1
}

detect_target() {
  local os_name arch_name target_os target_arch
  os_name="$(uname -s 2>/dev/null || printf unknown)"
  arch_name="$(uname -m 2>/dev/null || printf unknown)"

  case "$os_name" in
    Linux) target_os=linux ;;
    Darwin) target_os=darwin ;;
    *) die "unsupported OS for spawnd artifact: $os_name" ;;
  esac

  case "$arch_name" in
    x86_64|amd64) target_arch=x86_64 ;;
    arm64|aarch64) target_arch=arm64 ;;
    *) die "unsupported architecture for spawnd artifact: $arch_name" ;;
  esac

  printf '%s-%s\n' "$target_os" "$target_arch"
}

target=""
out_dir="${SPAWN_DAEMON_ARTIFACT_DIR:-dist/spawnd}"
skip_build=0

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --target)
      [[ "$#" -ge 2 ]] || die "--target requires a value"
      target="$2"
      shift 2
      ;;
    --target=*)
      target="${1#--target=}"
      shift
      ;;
    --out-dir)
      [[ "$#" -ge 2 ]] || die "--out-dir requires a value"
      out_dir="$2"
      shift 2
      ;;
    --out-dir=*)
      out_dir="${1#--out-dir=}"
      shift
      ;;
    --skip-build)
      skip_build=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
repo_root="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s\n' "$(dirname "$script_dir")")" ||
  die "could not resolve repo root"
cd "$repo_root"

detected_target="$(detect_target)"
target="${target:-$detected_target}"
case "$target" in
  linux-x86_64|linux-arm64|darwin-x86_64|darwin-arm64) ;;
  *) die "unsupported target: $target" ;;
esac

if [[ "$target" != "$detected_target" ]]; then
  die "cannot build $target on $detected_target; run this script on a $target host"
fi

command -v tar >/dev/null 2>&1 || die "tar is required"

release_dir="$repo_root/daemon/_build/default/rel/spawnd"
release_bin="$release_dir/bin/spawnd"
built_cli="$repo_root/daemon/_build/default/bin/spawnd"
release_cli="$release_dir/spawnd_cli"

if [[ "$skip_build" != "1" ]]; then
  command -v rebar3 >/dev/null 2>&1 || die "rebar3 is required"
  (cd daemon && rebar3 release && rebar3 escriptize) >&2
fi

[[ -x "$release_bin" ]] || die "release script is missing: $release_bin"
[[ -x "$built_cli" || -x "$release_cli" ]] || die "CLI escript is missing; run rebar3 escriptize"
if [[ -x "$built_cli" ]]; then
  cp "$built_cli" "$release_cli"
  chmod 755 "$release_cli"
fi

"$release_bin" escript spawnd_cli --version >/dev/null ||
  die "packaged spawnd CLI cannot run on this host"

mkdir -p "$out_dir"
artifact="$out_dir/spawnd-$target.tar.gz"
tmp_artifact="$artifact.tmp.$$"
manifest="$tmp_artifact.manifest"
rm -f "$tmp_artifact"
trap 'rm -f "$tmp_artifact" "$manifest"' EXIT INT TERM

tar -czf "$tmp_artifact" -C "$repo_root/daemon/_build/default/rel" spawnd
tar -tzf "$tmp_artifact" > "$manifest"
grep -Eq '^spawnd/(\./)?bin/spawnd$' "$manifest" ||
  die "artifact is missing spawnd/bin/spawnd"
grep -Eq '^spawnd/(\./)?spawnd_cli$' "$manifest" ||
  die "artifact is missing spawnd/spawnd_cli"
mv "$tmp_artifact" "$artifact"
rm -f "$manifest"
trap - EXIT INT TERM

printf '%s\n' "$artifact"
