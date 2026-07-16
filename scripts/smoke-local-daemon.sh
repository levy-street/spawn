#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'smoke-local-daemon: missing required command: %s\n' "$1" >&2
    exit 1
  }
}

need curl
need awk
need find
need mktemp
need python3
need ps
need readlink
need tr
need uname

linux_process_primitives_available() {
  local system_name="$1"
  local proc_root="$2"
  local self_comm

  [[ "$system_name" == "Linux" ]] || return 1
  [[ -r "$proc_root/self/stat" && -r "$proc_root/self/cmdline" \
    && -L "$proc_root/self/exe" && -r "$proc_root/self/comm" ]] || return 1
  self_comm="$(<"$proc_root/self/comm")"
  [[ -n "$self_comm" ]] || return 1
  ps -C "$self_comm" -o pid= >/dev/null 2>&1
}

linux_process_identity_at() {
  local proc_root="$1"
  local pid="$2"
  python3 - "$proc_root" "$pid" <<'PY'
import hashlib
import os
import sys
from pathlib import Path

proc = Path(sys.argv[1]) / sys.argv[2]
try:
    stat_tail = (proc / "stat").read_text(encoding="utf-8").rsplit(")", 1)[1].split()
    starttime = stat_tail[19]
    executable = os.readlink(proc / "exe")
    cmdline = (proc / "cmdline").read_bytes()
except (FileNotFoundError, IndexError, OSError, UnicodeDecodeError):
    raise SystemExit(1)
if not starttime.isdecimal() or not executable or not cmdline:
    raise SystemExit(1)
fingerprint = hashlib.sha256(os.fsencode(executable) + b"\0" + cmdline).hexdigest()
print(f"{starttime}:{fingerprint}")
PY
}

owned_process_identity_matches() {
  local proc_root="$1"
  local pid="$2"
  local expected="$3"
  local observed

  [[ -n "$expected" ]] || return 1
  observed="$(linux_process_identity_at "$proc_root" "$pid")" || return 1
  [[ "$observed" == "$expected" ]]
}

capture_owned_process_identity() {
  local label="$1"
  local pid="$2"
  local expected_exe="$3"
  shift 3
  local identity=""

  for _ in {1..100}; do
    identity="$(python3 - "/proc" "$pid" "$expected_exe" "$@" <<'PY'
import hashlib
import os
import sys
from pathlib import Path

proc = Path(sys.argv[1]) / sys.argv[2]
expected_exe = os.path.realpath(sys.argv[3])
expected_argv = sys.argv[4:]
try:
    stat_tail = (proc / "stat").read_text(encoding="utf-8").rsplit(")", 1)[1].split()
    starttime = stat_tail[19]
    executable = os.readlink(proc / "exe")
    cmdline = (proc / "cmdline").read_bytes()
except (FileNotFoundError, IndexError, OSError, UnicodeDecodeError):
    raise SystemExit(1)
argv = [part.decode(errors="surrogateescape") for part in cmdline.split(b"\0") if part]
if os.path.realpath(executable) != expected_exe or argv != expected_argv:
    raise SystemExit(1)
fingerprint = hashlib.sha256(os.fsencode(executable) + b"\0" + cmdline).hexdigest()
print(f"{starttime}:{fingerprint}")
PY
)" && [[ -n "$identity" ]] && {
      printf '%s\n' "$identity"
      return 0
    }
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.01
  done
  printf 'smoke-local-daemon: %s launch identity did not stabilize for pid %s\n' \
    "$label" "$pid" >&2
  return 1
}

validate_worker_socket_paths() {
  local dir="$1"
  python3 - "$dir" <<'PY'
import os
import sys

directory = sys.argv[1]
uuid = "f" * 8 + "-" + "f" * 4 + "-" + "4" + "f" * 3 + "-" + "8" + "f" * 3 + "-" + "f" * 12
names = (
    f"{uuid}.sock",
    f"{uuid}.lifecycle.sock",
    f".lifecycle-client-4294967295-{uuid}.sock",
)
limit = 107  # Linux sockaddr_un.sun_path bytes excluding the trailing NUL.
too_long = [(name, len(os.fsencode(os.path.join(directory, name)))) for name in names]
too_long = [(name, length) for name, length in too_long if length > limit]
if too_long:
    detail = ", ".join(f"{name}={length}" for name, length in too_long)
    raise SystemExit(
        f"smoke-local-daemon: worker socket path exceeds Linux {limit}-byte limit: {detail}"
    )
PY
}

owned_group_live_pids() {
  local pgid="$1"
  ps -eo pid=,pgid=,stat= | awk -v pgid="$pgid" \
    '$2 == pgid && $3 !~ /^Z/ { print $1 }'
}

owned_group_is_live() {
  local pgid="$1"
  [[ -n "$(owned_group_live_pids "$pgid")" ]]
}

claim_owned_process_group() {
  local label="$1"
  local pid="$2"
  local observed_pgid=""

  for _ in {1..100}; do
    observed_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$observed_pgid" == "$pid" ]]; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null || true
      printf 'smoke-local-daemon: %s exited before owning process group %s\n' \
        "$label" "$pid" >&2
      return 1
    fi
    sleep 0.01
  done

  printf 'smoke-local-daemon: %s did not acquire owned process group; pid=%s pgid=%s\n' \
    "$label" "$pid" "${observed_pgid:-unknown}" >&2
  return 1
}

stop_owned_process_group() {
  local label="$1"
  local pid="$2"
  local pgid="$3"
  local identity="$4"
  local term_attempts="${5:-100}"
  local kill_attempts="${6:-100}"
  local observed_pgid=""

  if [[ ! "$pid" =~ ^[1-9][0-9]*$ || "$pgid" != "$pid" ]]; then
    printf 'smoke-local-daemon: refusing unsafe %s stop; pid=%s pgid=%s\n' \
      "$label" "${pid:-unset}" "${pgid:-unset}" >&2
    return 1
  fi

  observed_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$observed_pgid" && "$observed_pgid" != "$pgid" ]]; then
    printf 'smoke-local-daemon: refusing mismatched %s stop; pid=%s expected_pgid=%s observed_pgid=%s\n' \
      "$label" "$pid" "$pgid" "$observed_pgid" >&2
    return 1
  fi
  if owned_group_is_live "$pgid"; then
    if ! owned_process_identity_matches /proc "$pid" "$identity"; then
      printf 'smoke-local-daemon: refusing %s TERM after launch identity changed; pid=%s pgid=%s\n' \
        "$label" "$pid" "$pgid" >&2
      return 1
    fi
    kill -TERM -- "-$pgid" >/dev/null 2>&1 || true
    for ((attempt = 0; attempt < term_attempts; attempt++)); do
      owned_group_is_live "$pgid" || break
      sleep 0.05
    done
  fi

  if owned_group_is_live "$pgid"; then
    printf 'smoke-local-daemon: %s did not stop after TERM; escalating owned process group %s\n' \
      "$label" "$pgid" >&2
    if ! owned_process_identity_matches /proc "$pid" "$identity"; then
      printf 'smoke-local-daemon: refusing %s KILL after launch identity changed; pid=%s pgid=%s\n' \
        "$label" "$pid" "$pgid" >&2
      return 1
    fi
    kill -KILL -- "-$pgid" >/dev/null 2>&1 || true
    for ((attempt = 0; attempt < kill_attempts; attempt++)); do
      owned_group_is_live "$pgid" || break
      sleep 0.05
    done
  fi

  if owned_group_is_live "$pgid"; then
    printf 'smoke-local-daemon: %s process group did not stop; pgid=%s pids=%s\n' \
      "$label" "$pgid" "$(owned_group_live_pids "$pgid" | tr '\n' ' ')" >&2
    return 1
  fi

  # The owned session leader is our direct child. With no live members left,
  # this wait only reaps an already-exited (possibly zombie) child.
  wait "$pid" 2>/dev/null || true
}

scoped_worker_pid_matches() {
  local proc="$1"
  local expected_exe="$2"
  local expected_worker_dir="$3"
  local observed_exe arg socket_name expect_socket=0

  [[ -d "$proc" && -r "$proc/cmdline" ]] || return 1
  observed_exe="$(readlink "$proc/exe" 2>/dev/null)" || return 1
  [[ "$observed_exe" == "$expected_exe" ]] || return 1
  while IFS= read -r -d '' arg; do
    if ((expect_socket)); then
      if [[ "$arg" == "$expected_worker_dir/"* ]]; then
        socket_name="${arg#"$expected_worker_dir/"}"
        if [[ -n "$socket_name" && "$socket_name" != */* && "$socket_name" == *.sock ]]; then
          return 0
        fi
      fi
      expect_socket=0
    elif [[ "$arg" == "--socket" ]]; then
      expect_socket=1
    fi
  done <"$proc/cmdline"
  return 1
}

scoped_worker_pids() {
  local proc_root="$1"
  local expected_exe="$2"
  local expected_worker_dir="$3"
  local proc

  for proc in "$proc_root"/[0-9]*; do
    if scoped_worker_pid_matches "$proc" "$expected_exe" "$expected_worker_dir"; then
      printf '%s\n' "${proc##*/}"
    fi
  done
}

active_scoped_worker_pids() {
  local candidate_stat worker_exe proc pid
  if ! linux_process_primitives_available "$(uname -s)" /proc; then
    printf '%s\n' "smoke-local-daemon: worker audit lost required Linux process identity" >&2
    return 1
  fi
  if ! worker_exe="$(readlink -f daemon/target/debug/spawn-worker 2>/dev/null)" \
    || [[ ! -x "$worker_exe" ]]; then
    printf '%s\n' "smoke-local-daemon: cannot establish exact spawn-worker identity" >&2
    return 1
  fi

  # Ask procps for the small set of kernel comm-name candidates, then apply
  # the exact executable and private --socket identity checks. This keeps
  # bounded teardown waits bounded even on hosts with very large /proc tables.
  while IFS= read -r pid; do
    pid="${pid//[[:space:]]/}"
    [[ "$pid" =~ ^[1-9][0-9]*$ ]] || continue
    proc="/proc/$pid"
    [[ -d "$proc" ]] || continue
    candidate_stat="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
    if [[ "$candidate_stat" == Z* ]]; then
      continue
    fi
    if [[ -z "$candidate_stat" ]]; then
      [[ -d "$proc" ]] || continue
      printf 'smoke-local-daemon: cannot read spawn-worker candidate state for pid %s\n' \
        "$pid" >&2
      return 1
    fi
    if [[ ! -r "$proc/cmdline" || ! -L "$proc/exe" ]] \
      || ! readlink "$proc/exe" >/dev/null 2>&1; then
      [[ -d "$proc" ]] || continue
      printf 'smoke-local-daemon: cannot validate spawn-worker candidate pid %s\n' \
        "$pid" >&2
      return 1
    fi
    if scoped_worker_pid_matches "$proc" "$worker_exe" "$worker_dir"; then
      printf '%s\n' "$pid"
    fi
  done < <(ps -C spawn-worker -o pid= 2>/dev/null)
}

self_test_scoped_worker_pids() {
  local fixture expected other actual
  fixture="$(mktemp -d)"
  expected="$fixture/spawn-worker"
  other="$fixture/other-worker"
  : >"$expected"
  : >"$other"
  mkdir -p "$fixture/proc/101" "$fixture/proc/102" "$fixture/proc/103" \
    "$fixture/proc/104"
  ln -s "$expected" "$fixture/proc/101/exe"
  ln -s "$expected" "$fixture/proc/102/exe"
  ln -s "$other" "$fixture/proc/103/exe"
  ln -s "$expected" "$fixture/proc/104/exe"
  printf 'spawn-worker\0--socket\0%s/workers/a.sock\0' "$fixture" \
    >"$fixture/proc/101/cmdline"
  printf 'spawn-worker\0--socket\0%s/other/b.sock\0' "$fixture" \
    >"$fixture/proc/102/cmdline"
  printf 'spawn-worker\0--socket\0%s/workers/c.sock\0' "$fixture" \
    >"$fixture/proc/103/cmdline"
  printf 'spawn-worker\0--socket\0%s/workers/nested/d.sock\0' "$fixture" \
    >"$fixture/proc/104/cmdline"
  actual="$(scoped_worker_pids "$fixture/proc" "$expected" "$fixture/workers")"
  rm -rf "$fixture"
  if [[ "$actual" != "101" ]]; then
    printf 'smoke-local-daemon: scoped worker matcher self-test failed: %s\n' "$actual" >&2
    return 1
  fi
  printf '%s\n' "smoke-local-daemon: scoped worker matcher self-test passed"
}

self_test_launch_identity() {
  local fixture expected identity
  fixture="$(mktemp -d)"
  expected="$fixture/owned"
  : >"$expected"
  mkdir -p "$fixture/proc/201"
  ln -s "$expected" "$fixture/proc/201/exe"
  python3 - "$fixture/proc/201" "$fixture" <<'PY'
import sys
from pathlib import Path

proc = Path(sys.argv[1])
cwd = sys.argv[2]
fields = ["S", *("0" for _ in range(18)), "12345"]
(proc / "stat").write_text(f"201 (owned) {' '.join(fields)}\n", encoding="utf-8")
(proc / "cmdline").write_bytes(b"owned\0--cwd\0" + cwd.encode() + b"\0")
PY
  identity="$(linux_process_identity_at "$fixture/proc" 201)"
  owned_process_identity_matches "$fixture/proc" 201 "$identity"

  # Same executable and directory, but an unrelated command line, must not
  # inherit the recorded launch identity.
  printf 'unrelated\0--cwd\0%s\0' "$fixture" >"$fixture/proc/201/cmdline"
  if owned_process_identity_matches "$fixture/proc" 201 "$identity"; then
    printf '%s\n' "smoke-local-daemon: unrelated launch identity was accepted" >&2
    rm -rf "$fixture"
    return 1
  fi

  # Restoring argv cannot hide PID reuse: /proc starttime remains part of the
  # identity and changing it must also fail closed.
  printf 'owned\0--cwd\0%s\0' "$fixture" >"$fixture/proc/201/cmdline"
  python3 - "$fixture/proc/201/stat" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
fields = path.read_text(encoding="utf-8").rsplit(")", 1)[1].split()
fields[19] = "12346"
path.write_text(f"201 (owned) {' '.join(fields)}\n", encoding="utf-8")
PY
  if owned_process_identity_matches "$fixture/proc" 201 "$identity"; then
    printf '%s\n' "smoke-local-daemon: changed process starttime was accepted" >&2
    rm -rf "$fixture"
    return 1
  fi
  rm -rf "$fixture"
  printf '%s\n' "smoke-local-daemon: launch identity self-test passed"
}

self_test_platform_and_socket_guards() {
  local long_dir
  if linux_process_primitives_available Darwin /proc \
    || linux_process_primitives_available Linux /nonexistent; then
    printf '%s\n' "smoke-local-daemon: unsupported process platform was accepted" >&2
    return 1
  fi
  validate_worker_socket_paths /tmp/smoke/workers
  printf -v long_dir '/tmp/%090d/workers' 0
  if validate_worker_socket_paths "$long_dir" >/dev/null 2>&1; then
    printf '%s\n' "smoke-local-daemon: oversized worker socket path was accepted" >&2
    return 1
  fi
  printf '%s\n' "smoke-local-daemon: platform and socket guard self-test passed"
}

self_test_owned_process_group() {
  local fixture identity pid python_exe

  fixture="$(mktemp -d)"
  python3 - "$fixture/ready" <<'PY' &
import os
import signal
import sys
from pathlib import Path


def stop(_signal: int, _frame: object) -> None:
    raise SystemExit(0)


os.setsid()
signal.signal(signal.SIGTERM, stop)
Path(sys.argv[1]).touch()
signal.pause()
PY
  pid=$!
  claim_owned_process_group "self-test process" "$pid"
  for _ in {1..100}; do
    [[ -f "$fixture/ready" ]] && break
    sleep 0.01
  done
  if [[ ! -f "$fixture/ready" ]]; then
    printf '%s\n' "smoke-local-daemon: owned process group self-test did not become ready" >&2
    kill -TERM "$pid" >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
    rm -rf "$fixture"
    return 1
  fi
  python_exe="$(readlink -f "$(command -v python3)")"
  if ! identity="$(capture_owned_process_identity \
    "self-test process" "$pid" "$python_exe" python3 - "$fixture/ready")"; then
    kill -TERM "$pid" >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
    rm -rf "$fixture"
    return 1
  fi
  if stop_owned_process_group \
    "self-test mismatched process" "$pid" "$pid" "0:$identity" 2 2 \
    >/dev/null 2>&1; then
    printf '%s\n' "smoke-local-daemon: mismatched launch identity was stopped" >&2
    kill -TERM "$pid" >/dev/null 2>&1 || true
    wait "$pid" 2>/dev/null || true
    rm -rf "$fixture"
    return 1
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    printf '%s\n' "smoke-local-daemon: identity mismatch signalled the owned process" >&2
    wait "$pid" 2>/dev/null || true
    rm -rf "$fixture"
    return 1
  fi
  stop_owned_process_group "self-test process" "$pid" "$pid" "$identity" 20 20
  rm -rf "$fixture"
  if owned_group_is_live "$pid"; then
    printf 'smoke-local-daemon: owned process group self-test leaked pgid %s\n' \
      "$pid" >&2
    return 1
  fi
  printf '%s\n' "smoke-local-daemon: owned process group self-test passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test_scoped_worker_pids
  self_test_launch_identity
  self_test_platform_and_socket_guards
  if ! linux_process_primitives_available "$(uname -s)" /proc; then
    printf '%s\n' \
      "smoke-local-daemon: self-test requires Linux /proc identity and procps -C" >&2
    exit 1
  fi
  self_test_owned_process_group
  exit 0
fi

if ! linux_process_primitives_available "$(uname -s)" /proc; then
  printf '%s\n' \
    "smoke-local-daemon: Linux /proc identity and procps -C support are required" >&2
  exit 1
fi

tmp_template="${SPAWN_SMOKE_TMP_TEMPLATE:-/tmp/spawn-smoke.XXXXXX}"
tmp_dir="$(mktemp -d "$tmp_template")"
server_pid=""
server_pgid=""
server_identity=""
daemon_pid=""
daemon_pgid=""
daemon_identity=""
worker_audit_required=0

cleanup() {
  local status=$?
  local cleanup_safe=1
  local control_ready=0
  set +e
  if [[ "$status" != "0" ]]; then
    if [[ -f "${server_log:-}" ]]; then
      printf '%s\n' "---- server log ----" >&2
      tail -200 "$server_log" >&2 || true
    fi
    if [[ -f "${daemon_log:-}" ]]; then
      printf '%s\n' "---- daemon log ----" >&2
      tail -200 "$daemon_log" >&2 || true
    fi
  fi
  if [[ -n "${smoke_token:-}" && -n "${smoke_host_id:-}" && -n "${base_url:-}" ]] \
    && declare -F delete_all_smoke_agents >/dev/null; then
    if ! curl -fsS "$base_url/healthz" >/dev/null 2>&1; then
      if ! stop_server || ! start_server; then
        printf '%s\n' "smoke-local-daemon: cleanup could not restart the server" >&2
        cleanup_safe=0
        status=1
      fi
    fi

    if [[ "$cleanup_safe" == "1" ]]; then
      if [[ -n "${daemon_pgid:-}" ]] && owned_group_is_live "$daemon_pgid" \
        && wait_daemon_ready; then
        control_ready=1
      else
        if stop_daemon && start_daemon && wait_daemon_ready; then
          control_ready=1
        else
          printf '%s\n' "smoke-local-daemon: cleanup could not establish daemon readiness" >&2
          cleanup_safe=0
          status=1
        fi
      fi
    fi

    if [[ "$control_ready" == "1" ]] && ! delete_all_smoke_agents; then
      cleanup_safe=0
      status=1
    fi
  fi
  if [[ "${worker_audit_required:-0}" == "1" ]] \
    && declare -F wait_for_smoke_worker_teardown >/dev/null; then
    if ! wait_for_smoke_worker_teardown 200; then
      cleanup_safe=0
      status=1
    fi
  fi
  if declare -F stop_daemon >/dev/null; then
    if ! stop_daemon; then
      cleanup_safe=0
      status=1
    fi
  fi
  if declare -F stop_server >/dev/null; then
    if ! stop_server; then
      cleanup_safe=0
      status=1
    fi
  fi

  if [[ "${worker_audit_required:-0}" == "1" ]]; then
    local scoped_workers=""
    if ! scoped_workers="$(active_scoped_worker_pids)"; then
      cleanup_safe=0
      status=1
    elif [[ -n "$scoped_workers" ]]; then
      printf '%s\n' "smoke-local-daemon: scoped worker audit found live workers after cleanup" >&2
      cleanup_safe=0
      status=1
    fi
  fi
  if [[ -d "${worker_dir:-}" ]] \
    && [[ -n "$(find "$worker_dir" -maxdepth 1 -type s -print -quit 2>/dev/null)" ]]; then
    printf '%s\n' "smoke-local-daemon: scoped worker audit found sockets after cleanup" >&2
    cleanup_safe=0
    status=1
  fi

  if [[ "$cleanup_safe" == "1" ]]; then
    rm -rf "$tmp_dir"
  else
    printf 'smoke-local-daemon: preserving %s because deterministic cleanup did not complete\n' \
      "$tmp_dir" >&2
  fi
  exit "$status"
}
trap cleanup EXIT

port="$(
  python3 - <<'PY'
import socket

s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
)"
base_url="http://127.0.0.1:$port"
db_url="sqlite+aiosqlite:///$tmp_dir/spawn-smoke.db"
server_log="$tmp_dir/server.log"
daemon_log="$tmp_dir/daemon.log"
daemon_home="$tmp_dir/daemon-home"
agent_cwd="$tmp_dir/agent-cwd"
fake_bin="$tmp_dir/fake-bin"
worker_dir="$tmp_dir/workers"
mkdir -p "$daemon_home" "$agent_cwd" "$fake_bin" "$worker_dir"
validate_worker_socket_paths "$worker_dir"

cat >"$fake_bin/codex" <<'SH'
#!/usr/bin/env sh
set -eu

printf '%s\n' "fake-codex-ready"
python3 - <<'PY'
import json
import os
from pathlib import Path


def report(name: str, ok: bool) -> None:
    results[name] = ok
    print(f"fake-codex-{name}:{'ok' if ok else 'bad'}", flush=True)


results: dict[str, bool] = {}
required = [
    "SPAWN_AGENT_CONFIG_DIR",
    "SPAWN_SKILLS_FILE",
    "SPAWN_SKILLS_DIR",
    "CODEX_HOME",
]
missing = [name for name in required if not os.environ.get(name)]
report("env", not missing)

config_dir = Path(os.environ.get("SPAWN_AGENT_CONFIG_DIR", "/missing"))
skills_file = Path(os.environ.get("SPAWN_SKILLS_FILE", "/missing"))
skills_dir = Path(os.environ.get("SPAWN_SKILLS_DIR", "/missing"))
codex_home = Path(os.environ.get("CODEX_HOME", "/missing"))

skills = json.loads(skills_file.read_text(encoding="utf-8"))
config = (codex_home / "config.toml").read_text(encoding="utf-8")

skill_names = [skill["name"] for skill in skills]

print("fake-codex-skills:" + ",".join(skill_names), flush=True)
report("config-dir", config_dir.is_dir())
report("skills-json", skill_names == ["spawn-smoke-skill"])
report("skill-file", (skills_dir / "spawn-smoke-skill" / "SKILL.md").is_file())
report("codex-config-skill", "[[skills.config]]" in config)
report("codex-config-project", 'trust_level = "trusted"' in config)
(Path.cwd() / ".spawn-smoke-capabilities.json").write_text(
    json.dumps({"skills": skill_names, "checks": results}),
    encoding="utf-8",
)
PY

while IFS= read -r line; do
  printf 'fake-codex-echo:%s\n' "$line"
done
SH
chmod 755 "$fake_bin/codex"

start_server() {
  local identity uv_exe
  if [[ -n "$server_pid" || -n "$server_pgid" ]]; then
    printf 'smoke-local-daemon: refusing to start a second server; pid=%s pgid=%s\n' \
      "${server_pid:-unset}" "${server_pgid:-unset}" >&2
    return 1
  fi
  printf '%s\n' "smoke-local-daemon: starting server on $base_url"
  (
    cd server
    SPAWN_DATABASE_URL="$db_url" \
      SPAWN_USE_INPROCESS_PUBSUB=1 \
      SPAWN_JWT_SECRET=smoke-test-secret-with-enough-length \
      SPAWN_PUBLIC_URL="$base_url" \
      exec python3 -c \
        'import os, sys; os.setsid(); os.execvpe(sys.argv[1], sys.argv[1:], os.environ)' \
        uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$port"
  ) >>"$server_log" 2>&1 &
  server_pid=$!
  if ! claim_owned_process_group "server" "$server_pid"; then
    return 1
  fi
  server_pgid="$server_pid"
  uv_exe="$(readlink -f "$(command -v uv)")"
  identity="$(capture_owned_process_identity \
    "server" "$server_pid" "$uv_exe" \
    uv run uvicorn spawn_server.main:app --host 127.0.0.1 --port "$port")" || return 1
  server_identity="$identity"

  for _ in {1..80}; do
    if curl -fsS "$base_url/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  curl -fsS "$base_url/healthz" >/dev/null
}

stop_server() {
  if [[ -n "$server_pid" ]]; then
    if ! stop_owned_process_group \
      "server" "$server_pid" "$server_pgid" "$server_identity"; then
      return 1
    fi
    server_pid=""
    server_pgid=""
    server_identity=""
  fi
}

start_daemon() {
  local daemon_exe identity
  if [[ -n "$daemon_pid" || -n "$daemon_pgid" ]]; then
    printf 'smoke-local-daemon: refusing to start a second daemon; pid=%s pgid=%s\n' \
      "${daemon_pid:-unset}" "${daemon_pgid:-unset}" >&2
    return 1
  fi
  printf '%s\n' "smoke-local-daemon: starting spawnd for host $smoke_host_id"
  worker_audit_required=1
  HOME="$daemon_home" \
    SPAWN_DISABLE_KEYRING=1 \
    SPAWN_CONFIG_DIR="$daemon_home/.config/spawn" \
    SPAWND_WORKER_DIR="$worker_dir" \
    PATH="$fake_bin:$PATH" \
    python3 -c \
      'import os, sys; os.setsid(); os.execvpe(sys.argv[1], sys.argv[1:], os.environ)' \
      daemon/target/debug/spawnd --server "$base_url" run \
    >>"$daemon_log" 2>&1 &
  daemon_pid=$!
  if ! claim_owned_process_group "daemon" "$daemon_pid"; then
    return 1
  fi
  daemon_pgid="$daemon_pid"
  daemon_exe="$(readlink -f daemon/target/debug/spawnd)"
  identity="$(capture_owned_process_identity \
    "daemon" "$daemon_pid" "$daemon_exe" \
    daemon/target/debug/spawnd --server "$base_url" run)" || return 1
  daemon_identity="$identity"
}

stop_daemon() {
  if [[ -n "$daemon_pid" ]]; then
    if ! stop_owned_process_group \
      "daemon" "$daemon_pid" "$daemon_pgid" "$daemon_identity"; then
      return 1
    fi
    daemon_pid=""
    daemon_pgid=""
    daemon_identity=""
  fi
}

wait_host_online() {
  python3 - "$base_url" "$smoke_token" "$smoke_host_id" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, host_id = sys.argv[1:]

for _ in range(100):
    req = urllib.request.Request(
        f"{base_url}/api/hosts/{host_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            host = json.loads(response.read().decode())
    except urllib.error.URLError:
        time.sleep(0.1)
        continue
    if host["status"] == "online":
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit("daemon did not come online")
PY
}

wait_daemon_ready() {
  python3 - "$base_url" "$smoke_token" "$smoke_host_id" <<'PY'
import sys
import time
import urllib.error
import urllib.request

base_url, token, host_id = sys.argv[1:]
deadline = time.monotonic() + 20
last = "no readiness attempt"

while time.monotonic() < deadline:
    req = urllib.request.Request(
        f"{base_url}/api/hosts/{host_id}/control/ping",
        headers={"Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            body = response.read()
        if response.status == 204 and body == b"":
            raise SystemExit(0)
        last = f"malformed control ping response: status={response.status} body={body!r}"
    except urllib.error.HTTPError as error:
        last = f"HTTP {error.code}: {error.read().decode()}"
    except (TimeoutError, urllib.error.URLError) as error:
        last = repr(error)
    time.sleep(0.1)

raise SystemExit(f"daemon control path did not become ready: {last}")
PY
}

delete_all_smoke_agents() {
  python3 - "$base_url" "$smoke_token" "$smoke_host_id" <<'PY'
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

base_url, token, host_id = sys.argv[1:]
headers = {"Authorization": f"Bearer {token}"}
query = urllib.parse.urlencode({"host_id": host_id, "include_archived": "true"})
req = urllib.request.Request(f"{base_url}/api/agents?{query}", headers=headers)
with urllib.request.urlopen(req, timeout=10) as response:
    agents = json.loads(response.read().decode())

failures = []
for agent in agents:
    agent_id = agent.get("id")
    if not isinstance(agent_id, str):
        failures.append(f"invalid agent identity: {agent!r}")
        continue
    req = urllib.request.Request(
        f"{base_url}/api/agents/{agent_id}", headers=headers, method="DELETE"
    )
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except urllib.error.HTTPError as error:
        if error.code != 404:
            failures.append(f"{agent_id}: HTTP {error.code} {error.read().decode()}")

if failures:
    raise SystemExit("smoke agent cleanup failed: " + "; ".join(failures))
PY
}

wait_for_smoke_worker_teardown() {
  local attempts="${1:-200}"
  local pids sockets
  for ((attempt = 0; attempt < attempts; attempt++)); do
    if ! pids="$(active_scoped_worker_pids)"; then
      return 1
    fi
    sockets="$(find "$worker_dir" -maxdepth 1 -type s -print -quit 2>/dev/null)"
    if [[ -z "$pids" && -z "$sockets" ]]; then
      return 0
    fi
    sleep 0.05
  done
  if ! pids="$(active_scoped_worker_pids)"; then
    return 1
  fi
  sockets="$(find "$worker_dir" -maxdepth 1 -type s -print 2>/dev/null)"
  printf 'smoke-local-daemon: scoped worker teardown timed out; pids=%s sockets=%s\n' \
    "${pids:-none}" "${sockets:-none}" >&2
  return 1
}

wait_agent_running() {
  local agent_id="$1"
  python3 - "$base_url" "$smoke_token" "$agent_id" <<'PY'
import json
import sys
import time
import urllib.error
import urllib.request

base_url, token, agent_id = sys.argv[1:]
last = None
for _ in range(120):
    req = urllib.request.Request(
        f"{base_url}/api/agents/{agent_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            last = json.loads(response.read().decode())
    except (urllib.error.HTTPError, urllib.error.URLError):
        time.sleep(0.1)
        continue
    if last.get("status") == "running":
        raise SystemExit(0)
    time.sleep(0.1)
raise SystemExit(f"agent did not reach running state; last={last!r}")
PY
}

wait_file_contains() {
  local path="$1"
  local expected="$2"
  for _ in {1..120}; do
    if [[ -f "$path" ]] && grep -F "$expected" "$path" >/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  printf 'smoke-local-daemon: %s did not contain %s\n' "$path" "$expected" >&2
  return 1
}

printf '%s\n' "smoke-local-daemon: building spawnd"
(cd daemon && cargo build --locked >/dev/null)

printf '%s\n' "smoke-local-daemon: preparing database"
(
  cd server
  SPAWN_DATABASE_URL="$db_url" \
    SPAWN_USE_INPROCESS_PUBSUB=1 \
    SPAWN_JWT_SECRET=smoke-test-secret-with-enough-length \
    SPAWN_PUBLIC_URL="$base_url" \
    uv run python - <<'PY'
import asyncio

import spawn_server.models  # noqa: F401
from spawn_server.db import Base, dispose_engine, get_engine, init_engine


async def main() -> None:
    init_engine()
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await dispose_engine()


asyncio.run(main())
PY
)

start_server

printf '%s\n' "smoke-local-daemon: provisioning daemon credentials"
creds="$(
  python3 - "$base_url" "$daemon_home" <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

base_url, home = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None, token: str | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base_url + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


signup = request(
    "POST",
    "/api/auth/signup",
    {"email": "smoke@example.com", "password": "passpasspass"},
)
token = signup["access_token"]
start = request(
    "POST",
    "/api/auth/device/start",
    {
        "host_name": "smoke-host",
        "os": sys.platform,
        "arch": "smoke",
        "version": "smoke",
    },
)
request("POST", "/api/auth/device/approve", {"user_code": start["user_code"]}, token)
poll = request("POST", "/api/auth/device/poll", {"device_code": start["device_code"]})

creds = {
    "access_token": poll["access_token"],
    "host_id": poll["host_id"],
    "server_url": base_url,
}
for config_dir in (
    os.path.join(home, ".config", "spawn"),
    os.path.join(home, "Library", "Application Support", "spawn"),
):
    os.makedirs(config_dir, exist_ok=True)
    with open(os.path.join(config_dir, "credentials.json"), "w", encoding="utf-8") as handle:
        json.dump(creds, handle)

print(json.dumps({"token": token, "host_id": poll["host_id"]}))
PY
)"
smoke_token="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])' <<<"$creds")"
smoke_host_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["host_id"])' <<<"$creds")"

start_daemon
wait_host_online
wait_daemon_ready

printf '%s\n' "smoke-local-daemon: verifying skills reach a real daemon-launched codex agent"
python3 - "$base_url" "$smoke_token" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base_url, token = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


request(
    "POST",
    "/api/skills",
    {
        "name": "spawn-smoke-skill",
        "description": "Smoke skill",
        "content": "# Smoke Skill\nUse this skill during the smoke test.",
        "enabled_by_default": True,
    },
)
PY

agent="$(
  python3 - "$base_url" "$smoke_token" "$smoke_host_id" "$agent_cwd" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base_url, token, host_id, cwd = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


created = request(
    "POST",
    "/api/agents",
    {
        "host_id": host_id,
        "name": "fake-codex-capabilities",
        "cwd": cwd,
        "argv": ["codex", "--yolo"],
    },
)
print(json.dumps({"agent_id": created["id"]}))
PY
)"
smoke_agent_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["agent_id"])' <<<"$agent")"
wait_agent_running "$smoke_agent_id"
capability_report="$agent_cwd/.spawn-smoke-capabilities.json"
wait_file_contains "$capability_report" '"skills": ["spawn-smoke-skill"]'
python3 - "$capability_report" <<'PY'
import json
import sys

report = json.loads(open(sys.argv[1], encoding="utf-8").read())
if not report["checks"] or not all(report["checks"].values()):
    raise SystemExit(f"fake codex capability checks failed: {report!r}")
PY
curl -fsS -X DELETE \
  -H "Authorization: Bearer $smoke_token" \
  "$base_url/api/agents/$smoke_agent_id" >/dev/null
smoke_agent_id=""
wait_for_smoke_worker_teardown 200
wait_daemon_ready

printf '%s\n' "smoke-local-daemon: creating persistent shell agent"
agent="$(
  python3 - "$base_url" "$smoke_token" "$smoke_host_id" "$agent_cwd" <<'PY'
import json
import sys
import urllib.error
import urllib.request

base_url, token, host_id, cwd = sys.argv[1:]


def request(method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except urllib.error.HTTPError as error:
        raise SystemExit(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


created = request(
    "POST",
    "/api/agents",
    {
        "host_id": host_id,
        "cwd": cwd,
        "argv": [
            "sh",
            "-lc",
            "printf 'spawn-smoke-ready\\n' > .spawn-smoke-ready; printf 'spawn-smoke-ready\\n'; while :; do sleep 1; done",
        ],
    },
)
print(json.dumps({"agent_id": created["id"]}))
PY
)"
smoke_agent_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["agent_id"])' <<<"$agent")"
wait_agent_running "$smoke_agent_id"
wait_file_contains "$agent_cwd/.spawn-smoke-ready" "spawn-smoke-ready"

if [[ "${SPAWN_SMOKE_INJECT_FAILURE_AFTER_PERSISTENT_READY:-0}" == "1" ]]; then
  printf '%s\n' "smoke-local-daemon: injecting cleanup failure after persistent readiness" >&2
  false
fi

printf '%s\n' "smoke-local-daemon: verifying concurrent worker lifecycles stay isolated"
python3 - "$base_url" "$smoke_token" "$smoke_host_id" "$agent_cwd" <<'PY'
import concurrent.futures
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request

base_url, token, host_id, root_cwd = sys.argv[1:]
agent_ids: list[str] = []


def request(method: str, path: str, payload: dict | None = None) -> dict:
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path,
        data=data,
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read()
            return json.loads(body.decode() or "{}")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{method} {path} failed: {error.code} {error.read().decode()}") from error


def wait_for(agent_id: str, path: Path, marker: str) -> None:
    last = None
    for _ in range(120):
        agent = request("GET", f"/api/agents/{agent_id}")
        last = agent
        if agent.get("status") == "running" and path.is_file() and path.read_text() == marker:
            return
        time.sleep(0.1)
    raise RuntimeError(f"agent {agent_id} did not become isolated and ready; last={last!r}")


def exercise(index: int) -> str:
    ready = f"concurrent-{index}-ready"
    cwd = Path(root_cwd) / f"concurrent-{index}"
    created = request(
        "POST",
        "/api/agents",
        {
            "host_id": host_id,
            "name": f"concurrent-{index}",
            "cwd": str(cwd),
            "argv": [
                "sh",
                "-lc",
                f"printf '{ready}' > .spawn-worker-ready; while :; do sleep 1; done",
            ],
            "create_cwd": True,
        },
    )
    agent_id = created["id"]
    agent_ids.append(agent_id)
    wait_for(agent_id, cwd / ".spawn-worker-ready", ready)
    return agent_id


try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(exercise, range(4)))
    ready_files = sorted(Path(root_cwd).glob("concurrent-*/.spawn-worker-ready"))
    if len(ready_files) != 4 or len({path.read_text() for path in ready_files}) != 4:
        raise RuntimeError(f"concurrent worker markers were not isolated: {ready_files!r}")
finally:
    for agent_id in list(agent_ids):
        try:
            request("DELETE", f"/api/agents/{agent_id}")
        except Exception:
            pass
PY

printf '%s\n' "smoke-local-daemon: verifying agent survives daemon restart"
stop_daemon
start_daemon
wait_host_online
wait_daemon_ready
wait_agent_running "$smoke_agent_id"
wait_file_contains "$agent_cwd/.spawn-smoke-ready" "spawn-smoke-ready"

printf '%s\n' "smoke-local-daemon: verifying daemon reconnects after server restart"
stop_server
start_server
wait_host_online
wait_daemon_ready
wait_agent_running "$smoke_agent_id"
wait_file_contains "$agent_cwd/.spawn-smoke-ready" "spawn-smoke-ready"

curl -fsS -X DELETE \
  -H "Authorization: Bearer $smoke_token" \
  "$base_url/api/agents/$smoke_agent_id" >/dev/null
smoke_agent_id=""

printf '%s\n' "smoke-local-daemon: passed"
