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
max_analysis_work = 1_000_000


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


def rust_pattern_bindings(path: Path, tokens, start: int, end: int, declaration: str) -> tuple[str, ...]:
    """Return value bindings from a bounded Rust declaration pattern."""

    if declaration in {"const", "static"}:
        binding = next(
            (
                value
                for kind, value in tokens[start:end]
                if kind == "ident" and value not in {"mut", "ref"}
            ),
            None,
        )
        return () if binding is None else (binding,)

    closing_for = {"(": ")", "[": "]", "{": "}"}
    stack: list[str] = []
    pattern_end = end
    for index in range(start, end):
        kind, value = tokens[index]
        if kind != "punct":
            continue
        if value in closing_for:
            stack.append(closing_for[value])
            if len(stack) > max_rust_concat_depth:
                die(path, "Rust binding-pattern nesting exceeded its parser depth")
        elif stack and value == stack[-1]:
            stack.pop()
        elif value == ":" and not stack:
            previous = tokens[index - 1][1] if index > start else ""
            following = tokens[index + 1][1] if index + 1 < end else ""
            if previous != ":" and following != ":":
                pattern_end = index
                break

    keywords = {
        "box",
        "const",
        "crate",
        "else",
        "false",
        "let",
        "mut",
        "ref",
        "self",
        "Self",
        "static",
        "super",
        "true",
    }
    bindings: set[str] = set()
    for index in range(start, pattern_end):
        kind, value = tokens[index]
        if kind != "ident" or value in keywords or value == "_":
            continue
        previous = tokens[index - 1][1] if index > start else ""
        previous_previous = tokens[index - 2][1] if index > start + 1 else ""
        following = tokens[index + 1][1] if index + 1 < pattern_end else ""
        following_following = tokens[index + 2][1] if index + 2 < pattern_end else ""
        preceded_by_path = previous == ":" and previous_previous == ":"
        followed_by_path = following == ":" and following_following == ":"
        field_label = following == ":" and following_following != ":"
        constructor = following in {"(", "[", "{"}
        macro_name = following == "!"
        if preceded_by_path or followed_by_path or field_label or constructor or macro_name:
            continue
        bindings.add(value)
        if len(bindings) > max_analysis_nodes:
            die(path, f"Rust binding pattern exceeds {max_analysis_nodes} names")
    return tuple(sorted(bindings))


def reviewed_rust_sink_family(
    parts: tuple[str, ...], shadowed_roots: frozenset[str] = frozenset()
) -> str | None:
    command_paths = {
        ("async_std", "process", "Command"),
        ("std", "process", "Command"),
        ("tokio", "process", "Command"),
    }
    library_paths = {("libloading", "Library")}
    if not parts or parts[0] in shadowed_roots:
        return None
    if parts in command_paths:
        return "command"
    if parts in library_paths:
        return "library"
    return None


def rust_sink_type_names(
    path: Path, tokens
) -> tuple[set[str], set[str], frozenset[str]]:
    """Resolve reviewed process/dynamic-loader use trees and type aliases."""

    # Bare type names carry no audited provenance. They become sinks only via
    # an exact reviewed import/type alias below. This also prevents a local
    # `struct Command` or `struct Library` from being treated like the std or
    # libloading type merely because its constructor has the same spelling.
    command_names: set[str] = set()
    library_names: set[str] = set()
    reviewed_roots = {"async_std", "libloading", "std", "tokio"}
    shadowed_roots = frozenset(
        tokens[index + 1][1]
        for index in range(len(tokens) - 1)
        if tokens[index] == ("ident", "mod")
        and tokens[index + 1][0] == "ident"
        and tokens[index + 1][1] in reviewed_roots
    )
    alias_edges: list[tuple[str, str]] = []
    parser_work = 0

    def add_family(alias: str, family: str | None) -> None:
        if alias == "_" or family is None:
            return
        (command_names if family == "command" else library_names).add(alias)

    def parse_use_tree(
        index: int,
        end: int,
        prefix: tuple[str, ...],
        depth: int,
    ) -> int:
        nonlocal parser_work
        if depth > max_rust_concat_depth:
            die(path, "Rust use-tree nesting exceeded its parser depth")
        while index < end and tokens[index] == ("punct", ":"):
            index += 1
        segments: list[str] = []
        while index < end and tokens[index][0] == "ident" and tokens[index][1] != "as":
            parser_work += 1
            if parser_work > max_analysis_tokens:
                die(path, f"Rust use-tree analysis exceeds {max_analysis_tokens} tokens")
            segments.append(tokens[index][1])
            index += 1
            if (
                index + 1 < end
                and tokens[index] == ("punct", ":")
                and tokens[index + 1] == ("punct", ":")
            ):
                index += 2
                if index < end and tokens[index] == ("punct", "{"):
                    close = rust_matching_delimiter(path, tokens, index)
                    cursor = index + 1
                    nested_prefix = prefix + tuple(segments)
                    while cursor < close:
                        if tokens[cursor] == ("punct", ","):
                            cursor += 1
                            continue
                        next_cursor = parse_use_tree(
                            cursor, close, nested_prefix, depth + 1
                        )
                        cursor = next_cursor if next_cursor > cursor else cursor + 1
                    return close + 1
                continue
            break
        if not segments:
            return index + 1
        full_path = prefix + tuple(segments)
        alias = segments[-1]
        if index < end and tokens[index] == ("ident", "as"):
            if index + 1 < end and tokens[index + 1][0] == "ident":
                alias = tokens[index + 1][1]
                index += 2
            else:
                return index + 1
        add_family(alias, reviewed_rust_sink_family(full_path, shadowed_roots))
        while index < end and tokens[index] != ("punct", ","):
            index += 1
        return index

    for index, token in enumerate(tokens):
        if token != ("ident", "use"):
            continue
        end = index + 1
        stack: list[str] = []
        closing_for = {"(": ")", "[": "]", "{": "}"}
        while end < len(tokens):
            parser_work += 1
            if parser_work > max_analysis_work:
                die(path, f"Rust alias analysis exceeds {max_analysis_work} steps")
            kind, value = tokens[end]
            if kind == "punct" and value in closing_for:
                stack.append(closing_for[value])
            elif kind == "punct" and stack and value == stack[-1]:
                stack.pop()
            elif kind == "punct" and value == ";" and not stack:
                break
            end += 1
        parse_use_tree(index + 1, end, (), 0)

    for index, token in enumerate(tokens):
        if token != ("ident", "type") or index + 1 >= len(tokens):
            continue
        alias_kind, alias = tokens[index + 1]
        if alias_kind != "ident":
            continue
        equals = index + 2
        while equals < len(tokens) and tokens[equals] != ("punct", "="):
            parser_work += 1
            if parser_work > max_analysis_work:
                die(path, f"Rust alias analysis exceeds {max_analysis_work} steps")
            if tokens[equals] == ("punct", ";"):
                break
            equals += 1
        if equals >= len(tokens) or tokens[equals] != ("punct", "="):
            continue
        end = equals + 1
        while end < len(tokens) and tokens[end] != ("punct", ";"):
            parser_work += 1
            if parser_work > max_analysis_work:
                die(path, f"Rust alias analysis exceeds {max_analysis_work} steps")
            end += 1
        rhs = tokens[equals + 1 : end]
        parts: list[str] = []
        valid_path = bool(rhs)
        cursor = 0
        while cursor < len(rhs):
            parser_work += 1
            if parser_work > max_analysis_work:
                die(path, f"Rust alias analysis exceeds {max_analysis_work} steps")
            kind, value = rhs[cursor]
            if kind != "ident":
                valid_path = False
                break
            parts.append(value)
            cursor += 1
            if cursor == len(rhs):
                break
            if (
                cursor + 1 >= len(rhs)
                or rhs[cursor] != ("punct", ":")
                or rhs[cursor + 1] != ("punct", ":")
            ):
                valid_path = False
                break
            cursor += 2
        if not valid_path:
            continue
        family = reviewed_rust_sink_family(tuple(parts), shadowed_roots)
        if family is not None:
            add_family(alias, family)
        elif len(parts) == 1:
            alias_edges.append((parts[0], alias))
            if len(alias_edges) > max_analysis_edges:
                die(path, f"Rust type-alias graph exceeds {max_analysis_edges} edges")

    dependents: dict[str, set[str]] = defaultdict(set)
    for source_name, alias in alias_edges:
        dependents[source_name].add(alias)
    queue = deque(
        [(name, "command") for name in sorted(command_names)]
        + [(name, "library") for name in sorted(library_names)]
    )
    visited = set(queue)
    while queue:
        source_name, family = queue.popleft()
        for alias in sorted(dependents.get(source_name, ())):
            item = (alias, family)
            if item in visited:
                continue
            visited.add(item)
            add_family(alias, family)
            queue.append(item)
            if len(visited) > max_analysis_nodes:
                die(path, f"Rust type-alias graph exceeds {max_analysis_nodes} nodes")
    return command_names, library_names, shadowed_roots


def reject_rust_concat(path: Path, source: str) -> None:
    tokens = rust_tokens(path, source)
    command_type_names, library_type_names, shadowed_sink_roots = rust_sink_type_names(
        path, tokens
    )
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
    assignment_records: list[tuple[tuple[str, ...], int, int, str, int]] = []
    nodes: set[str] = set()
    flow_work = 0

    assignment_contexts: dict[int, tuple[int, int | None]] = {}
    statement_start = 0
    active_declaration: int | None = None
    for index, token in enumerate(tokens):
        if token[0] == "ident" and token[1] in {"let", "const", "static"}:
            active_declaration = index
        if token == ("punct", "="):
            previous = tokens[index - 1][1] if index else ""
            following = tokens[index + 1][1] if index + 1 < len(tokens) else ""
            if previous not in {"=", "!", "<", ">"} and following not in {"=", ">"}:
                assignment_contexts[index] = (statement_start, active_declaration)
                active_declaration = None
        if token == ("punct", ";"):
            statement_start = index + 1
            active_declaration = None
        elif token[0] == "punct" and token[1] in {"{", "}"} and active_declaration is None:
            statement_start = index + 1

    delimiter_depths: list[int] = []
    delimiter_stack: list[tuple[str, int]] = []
    delimiter_pairs: dict[int, int] = {}
    closing_for = {"(": ")", "[": "]", "{": "}"}
    for index, (kind, value) in enumerate(tokens):
        if kind == "punct" and value in closing_for.values():
            if not delimiter_stack or value != delimiter_stack[-1][0]:
                die(path, "mismatched Rust flow-analysis delimiters")
            _, opener = delimiter_stack.pop()
            delimiter_pairs[opener] = index
            delimiter_pairs[index] = opener
        delimiter_depths.append(len(delimiter_stack))
        if kind == "punct" and value in closing_for:
            delimiter_stack.append((closing_for[value], index))
            if len(delimiter_stack) > max_rust_concat_depth:
                die(path, "Rust flow-analysis delimiter nesting exceeded its parser depth")
    if delimiter_stack:
        die(path, "unterminated Rust flow-analysis delimiter construction")

    assignment_ends: dict[int, int] = {}
    next_semicolon_same_depth = [len(tokens)] * len(tokens)
    next_semicolon_at_depth: dict[int, int] = {}
    for index in range(len(tokens) - 1, -1, -1):
        depth = delimiter_depths[index]
        next_semicolon_same_depth[index] = next_semicolon_at_depth.get(
            depth, len(tokens)
        )
        if tokens[index] == ("punct", ";"):
            next_semicolon_at_depth[depth] = index
        if index in assignment_contexts:
            assignment_ends[index] = next_semicolon_at_depth.get(depth, len(tokens))

    for equals in range(len(tokens)):
        context = assignment_contexts.get(equals)
        if context is None:
            continue
        left, declaration = context
        if declaration is not None:
            declaration_kind = tokens[declaration][1]
            targets = rust_pattern_bindings(
                path, tokens, declaration + 1, equals, declaration_kind
            )
        else:
            target = next(
                (tokens[index][1] for index in range(equals - 1, left - 1, -1) if tokens[index][0] == "ident"),
                None,
            )
            targets = () if target is None else (target,)
        if not targets:
            continue
        right = assignment_ends[equals]
        assignment_node = f"\x00assignment:{equals}"
        assignment_records.append((targets, equals + 1, right, assignment_node, equals))
        nodes.add(assignment_node)
        nodes.update(targets)
        if len(nodes) > max_analysis_nodes:
            die(path, f"Rust flow graph exceeds {max_analysis_nodes} nodes")

    edge_candidates: set[tuple[str, str]] = set()
    tainted: set[str] = set()
    dynamic_concat_starts = {start for start, _ in dynamic_concat_ranges}
    assignment_by_equals = {
        equals: (end, assignment_node)
        for _, _, end, assignment_node, equals in assignment_records
    }
    for targets, start, end, assignment_node, _ in assignment_records:
        contains_dynamic = False
        index = start
        while index < end:
            flow_work += 1
            if flow_work > max_analysis_work:
                die(path, f"Rust assignment graph exceeds {max_analysis_work} steps")
            nested = assignment_by_equals.get(index)
            if nested is not None and nested[0] <= end:
                edge_candidates.add((nested[1], assignment_node))
                index = nested[0]
                continue
            if tokens[index][0] == "ident" and tokens[index][1] not in targets:
                edge_candidates.add((tokens[index][1], assignment_node))
            contains_dynamic = contains_dynamic or index in dynamic_concat_starts
            index += 1
        edge_candidates.update((assignment_node, target) for target in targets)
        if contains_dynamic:
            tainted.add(assignment_node)
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
                flow_work += 1
                if flow_work > max_analysis_work:
                    die(path, f"Rust collection graph exceeds {max_analysis_work} steps")
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

    brace_scopes: list[int] = []
    lexical_scope_at: list[int | None] = []
    for index, token in enumerate(tokens):
        if token == ("punct", "}") and brace_scopes:
            brace_scopes.pop()
        lexical_scope_at.append(brace_scopes[-1] if brace_scopes else None)
        if token == ("punct", "{"):
            brace_scopes.append(index)
    local_type_definitions: dict[str, list[tuple[int | None, int]]] = defaultdict(list)
    for index in range(len(tokens) - 1):
        if (
            tokens[index][0] == "ident"
            and tokens[index][1] in {"enum", "mod", "struct", "trait", "union"}
            and tokens[index + 1][0] == "ident"
        ):
            scope_opener = lexical_scope_at[index]
            scope_end = (
                len(tokens)
                if scope_opener is None
                else delimiter_pairs.get(scope_opener, len(tokens))
            )
            local_type_definitions[tokens[index + 1][1]].append(
                (scope_opener, scope_end)
            )

    def imported_sink_name_is_visible(name: str, position: int) -> bool:
        for scope_opener, scope_end in local_type_definitions.get(name, ()):
            if scope_opener is None or scope_opener < position < scope_end:
                return False
        return True

    def is_executable_sink(index: int) -> bool:
        name = tokens[index][1]
        if name in executable_functions:
            return True
        if name not in {"from", "new", "open"}:
            return False
        reversed_path: list[str] = []
        cursor = index - 1
        while (
            cursor >= 2
            and tokens[cursor] == ("punct", ":")
            and tokens[cursor - 1] == ("punct", ":")
            and tokens[cursor - 2][0] == "ident"
        ):
            reversed_path.append(tokens[cursor - 2][1])
            cursor -= 3
        type_path = tuple(reversed(reversed_path))
        absolute_path = (
            cursor >= 1
            and tokens[cursor] == ("punct", ":")
            and tokens[cursor - 1] == ("punct", ":")
        )
        locally_shadowed_root = (
            type_path
            and not absolute_path
            and not imported_sink_name_is_visible(type_path[0], index)
        )
        family = reviewed_rust_sink_family(
            type_path,
            frozenset({type_path[0]}) if locally_shadowed_root else frozenset(),
        )
        imported_name = type_path[-1] if type_path else ""
        return (
            name in {"from", "new"}
            and (
                family == "command"
                or (
                    imported_name in command_type_names
                    and imported_sink_name_is_visible(imported_name, index)
                )
            )
        ) or (
            name in {"new", "open"}
            and (
                family == "library"
                or (
                    imported_name in library_type_names
                    and imported_sink_name_is_visible(imported_name, index)
                )
            )
        )

    for index in range(len(tokens) - 1):
        if (
            tokens[index][0] != "ident"
            or tokens[index + 1] != ("punct", "(")
            or not is_executable_sink(index)
        ):
            continue
        end = rust_matching_delimiter(path, tokens, index + 1)
        direct_dynamic = False
        referenced_taint = False
        for argument in range(index + 2, end):
            flow_work += 1
            if flow_work > max_analysis_work:
                die(path, f"Rust sink analysis exceeds {max_analysis_work} steps")
            direct_dynamic = direct_dynamic or argument in dynamic_concat_starts
            referenced_taint = referenced_taint or (
                tokens[argument][0] == "ident"
                and tokens[argument][1] in tainted
            )
        if direct_dynamic or referenced_taint:
            die(path, f"unreviewed Rust concat value reaches executable sink {tokens[index][1]}")

    def reject_interprocedural_flows() -> None:
        interprocedural_work = 0

        def spend_work(detail: str) -> None:
            nonlocal interprocedural_work
            interprocedural_work += 1
            if interprocedural_work > max_analysis_work:
                die(
                    path,
                    f"Rust interprocedural {detail} exceeds {max_analysis_work} steps",
                )

        def comma_ranges(opener: int, closer: int) -> tuple[tuple[int, int], ...]:
            interior_depth = delimiter_depths[opener] + 1
            ranges: list[tuple[int, int]] = []
            start = opener + 1
            for index in range(start, closer):
                spend_work("argument analysis")
                if (
                    tokens[index] == ("punct", ",")
                    and delimiter_depths[index] == interior_depth
                ):
                    if start < index:
                        ranges.append((start, index))
                    start = index + 1
            if start < closer:
                ranges.append((start, closer))
            return tuple(ranges)

        # Keep lexical module and owner identities so unrelated methods with
        # the same bare name cannot share a summary. The parser deliberately
        # covers ordinary modules, structs, traits, and impls without trying to
        # become a Rust type checker; unresolved receivers are handled
        # conservatively later.
        module_blocks: list[tuple[int, int, str]] = []
        struct_blocks: list[tuple[int, int, tuple[str, ...]]] = []
        owner_blocks: list[
            tuple[int, int, tuple[str, ...], str, tuple[str, ...] | None]
        ] = []

        def modules_at(position: int) -> tuple[str, ...]:
            return tuple(
                name
                for opener, closer, name in sorted(module_blocks)
                if opener < position < closer
            )

        for index in range(len(tokens) - 2):
            spend_work("declaration-context analysis")
            if (
                tokens[index] == ("ident", "mod")
                and tokens[index + 1][0] == "ident"
                and tokens[index + 2] == ("punct", "{")
            ):
                closer = delimiter_pairs.get(index + 2)
                if closer is not None:
                    module_blocks.append((index + 2, closer, tokens[index + 1][1]))

        def declared_type_key(
            parts: tuple[str, ...], module_path: tuple[str, ...]
        ) -> tuple[str, ...]:
            if not parts:
                return ()
            if parts[0] == "crate":
                return parts[1:]
            if parts[0] == "self":
                return module_path + parts[1:]
            if parts[0] == "super":
                return module_path[:-1] + parts[1:]
            return module_path + parts if len(parts) == 1 else parts

        for index in range(len(tokens) - 2):
            if (
                tokens[index] == ("ident", "struct")
                and tokens[index + 1][0] == "ident"
            ):
                opener = index + 2
                while opener < len(tokens) and tokens[opener][1] not in {"{", ";"}:
                    spend_work("struct-context analysis")
                    opener += 1
                if opener < len(tokens) and tokens[opener] == ("punct", "{"):
                    closer = delimiter_pairs.get(opener)
                    if closer is not None:
                        key = modules_at(index) + (tokens[index + 1][1],)
                        struct_blocks.append((opener, closer, key))

            if tokens[index][0] != "ident" or tokens[index][1] not in {"impl", "trait"}:
                continue
            declaration_kind = tokens[index][1]
            opener = index + 1
            while opener < len(tokens) and tokens[opener][1] not in {"{", ";"}:
                spend_work("owner-context analysis")
                opener += 1
            if opener >= len(tokens) or tokens[opener] != ("punct", "{"):
                continue
            closer = delimiter_pairs.get(opener)
            if closer is None:
                continue
            implemented_trait: tuple[str, ...] | None = None
            if declaration_kind == "trait":
                raw_parts = (
                    (tokens[index + 1][1],)
                    if index + 1 < opener and tokens[index + 1][0] == "ident"
                    else ()
                )
            else:
                for_positions = [
                    cursor
                    for cursor in range(index + 1, opener)
                    if tokens[cursor] == ("ident", "for")
                ]
                if for_positions:
                    trait_cursor = index + 1
                    if trait_cursor < opener and tokens[trait_cursor] == ("punct", "<"):
                        angle_depth = 0
                        while trait_cursor < for_positions[-1]:
                            if tokens[trait_cursor] == ("punct", "<"):
                                angle_depth += 1
                            elif tokens[trait_cursor] == ("punct", ">"):
                                angle_depth -= 1
                                if angle_depth == 0:
                                    trait_cursor += 1
                                    break
                            trait_cursor += 1
                    trait_parts: list[str] = []
                    while trait_cursor < for_positions[-1] and tokens[trait_cursor][0] == "ident":
                        trait_parts.append(tokens[trait_cursor][1])
                        trait_cursor += 1
                        if (
                            trait_cursor + 1 < for_positions[-1]
                            and tokens[trait_cursor] == ("punct", ":")
                            and tokens[trait_cursor + 1] == ("punct", ":")
                        ):
                            trait_cursor += 2
                            continue
                        break
                    implemented_trait = declared_type_key(
                        tuple(trait_parts), modules_at(index)
                    )
                cursor = for_positions[-1] + 1 if for_positions else index + 1
                if cursor < opener and tokens[cursor] == ("punct", "<"):
                    angle_depth = 0
                    while cursor < opener:
                        spend_work("impl-generic analysis")
                        if tokens[cursor] == ("punct", "<"):
                            angle_depth += 1
                        elif tokens[cursor] == ("punct", ">"):
                            angle_depth -= 1
                            if angle_depth == 0:
                                cursor += 1
                                break
                        cursor += 1
                parts: list[str] = []
                while cursor < opener:
                    spend_work("impl-owner analysis")
                    if tokens[cursor][0] != "ident":
                        break
                    parts.append(tokens[cursor][1])
                    cursor += 1
                    if (
                        cursor + 1 < opener
                        and tokens[cursor] == ("punct", ":")
                        and tokens[cursor + 1] == ("punct", ":")
                    ):
                        cursor += 2
                        continue
                    break
                raw_parts = tuple(parts)
            owner_key = declared_type_key(raw_parts, modules_at(index))
            if owner_key:
                owner_blocks.append(
                    (opener, closer, owner_key, declaration_kind, implemented_trait)
                )

        known_types = {key for _, _, key in struct_blocks} | {
            key for _, _, key, _, _ in owner_blocks
        }
        known_types_by_short: dict[str, set[tuple[str, ...]]] = defaultdict(set)
        for type_key in known_types:
            known_types_by_short[type_key[-1]].add(type_key)

        def normalize_type_path(
            parts: tuple[str, ...], module_path: tuple[str, ...]
        ) -> tuple[str, ...] | None:
            if not parts:
                return None
            if parts[0] == "crate":
                candidate = parts[1:]
            elif parts[0] == "self":
                candidate = module_path + parts[1:]
            elif parts[0] == "super":
                candidate = module_path[:-1] + parts[1:]
            elif len(parts) == 1:
                local = module_path + parts
                if local in known_types:
                    return local
                matches = known_types_by_short.get(parts[0], set())
                return next(iter(matches)) if len(matches) == 1 else None
            else:
                candidate = parts
                relative = module_path + parts
                if relative in known_types:
                    return relative
            return candidate if candidate in known_types else None

        def path_parts(start: int, end: int) -> tuple[tuple[str, ...], int]:
            parts: list[str] = []
            cursor = start
            while cursor < end and tokens[cursor][0] == "ident":
                parts.append(tokens[cursor][1])
                cursor += 1
                if (
                    cursor + 1 < end
                    and tokens[cursor] == ("punct", ":")
                    and tokens[cursor + 1] == ("punct", ":")
                ):
                    cursor += 2
                    continue
                break
            return tuple(parts), cursor

        def type_from_range(
            start: int, end: int, module_path: tuple[str, ...]
        ) -> tuple[str, ...] | None:
            colon = next(
                (
                    cursor
                    for cursor in range(start, end)
                    if tokens[cursor] == ("punct", ":")
                    and not (
                        cursor + 1 < end and tokens[cursor + 1] == ("punct", ":")
                    )
                    and not (
                        cursor > start and tokens[cursor - 1] == ("punct", ":")
                    )
                ),
                None,
            )
            if colon is None:
                return None
            cursor = colon + 1
            while cursor < end and (
                tokens[cursor][1] in {"&", "mut", "dyn"}
                or tokens[cursor][0] == "lifetime"
            ):
                cursor += 1
            parts, _ = path_parts(cursor, end)
            return normalize_type_path(parts, module_path)

        struct_fields: dict[
            tuple[str, ...], dict[str, tuple[str, ...]]
        ] = defaultdict(dict)
        for opener, closer, type_key in struct_blocks:
            for start, end in comma_ranges(opener, closer):
                if start >= end or tokens[start][0] != "ident":
                    continue
                field_type = type_from_range(start, end, type_key[:-1])
                if field_type is not None:
                    struct_fields[type_key][tokens[start][1]] = field_type

        function_records: list[dict[str, object]] = []
        parameter_nodes = 0
        for index, token in enumerate(tokens):
            if token != ("ident", "fn") or index + 1 >= len(tokens):
                continue
            if tokens[index + 1][0] != "ident":
                continue
            name = tokens[index + 1][1]
            opener = index + 2
            while opener < len(tokens) and tokens[opener] != ("punct", "("):
                spend_work("function-signature analysis")
                if tokens[opener][1] in {";", "{"}:
                    break
                opener += 1
            if opener >= len(tokens) or tokens[opener] != ("punct", "("):
                continue
            parameter_end = delimiter_pairs.get(opener)
            if parameter_end is None:
                die(path, "Rust function parameters have no closing delimiter")
            body_opener = parameter_end + 1
            while body_opener < len(tokens) and tokens[body_opener][1] not in {"{", ";"}:
                spend_work("function-signature analysis")
                body_opener += 1
            if body_opener >= len(tokens) or tokens[body_opener] != ("punct", "{"):
                continue
            body_end = delimiter_pairs.get(body_opener)
            if body_end is None:
                die(path, "Rust function body has no closing delimiter")
            module_path = modules_at(index)
            owners = [
                (owner_opener, owner_key, owner_kind, implemented_trait)
                for owner_opener, owner_end, owner_key, owner_kind, implemented_trait in owner_blocks
                if owner_opener < index < owner_end
            ]
            owner_context = max(owners) if owners else None
            owner_key = owner_context[1] if owner_context else None
            owner_kind = owner_context[2] if owner_context else None
            implemented_trait = owner_context[3] if owner_context else None
            parameters: list[tuple[str, ...]] = []
            parameter_types: list[tuple[str, ...] | None] = []
            has_receiver = False
            for start, end in comma_ranges(opener, parameter_end):
                if any(tokens[cursor] == ("ident", "self") for cursor in range(start, end)):
                    parameters.append(("self",))
                    parameter_types.append(owner_key)
                    has_receiver = True
                else:
                    parameters.append(rust_pattern_bindings(path, tokens, start, end, "let"))
                    parameter_types.append(type_from_range(start, end, module_path))
            return_type = None
            for cursor in range(parameter_end + 1, body_opener - 1):
                if (
                    tokens[cursor] == ("punct", "-")
                    and tokens[cursor + 1] == ("punct", ">")
                ):
                    return_type = type_from_range(cursor + 1, body_opener, module_path)
                    if return_type is None:
                        return_parts, _ = path_parts(cursor + 2, body_opener)
                        return_type = normalize_type_path(return_parts, module_path)
                    break
            parameter_nodes += len(parameters) + sum(map(len, parameters))
            if parameter_nodes > max_analysis_nodes:
                die(path, f"Rust callable parameter graph exceeds {max_analysis_nodes} nodes")
            function_records.append(
                {
                    "name": name,
                    "module": module_path,
                    "owner": owner_key,
                    "owner_kind": owner_kind,
                    "implemented_trait": implemented_trait,
                    "kind": "method" if owner_key is not None else "free",
                    "has_receiver": has_receiver,
                    "parameters": tuple(parameters),
                    "parameter_types": tuple(parameter_types),
                    "return_type": return_type,
                    "body_start": body_opener + 1,
                    "body_end": body_end,
                    "body_opener": body_opener,
                    "braced": True,
                    "definition": index,
                    "assignment_equals": None,
                }
            )
            if len(function_records) > max_analysis_nodes:
                die(path, f"Rust function graph exceeds {max_analysis_nodes} nodes")

        # Closures are first-class callable identities. Their data flow is kept
        # separate from ordinary taint so an alias/container can preserve the
        # precise function summary without turning every data identifier into
        # a possible call target.
        for targets, start, end, _, equals in assignment_records:
            if len(targets) != 1:
                continue
            opener = start
            while opener < end and tokens[opener][0] == "ident" and tokens[opener][1] in {"async", "move"}:
                opener += 1
            if opener >= end or tokens[opener] != ("punct", "|"):
                continue
            parameter_end = opener + 1
            while parameter_end < end and tokens[parameter_end] != ("punct", "|"):
                spend_work("closure-parameter analysis")
                parameter_end += 1
            if parameter_end >= end:
                die(path, "Rust closure parameters have no closing delimiter")
            parameters: list[tuple[str, ...]] = []
            parameter_types: list[tuple[str, ...] | None] = []
            segment_start = opener + 1
            for cursor in range(opener + 1, parameter_end + 1):
                if cursor == parameter_end or tokens[cursor] == ("punct", ","):
                    if segment_start < cursor:
                        parameters.append(rust_pattern_bindings(path, tokens, segment_start, cursor, "let"))
                        parameter_types.append(type_from_range(segment_start, cursor, modules_at(equals)))
                    segment_start = cursor + 1
            body_start = parameter_end + 1
            if body_start < end and tokens[body_start] == ("punct", "{"):
                body_end = delimiter_pairs.get(body_start)
                if body_end is None or body_end > end:
                    die(path, "Rust closure body has no bounded closing delimiter")
                body_opener: int | None = body_start
                body_start += 1
                braced = True
            else:
                body_end = end
                body_opener = None
                braced = False
            function_records.append(
                {
                    "name": targets[0],
                    "module": modules_at(equals),
                    "owner": None,
                    "owner_kind": None,
                    "implemented_trait": None,
                    "kind": "closure",
                    "has_receiver": False,
                    "parameters": tuple(parameters),
                    "parameter_types": tuple(parameter_types),
                    "return_type": None,
                    "body_start": body_start,
                    "body_end": body_end,
                    "body_opener": body_opener,
                    "braced": braced,
                    "definition": opener,
                    "assignment_equals": equals,
                }
            )
            parameter_nodes += len(parameters) + sum(map(len, parameters))
            if parameter_nodes > max_analysis_nodes or len(function_records) > max_analysis_nodes:
                die(path, f"Rust callable graph exceeds {max_analysis_nodes} nodes")

        if not function_records:
            return

        summaries = [
            {
                "return_dynamic": False,
                "return_parameters": set(),
                "return_callables": set(),
                "sink_parameters": set(),
            }
            for _ in function_records
        ]
        records_by_name: dict[str, set[int]] = defaultdict(set)
        free_records_by_name: dict[str, set[int]] = defaultdict(set)
        methods_by_name: dict[str, set[int]] = defaultdict(set)
        methods_by_owner_name: dict[tuple[tuple[str, ...], str], set[int]] = defaultdict(set)
        inherent_methods_by_owner_name: dict[
            tuple[tuple[str, ...], str], set[int]
        ] = defaultdict(set)
        implemented_traits: dict[tuple[str, ...], set[tuple[str, ...]]] = defaultdict(set)
        for _, _, owner_key, _, implemented_trait in owner_blocks:
            if implemented_trait is not None:
                implemented_traits[owner_key].add(implemented_trait)
        closure_by_equals: dict[int, int] = {}
        for record_index, record in enumerate(function_records):
            name = str(record["name"])
            records_by_name[name].add(record_index)
            if record["kind"] == "method":
                methods_by_name[name].add(record_index)
                methods_by_owner_name[(record["owner"], name)].add(record_index)
                if (
                    record["owner_kind"] == "impl"
                    and record["implemented_trait"] is None
                ):
                    inherent_methods_by_owner_name[(record["owner"], name)].add(
                        record_index
                    )
                if record["implemented_trait"] is not None:
                    implemented_traits[record["owner"]].add(
                        record["implemented_trait"]
                    )
            elif record["kind"] == "free":
                free_records_by_name[name].add(record_index)
            else:
                closure_by_equals[int(record["assignment_equals"])] = record_index

        def qualified_free_records(
            parts: tuple[str, ...], module_path: tuple[str, ...]
        ) -> frozenset[int]:
            if not parts:
                return frozenset()
            if parts[0] == "crate":
                qualified_module = parts[1:-1]
            elif parts[0] == "self":
                qualified_module = module_path + parts[1:-1]
            elif parts[0] == "super":
                qualified_module = module_path[:-1] + parts[1:-1]
            else:
                qualified_module = parts[:-1]
                relative_module = module_path + parts[:-1]
                if any(
                    function_records[candidate]["module"] == relative_module
                    for candidate in free_records_by_name.get(parts[-1], ())
                ):
                    qualified_module = relative_module
            return frozenset(
                candidate
                for candidate in free_records_by_name.get(parts[-1], ())
                if function_records[candidate]["module"] == qualified_module
            )

        callable_imports: list[
            tuple[
                str,
                tuple[str, ...],
                int | None,
                int,
                int,
                tuple[str, ...],
            ]
        ] = []

        def parse_callable_use_tree(
            index: int,
            end: int,
            prefix: tuple[str, ...],
            scope_opener: int | None,
            scope_end: int,
            module_path: tuple[str, ...],
            depth: int,
        ) -> int:
            if depth > max_rust_concat_depth:
                die(path, "Rust callable use-tree nesting exceeded its depth")
            while index < end and tokens[index] == ("punct", ":"):
                index += 1
            segments: list[str] = []
            while index < end and tokens[index][0] == "ident" and tokens[index][1] != "as":
                spend_work("callable import analysis")
                segments.append(tokens[index][1])
                index += 1
                if (
                    index + 1 < end
                    and tokens[index] == ("punct", ":")
                    and tokens[index + 1] == ("punct", ":")
                ):
                    index += 2
                    if index < end and tokens[index] == ("punct", "{"):
                        closer = delimiter_pairs.get(index)
                        if closer is None or closer > end:
                            return end
                        cursor = index + 1
                        nested_prefix = prefix + tuple(segments)
                        while cursor < closer:
                            if tokens[cursor] == ("punct", ","):
                                cursor += 1
                                continue
                            next_cursor = parse_callable_use_tree(
                                cursor,
                                closer,
                                nested_prefix,
                                scope_opener,
                                scope_end,
                                module_path,
                                depth + 1,
                            )
                            cursor = next_cursor if next_cursor > cursor else cursor + 1
                        return closer + 1
                    continue
                break
            if not segments:
                return index + 1
            alias = segments[-1]
            if index < end and tokens[index] == ("ident", "as"):
                if index + 1 < end and tokens[index + 1][0] == "ident":
                    alias = tokens[index + 1][1]
                    index += 2
            callable_imports.append(
                (
                    alias,
                    prefix + tuple(segments),
                    scope_opener,
                    scope_end,
                    0
                    if scope_opener is None
                    else delimiter_depths[scope_opener] + 1,
                    module_path,
                )
            )
            if len(callable_imports) > max_analysis_edges:
                die(path, f"Rust callable import graph exceeds {max_analysis_edges} edges")
            while index < end and tokens[index] != ("punct", ","):
                index += 1
            return index

        for use_index, token in enumerate(tokens):
            if token != ("ident", "use"):
                continue
            use_end = next_semicolon_same_depth[use_index]
            if use_end >= len(tokens):
                continue
            scope_opener = lexical_scope_at[use_index]
            scope_end = (
                len(tokens)
                if scope_opener is None
                else delimiter_pairs.get(scope_opener, len(tokens))
            )
            parse_callable_use_tree(
                use_index + 1,
                use_end,
                (),
                scope_opener,
                scope_end,
                modules_at(use_index),
                0,
            )

        def imported_callable_records(name: str, position: int) -> frozenset[int]:
            visible = [
                spec
                for spec in callable_imports
                if spec[0] == name
                and (spec[2] is None or spec[2] < position < spec[3])
            ]
            if not visible:
                return frozenset()
            deepest = max(spec[4] for spec in visible)
            return frozenset(
                candidate
                for spec in visible
                if spec[4] == deepest
                for candidate in qualified_free_records(spec[1], spec[5])
            )

        calls_by_record: list[
            tuple[tuple[int, int, str, tuple[tuple[int, int], ...]], ...]
        ] = []
        potential_callers: dict[int, set[int]] = defaultdict(set)
        dependency_edges: set[tuple[int, int]] = set()
        for caller_index, record in enumerate(function_records):
            calls: list[tuple[int, int, str, tuple[tuple[int, int], ...]]] = []
            body_start = int(record["body_start"])
            body_end = int(record["body_end"])
            for index in range(body_start, body_end):
                spend_work("call-graph analysis")
                if tokens[index][0] == "ident":
                    for callee_index in records_by_name.get(tokens[index][1], ()):
                        dependency_edges.add((callee_index, caller_index))
                if (
                    index + 1 >= body_end
                    or tokens[index][0] != "ident"
                    or tokens[index + 1] != ("punct", "(")
                    or (index > body_start and tokens[index - 1] == ("punct", "!"))
                ):
                    continue
                closer = delimiter_pairs.get(index + 1)
                if closer is None or closer > body_end:
                    continue
                calls.append((index, closer, tokens[index][1], comma_ranges(index + 1, closer)))
            calls_by_record.append(tuple(calls))
            for start, _, name, _ in calls:
                for callee_index in imported_callable_records(name, start):
                    dependency_edges.add((callee_index, caller_index))
        if len(dependency_edges) > max_analysis_edges:
            die(path, f"Rust interprocedural call graph exceeds {max_analysis_edges} edges")
        for callee_index, caller_index in dependency_edges:
            potential_callers[callee_index].add(caller_index)

        assignments_by_record: list[
            tuple[tuple[tuple[str, ...], int, int, int], ...]
        ] = []
        for record in function_records:
            body_start = int(record["body_start"])
            body_end = int(record["body_end"])
            assignments_by_record.append(
                tuple(
                    (targets, start, end, equals)
                    for targets, start, end, _, equals in assignment_records
                    if body_start <= equals < body_end and end <= body_end
                )
            )

        Flow = tuple[bool, frozenset[int], frozenset[int]]
        empty_flow: Flow = (False, frozenset(), frozenset())

        def merge_flow(first: Flow, second: Flow) -> Flow:
            merged = (first[0] or second[0], first[1] | second[1], first[2] | second[2])
            if len(merged[1]) + len(merged[2]) > max_analysis_nodes:
                die(path, f"Rust flow value exceeds {max_analysis_nodes} identities")
            return merged

        def resolve_free_name(
            name: str, module_path: tuple[str, ...], position: int | None = None
        ) -> frozenset[int]:
            if position is not None:
                imported = imported_callable_records(name, position)
                if imported:
                    return imported
            candidates = free_records_by_name.get(name, set())
            local = {
                candidate
                for candidate in candidates
                if function_records[candidate]["module"] == module_path
            }
            return frozenset(local or candidates)

        def resolve_path_callable(
            parts: tuple[str, ...], module_path: tuple[str, ...], position: int | None = None
        ) -> frozenset[int]:
            if not parts:
                return frozenset()
            if len(parts) == 1:
                return resolve_free_name(parts[0], module_path, position)
            owner = normalize_type_path(parts[:-1], module_path)
            if owner is not None:
                inherent = inherent_methods_by_owner_name.get((owner, parts[-1]), set())
                if inherent:
                    return frozenset(inherent)
                concrete = methods_by_owner_name.get((owner, parts[-1]), set())
                if concrete:
                    return frozenset(concrete)
                return frozenset(
                    candidate
                    for trait_key in implemented_traits.get(owner, ())
                    for candidate in methods_by_owner_name.get(
                        (trait_key, parts[-1]), ()
                    )
                )
            return qualified_free_records(parts, module_path)

        def receiver_expression_start(end: int, floor: int, depth: int = 0) -> int:
            if depth > max_rust_concat_depth or end <= floor:
                return max(floor, end - 1)
            position = end - 1
            value = tokens[position][1]
            if value in {')', ']', '}'} and position in delimiter_pairs:
                opener = delimiter_pairs[position]
                start = opener
                if value == "]":
                    start = receiver_expression_start(opener, floor, depth + 1)
                elif value == ")" and opener > floor and (
                    tokens[opener - 1][0] == "ident" or tokens[opener - 1][1] in {')', ']', '}'}
                ):
                    start = receiver_expression_start(opener, floor, depth + 1)
                elif value == "}" and opener > floor and tokens[opener - 1][0] == "ident":
                    start = opener - 1
                    while (
                        start >= floor + 3
                        and tokens[start - 1] == ("punct", ":")
                        and tokens[start - 2] == ("punct", ":")
                        and tokens[start - 3][0] == "ident"
                    ):
                        start -= 3
            else:
                start = position
                while (
                    start >= floor + 3
                    and tokens[start - 1] == ("punct", ":")
                    and tokens[start - 2] == ("punct", ":")
                    and tokens[start - 3][0] == "ident"
                ):
                    start -= 3
            if start > floor and tokens[start - 1] == ("punct", "."):
                start = receiver_expression_start(start - 1, floor, depth + 1)
            while start > floor and tokens[start - 1][1] in {"&", "mut", "*"}:
                start -= 1
            return start

        def analyze_record(
            record_index: int,
        ) -> tuple[bool, set[int], set[int], set[int]]:
            record = function_records[record_index]
            body_start = int(record["body_start"])
            body_end = int(record["body_end"])
            module_path = record["module"]
            bindings: dict[str, Flow] = {}
            type_bindings: dict[str, set[tuple[str, ...]]] = defaultdict(set)
            for parameter_index, names in enumerate(record["parameters"]):
                parameter_type = record["parameter_types"][parameter_index]
                for name in names:
                    bindings[str(name)] = (False, frozenset({parameter_index}), frozenset())
                    if parameter_type is not None:
                        type_bindings[str(name)].add(parameter_type)

            def expression_types(start: int, end: int, depth: int = 0) -> set[tuple[str, ...]]:
                if depth > max_rust_concat_depth or start >= end:
                    return set()
                while start < end and tokens[start][1] in {"&", "mut", "*"}:
                    start += 1
                if start >= end:
                    return set()
                if (
                    tokens[start] == ("punct", "(")
                    and delimiter_pairs.get(start) == end - 1
                ):
                    return expression_types(start + 1, end - 1, depth + 1)
                if tokens[start] == ("punct", "["):
                    closer = delimiter_pairs.get(start)
                    ranges = comma_ranges(start, closer) if closer is not None and closer < end else ()
                    return expression_types(*ranges[0], depth + 1) if ranges else set()
                if tokens[start][0] != "ident":
                    return set()
                parts, cursor = path_parts(start, end)
                current_types: set[tuple[str, ...]] = set()
                if len(parts) == 1 and parts[0] in type_bindings:
                    current_types.update(type_bindings[parts[0]])
                normalized = normalize_type_path(parts, module_path)
                if normalized is not None:
                    current_types.add(normalized)
                if cursor < end and tokens[cursor] == ("punct", "{"):
                    normalized = normalize_type_path(parts, module_path)
                    return {normalized} if normalized is not None else set()
                if cursor < end and tokens[cursor] == ("punct", "("):
                    callable_candidates = resolve_path_callable(parts, module_path, start)
                    current_types.update(
                        function_records[candidate]["return_type"]
                        for candidate in callable_candidates
                        if function_records[candidate]["return_type"] is not None
                    )
                    if len(parts) > 1:
                        owner = normalize_type_path(parts[:-1], module_path)
                        if owner is not None and parts[-1] in {"default", "new"}:
                            current_types.add(owner)
                scan = start
                while scan + 1 < end:
                    if (
                        tokens[scan] == ("punct", ".")
                        and tokens[scan + 1][0] == "ident"
                        and not (scan + 2 < end and tokens[scan + 2] == ("punct", "("))
                    ):
                        field = tokens[scan + 1][1]
                        current_types = {
                            struct_fields[type_key][field]
                            for type_key in current_types
                            if field in struct_fields.get(type_key, {})
                        }
                    scan += 1
                return current_types

            def call_resolution(
                start: int,
                explicit_arguments: tuple[tuple[int, int], ...],
                depth: int = 0,
            ) -> tuple[frozenset[int], tuple[tuple[int, int], ...], bool]:
                name = tokens[start][1]
                if start > body_start and tokens[start - 1] == ("punct", "."):
                    receiver_start = receiver_expression_start(start - 1, body_start)
                    receiver = (receiver_start, start - 1)
                    receiver_types = expression_types(*receiver, depth + 1)
                    if receiver_types:
                        candidates = {
                            candidate
                            for receiver_type in receiver_types
                            for candidate in resolve_path_callable(
                                receiver_type + (name,), module_path, start
                            )
                        }
                        return frozenset(candidates), (receiver,) + explicit_arguments, True
                    return frozenset(methods_by_name.get(name, ())), (receiver,) + explicit_arguments, False

                path_start = start
                while (
                    path_start >= body_start + 3
                    and tokens[path_start - 1] == ("punct", ":")
                    and tokens[path_start - 2] == ("punct", ":")
                    and tokens[path_start - 3][0] == "ident"
                ):
                    path_start -= 3
                parts, _ = path_parts(path_start, start + 1)
                if len(parts) > 1:
                    return resolve_path_callable(parts, module_path, start), explicit_arguments, True
                if name in bindings:
                    return bindings[name][2], explicit_arguments, True
                return resolve_free_name(name, module_path, start), explicit_arguments, True

            calls_at_start = {call[0]: call for call in calls_by_record[record_index]}

            def expression_flow(start: int, end: int, depth: int = 0) -> Flow:
                if depth > max_rust_concat_depth:
                    die(path, "Rust interprocedural expression nesting exceeded its depth")
                flow = empty_flow
                cursor = start
                while cursor < end:
                    spend_work("expression analysis")
                    if cursor in dynamic_concat_starts:
                        flow = (True, flow[1], flow[2])
                    call = calls_at_start.get(cursor)
                    if call is not None and call[1] < end:
                        _, closer, _, explicit_arguments = call
                        candidates, arguments, _ = call_resolution(cursor, explicit_arguments, depth + 1)
                        for candidate in candidates:
                            summary = summaries[candidate]
                            if summary["return_dynamic"]:
                                flow = (True, flow[1], flow[2])
                            flow = merge_flow(
                                flow,
                                (False, frozenset(), frozenset(summary["return_callables"])),
                            )
                            for parameter_index in summary["return_parameters"]:
                                if parameter_index < len(arguments):
                                    flow = merge_flow(flow, expression_flow(*arguments[parameter_index], depth + 1))
                        cursor = closer + 1
                        continue
                    if tokens[cursor][0] == "ident":
                        name = tokens[cursor][1]
                        previous = tokens[cursor - 1][1] if cursor > start else ""
                        previous_previous = tokens[cursor - 2][1] if cursor > start + 1 else ""
                        following = tokens[cursor + 1][1] if cursor + 1 < end else ""
                        following_following = tokens[cursor + 2][1] if cursor + 2 < end else ""
                        member = previous == "." or (previous == ":" and previous_previous == ":")
                        field_label = following == ":" and following_following != ":"
                        if not member and not field_label:
                            if name in bindings:
                                flow = merge_flow(flow, bindings[name])
                            else:
                                parts, path_end = path_parts(cursor, end)
                                callable_ids = resolve_path_callable(parts, module_path, cursor)
                                if callable_ids:
                                    flow = merge_flow(flow, (False, frozenset(), callable_ids))
                                    cursor = path_end
                                    continue
                    cursor += 1
                return flow

            assignments_at_end: dict[int, list[tuple[tuple[str, ...], int, int, int]]] = defaultdict(list)
            for assignment in assignments_by_record[record_index]:
                assignments_at_end[assignment[2]].append(assignment)
            collection_updates: dict[int, list[tuple[str, tuple[tuple[int, int], ...]]]] = defaultdict(list)
            for start, closer, name, arguments in calls_by_record[record_index]:
                if name in collection_mutators and start >= body_start + 2 and tokens[start - 1] == ("punct", "."):
                    receiver_start = receiver_expression_start(start - 1, body_start)
                    if receiver_start < start - 1 and tokens[receiver_start][0] == "ident":
                        collection_updates[closer].append((tokens[receiver_start][1], arguments))

            return_dynamic = False
            return_parameters: set[int] = set()
            return_callables: set[int] = set()
            sink_parameters: set[int] = set()
            for index in range(body_start, body_end + 1):
                spend_work("callable-body analysis")
                call = calls_at_start.get(index)
                if call is not None:
                    start, _, name, explicit_arguments = call
                    candidates, arguments, _ = call_resolution(start, explicit_arguments)
                    relevant_parameters: set[int] = set()
                    if is_executable_sink(start):
                        arguments = explicit_arguments
                        relevant_parameters.update(range(len(arguments)))
                    else:
                        for candidate in candidates:
                            relevant_parameters.update(summaries[candidate]["sink_parameters"])
                    for parameter_index in relevant_parameters:
                        if parameter_index >= len(arguments):
                            continue
                        argument_flow = expression_flow(*arguments[parameter_index])
                        if argument_flow[0]:
                            die(path, f"unreviewed Rust concat value reaches summarized executable call {name}")
                        sink_parameters.update(argument_flow[1])

                if index < body_end and tokens[index] == ("ident", "return"):
                    return_end = min(next_semicolon_same_depth[index], body_end)
                    returned = expression_flow(index + 1, return_end)
                    return_dynamic = return_dynamic or returned[0]
                    return_parameters.update(returned[1])
                    return_callables.update(returned[2])

                for receiver, arguments in collection_updates.get(index, ()):
                    update = empty_flow
                    for argument in arguments:
                        update = merge_flow(update, expression_flow(*argument))
                    bindings[receiver] = merge_flow(bindings.get(receiver, empty_flow), update)

                for targets, start, end, equals in sorted(
                    assignments_at_end.get(index, ()), key=lambda assignment: assignment[3], reverse=True
                ):
                    assigned = expression_flow(start, end)
                    closure_index = closure_by_equals.get(equals)
                    if closure_index is not None:
                        assigned = merge_flow(assigned, (False, frozenset(), frozenset({closure_index})))
                    assigned_types = expression_types(start, end)
                    for target in targets:
                        bindings[target] = merge_flow(bindings.get(target, empty_flow), assigned)
                        type_bindings[target].update(assigned_types)
                    context = assignment_contexts.get(equals)
                    if context is not None and context[1] is None:
                        left = context[0]
                        root_name = next(
                            (tokens[cursor][1] for cursor in range(left, equals) if tokens[cursor][0] == "ident"),
                            None,
                        )
                        if root_name is not None and root_name not in targets:
                            bindings[root_name] = merge_flow(bindings.get(root_name, empty_flow), assigned)

            if bool(record["braced"]):
                body_opener = int(record["body_opener"])
                interior_depth = delimiter_depths[body_opener] + 1
                last_semicolon = max(
                    (
                        index
                        for index in range(body_start, body_end)
                        if tokens[index] == ("punct", ";") and delimiter_depths[index] == interior_depth
                    ),
                    default=body_start - 1,
                )
                tail_start = last_semicolon + 1
            else:
                tail_start = body_start
            if tail_start < body_end:
                returned = expression_flow(tail_start, body_end)
                return_dynamic = return_dynamic or returned[0]
                return_parameters.update(returned[1])
                return_callables.update(returned[2])
            return return_dynamic, return_parameters, return_callables, sink_parameters

        queue = deque(range(len(function_records)))
        queued = set(queue)
        summary_edge_count = 0
        while queue:
            record_index = queue.popleft()
            queued.discard(record_index)
            return_dynamic, return_parameters, return_callables, sink_parameters = analyze_record(record_index)
            summary = summaries[record_index]
            changed = False
            if return_dynamic and not summary["return_dynamic"]:
                summary["return_dynamic"] = True
                changed = True
            new_return_parameters = return_parameters - summary["return_parameters"]
            new_return_callables = return_callables - summary["return_callables"]
            new_sink_parameters = sink_parameters - summary["sink_parameters"]
            summary["return_parameters"].update(new_return_parameters)
            summary["return_callables"].update(new_return_callables)
            summary["sink_parameters"].update(new_sink_parameters)
            changed = changed or bool(new_return_parameters or new_return_callables or new_sink_parameters)
            summary_edge_count += len(new_return_parameters) + len(new_return_callables) + len(new_sink_parameters)
            if summary_edge_count > max_analysis_edges:
                die(path, f"Rust callable summary graph exceeds {max_analysis_edges} edges")
            if not changed:
                continue
            for caller in sorted(potential_callers.get(record_index, ())):
                if caller not in queued:
                    queue.append(caller)
                    queued.add(caller)
                    if len(queue) > max_analysis_nodes:
                        die(path, f"Rust interprocedural work queue exceeds {max_analysis_nodes} nodes")

    reject_interprocedural_flows()


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

  expect_computed_fixture_accepted() {
    local path="$1"
    local label="$2"
    if ! WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null; then
      printf '%s\n' "worker-only guard self-test: rejected $label" >&2
      return 1
    fi
    rm "$path"
  }

  write_rust_fixture() {
    local path="$1"
    python3 -c \
      'from pathlib import Path; import sys; Path(sys.argv[1]).write_text(sys.stdin.read())' \
      "$path"
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

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-tuple-sink.rs" <<'RS'
fn main() {
    let (safe, executable) = (
        "worker",
        concat!(env!("WORKER_BIN"), "/worker"),
    );
    let _ = std::process::Command::new(executable).status();
    println!("{safe}");
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-tuple-sink.rs" \
    "tuple-destructured dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-nested-tuple-sink.rs" <<'RS'
fn main() {
    let (_, (_, executable)) = (
        "ignored",
        ("also-ignored", concat!(env!("WORKER_BIN"), "/worker")),
    );
    let _ = std::process::Command::new(executable).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-nested-tuple-sink.rs" \
    "nested tuple dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-slice-at-sink.rs" <<'RS'
fn main() {
    let [_, executable @ _, ..] = [
        "ignored",
        concat!(env!("WORKER_BIN"), "/worker"),
        "rest",
    ];
    let _ = std::process::Command::new(executable).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-slice-at-sink.rs" \
    "slice at-pattern dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-struct-shorthand-sink.rs" <<'RS'
struct Candidate {
    safe: &'static str,
    executable: &'static str,
}

fn main() {
    let Candidate { safe: _, executable } = Candidate {
        safe: "worker",
        executable: concat!(env!("WORKER_BIN"), "/worker"),
    };
    let _ = std::process::Command::new(executable).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-struct-shorthand-sink.rs" \
    "struct shorthand dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-struct-rename-sink.rs" <<'RS'
struct Candidate {
    safe: &'static str,
    executable: &'static str,
}

fn main() {
    let Candidate { executable: binary, .. } = Candidate {
        safe: "worker",
        executable: concat!(env!("WORKER_BIN"), "/worker"),
    };
    let _ = std::process::Command::new(binary).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-struct-rename-sink.rs" \
    "renamed struct-rest dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-binding-at-sink.rs" <<'RS'
fn main() {
    let pair @ (_, executable) = (
        "worker",
        concat!(env!("WORKER_BIN"), "/worker"),
    );
    let _ = std::process::Command::new(executable).status();
    println!("{:?}", pair);
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-binding-at-sink.rs" \
    "binding-at dynamic Rust executable sink" || return 1

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

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-command-alias-sink.rs" <<'RS'
use std::process::Command as Process;

fn main() {
    let executable = concat!(env!("WORKER_BIN"), "/worker");
    let _ = Process::new(executable).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-command-alias-sink.rs" \
    "import-aliased Command dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-command-import-sink.rs" <<'RS'
use std::process::Command;

fn main() {
    let executable = concat!(env!("WORKER_BIN"), "/worker");
    let _ = Command::new(executable).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-command-import-sink.rs" \
    "provenance-resolved bare Command import sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-grouped-command-sink.rs" <<'RS'
use std::process::{Command as Process, Stdio};

fn main() {
    let executable = concat!(env!("WORKER_BIN"), "/worker");
    let candidates = [executable];
    let _ = Process::new(candidates[0]).stdin(Stdio::null()).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-grouped-command-sink.rs" \
    "group-import aliased Command container sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-nested-use-sink.rs" <<'RS'
pub use std::{path::Path, process::{Command as Process}};

fn main() {
    let _ = Process::new(concat!(module_path!(), "::worker")).status();
    let _ = Path::new("worker");
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-nested-use-sink.rs" \
    "nested grouped re-export Command direct sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-type-alias-sink.rs" <<'RS'
type Process = std::process::Command;
type Launcher = Process;

fn main() {
    let executable = concat!(env!("WORKER_BIN"), "/worker");
    let _ = Launcher::new(executable).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-type-alias-sink.rs" \
    "local Command type-alias chain dynamic sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-library-alias-sink.rs" <<'RS'
use libloading::{Library as DynamicLibrary, Symbol};

fn load() {
    let library = concat!(env!("OUT_DIR"), "/worker_plugin.so");
    let candidates = [library];
    let _ = unsafe { DynamicLibrary::open(candidates[0]) };
    let _: Option<Symbol<'_, unsafe extern "C" fn()>> = None;
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-library-alias-sink.rs" \
    "group-import aliased Library container sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/safe-unrelated-constructor.rs" <<'RS'
struct Widget;
impl Widget {
    fn new(_: &str) -> Self {
        Self
    }
}
use crate::Widget as Process;

fn main() {
    let generated = concat!(env!("OUT_DIR"), "/generated.rs");
    let _ = Process::new(generated);
}
RS
  if ! WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null; then
    printf '%s\n' "worker-only guard self-test: rejected unrelated aliased Rust constructor" >&2
    return 1
  fi
  rm "$fixture/daemon/examples/safe-unrelated-constructor.rs"

  write_rust_fixture "$fixture/daemon/examples/safe-pattern-identifiers.rs" <<'RS'
struct Candidate {
    executable: &'static str,
}
const executable: &str = "worker";
const PATTERN: &str = "worker";

fn main() {
    let Candidate { executable: _ } = Candidate {
        executable: concat!(env!("OUT_DIR"), "/generated.rs"),
    };
    let _ = std::process::Command::new(executable).status();
    let crate::patterns::PATTERN = concat!(env!("OUT_DIR"), "/other.rs");
    let _ = std::process::Command::new(PATTERN).status();
}
RS
  if ! WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null; then
    printf '%s\n' "worker-only guard self-test: treated a Rust field/path as a value binding" >&2
    return 1
  fi
  rm "$fixture/daemon/examples/safe-pattern-identifiers.rs"

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-function-return.rs" <<'RS'
fn executable() -> &'static str {
    concat!(env!("WORKER_BIN"), "/worker")
}

fn main() {
    let _ = std::process::Command::new(executable()).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-function-return.rs" \
    "function-returned dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-parameter-sink.rs" <<'RS'
fn launch(executable: &str) {
    let _ = std::process::Command::new(executable).status();
}

fn main() {
    launch(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-parameter-sink.rs" \
    "parameter-forwarded dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-multihop-return.rs" <<'RS'
fn source() -> &'static str {
    concat!(env!("WORKER_BIN"), "/worker")
}
fn middle() -> &'static str {
    source()
}
fn executable() -> &'static str {
    middle()
}

fn main() {
    let candidate = executable();
    let candidates = [candidate];
    let _ = std::process::Command::new(candidates[0]).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-multihop-return.rs" \
    "multi-hop returned dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-multihop-wrapper.rs" <<'RS'
fn sink(executable: &str) {
    let _ = std::process::Command::new(executable).status();
}
fn middle(value: &str) {
    sink(value);
}
fn launch(label: &str, executable: &str) {
    println!("{label}");
    middle(executable);
}

fn main() {
    launch("worker", concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-multihop-wrapper.rs" \
    "reordered multi-hop parameter dynamic Rust sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-destructured-parameter.rs" <<'RS'
fn launch((_, executable): (&str, &str)) {
    let _ = std::process::Command::new(executable).status();
}

fn main() {
    launch(("worker", concat!(env!("WORKER_BIN"), "/worker")));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-destructured-parameter.rs" \
    "destructured-parameter dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-method-parameter.rs" <<'RS'
struct Runner;
impl Runner {
    fn launch(&self, executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}

fn main() {
    Runner.launch(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-method-parameter.rs" \
    "method-parameter dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-closure-parameter.rs" <<'RS'
fn main() {
    let launch = |executable: &str| {
        let _ = std::process::Command::new(executable).status();
    };
    launch(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-closure-parameter.rs" \
    "closure-parameter dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-cycle-sink.rs" <<'RS'
fn first(executable: &str) {
    second(executable);
}
fn second(executable: &str) {
    if std::hint::black_box(false) {
        first(executable);
    }
    let _ = std::process::Command::new(executable).status();
}

fn main() {
    first(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-cycle-sink.rs" \
    "cycle-safe summarized dynamic Rust executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-assigned-receiver.rs" <<'RS'
struct Runner {
    executable: &'static str,
}
impl Runner {
    fn launch(&self) {
        let _ = std::process::Command::new(self.executable).status();
    }
}

fn main() {
    let runner = Runner {
        executable: concat!(env!("WORKER_BIN"), "/worker"),
    };
    let alias = runner;
    alias.launch();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-assigned-receiver.rs" \
    "assigned and aliased receiver-state executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-temporary-receiver.rs" <<'RS'
struct Runner {
    executable: &'static str,
}
impl Runner {
    fn launch(&mut self) {
        let candidates = [self.executable];
        let _ = std::process::Command::new(candidates[0]).status();
    }
}

fn main() {
    Runner {
        executable: concat!(env!("WORKER_BIN"), "/worker"),
    }.launch();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-temporary-receiver.rs" \
    "temporary mutable receiver-state executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-nested-receiver.rs" <<'RS'
struct Runner {
    executable: &'static str,
}
struct Wrapper {
    runner: Runner,
}
impl Runner {
    fn launch(self) {
        let _ = std::process::Command::new(self.executable).status();
    }
}

fn main() {
    let wrapper = Wrapper {
        runner: Runner {
            executable: concat!(env!("WORKER_BIN"), "/worker"),
        },
    };
    wrapper.runner.launch();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-nested-receiver.rs" \
    "nested by-value receiver-state executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-container-receiver.rs" <<'RS'
struct Runner {
    executable: &'static str,
}
impl Runner {
    fn launch(&self) {
        let _ = std::process::Command::new(self.executable).status();
    }
}

fn main() {
    let runners = [Runner {
        executable: concat!(env!("WORKER_BIN"), "/worker"),
    }];
    runners[0].launch();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-container-receiver.rs" \
    "container-held receiver-state executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-mutated-receiver.rs" <<'RS'
struct Runner {
    executable: &'static str,
}
impl Runner {
    fn launch(&self) {
        let _ = std::process::Command::new(self.executable).status();
    }
}

fn main() {
    let mut runner = Runner { executable: "worker" };
    runner.executable = concat!(env!("WORKER_BIN"), "/worker");
    runner.launch();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-mutated-receiver.rs" \
    "mutated receiver-field executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-callable-alias.rs" <<'RS'
fn launch(executable: &str) {
    let _ = std::process::Command::new(executable).status();
}

fn main() {
    let callback = launch;
    callback(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-callable-alias.rs" \
    "local function-pointer alias executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-returned-callable.rs" <<'RS'
fn launch(executable: &str) {
    let _ = std::process::Command::new(executable).status();
}
fn choose() -> fn(&str) {
    launch
}

fn main() {
    let callbacks = [choose()];
    let callback = callbacks[0];
    callback(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-returned-callable.rs" \
    "returned and container-aliased callable executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-callable-cycle.rs" <<'RS'
fn launch(executable: &str) {
    let _ = std::process::Command::new(executable).status();
}

fn main() {
    let mut first = launch;
    let second = first;
    first = second;
    second(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-callable-cycle.rs" \
    "cycle-safe callable alias executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-returned-callable-cycle.rs" <<'RS'
fn launch(executable: &str) {
    let _ = std::process::Command::new(executable).status();
}
fn choose(recurse: bool) -> fn(&str) {
    if recurse { choose(false) } else { launch }
}

fn main() {
    let callback = choose(true);
    callback(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-returned-callable-cycle.rs" \
    "cycle-safe returned callable executable sink" || return 1

  write_rust_fixture "$fixture/daemon/examples/safe-local-sink-type-names.rs" <<'RS'
struct Command;
impl Command {
    fn new(_: &str) -> Self { Self }
}
struct Library;
impl Library {
    fn open(_: &str) -> Self { Self }
}

fn main() {
    let generated = concat!(env!("OUT_DIR"), "/generated.rs");
    let _ = Command::new(generated);
    let _ = Library::open(generated);
}
RS
  expect_computed_fixture_accepted \
    "$fixture/daemon/examples/safe-local-sink-type-names.rs" \
    "local Command and Library constructors" || return 1

  write_rust_fixture "$fixture/daemon/examples/safe-shadowed-reviewed-root.rs" <<'RS'
mod std {
    pub mod process {
        pub struct Command;
        impl Command {
            pub fn new(_: &str) -> Self { Self }
        }
    }
}

fn main() {
    let generated = concat!(env!("OUT_DIR"), "/generated.rs");
    let _ = std::process::Command::new(generated);
}
RS
  expect_computed_fixture_accepted \
    "$fixture/daemon/examples/safe-shadowed-reviewed-root.rs" \
    "locally shadowed reviewed sink root" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-absolute-reviewed-root.rs" <<'RS'
mod std {
    pub mod process {
        pub struct Command;
    }
}

fn main() {
    let executable = concat!(env!("WORKER_BIN"), "/worker");
    let _ = ::std::process::Command::new(executable).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-absolute-reviewed-root.rs" \
    "absolute reviewed sink despite a local root shadow" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-scope-reviewed-root.rs" <<'RS'
mod nested {
    mod std {
        pub mod process {
            pub struct Command;
        }
    }
}

fn main() {
    let executable = concat!(env!("WORKER_BIN"), "/worker");
    let _ = std::process::Command::new(executable).status();
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-scope-reviewed-root.rs" \
    "reviewed sink outside an unrelated nested root shadow" || return 1

  write_rust_fixture "$fixture/daemon/examples/safe-qualified-method-collision.rs" <<'RS'
struct Safe;
impl Safe {
    fn launch(&self, value: &str) { println!("{value}"); }
}
struct Real;
impl Real {
    fn launch(&self, executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}

fn main() {
    Safe.launch(concat!(env!("OUT_DIR"), "/generated.rs"));
}
RS
  expect_computed_fixture_accepted \
    "$fixture/daemon/examples/safe-qualified-method-collision.rs" \
    "explicit safe receiver with a colliding audited method" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-qualified-method-collision.rs" <<'RS'
struct Safe;
impl Safe {
    fn launch(&self, value: &str) { println!("{value}"); }
}
struct Real;
impl Real {
    fn launch(&self, executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}

fn main() {
    Real.launch(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-qualified-method-collision.rs" \
    "explicit audited receiver with a colliding safe method" || return 1

  write_rust_fixture "$fixture/daemon/examples/safe-associated-method-collision.rs" <<'RS'
struct Safe;
impl Safe {
    fn launch(&self, value: &str) { println!("{value}"); }
}
struct Real;
impl Real {
    fn launch(&self, executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}

fn main() {
    Safe::launch(&Safe, concat!(env!("OUT_DIR"), "/generated.rs"));
}
RS
  expect_computed_fixture_accepted \
    "$fixture/daemon/examples/safe-associated-method-collision.rs" \
    "explicit Safe associated method with a colliding Real method" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-associated-method-collision.rs" <<'RS'
struct Safe;
impl Safe {
    fn launch(&self, value: &str) { println!("{value}"); }
}
struct Real;
impl Real {
    fn launch(&self, executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}

fn main() {
    Real::launch(&Real, concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-associated-method-collision.rs" \
    "explicit Real associated method with a colliding Safe method" || return 1

  write_rust_fixture "$fixture/daemon/examples/safe-constructor-method-collision.rs" <<'RS'
struct Safe;
impl Safe {
    fn new() -> Self { Self }
    fn launch(&self, value: &str) { println!("{value}"); }
}
struct Real;
impl Real {
    fn launch(&self, executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}

fn main() {
    Safe::new().launch(concat!(env!("OUT_DIR"), "/generated.rs"));
}
RS
  expect_computed_fixture_accepted \
    "$fixture/daemon/examples/safe-constructor-method-collision.rs" \
    "constructor-resolved safe receiver with a colliding audited method" || return 1

  write_rust_fixture "$fixture/daemon/examples/safe-qualified-trait-collision.rs" <<'RS'
trait Launcher { fn launch(&self, value: &str); }
struct Safe;
impl Launcher for Safe {
    fn launch(&self, value: &str) { println!("{value}"); }
}
struct Real;
impl Launcher for Real {
    fn launch(&self, executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}

fn main() {
    Safe.launch(concat!(env!("OUT_DIR"), "/generated.rs"));
}
RS
  expect_computed_fixture_accepted \
    "$fixture/daemon/examples/safe-qualified-trait-collision.rs" \
    "explicit safe trait receiver with a colliding audited impl" || return 1

  write_rust_fixture "$fixture/daemon/examples/safe-inherent-trait-precedence.rs" <<'RS'
trait Launcher { fn launch(&self, value: &str); }
struct Safe;
impl Launcher for Safe {
    fn launch(&self, executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}
impl Safe {
    fn launch(&self, value: &str) { println!("{value}"); }
}

fn main() {
    Safe.launch(concat!(env!("OUT_DIR"), "/generated.rs"));
}
RS
  expect_computed_fixture_accepted \
    "$fixture/daemon/examples/safe-inherent-trait-precedence.rs" \
    "safe inherent method that takes precedence over a trait method" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-unresolved-trait-collision.rs" <<'RS'
trait Launcher { fn launch(&self, value: &str); }
struct Safe;
impl Launcher for Safe {
    fn launch(&self, value: &str) { println!("{value}"); }
}
struct Real;
impl Launcher for Real {
    fn launch(&self, executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}

fn invoke<T: Launcher>(runner: T) {
    runner.launch(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-unresolved-trait-collision.rs" \
    "unresolved receiver with a plausible audited trait impl" || return 1

  write_rust_fixture "$fixture/daemon/examples/safe-qualified-free-function-collision.rs" <<'RS'
mod safe {
    pub fn launch(value: &str) { println!("{value}"); }
}
mod real {
    pub fn launch(executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}

fn main() {
    safe::launch(concat!(env!("OUT_DIR"), "/generated.rs"));
}
RS
  expect_computed_fixture_accepted \
    "$fixture/daemon/examples/safe-qualified-free-function-collision.rs" \
    "qualified safe free function with a colliding audited function" || return 1

  write_rust_fixture "$fixture/daemon/examples/dynamic-concat-qualified-free-function.rs" <<'RS'
mod safe {
    pub fn launch(value: &str) { println!("{value}"); }
}
mod real {
    pub fn launch(executable: &str) {
        let _ = std::process::Command::new(executable).status();
    }
}

fn main() {
    real::launch(concat!(env!("WORKER_BIN"), "/worker"));
}
RS
  expect_computed_fixture_rejected \
    "$fixture/daemon/examples/dynamic-concat-qualified-free-function.rs" \
    "qualified audited free function with a colliding safe function" || return 1

  write_rust_fixture "$fixture/daemon/examples/safe-dynamic-helper.rs" <<'RS'
struct Widget;
impl Widget {
    fn new(_: usize) -> Self {
        Self
    }
}
fn label(value: &str) -> usize {
    value.len()
}
fn first(value: &str) -> &str {
    second(value)
}
fn second(value: &str) -> &str {
    if std::hint::black_box(false) {
        first(value)
    } else {
        value
    }
}

fn main() {
    let generated = concat!(env!("OUT_DIR"), "/generated.rs");
    let _ = Widget::new(label(generated));
    println!("{}", first(generated));
}
RS
  if ! WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null; then
    printf '%s\n' "worker-only guard self-test: rejected a non-sink local Rust helper" >&2
    return 1
  fi
  rm "$fixture/daemon/examples/safe-dynamic-helper.rs"

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
  # path; cycles, broad fanout, long append lists, and a deep return-summary
  # chain exercise bounded intraprocedural and interprocedural cases. The Rust
  # fixture also drives long callable/receiver alias chains and hundreds of
  # same-name methods, ensuring the qualified summaries remain bounded.
  python3 - \
    "$fixture/server/spawn_server/routes/binding-graph-performance.py" \
    "$fixture/scripts/binding-graph-performance.sh" \
    "$fixture/daemon/examples/call-graph-performance.rs" <<'PY'
from pathlib import Path
import sys

python_path = Path(sys.argv[1])
shell_path = Path(sys.argv[2])
rust_path = Path(sys.argv[3])

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

rust_lines = [
    f"fn return_{index}(value: &'static str) -> &'static str "
    f"{{ return_{index + 1}(value) }}"
    for index in range(1_200)
]
rust_lines.append("fn safe_callback(value: &'static str) { println!(\"{}\", value); }")
rust_lines.extend(
    f"struct SafeReceiver{index}; impl SafeReceiver{index} {{ "
    f"fn launch(&self, value: &'static str) {{ println!(\"{{}}\", value); }} }}"
    for index in range(200)
)
rust_lines.extend(
    [
        "struct RealReceiver;",
        "impl RealReceiver {",
        "    fn launch(&self, executable: &'static str) {",
        "        let _ = std::process::Command::new(executable).status();",
        "    }",
        "}",
    ]
)
rust_lines.extend(
    [
        "fn return_1200(value: &'static str) -> &'static str { value }",
        "fn main() {",
        '    let generated = concat!(env!("OUT_DIR"), "/generated.rs");',
    ]
)
rust_lines.append("    let callback_0 = safe_callback;")
rust_lines.extend(
    f"    let callback_{index} = callback_{index - 1};"
    for index in range(1, 801)
)
rust_lines.append("    let receiver_0 = SafeReceiver199;")
rust_lines.extend(
    f"    let receiver_{index} = receiver_{index - 1};"
    for index in range(1, 801)
)
rust_lines.extend(
    [
        "    callback_800(generated);",
        "    receiver_800.launch(generated);",
        '    println!("{}", return_0(generated));',
        "}",
    ]
)
rust_path.write_text("\n".join(rust_lines) + "\n")
PY
  if ! timeout 12s env WORKER_ONLY_GUARD_ROOT="$fixture" "$script_path" >/dev/null; then
    printf '%s\n' "worker-only guard self-test: binding graph exceeded linear-runtime ceiling" >&2
    return 1
  fi
  rm \
    "$fixture/server/spawn_server/routes/binding-graph-performance.py" \
    "$fixture/scripts/binding-graph-performance.sh" \
    "$fixture/daemon/examples/call-graph-performance.rs"

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
