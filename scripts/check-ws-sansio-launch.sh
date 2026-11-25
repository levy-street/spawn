#!/usr/bin/env bash
# Every place this repository starts the server runs uvicorn's sans-I/O
# websocket implementation, the one production is moving to. uvicorn's default,
# `--ws auto`, picks the legacy implementation, so a launcher that leaves the
# option out quietly tests something production does not run.
# docs/NETWORK.md ("The websocket implementation") compares the two; this gate
# fails when a launch lacks the setting.
#
# A launch is found by literal markers, per docs/GUARD_POLICY.md:
#
#   1. A line naming the app's import string, `spawn_server.main:<name>`, in
#      any file: shell, PowerShell, Python, Markdown, YAML, a unit file. Its
#      statement is that line plus the lines joined to it by a trailing `\`,
#      backtick, `,` or an open bracket. The statement must carry the setting
#      exactly once, as the two words `--ws websockets-sansio` (quoted array
#      items such as `'--ws', 'websockets-sansio'` count) or, in Python, as
#      `ws="websockets-sansio"`.
#   2. A Python call to uvicorn's `Config` or `run`, written `uvicorn.Config(`
#      or `uvicorn.run(`, or by a name imported from uvicorn. The call must
#      pass `ws="websockets-sansio"`, and no other `ws` value.
#
# The UVICORN_WS environment variable does not count: the support log's launch
# check (server/spawn_server/support_log_files.py) reads only the command
# line. Prose that quotes the import string must carry the option as well;
# name the module, `spawn_server.main`, instead.
#
# Git lists the files, tracked or not yet added, so a root git cannot read
# fails rather than passing on an empty listing.
#
# `--list` prints every launch found. macOS ships bash 3.2: no mapfile, no
# associative arrays.
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_root="${WS_SANSIO_LAUNCH_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SELF="scripts/check-ws-sansio-launch.sh"

fail() {
  printf 'ws-sansio-launch: %s\n' "$1" >&2
  exit 1
}

scan() {
  local mode="$1"
  cd "$repo_root"
  if [[ "$(git rev-parse --is-inside-work-tree 2>/dev/null || true)" != "true" ]]; then
    printf 'ws-sansio-launch: %s is not a git work tree; cannot find launches\n' "$repo_root" >&2
    return 1
  fi
  python3 -I - "$mode" "$SELF" <<'PY'
import re
import subprocess
import sys
from pathlib import Path

mode, own_path = sys.argv[1], sys.argv[2]

listed = subprocess.run(
    ["git", "grep", "-l", "-z", "-I", "--untracked", "-E",
     r"spawn_server\.main:|uvicorn", "--", ".", f":(exclude){own_path}"],
    capture_output=True,
)
if listed.returncode not in (0, 1):
    raise SystemExit("ws-sansio-launch: git grep failed: "
                     + listed.stderr.decode(errors="replace").strip())
files = sorted(name for name in listed.stdout.decode(errors="surrogateescape").split("\0") if name)

APP = re.compile(r"spawn_server\.main:[A-Za-z_]")
# Command form: `--ws` and its value as two words, optionally quoted array items.
CMD_SANSIO = re.compile(r"""(?<![\w-])--ws['"]?[\s,]+['"]?websockets-sansio(?![\w-])""")
CMD_ANY = re.compile(r"""(?<![\w-])--ws(?=[\s'"=,]|$)""")
PY_SANSIO = re.compile(r'(?<![\w.])ws\s*=\s*"websockets-sansio"')
PY_ANY = re.compile(r"(?<![\w.])ws\s*=(?!=)")
QUALIFIED_CALL = re.compile(r"(?<![\w.])uvicorn\.(?:Config|run)\s*\(")
IMPORT = re.compile(r"^[ \t]*from[ \t]+uvicorn[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)", re.M)
CONTINUES = ("\\", "`", ",", "(", "[", "{")
OPENING, CLOSING = "([{", ")]}"
MAX_LINES = 60


def depth_change(text):
    return sum(text.count(c) for c in OPENING) - sum(text.count(c) for c in CLOSING)


def continues(line):
    return line.rstrip().endswith(CONTINUES)


def statement(lines, index):
    start = index
    while start > 0 and index - start < MAX_LINES and continues(lines[start - 1]):
        start -= 1
    end, depth = start, 0
    while True:
        depth += depth_change(lines[end])
        if end >= index and depth <= 0 and not continues(lines[end]):
            break
        if end + 1 >= len(lines) or end - start >= MAX_LINES:
            break
        end += 1
    return start, end


def call_text(text, open_paren):
    depth = 0
    for position in range(open_paren, min(len(text), open_paren + 20000)):
        if text[position] in OPENING:
            depth += 1
        elif text[position] in CLOSING:
            depth -= 1
            if depth == 0:
                return text[open_paren:position + 1]
    return text[open_paren:open_paren + 20000]


def imported_names(text):
    names = []
    for match in IMPORT.finditer(text):
        for item in match.group(1).strip("()").split(","):
            parts = item.split()
            if not parts or parts[0] not in ("Config", "run"):
                continue
            names.append(parts[2] if len(parts) == 3 and parts[1] == "as" else parts[0])
    return names


launches, problems = [], []
for name in files:
    path = Path(name)
    if not path.is_file():
        continue
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    seen = set()
    for index, line in enumerate(lines):
        if not APP.search(line):
            continue
        start, end = statement(lines, index)
        if (start, end) in seen:
            continue
        seen.add((start, end))
        body = "\n".join(lines[start:end + 1])
        launches.append(f"{name}:{index + 1}: command")
        settings = len(CMD_ANY.findall(body)) + len(PY_ANY.findall(body))
        sansio = len(CMD_SANSIO.findall(body)) + len(PY_SANSIO.findall(body))
        if settings != 1 or sansio != 1:
            problems.append(
                f"{name}:{index + 1}: this launch must pass `--ws websockets-sansio` "
                f"(two words) once, and no other --ws value"
            )

    calls = [match.end() - 1 for match in QUALIFIED_CALL.finditer(text)]
    for alias in imported_names(text):
        pattern = re.compile(rf"(?<![\w.]){re.escape(alias)}\s*\(")
        for match in pattern.finditer(text):
            before = text[max(0, match.start() - 4):match.start()]
            if before.endswith("def "):
                continue
            calls.append(match.end() - 1)
    for open_paren in sorted(set(calls)):
        number = text.count("\n", 0, open_paren) + 1
        launches.append(f"{name}:{number}: python")
        body = call_text(text, open_paren)
        if len(PY_ANY.findall(body)) != 1 or len(PY_SANSIO.findall(body)) != 1:
            problems.append(f'{name}:{number}: this uvicorn call must pass ws="websockets-sansio"')

if mode == "list":
    print("\n".join(launches))
if problems:
    print("\n".join("ws-sansio-launch: " + problem for problem in problems), file=sys.stderr)
    print("ws-sansio-launch: every launch runs the websocket implementation production runs; "
          "see docs/NETWORK.md, \"The websocket implementation\".", file=sys.stderr)
    raise SystemExit(1)
if not launches:
    raise SystemExit("ws-sansio-launch: found no server launch at all; the markers no longer match")
print(f"ws-sansio-launch: {len(launches)} launches pass the sans-I/O websocket setting",
      file=sys.stderr if mode == "list" else sys.stdout)
PY
}

self_test() {
  local fixture outside output
  fixture="$(mktemp -d)"
  outside="$(mktemp -d)"
  trap 'rm -rf "$fixture" "$outside"' RETURN

  mkdir -p "$fixture/scripts" "$fixture/docs"
  cat >"$fixture/scripts/start.sh" <<'SH'
(
  cd server
  SPAWN_PUBLIC_URL="$url" \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$port" \
      --ws-max-size 67108864 --ws websockets-sansio
) &
SH
  cat >"$fixture/scripts/start.ps1" <<'PS1'
$serverProcess = Start-Process -FilePath (Get-Command uv).Source `
    -ArgumentList @(
        'run', '--frozen', 'uvicorn', 'spawn_server.main:app',
        '--host', '127.0.0.1', '--port', [string] $port,
        '--ws', 'websockets-sansio'
    ) `
    -PassThru
PS1
  cat >"$fixture/scripts/fixture.py" <<'PY_FIXTURE'
import uvicorn
from uvicorn import Config as UvicornConfig

server = uvicorn.Server(
    uvicorn.Config(
        app,
        host="127.0.0.1",
        ws="websockets-sansio",
        ws_ping_interval=20,
    )
)
probe = UvicornConfig(app, ws="websockets-sansio", ws_max_size=1024)
uvicorn.run("spawn_server.main:app", port=8000, ws="websockets-sansio")
PY_FIXTURE
  printf '%s\n' '```bash' \
    'uv run uvicorn spawn_server.main:app --reload --port 8000 --ws websockets-sansio' \
    '```' 'Name the module, `spawn_server.main`, in prose.' >"$fixture/docs/run.md"
  (cd "$fixture" && git init -q && git add -A)

  WS_SANSIO_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null 2>&1 ||
    fail "self-test: the sans-I/O launches did not pass: $(WS_SANSIO_LAUNCH_ROOT="$fixture" "$script_path" 2>&1)"
  output="$(WS_SANSIO_LAUNCH_ROOT="$fixture" "$script_path" --list 2>/dev/null)"
  [[ "$(printf '%s\n' "$output" | grep -c .)" == 7 ]] ||
    fail "self-test: expected seven launches in the fixture, listed: $output"

  # Each case must fail naming the file it changed, not merely fail.
  expect_failure() {
    local label="$1" file="$2" text="$3" original
    original="$(cat "$fixture/$file")"
    printf '%s\n' "$text" >>"$fixture/$file"
    if output="$(WS_SANSIO_LAUNCH_ROOT="$fixture" "$script_path" 2>&1)"; then
      fail "self-test: $label passed"
    fi
    [[ "$output" == *"$file:"* ]] || fail "self-test: $label failed without naming $file: $output"
    printf '%s\n' "$original" >"$fixture/$file"
  }

  expect_failure "a launch with the default implementation" scripts/start.sh \
    'uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port 8001'
  expect_failure "a launch with only the size option" scripts/start.sh \
    'uv run uvicorn spawn_server.main:app --ws-max-size 67108864'
  expect_failure "a launch naming the legacy implementation" scripts/start.sh \
    'uv run uvicorn spawn_server.main:app --ws websockets'
  expect_failure "a launch that overrides the setting later" scripts/start.sh \
    'uvicorn spawn_server.main:app --ws websockets-sansio --ws auto'
  expect_failure "the setting as one word" scripts/start.sh \
    'uvicorn spawn_server.main:app --ws=websockets-sansio'
  expect_failure "the setting through the environment" scripts/start.sh \
    'UVICORN_WS=websockets-sansio uv run uvicorn spawn_server.main:app --port 8001'
  expect_failure "the setting on a separate command" scripts/start.sh \
    "$(printf '%s\n' 'uv run uvicorn spawn_server.main:app --port 8001' 'echo --ws websockets-sansio')"
  expect_failure "a factory launch" scripts/start.sh \
    'uv run uvicorn --factory spawn_server.main:create_app --port 8001'
  expect_failure "a PowerShell array without the setting" scripts/start.ps1 \
    "$(printf '%s\n' '$p = Start-Process -FilePath uv `' "    -ArgumentList @(" \
      "        'run', 'uvicorn', 'spawn_server.main:app'," "        '--port', '8001'" '    )')"
  expect_failure "a Python Config without ws" scripts/fixture.py \
    "$(printf '%s\n' 'other = uvicorn.Config(' '    app,' '    port=0,' ')')"
  expect_failure "a Python run with the legacy implementation" scripts/fixture.py \
    'uvicorn.run(app, ws="websockets")'
  expect_failure "an imported Config without ws" scripts/fixture.py \
    'late = UvicornConfig(app, port=0)'
  expect_failure "a subprocess argument list without the setting" scripts/fixture.py \
    "$(printf '%s\n' 'command = [' '    "uvicorn",' '    "spawn_server.main:app",' ']')"
  expect_failure "prose quoting the import string" docs/run.md \
    'The app is `spawn_server.main:app`.'

  printf '%s\n' 'uv run uvicorn spawn_server.main:app --port 8001' >"$fixture/docs/new.md"
  if output="$(WS_SANSIO_LAUNCH_ROOT="$fixture" "$script_path" 2>&1)"; then
    fail "self-test: an untracked launch passed"
  fi
  [[ "$output" == *"docs/new.md:1"* ]] || fail "self-test: an untracked launch was not named: $output"
  rm -f "$fixture/docs/new.md"

  # A tree git cannot read is not a clean tree. The ceiling stops git finding
  # a repository above it.
  mkdir -p "$outside/root"
  if output="$(GIT_CEILING_DIRECTORIES="$outside" WS_SANSIO_LAUNCH_ROOT="$outside/root" \
    "$script_path" 2>&1)"; then
    fail "self-test: a root outside any git work tree passed"
  fi
  [[ "$output" == *"is not a git work tree"* ]] ||
    fail "self-test: a root outside any git work tree failed for another reason: $output"

  WS_SANSIO_LAUNCH_ROOT="$fixture" "$script_path" >/dev/null 2>&1 ||
    fail "self-test: the restored fixture did not pass"

  printf '%s\n' "ws-sansio-launch self-test passed"
}

case "${1:-}" in
  --self-test)
    self_test
    ;;
  --list)
    scan list
    ;;
  "")
    scan check
    ;;
  *)
    printf '%s\n' "usage: scripts/check-ws-sansio-launch.sh [--self-test | --list]" >&2
    exit 2
    ;;
esac
