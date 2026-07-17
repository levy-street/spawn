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
import io
import re
import sys
import tokenize
import warnings
from collections import defaultdict, deque
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
max_analysis_tokens = 250_000
max_analysis_nodes = 100_000
max_analysis_edges = 500_000


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

    def append(kind: str, value: str) -> None:
        tokens.append((kind, value))
        if len(tokens) > max_analysis_tokens:
            die(path, f"Rust token input exceeds {max_analysis_tokens}")

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
                token = source[index : end + 1]
                value = decoded_literal(token[1:] if token.startswith("b'") else token)
                append("string" if value is not None else "unknown_string", value if value is not None else token)
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
            append("string", source[body_start:body_end])
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
            append("string" if value is not None else "unknown_string", value if value is not None else token)
            index = end + 1
            continue

        identifier = re.match(r"[A-Za-z_][A-Za-z0-9_]*", source[index:])
        if identifier is not None:
            append("ident", identifier.group(0))
            index += identifier.end()
            continue
        append("punct", source[index])
        index += 1
    return tokens


def rust_matching_delimiter(path: Path, tokens, opener_index: int) -> int:
    closing_for = {"(": ")", "[": "]", "{": "}"}
    opener = tokens[opener_index][1]
    if tokens[opener_index][0] != "punct" or opener not in closing_for:
        die(path, "unreviewed Rust delimiter construction")
    stack = [closing_for[opener]]
    for index in range(opener_index + 1, len(tokens)):
        kind, value = tokens[index]
        if kind != "punct":
            continue
        if value in closing_for:
            stack.append(closing_for[value])
            if len(stack) > max_rust_concat_depth:
                die(path, "Rust delimiter nesting exceeded its parser depth")
        elif value == stack[-1]:
            stack.pop()
            if not stack:
                return index
        elif value in closing_for.values():
            die(path, "mismatched Rust delimiters")
    die(path, "unterminated Rust delimiter construction")


def reject_rust_concat(path: Path, source: str) -> None:
    tokens = rust_tokens(path, source)
    concat_cache: dict[int, tuple[int, str | None]] = {}

    def analyze_concat(start: int) -> tuple[int, str | None]:
        if start in concat_cache:
            return concat_cache[start]
        if (
            start + 2 >= len(tokens)
            or tokens[start] != ("ident", "concat")
            or tokens[start + 1] != ("punct", "!")
            or tokens[start + 2][1] not in {"(", "[", "{"}
        ):
            raise ValueError("not a concat invocation")
        end = rust_matching_delimiter(path, tokens, start + 2)
        parts: list[str] = []
        dynamic = False
        index = start + 3
        while index < end:
            kind, value = tokens[index]
            if kind == "string":
                parts.append(value)
            elif (
                kind == "ident"
                and value == "concat"
                and index + 2 < end
                and tokens[index + 1] == ("punct", "!")
                and tokens[index + 2][1] in {"(", "[", "{"}
            ):
                nested_end, nested_value = analyze_concat(index)
                if nested_value is None:
                    dynamic = True
                else:
                    parts.append(nested_value)
                index = nested_end
            elif kind == "punct" and value == ",":
                pass
            else:
                dynamic = True
            index += 1
        joined = bounded_join(parts)
        result = (end, None if dynamic else joined)
        concat_cache[start] = result
        return result

    dynamic_concat_ranges: list[tuple[int, int]] = []
    for start in range(len(tokens) - 2):
        if (
            tokens[start] == ("ident", "concat")
            and tokens[start + 1] == ("punct", "!")
            and tokens[start + 2][1] in {"(", "[", "{"}
        ):
            end, value = analyze_concat(start)
            if value is None:
                dynamic_concat_ranges.append((start, end))
            elif "tmux" in value.casefold():
                die(path, f"Rust concat construction {value!r}")

    # Dynamic concat inputs such as env! and module_path! are common in
    # include paths and diagnostics. They become forbidden only when their
    # value flows to a process, exec/syscall, or dynamic-loader sink.
    assignment_records: list[tuple[str, int, int]] = []
    nodes: set[str] = set()
    for equals in range(len(tokens)):
        if tokens[equals] != ("punct", "="):
            continue
        previous = tokens[equals - 1][1] if equals else ""
        following = tokens[equals + 1][1] if equals + 1 < len(tokens) else ""
        if previous in {"=", "!", "<", ">"} or following in {"=", ">"}:
            continue
        left = equals - 1
        while left >= 0 and tokens[left][1] not in {";", "{", "}"}:
            left -= 1
        left += 1
        target = None
        declaration = next(
            (
                index
                for index in range(left, equals)
                if tokens[index][0] == "ident" and tokens[index][1] in {"let", "const", "static"}
            ),
            None,
        )
        if declaration is not None:
            for index in range(declaration + 1, equals):
                if tokens[index][0] == "ident" and tokens[index][1] not in {"mut", "ref"}:
                    target = tokens[index][1]
                    break
        else:
            target = next(
                (tokens[index][1] for index in range(equals - 1, left - 1, -1) if tokens[index][0] == "ident"),
                None,
            )
        if target is None:
            continue
        right = equals + 1
        stack: list[str] = []
        closing_for = {"(": ")", "[": "]", "{": "}"}
        while right < len(tokens):
            kind, value = tokens[right]
            if kind == "punct" and value in closing_for:
                stack.append(closing_for[value])
            elif kind == "punct" and stack and value == stack[-1]:
                stack.pop()
            elif kind == "punct" and value == ";" and not stack:
                break
            right += 1
        assignment_records.append((target, equals + 1, right))
        nodes.add(target)
        if len(nodes) > max_analysis_nodes:
            die(path, f"Rust flow graph exceeds {max_analysis_nodes} nodes")

    edge_candidates: set[tuple[str, str]] = set()
    tainted: set[str] = set()
    dynamic_concat_starts = {start for start, _ in dynamic_concat_ranges}
    for target, start, end in assignment_records:
        contains_dynamic = False
        for index in range(start, end):
            if tokens[index][0] == "ident" and tokens[index][1] != target:
                edge_candidates.add((tokens[index][1], target))
            contains_dynamic = contains_dynamic or index in dynamic_concat_starts
        if contains_dynamic:
            tainted.add(target)
        if len(edge_candidates) > max_analysis_edges:
            die(path, f"Rust flow graph exceeds {max_analysis_edges} edges")

    collection_mutators = {"append", "extend", "insert", "push", "push_back", "push_front"}
    for index in range(len(tokens) - 3):
        if (
            tokens[index][0] == "ident"
            and tokens[index + 1] == ("punct", ".")
            and tokens[index + 2][0] == "ident"
            and tokens[index + 2][1] in collection_mutators
            and tokens[index + 3] == ("punct", "(")
        ):
            end = rust_matching_delimiter(path, tokens, index + 3)
            nodes.add(tokens[index][1])
            for argument in range(index + 4, end):
                if tokens[argument][0] == "ident":
                    edge_candidates.add((tokens[argument][1], tokens[index][1]))
                if argument in dynamic_concat_starts:
                    tainted.add(tokens[index][1])
            if len(nodes) > max_analysis_nodes or len(edge_candidates) > max_analysis_edges:
                die(path, "Rust collection flow graph exceeded its analysis cap")

    dependents: dict[str, set[str]] = defaultdict(set)
    for source_name, target in edge_candidates:
        if source_name in nodes:
            dependents[source_name].add(target)
    queue = deque(sorted(tainted))
    while queue:
        source_name = queue.popleft()
        for target in sorted(dependents.get(source_name, ())):
            if target not in tainted:
                tainted.add(target)
                queue.append(target)

    executable_functions = {
        "LoadLibraryA",
        "LoadLibraryW",
        "LoadPackagedLibrary",
        "dlopen",
        "dlmopen",
        "exec",
        "execl",
        "execlp",
        "execv",
        "execve",
        "execveat",
        "execvp",
        "execvpe",
        "fexecve",
        "popen",
        "posix_spawn",
        "posix_spawnp",
        "syscall",
        "system",
    }

    def is_executable_sink(index: int) -> bool:
        name = tokens[index][1]
        if name in executable_functions:
            return True
        if name not in {"from", "new", "open"}:
            return False
        prefix_identifiers: set[str] = set()
        cursor = index - 1
        while cursor >= 0 and (
            tokens[cursor][0] == "ident" or tokens[cursor][1] in {".", ":"}
        ):
            if tokens[cursor][0] == "ident":
                prefix_identifiers.add(tokens[cursor][1])
            cursor -= 1
        return (
            name in {"from", "new"} and "Command" in prefix_identifiers
        ) or (
            name in {"new", "open"} and "Library" in prefix_identifiers
        )

    for index in range(len(tokens) - 1):
        if (
            tokens[index][0] != "ident"
            or tokens[index + 1] != ("punct", "(")
            or not is_executable_sink(index)
        ):
            continue
        end = rust_matching_delimiter(path, tokens, index + 1)
        direct_dynamic = any(argument in dynamic_concat_starts for argument in range(index + 2, end))
        referenced_taint = any(
            tokens[argument][0] == "ident" and tokens[argument][1] in tainted
            for argument in range(index + 2, end)
        )
        if direct_dynamic or referenced_taint:
            die(path, f"unreviewed Rust concat value reaches executable sink {tokens[index][1]}")


def bounded_join(parts) -> str:
    value = "".join(parts)
    if len(value) > max_source_bytes:
        raise OverflowError("computed string exceeded source parser limit")
    return value


def python_static_string_uncached(
    node: ast.AST,
    bindings: dict[str, str],
    cache: dict[int, str | None] | None,
) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return bindings.get(node.id)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = python_static_string(node.left, bindings, cache)
        right = python_static_string(node.right, bindings, cache)
        return None if left is None or right is None else bounded_join((left, right))
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            elif isinstance(value, ast.FormattedValue):
                resolved = python_static_string(value.value, bindings, cache)
                if resolved is None:
                    return None
                parts.append(resolved)
            else:
                return None
        return bounded_join(parts)
    if isinstance(node, (ast.List, ast.Tuple)):
        values = [python_static_string(item, bindings, cache) for item in node.elts]
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
        separator = python_static_string(node.func.value, bindings, cache)
        values = python_static_string(node.args[0], bindings, cache)
        if separator is not None and values is not None:
            if isinstance(node.args[0], (ast.List, ast.Tuple)):
                items = [python_static_string(item, bindings, cache) for item in node.args[0].elts]
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


def python_static_string(
    node: ast.AST,
    bindings: dict[str, str],
    cache: dict[int, str | None] | None = None,
) -> str | None:
    key = id(node)
    if cache is not None and key in cache:
        return cache[key]
    value = python_static_string_uncached(node, bindings, cache)
    if cache is not None:
        cache[key] = value
    return value


def reject_python_static(path: Path, source: str) -> None:
    try:
        token_count = 0
        for _ in tokenize.generate_tokens(io.StringIO(source).readline):
            token_count += 1
            if token_count > max_analysis_tokens:
                die(path, f"Python token input exceeds {max_analysis_tokens}")
        tree = ast.parse(source, filename=str(path))
    except (SyntaxError, RecursionError, tokenize.TokenError) as exc:
        raise SystemExit(f"worker-only guard: cannot parse {path}: {exc}")
    ast_nodes = list(ast.walk(tree))
    if len(ast_nodes) > max_analysis_nodes:
        die(path, f"Python syntax tree exceeds {max_analysis_nodes} nodes")

    definitions: dict[str, list[ast.AST]] = {}
    ambiguous: set[str] = set()
    for node in sorted(ast_nodes, key=lambda item: (getattr(item, "lineno", 0), getattr(item, "col_offset", 0))):
        targets: list[str] = []
        value = None
        append = False
        if isinstance(node, ast.Assign):
            targets = [target.id for target in node.targets if isinstance(target, ast.Name)]
            value = node.value
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            targets = [node.target.id]
            value = node.value
        elif (
            isinstance(node, ast.AugAssign)
            and isinstance(node.target, ast.Name)
            and isinstance(node.op, ast.Add)
        ):
            targets = [node.target.id]
            value = node.value
            append = True
        if value is None:
            continue
        for target in targets:
            if append:
                if target not in definitions or target in ambiguous:
                    ambiguous.add(target)
                else:
                    definitions[target].append(value)
            elif target in definitions:
                ambiguous.add(target)
            else:
                definitions[target] = [value]
    if len(definitions) > max_analysis_nodes:
        die(path, f"Python binding graph exceeds {max_analysis_nodes} nodes")

    dependencies: dict[str, set[str]] = {}
    edge_count = 0
    for target, parts in definitions.items():
        names = {
            node.id
            for part in parts
            for node in ast.walk(part)
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id != target
        }
        dependencies[target] = names
        edge_count += len(names)
        if edge_count > max_analysis_edges:
            die(path, f"Python binding graph exceeds {max_analysis_edges} edges")

    dependents: dict[str, set[str]] = defaultdict(set)
    remaining: dict[str, int] = {}
    externally_blocked: set[str] = set()
    for target, names in dependencies.items():
        known = {name for name in names if name in definitions and name not in ambiguous}
        remaining[target] = len(known)
        if any(name not in definitions or name in ambiguous for name in names):
            externally_blocked.add(target)
        for name in known:
            dependents[name].add(target)

    bindings: dict[str, str] = {}
    queue = deque(
        sorted(
            target
            for target in definitions
            if target not in ambiguous and target not in externally_blocked and remaining[target] == 0
        )
    )
    try:
        while queue:
            target = queue.popleft()
            values = [python_static_string(part, bindings) for part in definitions[target]]
            if any(value is None for value in values):
                continue
            resolved = bounded_join(values)  # type: ignore[arg-type]
            bindings[target] = resolved
            if "tmux" in resolved.casefold():
                die(path, repr(resolved))
            for dependent in sorted(dependents.get(target, ())):
                remaining[dependent] -= 1
                if (
                    remaining[dependent] == 0
                    and dependent not in ambiguous
                    and dependent not in externally_blocked
                ):
                    queue.append(dependent)
        # Cycles and references to external runtime values remain unresolved in
        # deterministic lexical order; every resolvable edge is visited once.
        expression_cache: dict[int, str | None] = {}
        for node in ast_nodes:
            value = python_static_string(node, bindings, expression_cache)
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
    flattened = source.replace("\n", ";")
    matches = list(shell_assignment.finditer(flattened))
    variable_tokens = list(shell_variable.finditer(source))
    if len(matches) + len(variable_tokens) > max_analysis_tokens:
        die(path, f"shell token input exceeds {max_analysis_tokens}")

    definitions: dict[str, list[str]] = {}
    ambiguous: set[str] = set()
    for match in matches:
        raw = match.group("value")
        if raw[:1] in {'"', "'"}:
            raw = raw[1:-1]
        name = match.group("name")
        if match.group("append"):
            if name not in definitions or name in ambiguous:
                ambiguous.add(name)
            else:
                definitions[name].append(raw)
        elif name in definitions:
            ambiguous.add(name)
        else:
            definitions[name] = [raw]
    if len(definitions) > max_analysis_nodes:
        die(path, f"shell binding graph exceeds {max_analysis_nodes} nodes")

    dependencies: dict[str, set[str]] = {}
    edge_count = 0
    for name, parts in definitions.items():
        dependencies[name] = {
            match.group("braced") or match.group("plain")
            for part in parts
            for match in shell_variable.finditer(part)
        }
        edge_count += len(dependencies[name])
        if edge_count > max_analysis_edges:
            die(path, f"shell binding graph exceeds {max_analysis_edges} edges")

    dependents: dict[str, set[str]] = defaultdict(set)
    remaining: dict[str, int] = {}
    externally_blocked: set[str] = set()
    for name, dependencies_for_name in dependencies.items():
        known = {
            dependency
            for dependency in dependencies_for_name
            if dependency in definitions and dependency not in ambiguous
        }
        remaining[name] = len(known)
        if any(
            dependency not in definitions or dependency in ambiguous
            for dependency in dependencies_for_name
        ):
            externally_blocked.add(name)
        for dependency in known:
            dependents[dependency].add(name)

    bindings: dict[str, str] = {}
    queue = deque(
        sorted(
            name
            for name in definitions
            if name not in ambiguous and name not in externally_blocked and remaining[name] == 0
        )
    )
    while queue:
        name = queue.popleft()
        parts = [
            shell_variable.sub(
                lambda match: bindings[match.group("braced") or match.group("plain")],
                part,
            )
            for part in definitions[name]
        ]
        value = bounded_join(parts)
        bindings[name] = value
        if "tmux" in value.casefold():
            die(path, f"shell assignment {name}")
        for dependent in sorted(dependents.get(name, ())):
            remaining[dependent] -= 1
            if (
                remaining[dependent] == 0
                and dependent not in ambiguous
                and dependent not in externally_blocked
            ):
                queue.append(dependent)

    # Unresolved external references and cycles retain their original spelling;
    # resolved substitutions are one pass over the bounded source, not a
    # recursive expansion from each occurrence.
    expanded = shell_variable.sub(
        lambda match: bindings.get(
            match.group("braced") or match.group("plain"),
            match.group(0),
        ),
        source,
    )
    if len(expanded) > max_source_bytes:
        die(path, "shell string construction exceeded its parser limit")
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

  python3 - "$fixture/daemon/examples/safe-dynamic-concat.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''const BINDINGS: &str = concat!(env!("OUT_DIR"), "/bindings.rs");

fn worker_label() -> &'static str {
    concat!(module_path!(), "::worker")
}

fn main() {
    let generated = concat!(env!("OUT_DIR"), "/generated.rs");
    println!("{} {} {}", BINDINGS, generated, worker_label());
}
''')
PY
  if ! WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null; then
    printf '%s\n' "worker-only guard self-test: rejected unrelated dynamic Rust concat" >&2
    return 1
  fi
  rm "$fixture/daemon/examples/safe-dynamic-concat.rs"

  python3 - "$fixture/daemon/examples/dynamic-concat-direct-sink.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn main() {
    let _ = std::process::Command::new(concat!(env!("WORKER_BIN"), "/worker")).status();
}
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-direct-sink.rs" \
    "direct dynamic Rust executable sink" || return 1

  python3 - "$fixture/daemon/examples/dynamic-concat-assigned-sink.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn main() {
    let executable = concat!(module_path!(), "::worker");
    let _ = std::process::Command::new(executable).status();
}
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-assigned-sink.rs" \
    "assigned dynamic Rust executable sink" || return 1

  python3 - "$fixture/daemon/examples/dynamic-concat-aliased-sink.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn main() {
    let executable = concat!(env!("WORKER_BIN"), "/worker");
    let alias = executable;
    let candidates = [alias];
    let _ = std::process::Command::new(candidates[0]).status();
}
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-aliased-sink.rs" \
    "aliased container dynamic Rust executable sink" || return 1

  python3 - "$fixture/daemon/examples/dynamic-concat-loader-sink.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn load() {
    let library = concat!(env!("OUT_DIR"), "/worker_plugin.so");
    let _ = unsafe { libloading::Library::new(library) };
}
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-loader-sink.rs" \
    "dynamic Rust loader sink" || return 1

  python3 - "$fixture/daemon/examples/dynamic-concat-syscall-sink.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''unsafe fn launch() {
    let executable = concat!(env!("WORKER_BIN"), "/worker");
    libc::syscall(libc::SYS_execve, executable.as_ptr(), 0, 0);
}
''')
PY
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-syscall-sink.rs" \
    "dynamic Rust syscall sink" || return 1

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

  # Dependency propagation must visit bindings and edges, not repeatedly scan
  # the whole file. Eight thousand reverse aliases reproduces the old quadratic
  # path; cycles, broad fanout, and long append lists exercise bounded cases.
  python3 - \
    "$fixture/server/spawn_server/routes/binding-graph-performance.py" \
    "$fixture/scripts/binding-graph-performance.sh" <<'PY'
from pathlib import Path
import sys

python_path = Path(sys.argv[1])
shell_path = Path(sys.argv[2])

python_lines = [f"reverse_{index} = reverse_{index + 1}" for index in range(8_000)]
python_lines.extend(
    [
        "reverse_8000 = 'worker'",
        "cycle_a = cycle_b",
        "cycle_b = cycle_a",
    ]
)
python_lines.extend(f"fanout_{index} = reverse_0" for index in range(2_000))
python_lines.append("appended = ''")
python_lines.extend("appended += ''" for _ in range(2_000))
python_lines.append("result = (reverse_0, fanout_1999, appended)")
python_path.write_text("\n".join(python_lines) + "\n")

shell_lines = ["#!/usr/bin/env bash"]
shell_lines.extend(
    f'reverse_{index}="$reverse_{index + 1}"' for index in range(8_000)
)
shell_lines.extend(
    [
        "reverse_8000=worker",
        'cycle_a="$cycle_b"',
        'cycle_b="$cycle_a"',
    ]
)
shell_lines.extend(f'fanout_{index}="$reverse_0"' for index in range(2_000))
shell_lines.append('appended=""')
shell_lines.extend('appended+=""' for _ in range(2_000))
shell_lines.append("printf '%s\\n' \"$reverse_0$fanout_1999$appended\"")
shell_path.write_text("\n".join(shell_lines) + "\n")
PY
  if ! timeout 12s env WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null; then
    printf '%s\n' "worker-only guard self-test: binding graph exceeded linear-runtime ceiling" >&2
    return 1
  fi
  rm \
    "$fixture/server/spawn_server/routes/binding-graph-performance.py" \
    "$fixture/scripts/binding-graph-performance.sh"

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
