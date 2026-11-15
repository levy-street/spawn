#!/usr/bin/env bash
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_root="${NO_SERVER_AGENT_UPLOAD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$repo_root"

inventory_files() {
  local roots=(server/spawn_server daemon/src web/src)
  local existing=()
  local root
  for root in "${roots[@]}"; do
    [[ -e "$root" ]] && existing+=("$root")
  done
  if ((${#existing[@]} == 0)); then
    printf '%s\n' "no-server-agent-upload: production source inventory is empty" >&2
    return 1
  fi
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -z --cached --others --exclude-standard -- "${existing[@]}"
  else
    rg --files -0 "${existing[@]}"
  fi
}

rg_matches() {
  local pattern="$1"
  shift
  local output status
  set +e
  output="$(rg -n --color never "$pattern" "$@" 2>&1)"
  status=$?
  set -e
  if ((status > 1)); then
    printf 'no-server-agent-upload: source scan failed (rg=%s):\n%s\n' "$status" "$output" >&2
    return 2
  fi
  [[ $status == 0 ]] && printf '%s\n' "$output"
  return 0
}

required_once() {
  local file="$1"
  local sentinel="$2"
  local count status
  set +e
  count="$(rg -F -c --color never "$sentinel" "$file" 2>/dev/null)"
  status=$?
  set -e
  if ((status > 1)); then
    printf 'no-server-agent-upload: required-handler scan failed for %s\n' "$file" >&2
    return 1
  fi
  if [[ "$count" != "1" ]]; then
    printf 'no-server-agent-upload: required retired-leg handler missing or duplicated in %s: %s\n' \
      "$file" "$sentinel" >&2
    return 1
  fi
}

allowed_server_sentinel() {
  local match="$1"
  case "$match" in
    server/spawn_server/ws/browser.py:*'if ftype == "upload":' | \
    server/spawn_server/ws/browser.py:*'retired server-visible agent upload frame; closing' | \
    server/spawn_server/ws/browser.py:*'reason="agent uploads belong on spawn.ctl"' | \
    server/spawn_server/ws/daemon.py:*'elif ftype == "agent.uploaded":' | \
    server/spawn_server/ws/daemon.py:*'retired server-visible agent upload acknowledgement; closing' | \
    server/spawn_server/ws/daemon.py:*'reason="agent upload acknowledgements belong on spawn.ctl"' | \
    server/spawn_server/ws/daemon.py:*'if obj.get("code") == "upload_failed":' | \
    server/spawn_server/ws/daemon.py:*'retired server-visible agent upload error; closing' | \
    server/spawn_server/ws/daemon.py:*'reason="agent upload errors belong on spawn.ctl"') return 0 ;;
    *) return 1 ;;
  esac
}

allowed_daemon_endpoint_bytes() {
  local match="$1"
  local file="${match%%:*}"
  local remainder="${match#*:}"
  local match_line="${remainder%%:*}"
  local content="${remainder#*:}"
  [[ "$match_line" =~ ^[0-9]+$ ]] || return 1
  [[ "$file" == "daemon/src/host_direct.rs" ]] || return 1
  [[ "$content" == '                "bytes_b64": STANDARD.encode(bytes),' || \
    "$content" == '    let encoded = object.get("bytes_b64")?.as_str()?;' ]]
}

allowed_web_endpoint_bytes() {
  local match="$1"
  local file="${match%%:*}"
  local remainder="${match#*:}"
  local match_line="${remainder%%:*}"
  local content="${remainder#*:}"
  [[ "$match_line" =~ ^[0-9]+$ ]] || return 1
  [[ "$file" == "web/src/lib/hostControl.ts" ]] || return 1
  [[ "$content" == '            bytes_b64: bytesToBase64(chunk),' || \
    "$content" == '      bytes_b64?: string;' || \
    "$content" == '            message.bytes_b64,' || \
    "$content" == '        if (message.sequence !== incoming.nextSequence || typeof message.bytes_b64 !== "string") {' || \
    "$content" == '          bytes = base64ToBytes(message.bytes_b64);' ]]
}

allowed_web_test_bytes() {
  local match="$1"
  [[ "${match%%:*}" == "web/src/lib/hostControl.test.ts" ]]
}

required_exact_line_once() {
  local file="$1"
  local expected="$2"
  local count
  count="$(awk -v expected="$expected" '$0 == expected { count += 1 } END { print count + 0 }' "$file")"
  if [[ "$count" != "1" ]]; then
    printf 'no-server-agent-upload: required privileged endpoint line missing or duplicated in %s: %s\n' \
      "$file" "$expected" >&2
    return 1
  fi
}

required_line_between() {
  local file="$1"
  local expected="$2"
  local start="$3"
  local end="$4"
  awk -v expected="$expected" -v start="$start" -v end="$end" '
    index($0, start) { inside = 1; next }
    inside && index($0, end) { inside = 0 }
    inside && $0 == expected { count += 1 }
    END { exit count == 1 ? 0 : 1 }
  ' "$file" || {
    printf 'no-server-agent-upload: privileged endpoint line escaped its reviewed function in %s: %s\n' \
      "$file" "$expected" >&2
    return 1
  }
}

check_privileged_endpoint_structure() {
  local daemon_file="daemon/src/host_direct.rs"
  local web_file="web/src/lib/hostControl.ts"
  local daemon_encode='                "bytes_b64": STANDARD.encode(bytes),'
  local daemon_decode='    let encoded = object.get("bytes_b64")?.as_str()?;'
  local web_encode='            bytes_b64: bytesToBase64(chunk),'
  local web_type='      bytes_b64?: string;'
  local web_late='            message.bytes_b64,'
  local web_check='        if (message.sequence !== incoming.nextSequence || typeof message.bytes_b64 !== "string") {'
  local web_decode='          bytes = base64ToBytes(message.bytes_b64);'
  local line

  for line in "$daemon_encode" "$daemon_decode"; do
    required_exact_line_once "$daemon_file" "$line" || return 1
  done
  required_line_between "$daemon_file" "$daemon_encode" \
    'async fn publish_read_chunk(' 'pub(crate) fn decode_write_chunk(' || return 1
  required_line_between "$daemon_file" "$daemon_decode" \
    'pub(crate) fn decode_write_chunk(' 'Some(HostWriteChunk {' || return 1

  python3 - "$repo_root" <<'PY'
import hashlib
import os
import re
import sys

root = sys.argv[1]
direct_path = os.path.join(root, "daemon/src/host_direct.rs")
signal_path = os.path.join(root, "daemon/src/host_signal.rs")
control_path = os.path.join(root, "daemon/src/host_control.rs")
rtc_path = os.path.join(root, "daemon/src/rtc.rs")
main_path = os.path.join(root, "daemon/src/main.rs")

with open(direct_path, "rb") as source:
    direct_bytes = source.read()
direct = direct_bytes.decode()
with open(signal_path, "rb") as source:
    signal_bytes = source.read()
signal = signal_bytes.decode()
with open(control_path, encoding="utf-8") as source:
    control = source.read()
with open(rtc_path, encoding="utf-8") as source:
    rtc = source.read()
with open(main_path, encoding="utf-8") as source:
    main = source.read()

expected_direct_hash = "f4dbb1951394b94d6327dfb31b62f308e66d636385e077539180ef51024ad32b"
if hashlib.sha256(direct_bytes).hexdigest() != expected_direct_hash:
    raise SystemExit(
        "no-server-agent-upload: protected host direct module changed; review its complete capability inventory"
    )

expected_signal_hash = "2db23387b1baf49a214f6c26e7dbdbc1ab7648ff1e549edac4c0f041a7f0a7da"
if hashlib.sha256(signal_bytes).hexdigest() != expected_signal_hash:
    raise SystemExit(
        "no-server-agent-upload: fixed host signaling capability changed; review its complete implementation"
    )
if main.count("mod host_signal;") != 1 or main.count("mod host_direct;") != 1:
    raise SystemExit("no-server-agent-upload: protected module resolution changed")
if re.search(r"#\s*\[\s*path\s*=.*?\]", main, re.DOTALL):
    raise SystemExit("no-server-agent-upload: path-based module substitution is not allowed")

if "crate::" in direct:
    raise SystemExit("no-server-agent-upload: protected host direct module gained a crate-local dependency")
direct_api = re.findall(r"pub\(crate\)\s+(?:async\s+)?fn\s+(\w+)", direct)
if direct_api != ["new", "transport", "publish", "publish_read_chunk", "decode_write_chunk"]:
    raise SystemExit(
        "no-server-agent-upload: protected host direct API changed: " + ", ".join(direct_api)
    )
if direct.count("dc: Arc<RTCDataChannel>") != 2 or direct.count("self.dc.send_text(") != 1:
    raise SystemExit("no-server-agent-upload: protected host direct transport ownership changed")

expected_control_imports = """use crate::host_desktop::DesktopAction;
use crate::host_direct::{decode_write_chunk, HostDirectChannel};
use crate::host_files::{
    HostFileOperations, HostFileService, PendingWrite, WriteSessionGuard, MAX_FILE_BYTES,
    STREAM_CHUNK_BYTES,
};
use crate::host_signal::HostConnectedSignal;"""
if control.count(expected_control_imports) != 1:
    raise SystemExit("no-server-agent-upload: protected host-control dependency list changed")
# Reviewed allowlist. host_desktop/host_metrics/host_mime/host_preview are the
# workspaces-overhaul host capabilities: all four are host-local and reachable
# only over the direct RTC data channel — none of them imports the server
# WebSocket or any Outbound frame, so no agent or file content can reach the
# server through them (docs/TRUST.md). host_desktop has its own dedicated guard
# in scripts/check-host-desktop-launch.sh. host_transcripts (2026-09-23) only
# *locates* an agent's own transcript files under the home root and answers on
# the same data channel; the bytes are then read with fs.read. It is pinned
# below to depend on host_files alone, so it cannot reach a server transport.
# host_conv (2026-10-03) answers conv.inspect: which conversation a window is
# in, read from the window's process tree and the agent's own live-session
# registry. It is handed only a pid resolver for the device's windows, never
# the session registry, and is pinned below to depend on nothing crate-local
# and to execute nothing. Since 2026-11-12 it also reads which Codex thread
# files a window's Codex holds open (and each held rollout's first line), and
# keeps one note per Codex window, the thread id it last named, in a folder
# the caller hands it (spawnd's own <config>/conversations/), removing a
# window's note when the server stops the window for good; it writes nothing
# else. Since 2026-11-15 it also carries, for `conv.launch`, a handle that
# asks whether a window's Codex accepts `--no-daemon`: handed in by rtc_pair
# and answered by codex_launch (pinned below), run by nothing here.
if set(re.findall(r"crate::(\w+)", control)) != {
    "host_conv",
    "host_desktop",
    "host_direct",
    "host_files",
    "host_metrics",
    "host_mime",
    "host_preview",
    "host_signal",
    "host_transcripts",
}:
    raise SystemExit("no-server-agent-upload: protected host-control gained an unreviewed crate dependency")
transcripts_path = os.path.join(root, "daemon/src/host_transcripts.rs")
with open(transcripts_path, encoding="utf-8") as source:
    transcripts = source.read()
# config (2026-10-03) only names spawnd's own per-window homes, where a skilled
# window's Codex rollouts from before the linked CODEX_HOME still live; it is
# paths, pinned below to reach nothing but the platform's directory helpers.
if set(re.findall(r"crate::(\w+)", transcripts)) != {"config", "host_files"}:
    raise SystemExit("no-server-agent-upload: host transcript locator gained an unreviewed crate dependency")
if re.search(r"\b(?:WsOutbound|SessionSink|out_tx|reqwest|TcpStream|UdpSocket|mpsc)\b", transcripts):
    raise SystemExit("no-server-agent-upload: host transcript locator gained a transport")
with open(os.path.join(root, "daemon/src/config.rs"), encoding="utf-8") as source:
    config_source = source.read()
if set(re.findall(r"crate::(\w+)", config_source)) - {"platform"}:
    raise SystemExit("no-server-agent-upload: the locator's config dependency gained a crate dependency")
if re.search(
    r"\b(?:WsOutbound|SessionSink|out_tx|reqwest|tungstenite|TcpStream|UdpSocket|mpsc)\b",
    config_source,
):
    raise SystemExit("no-server-agent-upload: the locator's config dependency gained a transport")
conv_path = os.path.join(root, "daemon/src/host_conv.rs")
with open(conv_path, encoding="utf-8") as source:
    conv = source.read()
conv_runtime = conv.split("#[cfg(all(test, unix))]\nmod tests {")[0]
if set(re.findall(r"crate::(\w+)", conv)):
    raise SystemExit("no-server-agent-upload: conversation inspector gained a crate dependency")
if re.search(r"\b(?:WsOutbound|SessionSink|out_tx|reqwest|TcpStream|UdpSocket|mpsc)\b", conv):
    raise SystemExit("no-server-agent-upload: conversation inspector gained a transport")
if re.search(
    r"process::Command|\bCommand::new\b|\b(?:posix_spawnp?|execv[pe]*|execl[pe]*|fexecve|v?fork|system)\s*\(",
    conv_runtime,
):
    raise SystemExit("no-server-agent-upload: conversation inspector may not execute anything")
# The inspector's runtime is everything before its test module, and that
# module must be the file's last item: anything placed after it is refused
# rather than left unread.
conv_test_marker = "#[cfg(all(test, unix))]\nmod tests {"


def test_module_is_last(text):
    """One test module, ending the file: its closing brace is the only line at
    the top level after the marker and the last line with anything on it, so
    nothing — indented or not — follows it."""
    if text.count(conv_test_marker) != 1:
        return False
    lines = [line for line in text.split(conv_test_marker, 1)[1].splitlines() if line.strip()]
    return bool(lines) and lines[-1] == "}" and [
        line for line in lines if not line[0].isspace()
    ] == ["}"]


if not test_module_is_last(conv):
    raise SystemExit("no-server-agent-upload: conversation inspector code sits after its test module")
# Every way the inspector's runtime changes a file, counted: the notes folder
# (one DirBuilder, made 0700), one new file opened for writing, one rename
# over the last note, and two removals (a failed note's temporary file, and
# the note of a window that is forgotten). Enforced besides, as patterns:
# no std write, copy, link, truncate, create_dir, removal or re-permission
# beyond those counts; no `nix` module but `nix::libc`, no `extern` block,
# and no libc name outside the read-only list below (nor a glob, group or
# alias import of libc that would hide one); and every `custom_flags` is
# O_NOFOLLOW, optionally with O_NONBLOCK.
conv_mutations = {
    r"\.write\(true\)": 1,
    r"\.create_new\(true\)": 1,
    r"\bDirBuilder::new\(": 1,
    r"\bset_permissions\b": 1,
    r"\brename\s*\(": 1,
    r"\bremove_file\b": 2,
}
conv_libc_reads = {
    "O_NOFOLLOW", "O_NONBLOCK", "PROC_PIDLISTFDS", "PROC_PIDTBSDINFO",
    "PROX_FDTYPE_VNODE", "c_int", "c_void", "off_t", "pid_t", "proc_bsdinfo",
    "proc_fdinfo", "proc_listchildpids", "proc_pidfdinfo", "proc_pidinfo",
    "proc_pidpath", "vnode_info_path",
}
conv_flags = re.findall(r"custom_flags\(([^)]*)\)", conv_runtime)
if (
    any(
        len(re.findall(pattern, conv_runtime)) != expected
        for pattern, expected in conv_mutations.items()
    )
    or re.search(
        r"\bfs::write\b|\bFile::create\b|\bFile::options\b|\.append\(|\.truncate\(|"
        r"\.create\(true\)|\bcreate_dir(?:_all)?\b|\bcopy\s*\(|\bremove_dir|\bhard_link\b|"
        r"\bsymlink\s*\(|\bset_len\b|\bset_modified\b|\bset_times\b|\b(?:f|l)?chown\b|"
        r"\bfchmod\b|\bunlink(?:at)?\b|\bnix::(?!libc\b)\w+|\bextern\s+\"|"
        r"\blibc\s*::\s*[{*]|\blibc\s+as\b",
        conv_runtime,
    )
    or set(re.findall(r"\blibc::(\w+)", conv_runtime)) - conv_libc_reads
    or not conv_flags
    or any(
        not re.fullmatch(
            r"\s*nix::libc::O_NOFOLLOW(?:\s*\|\s*nix::libc::O_NONBLOCK)?\s*", flags
        )
        for flags in conv_flags
    )
):
    raise SystemExit("no-server-agent-upload: conversation inspector writes more than its window notes")
# codex_launch (2026-11-15) runs one program, when a pair-admitted device
# asks `conv.launch` just before it types Codex into a window: `codex
# --no-daemon --version`, by the path the window's own launch environment
# finds, in the window's folder, with a timeout. A device that can do that can
# already type into the window; nothing else triggers it and nothing is kept.
# Pinned to that one invocation, to the two run helpers it uses, to no
# transport and no write, with its test module last.
launch_path = os.path.join(root, "daemon/src/codex_launch.rs")
with open(launch_path, encoding="utf-8") as source:
    launch = source.read()
if not test_module_is_last(launch):
    raise SystemExit("no-server-agent-upload: codex launch probe code sits after its test module")
launch_runtime = launch.split(conv_test_marker)[0]
if set(re.findall(r"crate::(\w+)", launch)) != {"run"} or set(
    re.findall(r"crate::run::(\w+)", launch)
) != {"resolve_program_in_env", "run_program_capture_in"}:
    raise SystemExit("no-server-agent-upload: codex launch probe gained a crate dependency")
if re.search(r"\b(?:WsOutbound|SessionSink|out_tx|reqwest|TcpStream|UdpSocket|mpsc)\b", launch):
    raise SystemExit("no-server-agent-upload: codex launch probe gained a transport")
if (
    launch_runtime.count("run_program_capture_in(") != 1
    or launch_runtime.count('const PROGRAM: &str = "codex";') != 1
    or launch_runtime.count('const PROBE_ARGS: [&str; 2] = ["--no-daemon", "--version"];') != 1
    or re.search(
        r"process::Command|\bCommand::new\b|\b(?:posix_spawnp?|execv[pe]*|execl[pe]*|fexecve|v?fork|system)\s*\(|"
        r"\bfs::write\b|\bFile::create\b|\bOpenOptions\b|\bremove_(?:file|dir)|\brename\b|"
        r"\bset_permissions\b|\bcreate_dir|\bnix::|\blibc::",
        launch_runtime,
    )
):
    raise SystemExit("no-server-agent-upload: codex launch probe runs or writes more than its one version check")
if re.search(r"\b(?:WsOutbound|SessionSink|out_tx)\b|crate::(?:pty|ws|run)\b", control):
    raise SystemExit("no-server-agent-upload: raw server transport entered protected host-control")
sender_types = set(re.findall(r"mpsc::Sender<([^>]+)>", control))
if sender_types != {"ReadSignal", "WriteCleanup"}:
    raise SystemExit(
        "no-server-agent-upload: protected host-control sender inventory changed: "
        + ", ".join(sorted(sender_types))
    )
# The parent receives only a retirement handle: it can observe a closed bit
# and revoke effects, but cannot read protected values or publish to signaling.
expected_control_exports = [
    "pub(crate) struct Lifetime {",
    "pub(crate) fn is_retired(&self) -> bool {",
    "pub(crate) fn retire(&self) {",
    """pub(crate) fn install(
    dc: Arc<RTCDataChannel>,
    connected_signal: HostConnectedSignal,
    files_override: Option<Arc<HostFileService>>,
    pair: Option<crate::host_conv::WindowShells>,
) -> Arc<Lifetime> {""",
]
control_exports = list(
    re.finditer(r"(?m)^[ \t]*(?P<export>pub(?:\([^\n)]*\))?\s+)", control)
)
if len(control_exports) != len(expected_control_exports) or any(
    not control.startswith(expected, actual.start("export"))
    for expected, actual in zip(expected_control_exports, control_exports)
):
    raise SystemExit(
        "no-server-agent-upload: protected host-control exported surface changed"
    )
# Pin the private state and entire retirement implementation as well. Public
# trait methods and derives need no `pub` keyword, so the export list alone
# cannot detect them. The symbol inventory below rejects additional impls in
# this or another module, just as it does for HostConnectedSignal. Reviewed
# 2026-10-03: Context gained `pair`, the pid resolver for a pair-admitted
# channel's windows (host_conv::WindowShells); it publishes nothing.
lifetime_block = control[control.index("struct Context {"):control.index("impl Context {")]
if hashlib.sha256(lifetime_block.encode()).hexdigest() != (
    "8d64655df14d5488df14884d0d56c91d1f51f0f6ccbd1e8c3d9ab70e5943a908"
):
    raise SystemExit("no-server-agent-upload: protected host retirement capability changed")
if control.count("connected_signal: HostConnectedSignal") != 1:
    raise SystemExit("no-server-agent-upload: narrow connected signal capability changed")
if len(re.findall(r"\bconnected_signal\b", control)) != 4:
    raise SystemExit("no-server-agent-upload: connected signal was aliased or used outside its fixed topology")
signal_calls = re.findall(r"\bconnected_signal\s*\.\s*(\w+)\s*\(", control)
if signal_calls != ["clone", "publish"] or control.count("connected_signal.publish()") != 1:
    raise SystemExit("no-server-agent-upload: connected signal publication topology changed")
expected_symbol_counts = {
    "daemon/src/host_signal.rs": 2,
    "daemon/src/host_control.rs": 2,
    "daemon/src/rtc.rs": 2,
}
found_symbol_counts = {}
expected_lifetime_counts = {
    "daemon/src/host_control.rs": 4,
    "daemon/src/rtc.rs": 1,
    "daemon/src/rtc_pair.rs": 2,
}
found_lifetime_counts = {}
daemon_root = os.path.join(root, "daemon/src")
for directory, names, files in os.walk(daemon_root):
    names[:] = [name for name in names if name != "target"]
    for name in files:
        if not name.endswith(".rs"):
            continue
        path = os.path.join(directory, name)
        with open(path, encoding="utf-8") as source:
            text = source.read()
        count = len(re.findall(r"\bHostConnectedSignal\b", text))
        lifetime_count = len(re.findall(r"\bLifetime\b", text))
        if lifetime_count:
            relative = os.path.relpath(path, root).replace(os.sep, "/")
            found_lifetime_counts[relative] = lifetime_count
        if count:
            relative = os.path.relpath(path, root).replace(os.sep, "/")
            found_symbol_counts[relative] = count
if found_lifetime_counts != expected_lifetime_counts:
    raise SystemExit("no-server-agent-upload: host retirement capability escaped its fixed inventory")
if found_symbol_counts != expected_symbol_counts:
    raise SystemExit(
        "no-server-agent-upload: host connected capability escaped its fixed module/use inventory: "
        + repr(found_symbol_counts)
    )
if rtc.count("use crate::host_signal::HostConnectedSignal;") != 1 or rtc.count(
    "HostConnectedSignal::new(signaling, signal_id, binding)"
) != 1:
    raise SystemExit("no-server-agent-upload: connected signal construction topology changed")
PY

  for line in "$web_encode" "$web_type" "$web_late" "$web_check" "$web_decode"; do
    required_exact_line_once "$web_file" "$line" || return 1
  done
  required_line_between "$web_file" "$web_encode" \
    'async writeStream(' 'async transferFileTo(' || return 1
  for line in "$web_type" "$web_late" "$web_check" "$web_decode"; do
    required_line_between "$web_file" "$line" \
      'private handleControlMessage(' 'private sendSignal(' || return 1
  done

  local receivers expected_receivers
  receivers="$(
    rg -o --color never '[A-Za-z_$][A-Za-z0-9_$?.]*\.send\(' "$web_file" \
      | sort \
      | uniq -c \
      | awk '{$1 = $1; print}'
  )"
  # ws.send( carries signalling only: the offer/answer/candidate frames, the
  # keepalive pong reply, and rtc.config.request (connection stream 8d2c960).
  # File bytes go over channel.send( / this.channel.send( — the direct data channel.
  expected_receivers=$'2 channel.send(\n1 this.channel.send(\n3 ws.send('
  if [[ "$receivers" != "$expected_receivers" ]]; then
    printf 'no-server-agent-upload: web host-control send topology changed; review direct vs signaling channels:\n%s\n' \
      "$receivers" >&2
    return 1
  fi
}

check_production_test_imports() {
  python3 - "$repo_root" <<'PY'
import os
import re
import sys

root = sys.argv[1]
patterns = (
    re.compile(r'''(?:import|export)\s+(?:type\s+)?[\w*$,\s{}]+?\s+from\s*["']([^"']+)["']'''),
    re.compile(r'''import\s*["']([^"']+)["']'''),
    re.compile(r'''(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)'''),
)
bad = []
source_root = os.path.join(root, "web/src")
for directory, names, files in os.walk(source_root):
    names[:] = [name for name in names if name not in {"node_modules", "__pycache__"}]
    for name in files:
        if not name.endswith((".ts", ".tsx")) or re.search(r"\.(?:test|spec)\.(?:ts|tsx)$", name):
            continue
        path = os.path.join(directory, name)
        with open(path, encoding="utf-8") as source:
            text = source.read()
        for pattern in patterns:
            if any(re.search(r"\.(?:test|spec)(?:[./]|$)", spec) for spec in pattern.findall(text)):
                bad.append(os.path.relpath(path, root))
                break
if bad:
    raise SystemExit(
        "no-server-agent-upload: production web source imports an exempt test module:\n"
        + "\n".join(sorted(bad))
    )
PY
}

check_assembled_aliases() {
  python3 - "$repo_root" <<'PY'
import os
import re
import sys

root = sys.argv[1]
forbidden = (
    "bytesb64",
    "agentupload",
    "agentuploaded",
    "uploadfailed",
    "uploadsaved",
    "uploaderror",
    "requestupload",
    "resolveupload",
)
string_re = re.compile(r'''["']([^"'\\]*(?:\\.[^"'\\]*)*)["']''')


def has_forbidden_literals(text: str) -> bool:
    values = string_re.findall(text)
    if len(values) < 2:
        return False
    joined = "".join(re.sub(r"[^a-z0-9]", "", value.lower()) for value in values)
    return any(token in joined for token in forbidden)


def matching_delimiter(text: str, start: int, opening: str, closing: str) -> int | None:
    depth = 0
    index = start
    quote = None
    block_comment = 0
    while index < len(text):
        char = text[index]
        following = text[index + 1] if index + 1 < len(text) else ""
        if block_comment:
            if char == "/" and following == "*":
                block_comment += 1
                index += 2
                continue
            if char == "*" and following == "/":
                block_comment -= 1
                index += 2
                continue
            index += 1
            continue
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
            index += 1
            continue
        if char == "/" and following == "/":
            newline = text.find("\n", index + 2)
            index = len(text) if newline < 0 else newline + 1
            continue
        if char == "/" and following == "*":
            block_comment = 1
            index += 2
            continue
        raw_string = re.match(r'(?:br|cr|r)(?P<hashes>#{0,255})"', text[index:])
        if raw_string:
            terminator = '"' + raw_string.group("hashes")
            raw_end = text.find(terminator, index + raw_string.end())
            if raw_end < 0:
                return None
            index = raw_end + len(terminator)
            continue
        if char == '"':
            quote = char
            index += 1
            continue
        if char == "'" and (
            (index + 2 < len(text) and text[index + 2] == "'")
            or (index + 3 < len(text) and following == "\\" and text[index + 3] == "'")
        ):
            quote = char
            index += 1
            continue
        if char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def cfg_is_test_only(expression: str) -> bool:
    expression = re.sub(r"\s+", "", expression)
    if expression == "test":
        return True
    if not expression.startswith("all(") or not expression.endswith(")"):
        return False
    operands = []
    current = []
    depth = 0
    for char in expression[4:-1]:
        if char == "," and depth == 0:
            operands.append("".join(current))
            current = []
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        current.append(char)
    operands.append("".join(current))
    return "test" in operands


def strip_rust_test_modules(text: str) -> str:
    pattern = re.compile(
        r'#\s*\[\s*cfg\s*\((?P<cfg>[^\]]*)\)\s*\]\s*'
        r'(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{'
    )
    masked = list(text)
    for match in list(pattern.finditer(text)):
        if not cfg_is_test_only(match.group("cfg")):
            continue
        opening = text.find("{", match.start(), match.end())
        closing = matching_delimiter(text, opening, "{", "}")
        if closing is None:
            raise SystemExit("no-server-agent-upload: unbalanced test-only Rust module")
        for index in range(match.start(), closing + 1):
            if masked[index] != "\n":
                masked[index] = " "
    return "".join(masked)


def scan(path: str, text: str) -> None:
    if path.endswith(".rs"):
        text = strip_rust_test_modules(text)
    for match in re.finditer(r"concat!\s*\(", text):
        opening = text.find("(", match.start(), match.end())
        closing = matching_delimiter(text, opening, "(", ")")
        if closing is not None and has_forbidden_literals(text[match.start() : closing + 1]):
            raise SystemExit(f"no-server-agent-upload: assembled privileged alias in {path}")
    for match in re.finditer(r"\.join\s*\(", text):
        snippet = text[max(0, match.start() - 180) : min(len(text), match.end() + 220)]
        if has_forbidden_literals(snippet):
            raise SystemExit(f"no-server-agent-upload: joined privileged alias in {path}")
    for match in re.finditer(r'''["'][^"']+["']\s*\+\s*["'][^"']+["']''', text):
        if has_forbidden_literals(match.group(0)):
            raise SystemExit(f"no-server-agent-upload: concatenated privileged alias in {path}")
    for match in re.finditer(r"`[^`]{0,500}`", text):
        if has_forbidden_literals(match.group(0)):
            raise SystemExit(f"no-server-agent-upload: template privileged alias in {path}")


for relative_root in ("server/spawn_server", "daemon/src", "web/src"):
    absolute_root = os.path.join(root, relative_root)
    for directory, names, files in os.walk(absolute_root):
        names[:] = [name for name in names if name not in {"node_modules", "target", "__pycache__"}]
        for name in files:
            if not name.endswith((".py", ".rs", ".ts", ".tsx")):
                continue
            if re.search(r"\.(?:test|spec)\.(?:ts|tsx)$", name):
                continue
            path = os.path.join(directory, name)
            with open(path, encoding="utf-8") as source:
                scan(os.path.relpath(path, root), source.read())
PY
}

run_guard() {
  local inventory=()
  mapfile -d '' inventory < <(inventory_files)
  if ((${#inventory[@]} == 0)); then
    printf '%s\n' "no-server-agent-upload: production source inventory produced no files" >&2
    return 1
  fi

  local server=() daemon=() web=()
  local file
  for file in "${inventory[@]}"; do
    case "$file" in
      server/spawn_server/*) server+=("$file") ;;
      daemon/src/*) daemon+=("$file") ;;
      web/src/*) web+=("$file") ;;
    esac
  done
  if ((${#server[@]} == 0 || ${#daemon[@]} == 0 || ${#web[@]} == 0)); then
    printf '%s\n' "no-server-agent-upload: server/daemon/web production inventory is incomplete" >&2
    return 1
  fi

  local matches match rejected=""
  matches="$(rg_matches \
    'bytes_b64|\bAgentUpload\b|UploadResolution|request_upload|resolve_upload|agent\.upload(ed)?|upload\.(saved|error|legacy)|@router\.(post|put|patch)[^\n]*upload|/[{]?agent[^"]*/upload' \
    "${server[@]}")" || return $?
  while IFS= read -r match; do
    [[ -z "$match" ]] && continue
    allowed_server_sentinel "$match" || rejected+="$match"$'\n'
  done <<<"$matches"
  if [[ -n "$rejected" ]]; then
    printf 'no-server-agent-upload: server content/API/broker/ack/error leg returned:\n%s' \
      "$rejected" >&2
    return 1
  fi

  matches="$(rg_matches \
    '\bAgentUpload\b|UploadResolution|request_upload|resolve_upload|agent\.upload(ed)?|send_upload_error|bytes_b64' \
    "${daemon[@]}")" || return $?
  rejected=""
  while IFS= read -r match; do
    [[ -z "$match" ]] && continue
    allowed_daemon_endpoint_bytes "$match" || rejected+="$match"$'\n'
  done <<<"$matches"
  if [[ -n "$rejected" ]]; then
    printf 'no-server-agent-upload: daemon WebSocket/content upload leg returned:\n%s' \
      "$rejected" >&2
    return 1
  fi

  matches="$(rg_matches \
    '\bAgentUpload\b|agents\.(upload|uploadFile)|upload\.(saved|error|legacy)|bytes_b64|/agents/[^"]*/upload' \
    "${web[@]}")" || return $?
  rejected=""
  while IFS= read -r match; do
    [[ -z "$match" ]] && continue
    allowed_web_endpoint_bytes "$match" || allowed_web_test_bytes "$match" || \
      rejected+="$match"$'\n'
  done <<<"$matches"
  if [[ -n "$rejected" ]]; then
    printf 'no-server-agent-upload: web server API/schema/ack/error leg returned:\n%s' \
      "$rejected" >&2
    return 1
  fi

  [[ ! -e server/spawn_server/agent_control.py ]] || {
    printf '%s\n' "no-server-agent-upload: retired server agent upload helper returned" >&2
    return 1
  }

  required_once server/spawn_server/ws/browser.py 'if ftype == "upload":'
  required_once server/spawn_server/ws/browser.py 'reason="agent uploads belong on spawn.ctl"'
  required_once server/spawn_server/ws/daemon.py 'elif ftype == "agent.uploaded":'
  required_once server/spawn_server/ws/daemon.py \
    'reason="agent upload acknowledgements belong on spawn.ctl"'
  required_once server/spawn_server/ws/daemon.py 'if obj.get("code") == "upload_failed":'
  required_once server/spawn_server/ws/daemon.py \
    'reason="agent upload errors belong on spawn.ctl"'
  check_privileged_endpoint_structure
  check_production_test_imports
  check_assembled_aliases
}

self_test() {
  local fixture source_root="$repo_root"
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' RETURN
  mkdir -p \
    "$fixture/server/spawn_server/routes" \
    "$fixture/server/spawn_server/ws" \
    "$fixture/daemon/src" \
    "$fixture/web/src/lib"
  git -C "$fixture" init -q
  printf '%s\n' 'pass' >"$fixture/server/spawn_server/routes/agents.py"
  printf '%s\n' \
    'if ftype == "upload":' \
    '    log.warning("retired server-visible agent upload frame; closing")' \
    '    reason="agent uploads belong on spawn.ctl"' \
    >"$fixture/server/spawn_server/ws/browser.py"
  printf '%s\n' \
    'elif ftype == "agent.uploaded":' \
    '    log.warning("retired server-visible agent upload acknowledgement; closing")' \
    '    reason="agent upload acknowledgements belong on spawn.ctl"' \
    'if obj.get("code") == "upload_failed":' \
    '    log.warning("retired server-visible agent upload error; closing")' \
    '    reason="agent upload errors belong on spawn.ctl"' \
    >"$fixture/server/spawn_server/ws/daemon.py"
  cp "$source_root/daemon/src/main.rs" "$fixture/daemon/src/main.rs"
  cp "$source_root/daemon/src/rtc.rs" "$fixture/daemon/src/rtc.rs"
  cp "$source_root/daemon/src/rtc_pair.rs" "$fixture/daemon/src/rtc_pair.rs"
  cp "$source_root/daemon/src/host_control.rs" "$fixture/daemon/src/host_control.rs"
  cp "$source_root/daemon/src/host_transcripts.rs" "$fixture/daemon/src/host_transcripts.rs"
  cp "$source_root/daemon/src/config.rs" "$fixture/daemon/src/config.rs"
  cp "$source_root/daemon/src/host_conv.rs" "$fixture/daemon/src/host_conv.rs"
  cp "$source_root/daemon/src/codex_launch.rs" "$fixture/daemon/src/codex_launch.rs"
  cp "$source_root/daemon/src/host_direct.rs" "$fixture/daemon/src/host_direct.rs"
  cp "$source_root/daemon/src/host_signal.rs" "$fixture/daemon/src/host_signal.rs"
  printf '%s\n' \
    '#[cfg(test)]' \
    'mod tests {' \
    '  const RAW: &str = r#"C:\say "hello"\"#;' \
    '  const FIELD: &str = concat!("bytes", "_b64");' \
    '}' \
    >"$fixture/daemon/src/raw_string_test.rs"
  printf '%s\n' \
    '#[cfg(all(test, windows))]' \
    'mod windows_tests {' \
    '  const FIELD: &str = concat!("bytes", "_b64");' \
    '}' \
    >"$fixture/daemon/src/windows_test.rs"
  printf '%s\n' 'export const ok = true;' >"$fixture/web/src/lib/api.ts"
  printf '%s\n' \
    'async writeStream() {' \
    '  this.sendStreamFrame("stream.chunk", streamId, {' \
    '            bytes_b64: bytesToBase64(chunk),' \
    '  });' \
    '}' \
    'async transferFileTo() {}' \
    'private handleControlMessage() {' \
    '      bytes_b64?: string;' \
    '            message.bytes_b64,' \
    '        if (message.sequence !== incoming.nextSequence || typeof message.bytes_b64 !== "string") {' \
    '          bytes = base64ToBytes(message.bytes_b64);' \
    '}' \
    'private sendSignal() {' \
    '  ws.send(frame);' \
    '  ws.send(pong);' \
    '  ws.send(configRequest);' \
    '}' \
    'function directTopology() {' \
    '  channel.send(one);' \
    '  channel.send(two);' \
    '  this.channel.send(three);' \
    '}' \
    >"$fixture/web/src/lib/hostControl.ts"
  printf '%s\n' 'const directTest = { bytes_b64: btoa("x") };' \
    >"$fixture/web/src/lib/hostControl.test.ts"

  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  local cases=(
    'server/spawn_server/routes/new.py|@router.post("/{agent_id}/upload")'
    'server/spawn_server/ws/new.py|if frame["type"] == "agent.upload": pass'
    'server/spawn_server/broker_moved.py|request_upload(frame)'
    'server/spawn_server/schema_moved.py|class AgentUpload: pass'
    'server/spawn_server/content_moved.py|bytes_b64 = secret'
    'server/spawn_server/ack_moved.py|kind = "agent.uploaded"'
    'server/spawn_server/error_moved.py|kind = "upload.error"'
    'daemon/src/moved.rs|const LEGACY: &str = "agent.uploaded";'
    'daemon/src/rtc_helper.rs|fn legacy_agent_upload(bytes_b64: &str) { send_to_server(bytes_b64); }'
    'daemon/src/assembled.rs|const FIELD: &str = concat!("bytes", "_b64");'
    'web/src/lib/moved.ts|export const route = "/agents/${id}/upload";'
    'web/src/lib/assembled.ts|export const FIELD = ["bytes", "b64"].join("_");'
    'web/src/lib/importTest.ts|import { directTest } from "./hostControl.test";'
    'server/spawn_server/assembled.py|FIELD = "".join(("bytes", "_b64"))'
  )
  local case path body
  for case in "${cases[@]}"; do
    path="${case%%|*}"
    body="${case#*|}"
    printf '%s\n' "$body" >"$fixture/$path"
    if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
      printf 'no-server-agent-upload self-test: failed to reject %s\n' "$path" >&2
      return 1
    fi
    rm "$fixture/$path"
  done

  local rtc_original
  rtc_original="$(<"$fixture/daemon/src/rtc.rs")"
  printf '%s\n' \
    'fn legacy_agent_upload(bytes_b64: &str) { send_to_server(bytes_b64); }' \
    "$rtc_original" >"$fixture/daemon/src/rtc.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: privileged rtc.rs relay passed" >&2
    return 1
  fi
  printf '%s\n' "$rtc_original" >"$fixture/daemon/src/rtc.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  printf '%s\n' \
    "$rtc_original" \
    'fn legacy_agent_upload_after_tests(bytes_b64: &str) { send_to_server(bytes_b64); }' \
    >"$fixture/daemon/src/rtc.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: post-tests rtc.rs relay passed" >&2
    return 1
  fi
  printf '%s\n' "$rtc_original" >"$fixture/daemon/src/rtc.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  local host_control_original
  host_control_original="$(<"$fixture/daemon/src/host_control.rs")"
  printf '%s\n' \
    "$host_control_original" \
    'fn legacy_host_relay(bytes_b64: &str) { send_to_server(bytes_b64); }' \
    >"$fixture/daemon/src/host_control.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: privileged daemon host-control relay passed" >&2
    return 1
  fi
  printf '%s\n' "$host_control_original" >"$fixture/daemon/src/host_control.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  printf '%s\n' \
    "$host_control_original" \
    'pub(crate) fn export_protected_value(value: Value) -> Value { value }' \
    >"$fixture/daemon/src/host_control.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: protected host-control value export passed" >&2
    return 1
  fi
  printf '%s\n' "$host_control_original" >"$fixture/daemon/src/host_control.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  printf '%s\n' \
    "$host_control_original" \
    'impl AsRef<serde_json::Value> for Lifetime {' \
    '  fn as_ref(&self) -> &serde_json::Value { unimplemented!() }' \
    '}' \
    >"$fixture/daemon/src/host_control.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: retirement capability trait export passed" >&2
    return 1
  fi
  printf '%s\n' "$host_control_original" >"$fixture/daemon/src/host_control.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  # The conversation inspector changes nothing but its window notes.
  local conv_original conv_runtime_part conv_tests_part conv_case
  conv_original="$(<"$fixture/daemon/src/host_conv.rs")"
  conv_runtime_part="${conv_original%%'#[cfg(all(test, unix))]'*}"
  conv_tests_part="${conv_original#"$conv_runtime_part"}"
  for conv_case in \
    'fn sneaky(path: &Path) { let _ = std::fs::copy(path, "/tmp/x"); }' \
    'fn sneaky(path: &Path) { let _ = std::fs::OpenOptions::new().write(true).open(path); }' \
    'fn sneaky(path: &Path) { let _ = std::fs::remove_file(path); }' \
    'fn sneaky(path: &Path) { let _ = std::fs::remove_dir_all(path); }' \
    'fn sneaky(path: &Path) { use std::os::unix::fs::PermissionsExt; let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o777)); }' \
    'fn sneaky(path: &Path) { let _ = std::fs::write(path, b"x"); }' \
    'fn sneaky(path: &Path) { let _ = std::os::unix::fs::symlink(path, "/tmp/x"); }' \
    'fn sneaky(path: &Path) { let _ = std::fs::create_dir_all(path); }' \
    'fn sneaky(path: &Path) { let _ = nix::unistd::truncate(path, 0); }' \
    'fn sneaky(path: &Path) { let _ = nix::unistd::mkdir(path, nix::sys::stat::Mode::S_IRWXU); }' \
    'fn sneaky(path: &Path) { let _ = nix::fcntl::renameat(None, path, None, "/tmp/x"); }' \
    'fn sneaky(path: &Path) { let _ = nix::sys::stat::fchmodat(None, path, nix::sys::stat::Mode::S_IRWXU, nix::sys::stat::FchmodatFlags::FollowSymlink); }' \
    'fn sneaky(path: &Path) { use std::os::unix::fs::OpenOptionsExt; let _ = std::fs::OpenOptions::new().read(true).custom_flags(nix::libc::O_TRUNC).open(path); }' \
    'fn sneaky(path: &Path) { use std::os::unix::fs::OpenOptionsExt; let _ = std::fs::OpenOptions::new().read(true).custom_flags(0o1000).open(path); }' \
    'use nix::libc::*;' \
    'extern "C" { fn unlink(path: *const u8) -> i32; }'; do
    printf '%s\n%s\n%s' "$conv_runtime_part" "$conv_case" "$conv_tests_part" \
      >"$fixture/daemon/src/host_conv.rs"
    if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
      printf 'no-server-agent-upload self-test: inspector write passed: %s\n' "$conv_case" >&2
      return 1
    fi
  done
  for after_tests in \
    'fn after_tests(path: &Path) { let _ = std::fs::write(path, b"x"); }' \
    '    fn indented_after_tests(path: &Path) { let _ = std::fs::write(path, b"x"); }'; do
    printf '%s\n%s\n' "$conv_original" "$after_tests" >"$fixture/daemon/src/host_conv.rs"
    if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
      printf 'no-server-agent-upload self-test: inspector code after its test module passed: %s\n' "$after_tests" >&2
      return 1
    fi
  done
  printf '%s\n' "$conv_original" >"$fixture/daemon/src/host_conv.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  local launch_original
  launch_original="$(<"$fixture/daemon/src/codex_launch.rs")"
  for launch_case in \
    'fn sneaky() { let _ = std::process::Command::new("sh").spawn(); }' \
    'async fn sneaky(env: &BTreeMap<String, String>) { let _ = crate::run::run_program_capture_in("codex", &["update"], PROBE_TIMEOUT, 1, Some(env), None).await; }' \
    'fn sneaky() { crate::run::resolved_command_env(); }' \
    'fn sneaky(path: &Path) { let _ = std::fs::write(path, b"x"); }'; do
    printf '%s\n%s\n' "$launch_case" "$launch_original" >"$fixture/daemon/src/codex_launch.rs"
    if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
      printf 'no-server-agent-upload self-test: codex launch probe change passed: %s\n' "$launch_case" >&2
      return 1
    fi
  done
  printf '%s\n%s\n' "$launch_original" 'fn after_tests() { let _ = std::process::Command::new("sh").spawn(); }' \
    >"$fixture/daemon/src/codex_launch.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' "no-server-agent-upload self-test: codex launch code after its test module passed" >&2
    return 1
  fi
  printf '%s\n' "$launch_original" >"$fixture/daemon/src/codex_launch.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  local config_original
  config_original="$(<"$fixture/daemon/src/config.rs")"
  printf '%s\n' \
    "$config_original" \
    'pub fn send_transcript(out_tx: &str) { crate::ws::send(out_tx); }' \
    >"$fixture/daemon/src/config.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: a transport in the locator's config dependency passed" >&2
    return 1
  fi
  printf '%s\n' "$config_original" >"$fixture/daemon/src/config.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  local host_direct_original
  host_direct_original="$(<"$fixture/daemon/src/host_direct.rs")"
  printf '%s\n' \
    "$host_direct_original" \
    'fn disguised_daemon_relay(bytes: &[u8]) {' \
    '  let envelope = json!({' \
    '                "bytes_b64": STANDARD.encode(bytes),' \
    '  });' \
    '  send_to_server(envelope);' \
    '}' \
    >"$fixture/daemon/src/host_direct.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: reused daemon endpoint allowance passed" >&2
    return 1
  fi
  printf '%s\n' "$host_direct_original" >"$fixture/daemon/src/host_direct.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  local host_signal_original
  host_signal_original="$(<"$fixture/daemon/src/host_signal.rs")"
  printf '%s\n' \
    "$host_signal_original" \
    'impl HostConnectedSignal {' \
    '  pub(crate) fn publish_protected(&self, protected: serde_json::Value) -> bool {' \
    '    self.out_tx.try_send(WsOutbound::json(protected.to_string())).is_ok()' \
    '  }' \
    '}' \
    >"$fixture/daemon/src/host_signal.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: second connected-signal inherent impl passed" >&2
    return 1
  fi
  printf '%s\n' "$host_signal_original" >"$fixture/daemon/src/host_signal.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  printf '%s\n' \
    "$host_signal_original" \
    'pub(crate) trait ArbitraryPublisher {' \
    '  fn emit(&self, protected: serde_json::Value) -> bool;' \
    '}' \
    'impl ArbitraryPublisher for HostConnectedSignal {' \
    '  fn emit(&self, protected: serde_json::Value) -> bool {' \
    '    self.out_tx.try_send(WsOutbound::json(protected.to_string())).is_ok()' \
    '  }' \
    '}' \
    >"$fixture/daemon/src/host_signal.rs"
  printf '%s\n' \
    "$host_control_original" \
    'use crate::host_signal::ArbitraryPublisher as OpaquePublisher;' \
    'fn relay_via_trait_alias(capability: &HostConnectedSignal, protected: Value) -> bool {' \
    '  OpaquePublisher::emit(capability, protected)' \
    '}' \
    >"$fixture/daemon/src/host_control.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: connected-signal trait impl alias passed" >&2
    return 1
  fi
  printf '%s\n' "$host_signal_original" >"$fixture/daemon/src/host_signal.rs"
  printf '%s\n' "$host_control_original" >"$fixture/daemon/src/host_control.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  printf '%s\n' \
    "$host_control_original" \
    'struct RawProtectedUplink {' \
    '  uplink: mpsc::Sender<crate::pty::WsOutbound>,' \
    '}' \
    'impl RawProtectedUplink {' \
    '  async fn publish(&self, protected: Value) {' \
    '    if let Ok(permit) = self.uplink.reserve().await {' \
    '      permit.send(crate::pty::WsOutbound::json(protected.to_string()));' \
    '    }' \
    '  }' \
    '}' \
    >"$fixture/daemon/src/host_control.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: raw protected server uplink passed" >&2
    return 1
  fi
  printf '%s\n' "$host_control_original" >"$fixture/daemon/src/host_control.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  printf '%s\n' \
    "$host_control_original" \
    'use crate::pty::WsOutbound as OpaqueFrame;' \
    'use tokio::sync::mpsc::Sender as OpaqueRoute;' \
    'struct RenamedProtectedUplink(OpaqueRoute<OpaqueFrame>);' \
    'impl RenamedProtectedUplink {' \
    '  async fn publish(&self, protected: Value) {' \
    '    if let Ok(permit) = self.0.reserve().await {' \
    '      permit.send(OpaqueFrame::json(protected.to_string()));' \
    '    }' \
    '  }' \
    '}' \
    >"$fixture/daemon/src/host_control.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: aliased protected server uplink passed" >&2
    return 1
  fi
  printf '%s\n' "$host_control_original" >"$fixture/daemon/src/host_control.rs"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  local web_host_control_original
  web_host_control_original="$(<"$fixture/web/src/lib/hostControl.ts")"
  printf '%s\n' \
    "$web_host_control_original" \
    'export function legacyHostRelay(bytes_b64: string) { sendToServer(bytes_b64); }' \
    >"$fixture/web/src/lib/hostControl.ts"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: privileged web host-control relay passed" >&2
    return 1
  fi
  printf '%s\n' "$web_host_control_original" >"$fixture/web/src/lib/hostControl.ts"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  printf '%s\n' \
    "$web_host_control_original" \
    'export function disguisedWebRelay(chunk: Uint8Array) {' \
    '  const envelope = {' \
    '            bytes_b64: bytesToBase64(chunk),' \
    '  };' \
    '  serverWebSocket.send(JSON.stringify(envelope));' \
    '}' \
    >"$fixture/web/src/lib/hostControl.ts"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: reused web endpoint allowance passed" >&2
    return 1
  fi
  printf '%s\n' "$web_host_control_original" >"$fixture/web/src/lib/hostControl.ts"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  sed -i '/agent uploads belong on spawn.ctl/d' "$fixture/server/spawn_server/ws/browser.py"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' "no-server-agent-upload self-test: missing sentinel passed" >&2
    return 1
  fi
  printf '%s\n' '    reason="agent uploads belong on spawn.ctl"' \
    >>"$fixture/server/spawn_server/ws/browser.py"
  NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null

  mkdir -p "$fixture/bin"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 2' >"$fixture/bin/rg"
  chmod +x "$fixture/bin/rg"
  if PATH="$fixture/bin:$PATH" NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" \
    "$script_path" >/dev/null 2>&1; then
    printf '%s\n' "no-server-agent-upload self-test: rg failure passed open" >&2
    return 1
  fi

  printf '%s\n' "no-server-agent-upload self-test passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

run_guard
printf '%s\n' "no-server-agent-upload: passed"
