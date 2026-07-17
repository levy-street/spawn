#!/usr/bin/env bash
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_root="${WORKER_ONLY_GUARD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$repo_root"

forbidden='tmux|tmux_session|agent\.rename|SPAWND_SESSION_BACKEND|BackendKind|ExactReplayBuffer'

guard_paths=(
  daemon
  server
  web
  README.md
  daemon/README.md
  server/README.md
  web/README.md
  proto/README.md
  .env.example
  .github
  infra
  scripts
)

run_guard() {
  command -v python3 >/dev/null 2>&1 || {
    printf '%s\n' "worker-only guard: python3 is required" >&2
    return 1
  }
  if [[ -e daemon/src/tmux.rs ]]; then
    printf '%s\n' "worker-only guard: daemon/src/tmux.rs must not exist" >&2
    return 1
  fi

  local existing_paths=()
  local path
  for path in "${guard_paths[@]}"; do
    [[ -e "$path" ]] && existing_paths+=("$path")
  done

  # In a worktree, scan tracked files plus non-ignored new source. This keeps
  # generated runtime data (notably server/data transcripts) out of the source
  # boundary without allowing a newly added, not-yet-staged source file to
  # evade the guard. Source archives without Git metadata use the same path
  # inventory with explicit generated-data exclusions below.
  local scan_paths=()
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    mapfile -d '' scan_paths < <(
      git ls-files -z --cached --others --exclude-standard -- "${existing_paths[@]}"
    )
    local filtered_paths=()
    local scan_path
    for scan_path in "${scan_paths[@]}"; do
      [[ "$scan_path" == "scripts/check-worker-only-daemon.sh" ]] || \
        filtered_paths+=("$scan_path")
    done
    scan_paths=("${filtered_paths[@]}")
  else
    scan_paths=("${existing_paths[@]}")
  fi

  # Scan every Rust source under daemon, including examples and any future
  # production-ish bin/build/bench trees. Also scan the server, browser,
  # generated-installer source, protocol tests, CI, and operational smokes.
  local matches
  matches="$(rg -n -i "$forbidden" \
    "${scan_paths[@]}" \
    --glob '!target/**' \
    --glob '!daemon/target/**' \
    --glob '!node_modules/**' \
    --glob '!web/node_modules/**' \
    --glob '!.next/**' \
    --glob '!web/.next/**' \
    --glob '!.venv/**' \
    --glob '!server/.venv/**' \
    --glob '!.pytest_cache/**' \
    --glob '!server/.pytest_cache/**' \
    --glob '!.ruff_cache/**' \
    --glob '!server/.ruff_cache/**' \
    --glob '!server/data/**' \
    --glob '!test-results/**' \
    --glob '!web/test-results/**' \
    --glob '!check-worker-only-daemon.sh' || true)"
  if [[ -n "$matches" ]]; then
    printf '%s\n' "worker-only guard: retired backend surface found:" >&2
    printf '%s\n' "$matches" >&2
    return 1
  fi

  # The lexical inventory above catches direct references. This second pass
  # folds ordinary static string construction so splitting the retired binary
  # name across Rust/Python literals or shell variables cannot revive it while
  # preserving historical prose under docs/.
  python3 - "$repo_root" "${scan_paths[@]}" <<'PY'
from __future__ import annotations

import ast
import re
import sys
import warnings
from pathlib import Path


root = Path(sys.argv[1]).resolve()
raw_paths = sys.argv[2:]
suffixes = {".py", ".rs", ".sh", ".bash"}
excluded_parts = {
    ".next",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "data",
    "node_modules",
    "target",
    "test-results",
}
max_source_bytes = 4 * 1024 * 1024
max_rust_concat_depth = 128


def die(path: Path, detail: str) -> None:
    relative = path.relative_to(root).as_posix()
    raise SystemExit(
        f"worker-only guard: computed retired backend surface found in "
        f"{relative}: {detail}"
    )


def iter_sources():
    seen: set[Path] = set()
    for raw in raw_paths:
        candidate = (root / raw).resolve()
        try:
            candidate.relative_to(root)
        except ValueError:
            raise SystemExit(f"worker-only guard: scan path escaped root: {raw}")
        paths = candidate.rglob("*") if candidate.is_dir() else (candidate,)
        for path in paths:
            if not path.is_file() or path.suffix not in suffixes:
                continue
            relative = path.relative_to(root)
            if path in seen or excluded_parts.intersection(relative.parts):
                continue
            if relative.as_posix() == "scripts/check-worker-only-daemon.sh":
                continue
            seen.add(path)
            yield path


def decoded_literal(token: str) -> str | None:
    token = token.strip()
    raw = re.fullmatch(r'(?:br|r)(?P<hashes>#{0,255})"(?P<body>.*)"(?P=hashes)', token, re.S)
    if raw is not None:
        return raw.group("body")
    if token.startswith('b"') or token.startswith("b'"):
        token = token[1:]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", SyntaxWarning)
            value = ast.literal_eval(token)
    except (SyntaxError, ValueError):
        return None
    if isinstance(value, bytes):
        return value.decode("utf-8", "ignore")
    return value if isinstance(value, str) else None


literal_pattern = re.compile(
    r'''(?sx)(?:br|r)\#{0,255}".*?"\#{0,255}|b?"(?:\\.|[^"\\])*"|b?'(?:\\.|[^'\\])*' '''
)
literal_joiner = re.compile(r"[\s,+!()\[\]{}.:;&|]*", re.S)


def reject_joined_literals(path: Path, source: str) -> None:
    literals = [
        (match.start(), match.end(), decoded_literal(match.group(0)))
        for match in literal_pattern.finditer(source)
    ]
    joined_tail = ""
    previous_end: int | None = None
    for start, end, value in literals:
        if value is None:
            joined_tail = ""
            previous_end = None
            continue
        folded = value.casefold()
        if previous_end is None or literal_joiner.fullmatch(source[previous_end:start]) is None:
            joined_tail = folded
        else:
            joined_tail += folded
        if "tmux" in joined_tail:
            die(path, repr(value))
        joined_tail = joined_tail[-3:]
        previous_end = end


def rust_tokens(path: Path, source: str):
    tokens: list[tuple[str, str]] = []
    index = 0
    while index < len(source):
        if source[index].isspace():
            index += 1
            continue
        if source.startswith("//", index):
            newline = source.find("\n", index + 2)
            index = len(source) if newline < 0 else newline + 1
            continue
        if source.startswith("/*", index):
            depth = 1
            index += 2
            while depth:
                if index >= len(source):
                    raise SystemExit(
                        f"worker-only guard: unterminated Rust block comment in {path}"
                    )
                if source.startswith("/*", index):
                    depth += 1
                    if depth > max_rust_concat_depth:
                        die(path, "Rust block-comment nesting exceeded its parser depth")
                    index += 2
                elif source.startswith("*/", index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            continue

        char_start = index + 2 if source.startswith("b'", index) else index + 1
        if source[index:index + 1] == "'" or source.startswith("b'", index):
            end = char_start
            if end < len(source) and source[end] == "\\":
                end += 1
                if source.startswith("u{", end):
                    closing = source.find("}", end + 2)
                    end = len(source) if closing < 0 else closing + 1
                elif source.startswith("x", end):
                    end += 3
                else:
                    end += 1
            else:
                end += 1
            if end < len(source) and source[end] == "'":
                tokens.append(("char", source[index : end + 1]))
                index = end + 1
                continue

        raw_match = re.match(r'(?:br|cr|r)(?P<hashes>#{0,255})"', source[index:])
        if raw_match is not None:
            hashes = raw_match.group("hashes")
            body_start = index + raw_match.end()
            closing = '"' + hashes
            body_end = source.find(closing, body_start)
            if body_end < 0:
                raise SystemExit(f"worker-only guard: unterminated Rust raw string in {path}")
            tokens.append(("string", source[body_start:body_end]))
            index = body_end + len(closing)
            continue

        prefix_length = 1 if source.startswith(('b"', 'c"'), index) else 0
        if source[index + prefix_length : index + prefix_length + 1] == '"':
            end = index + prefix_length + 1
            escaped = False
            while end < len(source):
                character = source[end]
                if character == '"' and not escaped:
                    break
                if character == "\\" and not escaped:
                    escaped = True
                else:
                    escaped = False
                end += 1
            if end >= len(source):
                raise SystemExit(f"worker-only guard: unterminated Rust string in {path}")
            token = source[index : end + 1]
            value = decoded_literal(token[1:] if prefix_length else token)
            tokens.append(("string", value) if value is not None else ("unknown_string", token))
            index = end + 1
            continue

        identifier = re.match(r"[A-Za-z_][A-Za-z0-9_]*", source[index:])
        if identifier is not None:
            tokens.append(("ident", identifier.group(0)))
            index += identifier.end()
            continue
        tokens.append(("punct", source[index]))
        index += 1
    return tokens


def reject_rust_concat(path: Path, source: str) -> None:
    tokens = rust_tokens(path, source)
    closing_for = {"(": ")", "[": "]", "{": "}"}
    for start in range(len(tokens) - 2):
        if tokens[start] != ("ident", "concat") or tokens[start + 1] != ("punct", "!"):
            continue
        opener = tokens[start + 2][1]
        if tokens[start + 2][0] != "punct" or opener not in closing_for:
            continue
        stack = [closing_for[opener]]
        values: list[str] = []
        index = start + 3
        valid = True
        while index < len(tokens) and stack:
            kind, value = tokens[index]
            if kind == "string":
                values.append(value)
            elif kind == "unknown_string":
                die(path, "unreviewed Rust string escape in concat construction")
            elif kind == "ident":
                valid = value == "concat"
            elif value in closing_for:
                stack.append(closing_for[value])
                if len(stack) > max_rust_concat_depth:
                    die(path, "Rust concat nesting exceeded its parser depth")
            elif value == stack[-1]:
                stack.pop()
            elif value not in {"!", ","}:
                valid = False
            if not valid:
                break
            index += 1
        if not valid:
            die(path, "unreviewed Rust concat construction")
        if stack:
            die(path, "unterminated Rust concat construction")
        joined = "".join(values)
        if "tmux" in joined.casefold():
            die(path, f"Rust concat construction {joined!r}")


def bounded_join(parts) -> str:
    value = "".join(parts)
    if len(value) > max_source_bytes:
        raise OverflowError("computed string exceeded source parser limit")
    return value


def python_static_string(node: ast.AST, bindings: dict[str, str]) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return bindings.get(node.id)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = python_static_string(node.left, bindings)
        right = python_static_string(node.right, bindings)
        return None if left is None or right is None else bounded_join((left, right))
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            elif isinstance(value, ast.FormattedValue):
                resolved = python_static_string(value.value, bindings)
                if resolved is None:
                    return None
                parts.append(resolved)
            else:
                return None
        return bounded_join(parts)
    if isinstance(node, (ast.List, ast.Tuple)):
        values = [python_static_string(item, bindings) for item in node.elts]
        return None if any(value is None for value in values) else bounded_join(values)  # type: ignore[arg-type]
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "chr"
        and len(node.args) == 1
        and isinstance(node.args[0], ast.Constant)
        and isinstance(node.args[0].value, int)
    ):
        try:
            return chr(node.args[0].value)
        except ValueError:
            return None
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "join"
        and len(node.args) == 1
    ):
        separator = python_static_string(node.func.value, bindings)
        values = python_static_string(node.args[0], bindings)
        if separator is not None and values is not None:
            if isinstance(node.args[0], (ast.List, ast.Tuple)):
                items = [python_static_string(item, bindings) for item in node.args[0].elts]
                if all(item is not None for item in items):
                    joined = separator.join(items)  # type: ignore[arg-type]
                    if len(joined) > max_source_bytes:
                        raise OverflowError("computed string exceeded source parser limit")
                    return joined
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "decode"
        and isinstance(node.func.value, ast.Call)
        and isinstance(node.func.value.func, ast.Name)
        and node.func.value.func.id == "bytes"
        and len(node.func.value.args) == 1
        and isinstance(node.func.value.args[0], (ast.List, ast.Tuple))
    ):
        values = node.func.value.args[0].elts
        if all(isinstance(item, ast.Constant) and isinstance(item.value, int) for item in values):
            try:
                return bytes(item.value for item in values).decode()  # type: ignore[union-attr]
            except (UnicodeDecodeError, ValueError):
                return None
    return None


def reject_python_static(path: Path, source: str) -> None:
    try:
        tree = ast.parse(source, filename=str(path))
    except (SyntaxError, RecursionError) as exc:
        raise SystemExit(f"worker-only guard: cannot parse {path}: {exc}")
    bindings: dict[str, str] = {}
    assignments = [
        node
        for node in ast.walk(tree)
        if isinstance(node, (ast.Assign, ast.AnnAssign))
    ]
    try:
        for _ in range(len(assignments) + 1):
            changed = False
            for node in assignments:
                target = None
                value = None
                if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                    target, value = node.targets[0].id, node.value
                elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                    target, value = node.target.id, node.value
                if target is None or value is None:
                    continue
                resolved = python_static_string(value, bindings)
                if resolved is not None and bindings.get(target) != resolved:
                    bindings[target] = resolved
                    changed = True
            if not changed:
                break
        for node in ast.walk(tree):
            value = python_static_string(node, bindings)
            if value is not None and "tmux" in value.casefold():
                die(path, repr(value))
    except (OverflowError, RecursionError) as exc:
        die(path, f"Python string construction exceeded its parser bound: {exc}")


shell_assignment = re.compile(
    r'''(?mx)(?:^|;)\s*(?:export\s+|local\s+|readonly\s+)?
        (?P<name>[A-Za-z_][A-Za-z0-9_]*)(?P<append>\+)?=
        (?P<value>"[^"\n]*"|'[^'\n]*'|[A-Za-z0-9_.-]+)\s*(?=;|$)
    '''
)
shell_variable = re.compile(r"\$(?:\{(?P<braced>[A-Za-z_][A-Za-z0-9_]*)\}|(?P<plain>[A-Za-z_][A-Za-z0-9_]*))")


def reject_shell_static(path: Path, source: str) -> None:
    bindings: dict[str, str] = {}

    def expand(value: str, resolving: frozenset[str] = frozenset()) -> str:
        def replace(match: re.Match[str]) -> str:
            name = match.group("braced") or match.group("plain")
            if name not in bindings:
                return match.group(0)
            if name in resolving:
                return match.group(0)
            return expand(bindings[name], resolving | {name})

        expanded = shell_variable.sub(replace, value)
        if len(expanded) > max_source_bytes:
            die(path, "shell string construction exceeded its parser limit")
        return expanded

    for match in shell_assignment.finditer(source.replace("\n", ";")):
        raw = match.group("value")
        if raw[:1] in {'"', "'"}:
            raw = raw[1:-1]
        value = expand(raw)
        name = match.group("name")
        bindings[name] = bindings.get(name, "") + value if match.group("append") else value
        if "tmux" in bindings[name].casefold():
            die(path, f"shell assignment {name}")
    expanded = expand(source)
    if "tmux" in expanded.casefold():
        die(path, "shell variable expansion")


for path in iter_sources():
    try:
        if path.stat().st_size > max_source_bytes:
            die(path, f"source exceeds {max_source_bytes} byte parser limit")
        source = path.read_text()
    except (OSError, UnicodeError) as exc:
        raise SystemExit(f"worker-only guard: cannot read {path}: {exc}")
    reject_joined_literals(path, source)
    if path.suffix == ".rs":
        reject_rust_concat(path, source)
    elif path.suffix == ".py":
        reject_python_static(path, source)
    elif path.suffix in {".sh", ".bash"}:
        reject_shell_static(path, source)
PY
}

self_test() {
  local fixture
  fixture="$(mktemp -d)"
  trap 'rm -rf "$fixture"' RETURN
  mkdir -p \
    "$fixture/daemon/src" \
    "$fixture/daemon/examples" \
    "$fixture/server/spawn_server/routes" \
    "$fixture/web/scripts" \
    "$fixture/scripts"
  printf '%s\n' 'fn main() {}' >"$fixture/daemon/src/main.rs"
  git -C "$fixture" init -q
  printf '%s\n' 'server/data/' >"$fixture/.gitignore"

  WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null

  expect_computed_fixture_rejected() {
    local path="$1"
    local label="$2"
    if WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
      printf '%s\n' "worker-only guard self-test: accepted $label" >&2
      return 1
    fi
    rm "$path"
  }

  # Ignored runtime transcripts are historical data, not a production source
  # surface. They must neither fail the guard nor produce unbounded output.
  mkdir -p "$fixture/server/data/transcripts"
  local retired_word='t'
  retired_word+='mux'
  printf '%s\n' "$retired_word capture-pane" \
    >"$fixture/server/data/transcripts/runtime.log"
  WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null

  local surfaces=(
    daemon/examples/rtc_probe.rs
    server/spawn_server/routes/install.py
    web/scripts/protocol.mjs
    scripts/smoke-protocol.sh
  )
  local surface
  for surface in "${surfaces[@]}"; do
    printf '%s\n' "$retired_word" >"$fixture/$surface"
    if WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
      printf 'worker-only guard self-test: failed to reject %s\n' "$surface" >&2
      return 1
    fi
    rm "$fixture/$surface"
  done

  python3 - "$fixture/daemon/examples/computed-retired.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn main() {
    let binary = concat!("t", "mux");
    let _ = std::process::Command::new(binary).status();
}
''')
PY
  if WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' "worker-only guard self-test: accepted computed Rust backend" >&2
    return 1
  fi
  rm "$fixture/daemon/examples/computed-retired.rs"

  python3 - "$fixture/daemon/examples/computed-padded.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn main() {
    let retired = concat!("t", "m", "u", "", "", "", "", "", "x");
    let _ = std::process::Command::new(retired).status();
}
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/computed-padded.rs" \
    "exact padded Rust backend" || return 1

  python3 - "$fixture/daemon/examples/computed-long-commented.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn main() {
    let retired = concat!(
        r#"t"#,
        /* arbitrary empty padding */ "", "", "", "", "", "", "", "", "", "",
        // Fragment comments and whitespace are semantically irrelevant.
        r###"m"###,

        "", "", "", "", "", "", "", "", "", "",
        "u",
        /* nested block comments are valid Rust: /* inner */ outer */
        "", "", "", "", "", "", "", "", "", "",
        "x",
    );
    let _ = std::process::Command::new(retired).status();
}
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/computed-long-commented.rs" \
    "long commented raw-string Rust backend" || return 1

  python3 - "$fixture/daemon/examples/computed-nested.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn main() {
    let retired = concat![
        r"t",
        concat!("", "m", concat! { "", "u", "", }, ""),
        r##"x"##,
    ];
    let _ = std::process::Command::new(retired).status();
}
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/computed-nested.rs" \
    "nested delimiter Rust backend" || return 1

  python3 - "$fixture/daemon/examples/computed-unreviewed.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn main() {
    let retired = concat!("t", stringify!(mux));
    let _ = std::process::Command::new(retired).status();
}
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/computed-unreviewed.rs" \
    "unreviewed Rust concat executable" || return 1

  python3 - "$fixture/server/spawn_server/routes/computed_backend.py" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''import subprocess
backend = "t" + "mux"
subprocess.run([backend], check=False)
''')
PY
  if WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' "worker-only guard self-test: accepted computed Python backend" >&2
    return 1
  fi
  rm "$fixture/server/spawn_server/routes/computed_backend.py"

  python3 - "$fixture/server/spawn_server/routes/computed_padded_backend.py" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''import subprocess
backend = "".join([
    "t",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "m",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "u",
    "", "", "", "", "", "", "", "", "", "", "", "",
    "x",
])
subprocess.run([backend], check=False)
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/server/spawn_server/routes/computed_padded_backend.py" \
    "padded Python backend" || return 1

  python3 - "$fixture/server/spawn_server/routes/computed_nested_backend.py" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''import subprocess
backend = ("t" + ("" + ("m" + ("" + ("u" + ("" + "x"))))))
subprocess.run([backend], check=False)
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/server/spawn_server/routes/computed_nested_backend.py" \
    "nested Python backend" || return 1

  python3 - "$fixture/scripts/computed-backend.sh" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''#!/usr/bin/env bash
backend=t
backend+=mux
"$backend" new-session
''')
PY
  if WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null 2>&1; then
    printf '%s\n' "worker-only guard self-test: accepted computed shell backend" >&2
    return 1
  fi
  rm "$fixture/scripts/computed-backend.sh"

  python3 - "$fixture/scripts/computed-padded-backend.sh" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''#!/usr/bin/env bash
backend=t
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=m
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=u
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=""
backend+=x
"$backend" new-session
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/scripts/computed-padded-backend.sh" \
    "padded shell backend" || return 1

  printf '%s\n' "worker-only daemon guard self-test passed"
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

# Historical documents under docs/ may discuss the retired backend. Runtime
# code, tests, metadata, top-level documentation, and operational fixtures may
# not reintroduce it.
run_guard

printf '%s\n' "worker-only daemon guard passed"
