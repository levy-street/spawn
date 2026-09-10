#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-}"
if [[ -z "$base_url" ]]; then
  printf 'Usage: %s https://spawn.example.com\n' "$0" >&2
  exit 2
fi

base_url="${base_url%/}"
tmp_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-http-surface: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need curl
need python3

fetch() {
  local path="$1"
  if ! curl --fail --silent --show-error --location --max-time "${SPAWN_HTTP_SMOKE_TIMEOUT:-20}" \
    "$base_url$path"; then
    printf 'smoke-http-surface: GET %s failed\n' "$path" >&2
    return 1
  fi
}

contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$file"; then
    printf 'smoke-http-surface: %s did not contain %s\n' "$file" "$needle" >&2
    return 1
  fi
}

host_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os:$arch" in
    Darwin:arm64) printf '%s\n' "darwin-aarch64" ;;
    Darwin:x86_64) printf '%s\n' "darwin-x86_64" ;;
    Linux:x86_64|Linux:amd64) printf '%s\n' "linux-x86_64" ;;
    Linux:aarch64|Linux:arm64) printf '%s\n' "linux-aarch64" ;;
    *) return 1 ;;
  esac
}

printf 'smoke-http-surface: checking %s\n' "$base_url"

fetch "/" >"$tmp_dir/root.html"
contains "$tmp_dir/root.html" "spawn"

fetch "/download" >"$tmp_dir/download.html"
contains "$tmp_dir/download.html" "install.sh"
contains "$tmp_dir/download.html" "LaunchAgent"
contains "$tmp_dir/download.html" "systemd"

fetch "/healthz" >"$tmp_dir/health.json"
python3 - "$tmp_dir/health.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    body = json.load(handle)
if body.get("status") != "ok":
    raise SystemExit(f"unexpected /healthz payload: {body!r}")
PY

fetch "/install.sh" >"$tmp_dir/install.sh"
contains "$tmp_dir/install.sh" "DEFAULT_SERVER=$base_url"
contains "$tmp_dir/install.sh" "/api/install/spawnd/"
# The shell publishes a matched pair; possession owns service registration
# (including systemd linger and LaunchAgents) inside the daemon.
contains "$tmp_dir/install.sh" '__publish-release --install-root "$INSTALL_ROOT"'
contains "$tmp_dir/install.sh" 'exec_attached "$RUN_BIN" --server "$SERVER" possess'

# The Windows installer is rendered by the server and 503s until a Windows
# release exists, so its body is not assertable here — but reaching the server
# at all is. A 404 means the single-origin proxy never forwarded the path and
# the published `irm .../install.ps1 | iex` one-liner is dead, which is exactly
# how this shipped once.
ps1_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --location \
  --max-time "${SPAWN_HTTP_SMOKE_TIMEOUT:-20}" "$base_url/install.ps1")"
case "$ps1_status" in
  200) printf 'smoke-http-surface: /install.ps1 is served\n' ;;
  503) printf 'smoke-http-surface: /install.ps1 reaches the server; no Windows release yet\n' ;;
  *)
    printf 'smoke-http-surface: GET /install.ps1 returned %s; expected 200 or 503\n' "$ps1_status" >&2
    exit 1
    ;;
esac

if target="$(host_target)"; then
  binary="$tmp_dir/spawnd"
  fetch "/api/install/spawnd/$target" >"$binary"
  if [[ ! -s "$binary" ]]; then
    printf 'smoke-http-surface: downloaded daemon binary for %s is empty\n' "$target" >&2
    exit 1
  fi
  chmod 755 "$binary"
  if [[ "${SPAWN_HTTP_SMOKE_SKIP_BINARY_EXEC:-0}" != "1" ]]; then
    "$binary" --version >/dev/null
  fi
  printf 'smoke-http-surface: verified hosted daemon binary for %s\n' "$target"
else
  printf '%s\n' "smoke-http-surface: no hosted daemon target for this platform; skipped binary download"
fi

printf '%s\n' "smoke-http-surface: passed"
