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
contains "$tmp_dir/install.sh" "enable-linger"
contains "$tmp_dir/install.sh" "LaunchAgent"

fetch "/.well-known/oauth-protected-resource/mcp" >"$tmp_dir/mcp-resource.json"
python3 - "$tmp_dir/mcp-resource.json" "$base_url" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    body = json.load(handle)
base_url = sys.argv[2].rstrip("/")
expected_resource = f"{base_url}/mcp"
if body.get("resource") != expected_resource:
    raise SystemExit(f"unexpected MCP resource metadata: {body!r}")
servers = body.get("authorization_servers")
if not isinstance(servers, list) or f"{base_url}/api" not in servers:
    raise SystemExit(f"unexpected MCP authorization servers: {body!r}")
PY

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
