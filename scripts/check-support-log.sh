#!/usr/bin/env bash
# The support log (daemon/src/support_log.rs) is the one daemon record meant
# to leave a machine one day, when its owner allows it. What keeps terminal
# content, file content and secrets out of it is partly in the code and partly
# in where it is not allowed to look. This gate pins the second part in the
# source, so it cannot be relaxed quietly:
#
#   1. The reader names exactly two files, `support.jsonl` and
#      `support.jsonl.1` (plus the lock), and reads them only by those names.
#   2. The module never lists a folder: no read_dir, no cap-std `entries`, no
#      glob or directory walk. Whatever else lands in or beside the support
#      folder — a diagnostics replay dump, a scrollback segment — is never
#      found through it.
#   3. The module refers to no replay dump and no scrollback or worker path.
#   4. The support log's levels are its own: the module reads no environment
#      and builds no EnvFilter, and main.rs applies `RUST_LOG` only to the
#      stderr layer (no global `with_env_filter`).
#   5. The modules that handle file and terminal contents make no tracing
#      calls at all, so nothing they hold can become an event.
#
# Deliberately a literal-source check, per docs/GUARD_POLICY.md: it greps for
# code markers on non-comment lines, never prose.
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_root="${SUPPORT_LOG_GUARD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$repo_root"

MODULE="daemon/src/support_log.rs"
MAIN="daemon/src/main.rs"
CONTENT_MODULES=(
  daemon/src/host_files.rs
  daemon/src/host_control.rs
  daemon/src/host_preview.rs
  daemon/src/upload.rs
  daemon/src/host_transcripts.rs
  daemon/src/activity.rs
  daemon/src/sessions.rs
  daemon/src/sessiond/emulator.rs
  daemon/src/sessiond/scrollback.rs
)

fail() {
  printf 'support-log: %s\n' "$1" >&2
  exit 1
}

# Source lines with whole-line comments removed: doc comments may describe
# what the module avoids without tripping the markers below.
code_of() {
  grep -v -E '^[[:space:]]*//' "$1" || true
}

for file in "$MODULE" "$MAIN" "${CONTENT_MODULES[@]}"; do
  [[ -f "$file" ]] || fail "missing file: $file"
done

module_code="$(code_of "$MODULE")"

# 1. Exactly the reviewed file names, and reads only by them.
names="$(grep -oE '"[^"]*\.(jsonl|jsonl\.[0-9]+|lock|log|replay)"' <<<"$module_code" | sort -u || true)"
expected_names='"support.jsonl"
"support.jsonl.1"
"support.lock"'
if [[ "$names" != "$expected_names" ]]; then
  printf 'support-log: file names in the module:\n%s\n' "$names" >&2
  fail "the support log names exactly support.jsonl, support.jsonl.1 and support.lock"
fi
for binding in 'const CURRENT: &str = "support.jsonl";' 'const PREVIOUS: &str = "support.jsonl.1";' 'const LOCK: &str = "support.lock";'; do
  grep -qF "$binding" <<<"$module_code" || fail "missing file-name constant: $binding"
done
reads="$(grep -oE 'read_capped\(&dir, [A-Z_]+\)' <<<"$module_code" | sort -u || true)"
expected_reads='read_capped(&dir, CURRENT)
read_capped(&dir, PREVIOUS)'
if [[ "$reads" != "$expected_reads" ]]; then
  printf 'support-log: reads in the module:\n%s\n' "$reads" >&2
  fail "the reader reads exactly CURRENT and PREVIOUS"
fi

# 2. No folder listing of any kind.
for marker in 'read_dir' '.entries(' 'glob(' 'glob::' 'walkdir' 'WalkDir' 'read_link'; do
  if grep -qF -- "$marker" <<<"$module_code"; then
    fail "the support log module must not list or walk a folder: $marker"
  fi
done

# 3. No replay dump, scrollback or worker paths.
for marker in 'REPLAY_DUMP' '.replay' 'scrollback' 'seg-' 'worker_dir' 'workers'; do
  if grep -qF -- "$marker" <<<"$module_code"; then
    fail "the support log module must not refer to: $marker"
  fi
done

# 4. Fixed levels.
for marker in 'EnvFilter' 'RUST_LOG' 'env::var'; do
  if grep -qF -- "$marker" <<<"$module_code"; then
    fail "the support log's filter must not read the environment: $marker"
  fi
done
main_code="$(code_of "$MAIN")"
if grep -qF 'with_env_filter(' <<<"$main_code"; then
  fail "main.rs must apply RUST_LOG to the stderr layer only, never globally"
fi
grep -qF '.with_filter(filter)' <<<"$main_code" ||
  fail "main.rs no longer gives the stderr layer its own filter"

# 5. No tracing where contents are handled.
for file in "${CONTENT_MODULES[@]}"; do
  file_code="$(code_of "$file")"
  if grep -qE 'tracing::|#\[instrument|\b(trace|debug|info|warn|error)!\(' <<<"$file_code"; then
    fail "no tracing calls in $file: it handles file or terminal contents"
  fi
done

self_test() {
  local fixture
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' RETURN

  mkdir -p "$fixture/daemon/src/sessiond"
  for file in "$MODULE" "$MAIN" "${CONTENT_MODULES[@]}"; do
    cp "$file" "$fixture/$file"
  done
  SUPPORT_LOG_GUARD_ROOT="$fixture" "$script_path" >/dev/null ||
    fail "self-test: an unmodified copy did not pass"

  local original
  original="$(cat "$fixture/$MODULE")"
  expect_failure() {
    local what="$1"
    if SUPPORT_LOG_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
      fail "self-test: $what passed"
    fi
    printf '%s\n' "$original" >"$fixture/$MODULE"
  }

  printf '%s\n' 'const OLDER: &str = "support.jsonl.2";' >>"$fixture/$MODULE"
  expect_failure "a third file name"

  printf '%s\n' 'let x = read_capped(&dir, OLDER);' >>"$fixture/$MODULE"
  expect_failure "a read of another file"

  printf '%s\n' 'let listing = std::fs::read_dir(support_dir);' >>"$fixture/$MODULE"
  expect_failure "a folder listing"

  printf '%s\n' 'for entry in dir.entries()? {}' >>"$fixture/$MODULE"
  expect_failure "a cap-std folder listing"

  printf '%s\n' 'let dump = std::env::var_os("SPAWND_DIAG_REPLAY_DUMP_DIR");' >>"$fixture/$MODULE"
  expect_failure "a replay-dump reference"

  printf '%s\n' 'let segments = log_dir.join("workers");' >>"$fixture/$MODULE"
  expect_failure "a worker path"

  printf '%s\n' 'let filter = EnvFilter::from_default_env();' >>"$fixture/$MODULE"
  expect_failure "an environment-driven filter"

  # A comment may name what the module avoids.
  printf '%s\n' '// never a read_dir, never a scrollback segment' >>"$fixture/$MODULE"
  SUPPORT_LOG_GUARD_ROOT="$fixture" "$script_path" >/dev/null ||
    fail "self-test: a comment naming a marker failed"
  printf '%s\n' "$original" >"$fixture/$MODULE"

  local original_main
  original_main="$(cat "$fixture/$MAIN")"
  printf '%s\n' 'let s = fmt().with_env_filter(filter).finish();' >>"$fixture/$MAIN"
  if SUPPORT_LOG_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: a global environment filter passed"
  fi
  printf '%s\n' "$original_main" >"$fixture/$MAIN"

  local content="$fixture/daemon/src/sessiond/scrollback.rs"
  local original_content
  original_content="$(cat "$content")"
  printf '%s\n' 'tracing::debug!(line = %text, "committed");' >>"$content"
  if SUPPORT_LOG_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: a tracing call in a content module passed"
  fi
  printf '%s\n' "$original_content" >"$content"
  printf '%s\n' 'warn!("read {}", contents);' >>"$fixture/daemon/src/host_files.rs"
  if SUPPORT_LOG_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    fail "self-test: an imported tracing macro in a content module passed"
  fi

  printf '%s\n' "support-log self-test passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

printf '%s\n' "support-log: passed"
