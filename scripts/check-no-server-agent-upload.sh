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

allowed_rtc_test_only_bytes() {
  local match="$1"
  [[ "$match" == daemon/src/rtc.rs:*bytes_b64* ]] || return 1
  local remainder="${match#daemon/src/rtc.rs:}"
  local match_line="${remainder%%:*}"
  [[ "$match_line" =~ ^[0-9]+$ ]] || return 1
  local tests_line status
  set +e
  tests_line="$(rg -n --color never '^mod tests \{$' daemon/src/rtc.rs 2>/dev/null)"
  status=$?
  set -e
  [[ $status == 0 && "$tests_line" =~ ^([0-9]+): ]] || return 1
  ((match_line > BASH_REMATCH[1]))
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
    case "$match" in
      daemon/src/host_control.rs:*bytes_b64*) ;;
      *) allowed_rtc_test_only_bytes "$match" || rejected+="$match"$'\n' ;;
    esac
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
    case "$match" in
      web/src/lib/hostControl.ts:*bytes_b64* | web/src/lib/hostControl.test.ts:*bytes_b64*) ;;
      *) rejected+="$match"$'\n' ;;
    esac
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
    '    const DIRECT_ENDPOINT_FIELD: &str = "bytes_b64";' \
    '}' \
    >"$fixture/daemon/src/rtc.rs"
  printf '%s\n' 'export const ok = true;' >"$fixture/web/src/lib/api.ts"

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
    'web/src/lib/moved.ts|export const route = "/agents/${id}/upload";'
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
