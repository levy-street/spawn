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
  [[ "$file" == "daemon/src/host_control.rs" ]] || return 1
  [[ "$content" == '                    "bytes_b64": STANDARD.encode(&buffer[..read]),' || \
    "$content" == '            object.get("bytes_b64").and_then(Value::as_str),' ]]
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
  local daemon_file="daemon/src/host_control.rs"
  local web_file="web/src/lib/hostControl.ts"
  local daemon_encode='                    "bytes_b64": STANDARD.encode(&buffer[..read]),'
  local daemon_decode='            object.get("bytes_b64").and_then(Value::as_str),'
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
    'async fn send_read(' 'async fn handle_late_write_chunk(' || return 1
  required_line_between "$daemon_file" "$daemon_decode" \
    'async fn handle_stream_chunk(' 'async fn handle_stream_end(' || return 1

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
  receivers="$(rg -o --color never '[A-Za-z_$][A-Za-z0-9_$?.]*\.send\(' "$web_file" | sort | uniq -c)"
  expected_receivers=$'      2 channel.send(\n      1 this.channel.send(\n      1 ws.send('
  if [[ "$receivers" != "$expected_receivers" ]]; then
    printf 'no-server-agent-upload: web host-control send topology changed; review direct vs signaling channels:\n%s\n' \
      "$receivers" >&2
    return 1
  fi
  receivers="$(rg -o --color never '[A-Za-z_$][A-Za-z0-9_$?.]*\.send\(' "$daemon_file" | sort | uniq -c)"
  expected_receivers=$'      1 publication_context.send(\n      5 self.send('
  if [[ "$receivers" != "$expected_receivers" ]] || rg -n --color never \
    'send_?to_?server|server[^[:space:]]*\.send|websocket|crate::ws' "$daemon_file" >/dev/null; then
    printf 'no-server-agent-upload: daemon host-control send topology gained a server-capable relay:\n%s\n' \
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


def strip_rust_test_modules(text: str) -> str:
    pattern = re.compile(
        r'#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{'
    )
    masked = list(text)
    for match in list(pattern.finditer(text)):
        opening = text.find("{", match.start(), match.end())
        closing = matching_delimiter(text, opening, "{", "}")
        if closing is None:
            raise SystemExit("no-server-agent-upload: unbalanced #[cfg(test)] module")
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
  local fixture
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
  printf '%s\n' 'fn main() {}' >"$fixture/daemon/src/main.rs"
  printf '%s\n' \
    'fn production_rtc() {}' \
    '#[cfg(test)]' \
    'mod tests {' \
    '    const DIRECT_ENDPOINT_FIELD: &str = concat!("bytes", "_b64");' \
    '}' \
    >"$fixture/daemon/src/rtc.rs"
  printf '%s\n' \
    'async fn send_read() {' \
    '  self.send(json!({' \
    '                    "bytes_b64": STANDARD.encode(&buffer[..read]),' \
    '  })).await;' \
    '}' \
    'async fn handle_late_write_chunk() {}' \
    'async fn handle_stream_chunk(object: Object) {' \
    '            object.get("bytes_b64").and_then(Value::as_str),' \
    '}' \
    'async fn handle_stream_end() {}' \
    'fn direct_topology() {' \
    '  self.send(one);' \
    '  self.send(two);' \
    '  self.send(three);' \
    '  self.send(four);' \
    '  publication_context.send(hello);' \
    '}' \
    >"$fixture/daemon/src/host_control.rs"
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
    'fn disguised_daemon_relay(buffer: &[u8], read: usize) {' \
    '  let envelope = json!({' \
    '                    "bytes_b64": STANDARD.encode(&buffer[..read]),' \
    '  });' \
    '  send_to_server(envelope);' \
    '}' \
    >"$fixture/daemon/src/host_control.rs"
  if NO_SERVER_AGENT_UPLOAD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' \
      "no-server-agent-upload self-test: reused daemon endpoint allowance passed" >&2
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
