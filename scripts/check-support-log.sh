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
#   7. Every production tracing field has a policy decision. Filesystem path
#      fields additionally require an exact reviewed statement and location.
#
# Deliberately a literal-source check, per docs/GUARD_POLICY.md: code markers
# and tracing token trees, never prose or value-origin inference.
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
COLLECTION_MODULES=(daemon/src/support.rs daemon/src/support_store.rs daemon/src/support_consent.rs daemon/src/support_io.rs)

fail() {
  printf 'support-log: %s\n' "$1" >&2
  exit 1
}

# Source lines with whole-line comments removed: doc comments may describe
# what the module avoids without tripping the markers below.
code_of() {
  grep -v -E '^[[:space:]]*//' "$1" || true
}

for file in "$MODULE" "$POLICY" "$MAIN" "${CONTENT_MODULES[@]}" "${COLLECTION_MODULES[@]}"; do
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
require(set(policy) == {"fields", "error_sites", "path_sites"}, "unexpected policy section")
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

# Inventory literal Rust token trees, not text inside comments or strings.
# Keep all platform/feature branches; skip only explicit test items and the
# two out-of-line test modules. Unknown tracing syntax fails for review.
token = re.compile(r'\s+|//[^\n]*|/\*|(?:br|r)(?P<hashes>\#*)".*?"(?P=hashes)|b?"(?:\\.|[^"\\])*"|b?\'(?:\\.|[^\'\\])\'|(?:r\#)?[A-Za-z_][A-Za-z_0-9]*|::|.', re.S)
macros = {"trace", "debug", "info", "warn", "error", "event", "span"}
macros |= {name + "_span" for name in ("trace", "debug", "info", "warn", "error")}
path_names = {"path", "dir", "launch", "shell", "codex_home"}

def tokens(text):
    result, pos = [], 0
    while pos < len(text):
        match = token.match(text, pos)
        value, start = match.group(), pos
        pos = match.end()
        if value == "/*":
            depth = 1
            while depth:
                comment = re.search(r'/\*|\*/', text[pos:])
                require(comment is not None, "unterminated Rust comment")
                depth += 1 if comment.group() == "/*" else -1
                pos += comment.end()
        elif not value.isspace() and not value.startswith("//"):
            result.append((value, start, pos))
    return result

def inventory(text):
    ts = tokens(text)
    words = [t[0] for t in ts]
    ends, stack = {}, []
    for i, word in enumerate(words):
        if word in {"(", "[", "{"}:
            stack.append(i)
        elif word in {")", "]", "}"}:
            require(bool(stack), "unbalanced Rust token tree")
            start = stack.pop()
            require(words[start] + word in {"()", "[]", "{}"}, "mismatched Rust delimiters")
            ends[start] = i
    require(not stack, "unbalanced Rust token tree")

    def args(start, end):
        part, i = start, start
        while i < end:
            if words[i] == ",":
                if part < i:
                    yield words[part:i]
                part = i + 1
            i = ends[i] + 1 if i in ends else i + 1
        if part < end:
            yield words[part:end]

    i = 0
    while i < len(words):
        if words[i:i+7] == ["#", "[", "cfg", "(", "test", ")", "]"] or words[i:i+4] == ["#", "[", "test", "]"]:
            i = ends[i+1] + 1
            # Attributes, signatures and initializers may contain token trees.
            while i < len(words) and words[i] not in {"{", ";", ","}:
                i = ends[i] + 1 if i in ends else i + 1
            i = ends[i] + 1 if i in ends else i + 1
            continue
        if words[i:i+2] == ["use", "tracing"]:
            end = words.index(";", i)
            require("as" not in words[i:end], "tracing import aliases require guard support")
        if words[i] not in macros or words[i+1:i+3] not in (["!", "("], ["!", "{"], ["!", "["]):
            i += 1
            continue
        # Bare imported macros and tracing-qualified macros are covered.
        if i >= 2 and words[i-1] == "::" and words[i-2] != "tracing":
            i += 1
            continue
        start = i - 2 if i >= 2 and words[i-1] == "::" else i
        end = ends[i+2]
        fields = set()
        span_name = words[i] == "span" or words[i].endswith("_span")
        for arg in args(i+3, end):
            if len(arg) > 1 and arg[1] == ":" and arg[0] in {"target", "parent", "name"}:
                continue
            if words[i] in {"event", "span"} and re.fullmatch(r'(?:tracing::)?Level::(?:TRACE|DEBUG|INFO|WARN|ERROR)', "".join(arg)):
                continue
            if re.match(r'^(?:r\#*)?"', arg[0]) and (len(arg) == 1 or arg[1] != "="):
                if span_name:
                    span_name = False
                    continue
                fields.add("message")
                break  # Subsequent arguments belong to the format string.
            field = re.match(r'^[%?]?([A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*)(?:=|$)', "".join(arg))
            require(field is not None, "review unsupported tracing field syntax")
            fields.add(field[1])
        yield text.count("\n", 0, ts[start][1]) + 1, text[ts[start][1]:ts[end][2]], fields
        i += 1  # Also inventory tracing calls nested inside field expressions.

reviewed_paths = {}
for site in policy["path_sites"]:
    key = (site["file"], site["line"], site["field"])
    require(key not in reviewed_paths, "duplicate path callsite")
    require(site["field"] in path_names and bool(site.get("why")), "path callsite needs an origin review")
    reviewed_paths[key] = site["source"]
found_paths = {}
for path in sorted(Path("daemon/src").rglob("*.rs")):
    if path.name in {"support_log_tests.rs", "support_tests.rs", "support_store_tests.rs", "update_tests.rs"}:
        continue  # Both are included only by #[cfg(test)] modules.
    text = path.read_text()
    for line, statement, fields in inventory(text):
        missing = fields - policy["fields"].keys()
        require(not missing, f"unreviewed tracing fields at {path}:{line}: {sorted(missing)}")
        for field in fields & path_names:
            key = (str(path.relative_to("daemon")), line, field)
            require(reviewed_paths.get(key) == statement, f"review new/moved/changed path callsite {key}")
            found_paths[key] = statement
require(found_paths == reviewed_paths, "remove or review stale path callsites")

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
    '"choice" => rule.values.iter().any(|v| v == raw)',
]:
    require(gate in collector, "missing construction gate: " + gate)
visitor = collector.split("impl Visit for Collector<'_> {", 1)[1]
compact = re.sub(r"\s+", "", visitor)
require('self.push_text(field,||bounded_format(value));' in compact, "Debug bypasses admission")
require('self.push_text(field,||{' in compact, "str bypasses admission")
require(compact.count('self.push_scalar(field,||') == 6, "all scalar types must use admission")
require(compact.count('self.fields.push(') == 1 and 'FieldValue::Str(WITHHELD.to_owned())' in compact, "bytes must be withheld")
require('msg: &msg' in source and 'fields: is_spawnd(target).then_some(FieldsOut(&fields))' in source, "foreign record shape changed")
# Pin the production event emission and only its empty message argument. An
# extra event visitation or render call is a new path requiring review.
require(layer.count("event.record(") == 1, "additional event visitation path")
require(layer.count("render_line(") == 1, "additional event rendering path")
require('"",\n                collector.fields,' in layer, "event messages must remain empty")

# Collection is deliberately split: consent/receipts have local storage, but
# the uploader may not open any file or choose an arbitrary byte source.
upload = Path("daemon/src/support.rs").read_text()
upload_compact = re.sub(r"\s+", "", upload)
storage = Path("daemon/src/support_store.rs").read_text()
consent = Path("daemon/src/support_consent.rs").read_text()
io_worker = Path("daemon/src/support_io.rs").read_text()
for module in (upload, storage, consent, io_worker):
    code = "\n".join(line for line in module.splitlines() if not line.lstrip().startswith("//"))
    for marker in ("read_dir", ".entries(", "glob(", "glob::", "walkdir", "WalkDir", "read_link",
                   "scrollback", "REPLAY_DUMP", ".replay", "spawnd.log", "err.log", "journal"):
        require(marker not in code, "forbidden collection source: " + marker)
for marker in ("std::fs", "tokio::fs", "File::", "OpenOptions", "include_bytes!", "include_str!",
               "Command::new", "read_to_end", "read_to_string", "crate::host_files", "crate::host_control",
               "crate::upload", "crate::worker_backend", "crate::sessions", "crate::pty"):
    require(marker not in upload, "uploader must not open or produce another byte source: " + marker)
require(upload_compact.count("request.send()") == 1 and upload.count("client.post(") == 1,
        "exactly one HTTP upload call site")
require(upload_compact.count(".body(") == 1 and
        ".body(body)" in upload_compact,
        "only the reader NDJSON may be a raw body")
require(upload_compact.count(".json(") == 1 and
        ".json(&reason)" in upload_compact,
        "only the typed refusal enum may be JSON")
require(upload.count("let support_log::UploadBundle { header, body } = prepared;") == 1,
        "NDJSON bytes must come from the support reader")
require(not re.search(r"\blet\s+(?:mut\s+)?body\b", upload), "body shadowing requires review")
require(not re.search(r"->\s*(?:Vec\s*<\s*u8\s*>|bytes::Bytes)", upload), "extra byte-returning helper")
# Hash reviewed token markers, not whitespace or line numbers. These pin the
# refusal representation and every function carrying upload bytes;
# they are a regression guard, NOT a data-flow or security proof.
import hashlib
UPLOAD_MARKERS = [('#[serde(tag = "declined", rename_all = "snake_case")]', 'pub(crate) struct Trust {', '851d0947e59bb94da22450470376692fcae746c02fb7df3e6ffa26baec323296'), ('fn prepare(', 'fn endpoint(', 'a00b4d7b12bf5e35d0e0a39fcc142614f4821c6b7cdc96387d063e4d9fb11555'), ('async fn collect(', '#[path = "support_tests.rs"]', 'f5b389e55f2043f6a35bb17cff87c5b7075a204b2c41f7255c65b36ff3174a73')]
for start, end, digest in UPLOAD_MARKERS:
    require(upload.count(start) == 1 and upload.count(end) == 1, "unique upload marker")
    region = upload.split(start, 1)[1].split(end, 1)[0]
    marked = " ".join(value for value, _, _ in tokens(region))
    require(hashlib.sha256(marked.encode()).hexdigest() == digest, "review upload marker: " + start)
BODY_MARKERS = [('fn read_window(', 'pub(crate) const MAX_BODY_BYTES:', 'f551404eba6ad4d79e9fe8d26c65e7b6282ba9ddd436652393d0feb0f3ad3bfd'), ('impl Bundle {', 'fn record_time(', '94b3f931a7ec20d2fd04c66d77f46da1f9608bd93e9d11137a8b775c3d6bc858'), ('pub(crate) const MAX_BODY_BYTES:', '/// Tests only: one support log', '9d3a8035f9566d9297ed3a1be7708b2e488aa6588ea1211622976570d7f9151d')]
for start, end, digest in BODY_MARKERS:
    require(source.count(start) == 1 and source.count(end) == 1, "unique body source marker")
    region = source.split(start, 1)[1].split(end, 1)[0]
    marked = " ".join(value for value, _, _ in tokens(region))
    require(hashlib.sha256(marked.encode()).hexdigest() == digest, "review body source marker: " + start)
require(upload.count("support_log::collect_bundle(") == 1, "one support reader per collection")
require("Policy::none()" in upload and "retry::never()" in upload and "connect_timeout(" in upload and "timeout_at(work_deadline" in upload_compact,
        "origin-pinned bounded upload required")
require("request_id: Uuid" in upload and "crate::config::api_url(&base," in upload, "typed request path required")
require("spawn_blocking" not in upload and "ctx.io.run_with(" in upload_compact,
        "snapshot must run on the dedicated support worker")
require(upload.count("tokio::spawn(") == 1 and "tokio::spawn(serve(" in upload_compact,
        "only the sequential support actor may be spawned")
require('.no_proxy()' in upload and '.dns_resolver(' in upload,
        "collector DNS must use the support worker without environment proxies")
require('MAX_BODY_BYTES: usize = 900 * 1024;' in source and
        'application/x-ndjson' in upload, "bounded NDJSON body required")
for module in (storage, consent, io_worker):
    require("reqwest" not in module and ".post(" not in module, "storage cannot upload")
run = Path("daemon/src/run.rs").read_text()
arm = run.split("Inbound::SupportLogCollect {", 1)[1].split("Inbound::Error", 1)[0]
require(".await" not in arm and "support.collect(" in arm, "dispatch must only enqueue collection")
require("crate::run::admitted_device(" in upload and "find_valid_chain(" in run and
        "if revoked.contains(&verified.sender_public_key().to_bytes())" in run,
        "support admission must preserve the unchanged connection verifier")
PY_POLICY

self_test() {
  local fixture
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' RETURN

  mkdir -p "$fixture/daemon"
  cp -R daemon/src "$fixture/daemon/src"
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

  printf '%s\n' 'tracing::warn!(new_support_field = 1, "inventory");' >>"$fixture/$MODULE"
  expect_failure "a field without a policy decision"

  printf '%s\n' 'warn!(' '    %new_support_field,' '    "inventory"' ');' >>"$fixture/$MODULE"
  expect_failure "an imported multiline shorthand field without a decision"

  printf '%s\n' 'tracing::warn!(count = { tracing::warn!(new_support_field = 1); 1 });' >>"$fixture/$MODULE"
  expect_failure "an undecided field in a nested tracing call"

  printf '%s\n' 'tracing::warn!(path = %value, "unreviewed path origin");' >>"$fixture/$MODULE"
  expect_failure "a new callsite using a reviewed path name"

  printf '%s\n' 'warn!(%shell, "unreviewed shell origin");' >>"$fixture/$MODULE"
  expect_failure "an imported shorthand path callsite"

  mutate_module '"choice" => rule.values.iter().any(|v| v == raw)' '"choice" => true'
  expect_failure "accepting arbitrary choice strings"

  mutate_module '                collector.fields,' '                { event.record(&mut collector); collector.fields },'
  expect_failure "an extra event visitation path"

  mutate_module '                "",' '                &format!("{:?}", event),'
  expect_failure "formatting a message into an event"

  local upload_file="$fixture/daemon/src/support.rs"
  local original_upload
  original_upload="$(cat "$upload_file")"
  expect_upload_failure() {
    if SUPPORT_LOG_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
      fail "self-test: $1 passed"
    fi
    printf '%s\n' "$original_upload" >"$upload_file"
  }
  for mutation in 'let b = std::fs::read(path);' 'let b = tokio::fs::read(path);' 'let b = File::open(path);' 'let b = include_bytes!("extra");' 'let b = glob("*");' 'let b = dir.entries();' 'let b = "scrollback";' 'let b = "SPAWND_DIAG_REPLAY_DUMP_DIR";' 'let b = "spawnd.log";' 'let b = "err.log";' 'let b = "journal";' 'let b = client.post(url).send().await;'; do
    printf '%s\n' "$mutation" >>"$upload_file"
    expect_upload_failure "another collection source or upload: $mutation"
  done
  python3 -I - "$upload_file" <<'PY_MUTATE_UPLOAD'
from pathlib import Path
import sys
p = Path(sys.argv[1]); s = p.read_text()
assert '.body(body)' in s
p.write_text(s.replace('.body(body)', '.body(arbitrary)'))
PY_MUTATE_UPLOAD
  expect_upload_failure "a body not supplied by the support reader"

  for mutation in 'request = request.json(&credentials);' 'request = request.body(arbitrary);' 'let body = arbitrary;' 'fn other_bytes() -> Vec<u8> { elsewhere() }'; do
    printf '%s\n' "$mutation" >>"$upload_file"
    expect_upload_failure "extra, shadowed or helper body: $mutation"
  done
  python3 -I - "$upload_file" <<'PY_MUTATE_UPLOAD'
from pathlib import Path
import sys
p = Path(sys.argv[1]); s = p.read_text()
p.write_text(s.replace('.body(body)', '.body(other_bytes())') + '\nfn other_bytes() -> Vec<u8> { elsewhere() }\n')
PY_MUTATE_UPLOAD
  expect_upload_failure "helper sourcing bytes elsewhere"

  mutate_module 'MAX_BODY_BYTES: usize = 900 * 1024;' 'MAX_BODY_BYTES: usize = 1024 * 1024;'
  expect_failure "an enlarged NDJSON body cap"
  mutate_module 'self.header.bytes = total;' 'self.header.bytes = 0;'
  expect_failure "changed NDJSON encoding"
  mutate_module 'used + text.len() + 1 > max_bytes' 'used > max_bytes'
  expect_failure "changed NDJSON selection"

  for pair in 'application/x-ndjson application/octet-stream' '.no_proxy() .pool_max_idle_per_host(0)'; do
    read -r old new <<<"$pair"
    python3 -I - "$upload_file" "$old" "$new" <<'PY_MUTATE_UPLOAD'
from pathlib import Path
import sys
p = Path(sys.argv[1]); s = p.read_text()
p.write_text(s.replace(sys.argv[2], sys.argv[3]))
PY_MUTATE_UPLOAD
    expect_upload_failure "changed body or resolver contract: $old"
  done

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

  python3 -I - "$fixture/$POLICY" <<'PY_MUTATE'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
policy = json.loads(path.read_text())
policy["path_sites"][0]["line"] += 1
path.write_text(json.dumps(policy))
PY_MUTATE
  expect_failure "a stale path callsite entry"
  printf '%s\n' "$original_policy" >"$fixture/$POLICY"

  # Strings/comments are not callsites; test-only unknown fields are deliberate.
  cat >>"$fixture/$MODULE" <<'RUST'
const DECOY: &str = r#"tracing::warn!(undecided_field = 1, path = value);"#;
/* outer /* tracing::warn!(undecided_field = 1); */ comment */
#[cfg(test)]
fn inventory_fixture() { tracing::warn!(undecided_field = 1, path = value); }
RUST
  SUPPORT_LOG_GUARD_ROOT="$fixture" "$script_path" >/dev/null ||
    fail "self-test: strings, comments or test-only fields entered the inventory"
  printf '%s\n' "$original" >"$fixture/$MODULE"

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
