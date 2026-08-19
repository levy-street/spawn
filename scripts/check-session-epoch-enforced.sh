#!/usr/bin/env bash
# Every entry point that turns a caller-supplied token into a `User` must
# check the account's session epoch. REST did; both WebSockets quietly did
# not, so a password reset evicted every API call while `/ws/browser` and
# `/ws/host` kept authenticating the stolen 30-day session cookie for its
# full lifetime. The epoch is the only mechanism that can revoke a stateless
# session, and a token-accepting path that skips it is unrevocable by
# construction — exactly the drift a literal source guard catches.
#
# The rule, applied per function body in server/spawn_server:
#   decodes a token AND resolves a user session (mentions KIND_ACCESS)
#     => must also call session_epoch_matches or _assert_current_epoch
#
# Daemon-token paths (KIND_DAEMON) are deliberately out of scope: they are
# host-scoped, carry no session epoch, and are revoked by deleting the Host.
set -euo pipefail

repo_root="${SESSION_EPOCH_GUARD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

fail() {
  printf 'session-epoch guard: %s\n' "$1" >&2
  exit 1
}

# Walks each Python file one top-level-or-nested `def` block at a time and
# prints "file:line" for every block that decodes a session token without
# checking the epoch. Block extent is the run of lines indented deeper than
# the `def` itself, which is all the structure this needs.
offending_functions() {
  local root="$1"
  find "$root/server/spawn_server" -name '*.py' -print0 \
    | xargs -0 awk '
      function flush() {
        if (name != "" && decodes && session_token && !epoch_checked)
          printf "%s:%d:%s\n", file, start, name
        name = ""; decodes = 0; session_token = 0; epoch_checked = 0
      }
      FNR == 1 { flush(); file = FILENAME }
      {
        line = $0
        match(line, /^[ \t]*/)
        indent = RLENGTH
        if (line ~ /^[ \t]*(async[ \t]+)?def[ \t]+/) {
          if (name != "" && indent > def_indent) {
            # A nested def still belongs to the function being scanned.
          } else {
            flush()
            def_indent = indent
            start = FNR
            sub(/^[ \t]*(async[ \t]+)?def[ \t]+/, "", line)
            sub(/\(.*$/, "", line)
            name = line
            next
          }
        }
        if (name == "") next
        if (line ~ /^[ \t]*$/) next
        if (indent <= def_indent) { flush(); next }
        if ($0 ~ /decode_token\(/) decodes = 1
        if ($0 ~ /KIND_ACCESS/) session_token = 1
        if ($0 ~ /session_epoch_matches|_assert_current_epoch/) epoch_checked = 1
      }
      END { flush() }
    '
}

check_tree() {
  local root="$1" offenders

  [[ -d "$root/server/spawn_server" ]] || fail "missing server/spawn_server in $root"

  # The comparison itself must live in exactly one place, so the REST and
  # WebSocket paths cannot drift apart again.
  grep -Fq 'def session_epoch_matches(' "$root/server/spawn_server/auth.py" \
    || fail 'auth.py must define session_epoch_matches()'

  offenders="$(offending_functions "$root" || true)"
  if [[ -n "$offenders" ]]; then
    printf 'these token-accepting functions resolve a user without a session-epoch check:\n' >&2
    printf '%s\n' "$offenders" >&2
    printf 'call auth.session_epoch_matches() (or _assert_current_epoch) before trusting the user\n' >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/server"
  cp -R "$repo_root/server/spawn_server" "$tmp/server/spawn_server"
  check_tree "$tmp"

  cat >"$tmp/server/spawn_server/_guard_probe.py" <<'PY'
async def _resolve_user_unchecked(raw):
    payload = decode_token(raw)
    if payload.get("kind") != KIND_ACCESS:
        return None
    return await session.get(User, payload["sub"])
PY
  if (check_tree "$tmp") >/dev/null 2>&1; then
    fail 'self-test accepted a token path with no epoch check'
  fi

  # The same function with the check restored must pass, or the guard is
  # just rejecting everything.
  cat >"$tmp/server/spawn_server/_guard_probe.py" <<'PY'
async def _resolve_user_checked(raw):
    payload = decode_token(raw)
    if payload.get("kind") != KIND_ACCESS:
        return None
    user = await session.get(User, payload["sub"])
    if not auth.session_epoch_matches(payload, user):
        return None
    return user
PY
  check_tree "$tmp"

  rm "$tmp/server/spawn_server/_guard_probe.py"
  python3 - "$tmp/server/spawn_server/auth.py" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.write_text(path.read_text().replace("def session_epoch_matches(", "def _epoch_ok("))
PY
  if (check_tree "$tmp") >/dev/null 2>&1; then
    fail 'self-test accepted a missing session_epoch_matches definition'
  fi
  printf '%s\n' 'session-epoch guard self-test passed'
elif [[ $# -eq 0 ]]; then
  check_tree "$repo_root"
  printf '%s\n' 'session-epoch guard: every token-accepting entry point checks the epoch'
else
  fail 'usage: check-session-epoch-enforced.sh [--self-test]'
fi
