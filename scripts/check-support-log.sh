#!/usr/bin/env bash
# The support log (daemon/src/support_log.rs) is the one daemon record meant
# to leave a machine one day, when its owner allows it. What keeps terminal
# content, file content and secrets out of it is partly in the code and partly
# in where it is not allowed to look. This gate pins the second part in the
# source, so it cannot be relaxed quietly:
#
#   1. The reader names exactly two files, `support-v3.jsonl` and
#      `support-v3.jsonl.1` (plus the lock), read only by those names.
#      Legacy names are deletion-only.
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
#   6. Field rules come from one policy, errors require exact reviewed
#      callsites, messages are omitted and foreign values are never visited.
#
# Deliberately a literal-source check, per docs/GUARD_POLICY.md: it greps for
# code markers on non-comment lines, never prose.
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_root="${SUPPORT_LOG_GUARD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$repo_root"

MODULE="daemon/src/support_log.rs"
POLICY="daemon/src/support_log_policy.json"
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

for file in "$MODULE" "$POLICY" "$MAIN" "${CONTENT_MODULES[@]}"; do
  [[ -f "$file" ]] || fail "missing file: $file"
done

module_code="$(code_of "$MODULE")"

# 1. Exactly the reviewed file names, and reads only by them.
names="$(grep -oE '"[^"]*\.(jsonl|jsonl\.[0-9]+|lock|log|replay)"' <<<"$module_code" | sort -u || true)"
expected_names='"support-v2.jsonl"
"support-v2.jsonl.1"
"support-v3.jsonl"
"support-v3.jsonl.1"
"support.jsonl"
"support.jsonl.1"
"support.lock"'
if [[ "$names" != "$expected_names" ]]; then
  printf 'support-log: file names in the module:\n%s\n' "$names" >&2
  fail "the support log names only the versioned pair, the deletion-only legacy pair and support.lock"
fi
for binding in 'const CURRENT: &str = "support-v3.jsonl";' 'const PREVIOUS: &str = "support-v3.jsonl.1";' 'const LOCK: &str = "support.lock";'; do
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

# 6. The single policy and the visitor's construction. Source checks are
# deliberately literal; origin notes require human review, never word matching.
python3 -I - <<'PY_POLICY'
import json
import re
from pathlib import Path

def require(ok, message):
    if not ok:
        raise SystemExit("support-log: " + message)

source = Path("daemon/src/support_log.rs").read_text()
policy = json.loads(Path("daemon/src/support_log_policy.json").read_text())
require('include_str!("support_log_policy.json")' in source, "runtime must use the reviewed policy")
require(set(policy) == {"fields", "error_sites"}, "unexpected policy section")
for name, rule in policy["fields"].items():
    require(re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", name), "invalid field name")
    require(rule["kind"] in {"withheld", "scalar", "text", "id", "choice", "version"}, "unknown field rule")
    require(bool(rule.get("why")), "field rule needs an origin/type justification")
    require(name not in {"error", "message"} or rule["kind"] == "withheld", "error/message cannot be admitted by name")
    if rule["kind"] == "choice":
        require(bool(rule.get("values")), "a choice needs explicit values")
seen = set()
for site in policy["error_sites"]:
    key = (site["target"], site["file"], site["line"], site["field"])
    require(key not in seen, "duplicate error callsite")
    seen.add(key)
    require(site["field"] in {"error", "reason"}, "only reviewed error/reason exceptions")
    require(site["target"].startswith("spawnd::"), "foreign targets cannot admit error text")
    require(bool(site.get("why")), "error callsite needs an origin justification")
    text = Path("daemon", site["file"]).read_text()
    start = sum(len(line) for line in text.splitlines(keepends=True)[:site["line"] - 1])
    offset = text[start:].splitlines()[0].find("tracing::")
    require(offset >= 0 and text[start + offset:].startswith(site["source"]), f"review moved/changed error callsite {key}")
# The only legacy-name occurrences are the deletion-only array.
legacy = ['"support.jsonl"', '"support.jsonl.1"', '"support-v2.jsonl"', '"support-v2.jsonl.1"']
cleanup = source.split('fn discard_legacy', 1)[1].split('/// Append', 1)[0]
for name in legacy:
    require(source.count(name) == 1 and name in cleanup, "legacy name outside deletion loop")
startup = source.split('impl Store {', 1)[1].split('fn discard_legacy', 1)[0]
require('.try_lock()' in startup and '.lock()' not in startup, "startup must not wait for the support lock")
layer = source.split('impl<S> Layer<S>', 1)[1].split('#[derive(Debug', 1)[0]
require('if is_spawnd(meta.target()) && normalized.is_none() {\n                event.record(&mut collector);\n            }' in layer, "foreign/bridged events must not visit content")
require('collector.message' not in source, "event message text must never be collected")
collector = source.split("impl Collector<'_> {", 1)[1].split('/// Format a `Debug`', 1)[0]
for gate in [
    'field.name() != "message"',
    'site.field == name', 'site.target == self.meta.target()',
    'self.meta.file().map(Path::new) == Some(Path::new(&site.file))', 'Some(site.line) == self.meta.line()',
    'if self.text_allowed(field.name())', 'self.checked_text(field.name(), &format())',
    'rule.kind == "scalar"', '_ => false',
]:
    require(gate in collector, "missing construction gate: " + gate)
visitor = collector.split("impl Visit for Collector<'_> {", 1)[1]
compact = re.sub(r"\s+", "", visitor)
require('self.push_text(field,||bounded_format(value));' in compact, "Debug bypasses admission")
require('self.push_text(field,||{' in compact, "str bypasses admission")
require(compact.count('self.push_scalar(field,||') == 6, "all scalar types must use admission")
require(compact.count('self.fields.push(') == 1 and 'FieldValue::Str(WITHHELD.to_owned())' in compact, "bytes must be withheld")
require('msg: &msg' in source and 'fields: is_spawnd(target).then_some(FieldsOut(&fields))' in source, "foreign record shape changed")
PY_POLICY

self_test() {
  local fixture
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' RETURN

  mkdir -p "$fixture/daemon/src/sessiond"
  for file in daemon/src/worker_backend.rs daemon/src/pty.rs daemon/src/rtc.rs; do
    cp "$file" "$fixture/$file"
  done
  for file in "$MODULE" "$POLICY" "$MAIN" "${CONTENT_MODULES[@]}"; do
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

  printf '%s\n' 'const OLDER: &str = "support-v3.jsonl.2";' >>"$fixture/$MODULE"
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

  printf '%s\n' 'let legacy = read_capped(&dir, "support.jsonl");' >>"$fixture/$MODULE"
  expect_failure "a legacy file read"

  mutate_module() {
    python3 -I - "$fixture/$MODULE" "$1" "$2" <<'PY_REPLACE'
from pathlib import Path
import sys
path = Path(sys.argv[1])
source = path.read_text()
assert sys.argv[2] in source
path.write_text(source.replace(sys.argv[2], sys.argv[3]))
PY_REPLACE
  }
  mutate_module 'field.name() != "message"' 'true'
  expect_failure "recording event message text"

  mutate_module 'rule.kind == "scalar"' 'true'
  expect_failure "admitting numbers under arbitrary field names"

  mutate_module 'Some(site.line) == self.meta.line()' 'true'
  expect_failure "admitting errors from unreviewed callsites"

  mutate_module 'is_spawnd(meta.target()) && normalized.is_none()' 'true'
  expect_failure "visiting third-party event values"

  mutate_module '.try_lock()' '.lock()'
  expect_failure "blocking startup on the support lock"

  local original_policy
  original_policy="$(cat "$fixture/$POLICY")"
  python3 -I - "$fixture/$POLICY" <<'PY_MUTATE'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
policy = json.loads(path.read_text())
policy["error_sites"][0]["line"] += 1
path.write_text(json.dumps(policy))
PY_MUTATE
  expect_failure "a stale error callsite entry"
  printf '%s\n' "$original_policy" >"$fixture/$POLICY"

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
