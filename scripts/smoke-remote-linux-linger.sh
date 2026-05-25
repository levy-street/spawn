#!/usr/bin/env bash
set -euo pipefail

host="${1:-}"
if [[ -z "$host" ]]; then
  printf 'Usage: %s ssh-host\n' "$0" >&2
  exit 2
fi

ssh "$host" 'bash -se' <<'REMOTE'
set -euo pipefail

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-remote-linux-linger: missing %s\n' "$1" >&2
    exit 1
  }
}

need loginctl

orig="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || printf unknown)"
if [[ "$orig" != "yes" && "$orig" != "no" ]]; then
  printf 'smoke-remote-linux-linger: could not read original linger state: %s\n' "$orig" >&2
  exit 1
fi

restore() {
  if [[ "$orig" == "yes" ]]; then
    loginctl enable-linger "$USER" >/dev/null 2>&1 || true
  else
    loginctl disable-linger "$USER" >/dev/null 2>&1 || true
  fi
}
trap restore EXIT

loginctl enable-linger "$USER"
enabled="$(loginctl show-user "$USER" -p Linger --value)"
if [[ "$enabled" != "yes" ]]; then
  printf 'smoke-remote-linux-linger: expected yes after enable, got %s\n' "$enabled" >&2
  exit 1
fi

restore
restored="$(loginctl show-user "$USER" -p Linger --value)"
if [[ "$restored" != "$orig" ]]; then
  printf 'smoke-remote-linux-linger: expected restored %s, got %s\n' "$orig" "$restored" >&2
  exit 1
fi

trap - EXIT
printf '%s\n' "smoke-remote-linux-linger: passed"
REMOTE
