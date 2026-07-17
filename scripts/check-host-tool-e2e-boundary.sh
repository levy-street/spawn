#!/usr/bin/env bash
set -euo pipefail

script_path="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
repo_root="${HOST_TOOL_E2E_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
rg_bin="${HOST_TOOL_E2E_RG:-rg}"

fail() {
  printf 'host-tool-e2e-boundary: %s\n' "$*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "required tool is unavailable: $1"
}

run_guard() {
  require_tool git
  require_tool node
  require_tool python3
  require_tool rustc
  require_tool "$rg_bin"
  "$rg_bin" --version >/dev/null 2>&1 || fail "ripgrep health check failed"
  [[ -d "$repo_root" ]] || fail "root does not exist: $repo_root"

  local inventory
  inventory="$(mktemp)"
  trap 'rm -f "$inventory"' RETURN
  if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$repo_root" ls-files --cached --others --exclude-standard -- \
      server/spawn_server daemon/src web/src >"$inventory" \
      || fail "git production inventory failed"
  else
    (
      cd "$repo_root"
      "$rg_bin" --files server/spawn_server daemon/src web/src
    ) >"$inventory" || fail "fallback production inventory failed"
  fi
  [[ -s "$inventory" ]] || fail "production inventory is empty"

  python3 - "$repo_root" "$inventory" <<'PY'
from __future__ import annotations

import ast
import hashlib
import os
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path


root = Path(sys.argv[1]).resolve()
inventory_path = Path(sys.argv[2])
prefixes = ("server/spawn_server/", "daemon/src/", "web/src/")
extensions = {".py", ".rs", ".ts", ".tsx"}


def die(message: str) -> None:
    raise SystemExit(f"host-tool-e2e-boundary: {message}")


relative_paths: list[str] = []
for raw in inventory_path.read_text().splitlines():
    relative = raw.strip().replace("\\", "/")
    if not relative or not relative.startswith(prefixes):
        continue
    if Path(relative).suffix not in extensions:
        continue
    if re.search(r"\.(?:test|spec)\.[^.]+$", relative):
        continue
    path = (root / relative).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        die(f"inventory escaped the root: {relative}")
    if not path.is_file():
        die(f"inventoried production file is missing: {relative}")
    relative_paths.append(relative)

if not relative_paths:
    die("production source inventory is empty")
if len(relative_paths) != len(set(relative_paths)):
    die("production source inventory contains duplicates")

sources: dict[str, str] = {}
for relative in sorted(relative_paths):
    try:
        sources[relative] = (root / relative).read_text()
    except (OSError, UnicodeError) as exc:
        die(f"cannot read {relative}: {exc}")

required_files = {
    "server/spawn_server/routes/hosts.py",
    "server/spawn_server/schemas.py",
    "server/spawn_server/presets.py",
    "daemon/src/host_control.rs",
    "daemon/src/host_tools.rs",
    "web/src/components/hosts/HostToolsPanel.tsx",
    "web/src/lib/api.ts",
    "web/src/lib/hostControl.ts",
}
missing_files = sorted(required_files - sources.keys())
if missing_files:
    die(f"required production files are missing from inventory: {missing_files}")


def require_count(relative: str, needle: str, expected: int = 1) -> None:
    count = sources[relative].count(needle)
    if count != expected:
        die(f"{relative} must contain {needle!r} exactly {expected} time(s), found {count}")


def require_present(relative: str, needle: str) -> None:
    if needle not in sources[relative]:
        die(f"{relative} is missing required sentinel {needle!r}")


# The server may disclose only preset identity, canonical agent kind, and policy timestamps.
server_trees: dict[str, ast.Module] = {}
for relative, source in sources.items():
    if not relative.startswith("server/spawn_server/") or not relative.endswith(".py"):
        continue
    try:
        server_trees[relative] = ast.parse(source, filename=relative)
    except SyntaxError as exc:
        die(f"cannot parse server production source {relative}: {exc}")

def static_python_string(node: ast.AST, bindings: dict[str, str]) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return bindings.get(node.id)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = static_python_string(node.left, bindings)
        right = static_python_string(node.right, bindings)
        return None if left is None or right is None else left + right
    if isinstance(node, (ast.List, ast.Tuple)):
        values = [static_python_string(item, bindings) for item in node.elts]
        return None if any(value is None for value in values) else "".join(values)  # type: ignore[arg-type]
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "join"
        and len(node.args) == 1
    ):
        separator = static_python_string(node.func.value, bindings)
        values_node = node.args[0]
        if separator is not None and isinstance(values_node, (ast.List, ast.Tuple)):
            values = [static_python_string(item, bindings) for item in values_node.elts]
            if all(value is not None for value in values):
                return separator.join(values)  # type: ignore[arg-type]
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
    return None


server_string_bindings: dict[str, dict[str, str]] = {}
for relative, tree in server_trees.items():
    bindings: dict[str, str] = {}
    for _ in range(8):
        changed = False
        for node in ast.walk(tree):
            target: ast.Name | None = None
            value_node: ast.AST | None = None
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                target, value_node = node.targets[0], node.value
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                target, value_node = node.target, node.value
            if target is None or value_node is None:
                continue
            value = static_python_string(value_node, bindings)
            if value is not None and bindings.get(target.id) != value:
                bindings[target.id] = value
                changed = True
        if not changed:
            break
    server_string_bindings[relative] = bindings
    for node in ast.walk(tree):
        value = static_python_string(node, bindings)
        if value in {"tool.check", "tool.install"}:
            die(f"server production computes endpoint-only operation in {relative}:{node.lineno}")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "vars":
            die(f"server production uses unreviewed vars() field access in {relative}:{node.lineno}")

hosts_relative = "server/spawn_server/routes/hosts.py"
hosts_tree = server_trees[hosts_relative]
metadata_functions = [
    node
    for node in hosts_tree.body
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    and node.name == "list_host_tool_metadata"
]
if len(metadata_functions) != 1:
    die("server metadata handler must exist exactly once at module scope")
metadata = metadata_functions[0]

allowed_routes = {
    ("get", "/{host_id}/tools", "list_host_tools"),  # HOST-03B legacy compatibility
    ("get", "/{host_id}/tool-targets", "list_host_tool_metadata"),
    ("post", "/{host_id}/tools/{preset_id}/install", "install_host_tool"),  # HOST-03B
    ("patch", "/{host_id}/tools/{preset_id}/policy", "patch_host_tool_policy"),  # HOST-03B
}
found_routes: set[tuple[str, str, str]] = set()
for relative, tree in server_trees.items():
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call) or not isinstance(decorator.func, ast.Attribute):
                continue
            if decorator.func.attr not in {"get", "post", "put", "patch", "delete"}:
                continue
            if not decorator.args:
                die(f"server route has no literal path in {relative}:{node.lineno}")
            route = static_python_string(
                decorator.args[0], server_string_bindings.get(relative, {})
            )
            if route is None:
                die(f"server route path is computed or unresolved in {relative}:{node.lineno}")
            if "tool" not in route.lower():
                continue
            found = (decorator.func.attr, route, node.name)
            if relative != hosts_relative or found not in allowed_routes:
                die(f"unapproved server tool route {found!r} in {relative}:{node.lineno}")
            found_routes.add(found)
if found_routes != allowed_routes:
    die(f"server tool route allowlist changed: {sorted(found_routes)!r}")

forbidden_attributes = {
    "default_argv",
    "install",
    "last_auto_update_error",
    "command",
    "path",
    "version",
    "output",
    "stdout",
    "stderr",
    "error",
    "payload",
    "websocket",
}
metadata_attributes = {node.attr for node in ast.walk(metadata) if isinstance(node, ast.Attribute)}
leaked_attributes = sorted(metadata_attributes & forbidden_attributes)
if leaked_attributes:
    die(f"metadata handler reads protected attributes: {leaked_attributes}")
metadata_names = {node.id for node in ast.walk(metadata) if isinstance(node, ast.Name)}
if metadata_names & {"get_broker", "get_backend", "log", "logging", "Response"}:
    die("metadata handler touches a broker, Redis backend, logger, or raw response")
body_module = ast.Module(body=metadata.body, type_ignores=[])
allowed_named_calls = {"_get_owned_host", "and_", "bool", "or_", "select"}
for call in (node for node in ast.walk(body_module) if isinstance(node, ast.Call)):
    if isinstance(call.func, ast.Name) and call.func.id not in allowed_named_calls:
        die(f"metadata handler delegates to unreviewed helper {call.func.id!r}")

schemas_tree = server_trees["server/spawn_server/schemas.py"]
metadata_classes = [
    node
    for node in schemas_tree.body
    if isinstance(node, ast.ClassDef) and node.name == "HostToolMetadata"
]
if len(metadata_classes) != 1:
    die("HostToolMetadata schema must exist exactly once")
metadata_fields = {
    node.target.id
    for node in metadata_classes[0].body
    if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
}
allowed_metadata_fields = {
    "preset_id",
    "preset_name",
    "agent_kind",
    "auto_update",
    "last_checked_at",
    "last_auto_update_at",
}
if metadata_fields != allowed_metadata_fields:
    die(f"metadata schema field allowlist changed: {sorted(metadata_fields)}")

# HOST-03B legacy compatibility is retained only in these already-reviewed scopes.
allowed_tool_symbols = {
    "server/spawn_server/models.py": {"HostToolPolicy"},
    "server/spawn_server/schemas.py": {
        "HostToolTarget", "HostToolStatus", "HostToolList", "HostToolMetadata",
        "HostToolMetadataList", "HostToolInstallResult", "HostToolPolicyPatch", "HostToolPolicyOut",
    },
    "server/spawn_server/ws/broker.py": {
        "request_tool_check", "resolve_tool_check", "request_tool_install", "resolve_tool_install",
    },
    hosts_relative: {
        "_preset_to_tool_target", "_merge_tool_policy", "_should_auto_update",
        "_auto_update_error_from_result", "_run_auto_update", "_owned_auto_update",
        "_auto_update_task_done", "_start_auto_update", "wait_for_auto_update_tasks_idle",
        "run_auto_update_checks_once", "_auto_update_check_loop", "start_auto_update_checker",
        "stop_auto_update_checker", "list_host_tools", "list_host_tool_metadata",
        "install_host_tool", "patch_host_tool_policy",
    },
}
found_tool_symbols: dict[str, set[str]] = {}
for relative, tree in server_trees.items():
    for node in ast.walk(tree):
        if not isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        lowered = node.name.lower()
        if "tool" not in lowered and "auto_update" not in lowered:
            continue
        if node.name not in allowed_tool_symbols.get(relative, set()):
            die(f"unreviewed server tool helper {relative}:{node.lineno}:{node.name}")
        found_tool_symbols.setdefault(relative, set()).add(node.name)
if found_tool_symbols != allowed_tool_symbols:
    die("reviewed server legacy tool symbol inventory changed")

expected_legacy_strings = Counter({
    ("server/spawn_server/ws/broker.py", "request_tool_check", "host.tools.check"): 1,
    ("server/spawn_server/ws/broker.py", "request_tool_check", "host.tools.check_result"): 1,
    ("server/spawn_server/ws/broker.py", "request_tool_install", "host.tools.install"): 1,
    ("server/spawn_server/ws/broker.py", "request_tool_install", "host.tools.install_result"): 1,
    ("server/spawn_server/ws/broker.py", "resolve_tool_check", "host.tools.check_result"): 1,
    ("server/spawn_server/ws/broker.py", "resolve_tool_install", "host.tools.install_result"): 1,
    ("server/spawn_server/ws/daemon.py", "daemon_ws", "host.tools.check_result"): 1,
    ("server/spawn_server/ws/daemon.py", "daemon_ws", "host.tools.install_result"): 1,
    ("server/spawn_server/ws/owner_dispatch.py", "<module>", "host.tools.check_result"): 1,
    ("server/spawn_server/ws/owner_dispatch.py", "<module>", "host.tools.install_result"): 1,
})

# These are the complete server-side reads of fields capable of reconstructing
# protected tool commands/results. Inventorying the access itself (not helper
# names) prevents a generic relay/helper from bypassing the allowlist.
protected_server_attributes = {
    "command", "default_argv", "install", "last_auto_update_error", "output",
    "path", "payload", "stderr", "stdout", "version",
}
expected_server_attribute_reads = Counter({
    ("server/spawn_server/presets.py", "seed_builtin_presets", "install"): 2,
    ("server/spawn_server/presets.py", "seed_builtin_presets", "subscript:default_argv"): 1,
    ("server/spawn_server/presets.py", "seed_builtin_presets", "get:install"): 2,
    ("server/spawn_server/agent_control.py", "upload_agent_file", "subscript:path"): 1,
    ("server/spawn_server/routes/agents.py", "_dispatch_agent_launch", "install"): 1,
    ("server/spawn_server/routes/agents.py", "create_agent", "default_argv"): 1,
    ("server/spawn_server/routes/device.py", "device_poll", "version"): 1,
    ("server/spawn_server/routes/device.py", "device_start", "version"): 1,
    (hosts_relative, "_merge_tool_policy", "last_auto_update_error"): 2,
    (hosts_relative, "_preset_to_tool_target", "default_argv"): 1,
    (hosts_relative, "_preset_to_tool_target", "install"): 1,
    (hosts_relative, "_run_auto_update", "last_auto_update_error"): 1,
    (hosts_relative, "_should_auto_update", "install"): 1,
    (hosts_relative, "_to_out", "version"): 1,
    (hosts_relative, "install_host_tool", "install"): 1,
    (hosts_relative, "list_host_tools", "last_auto_update_error"): 1,
    (hosts_relative, "patch_host_tool_policy", "last_auto_update_error"): 1,
    (hosts_relative, "run_auto_update_checks_once", "last_auto_update_error"): 1,
    ("server/spawn_server/routes/presets.py", "create_preset", "default_argv"): 1,
    ("server/spawn_server/routes/presets.py", "create_preset", "install"): 1,
    ("server/spawn_server/routes/presets.py", "update_preset", "default_argv"): 2,
    ("server/spawn_server/routes/presets.py", "update_preset", "install"): 2,
    ("server/spawn_server/ws/broker.py", "_request_owner_result", "payload"): 1,
    ("server/spawn_server/ws/browser.py", "browser_ws", "get:path"): 1,
    ("server/spawn_server/ws/daemon.py", "daemon_ws", "get:path"): 1,
    ("server/spawn_server/ws/owner_dispatch.py", "encode_owner_result", "payload"): 1,
    ("server/spawn_server/ws/owner_dispatch.py", "decode_owner_result", "get:payload"): 1,
})


class LegacyStringVisitor(ast.NodeVisitor):
    def __init__(self, relative: str, tree: ast.Module, bindings: dict[str, str]) -> None:
        self.relative = relative
        self.bindings = bindings
        self.attrgetter_names = {"attrgetter"}
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "operator":
                for name in node.names:
                    if name.name == "attrgetter":
                        self.attrgetter_names.add(name.asname or name.name)
        self.scope = ["<module>"]
        self.legacy = Counter()
        self.protected_attributes = Counter()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str) and node.value.startswith("host.tools."):
            self.legacy[(self.relative, self.scope[-1], node.value)] += 1

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if node.attr in protected_server_attributes:
            self.protected_attributes[(self.relative, self.scope[-1], node.attr)] += 1
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        if isinstance(node.slice, ast.Constant) and node.slice.value in protected_server_attributes:
            self.protected_attributes[
                (self.relative, self.scope[-1], f"subscript:{node.slice.value}")
            ] += 1
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        is_attrgetter = (
            isinstance(node.func, ast.Name) and node.func.id in self.attrgetter_names
        ) or (
            isinstance(node.func, ast.Attribute) and node.func.attr == "attrgetter"
        )
        if is_attrgetter:
            for argument in node.args:
                value = static_python_string(argument, self.bindings)
                if value in protected_server_attributes:
                    self.protected_attributes[
                        (self.relative, self.scope[-1], f"attrgetter:{value}")
                    ] += 1
        if (
            isinstance(node.func, ast.Name)
            and node.func.id == "getattr"
            and len(node.args) >= 2
            and isinstance(node.args[1], ast.Constant)
            and node.args[1].value in protected_server_attributes
        ):
            self.protected_attributes[
                (self.relative, self.scope[-1], f"getattr:{node.args[1].value}")
            ] += 1
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and node.args[0].value in protected_server_attributes
        ):
            self.protected_attributes[
                (self.relative, self.scope[-1], f"get:{node.args[0].value}")
            ] += 1
        self.generic_visit(node)


found_legacy_strings = Counter()
found_server_attribute_reads = Counter()
for relative, tree in server_trees.items():
    visitor = LegacyStringVisitor(
        relative, tree, server_string_bindings.get(relative, {})
    )
    visitor.visit(tree)
    found_legacy_strings.update(visitor.legacy)
    found_server_attribute_reads.update(visitor.protected_attributes)
if found_legacy_strings != expected_legacy_strings:
    die(f"exact legacy server tool frame inventory changed: {found_legacy_strings!r}")
if found_server_attribute_reads != expected_server_attribute_reads:
    die(f"protected server field access inventory changed: {found_server_attribute_reads!r}")


# Browser production has its query plus authoritative reconciliation metadata
# reads, direct E2E checks/install, and an explicit legacy-policy inhibitor.
panel_relative = "web/src/components/hosts/HostToolsPanel.tsx"
control_relative = "web/src/lib/hostControl.ts"
api_relative = "web/src/lib/api.ts"
for needle, expected in (
    ("hosts.toolTargets(", 2),
    ("hosts.updateToolPolicy(", 2),
    ("client.checkTools(", 3),
    ("client.installTool(", 1),
):
    require_count(panel_relative, needle, expected)
for relative, source in sources.items():
    if not relative.startswith("web/src/"):
        continue
    if re.search(r"\bhosts\s*\.\s*(?:tools|installTool)\b", source):
        die(f"browser production references a HOST-03B content helper in {relative}")
    if re.search(r"\bhosts\s*\[", source):
        die(f"browser production uses an unreviewed computed hosts helper in {relative}")
    if re.search(r"\{[^}]*\b(?:tools|installTool)\b[^}]*\}\s*=\s*hosts\b", source, re.S):
        die(f"browser production destructures a HOST-03B content helper in {relative}")


def string_literal_stream(source: str) -> str:
    # Joining lexical string fragments catches property/route/operation names
    # assembled with concatenation, arrays, templates, or computed brackets.
    fragments: list[str] = []
    for match in re.finditer(r'''(?s)(["'])(.*?)(?<!\\)\1|`(.*?)`''', source):
        fragments.append(match.group(2) if match.group(1) else match.group(3))
    return "".join(fragments)


web_literal_streams = {
    relative: string_literal_stream(source)
    for relative, source in sources.items()
    if relative.startswith("web/src/")
}
for relative, stream in web_literal_streams.items():
    if relative != control_relative and ("tool.check" in stream or "tool.install" in stream):
        die(f"endpoint-only computed tool operation moved outside hostControl.ts into {relative}")

control_operations = Counter(
    operation
    for operation in ("tool.check", "tool.install")
    for _ in range(web_literal_streams[control_relative].count(operation))
)
if control_operations != Counter({"tool.check": 1, "tool.install": 4}):
    die(f"hostControl.ts exact endpoint operation inventory changed: {control_operations!r}")

legacy_routes = {
    "/tools`": 1,
    "/tools/${presetId}/install`": 1,
    "/tools/${presetId}/policy`": 1,
}
for suffix, expected in legacy_routes.items():
    occurrences = [
        relative
        for relative, source in sources.items()
        if relative.startswith("web/src/")
        for _ in range(source.count(suffix))
    ]
    if occurrences != [api_relative] * expected:
        die(f"HOST-03B browser route {suffix!r} escaped its exact api.ts allowlist: {occurrences}")
for relative, stream in web_literal_streams.items():
    sensitive_host_routes = sum(
        "tool" in segment
        for segment in stream.split("/api/hosts")[1:]
    )
    expected = 4 if relative == api_relative else 0
    if sensitive_host_routes != expected:
        die(
            f"computed browser host-tool route inventory changed in {relative}: "
            f"expected {expected}, found {sensitive_host_routes}"
        )
all_web = "\n".join(source for relative, source in sources.items() if relative.startswith("web/src/"))
if all_web.count("/tool-targets`") != 1 or sources[api_relative].count("/tool-targets`") != 1:
    die("public tool metadata route must occur exactly once in api.ts")

for relative, source in sources.items():
    if not relative.startswith("web/src/"):
        continue
    if re.search(r"['\"](?:ba)?sh['\"]\s*,\s*['\"]-c['\"]", source, re.S):
        die(f"browser production contains shell evaluation in {relative}")
    if re.search(r"\b(?:eval|Function)\s*\(", source):
        die(f"browser production contains dynamic evaluation in {relative}")

require_count(control_relative, "async checkTools(")
require_count(control_relative, "async installTool(")
require_count(control_relative, '"tool.check",')
require_count(control_relative, "TOOL_CANCEL_RESPONSE_TIMEOUT_MS", 2)
require_count(panel_relative, "new AbortController()")
for needle, expected in (
    ('"host-tool-reconciliation"', 1),
    ("gcTime: Number.POSITIVE_INFINITY", 1),
    ("qc.setQueryData<ReconciliationMap>(reconciliationKey", 4),
    ("Check now must return a definitive status", 1),
    ("Boolean(reconciliationByTarget[tool.preset_id])", 2),
    ("if (reconciliationByTarget[tool.preset_id]) return", 1),
    ("isDefinitiveReconciliation(status)", 2),
    ('typeof status.latest_version === "string"', 1),
    ('typeof status.update_available === "boolean"', 1),
):
    require_count(panel_relative, needle, expected)

command_block = re.search(
    r"const TOOL_COMMANDS = \{(?P<body>.*?)\} as const;", sources[control_relative], re.S
)
if command_block is None:
    die("browser endpoint command policy is missing")
browser_commands = {
    quoted or bare: value
    for quoted, bare, value in re.findall(
        r"^\s*(?:['\"]([^'\"]+)['\"]|([\w-]+)):\s*['\"]([^'\"]+)['\"],?\s*$",
        command_block.group("body"),
        re.M,
    )
}
expected_commands = {
    "claude-code": "claude", "codex": "codex", "opencode": "opencode", "aider": "aider", "shell": "bash",
}
if browser_commands != expected_commands:
    die(f"browser canonical tool policy changed: {browser_commands!r}")


# Endpoint execution must stay direct-argv, bounded, cancellation-owned, and non-logging.
host_tools_relative = "daemon/src/host_tools.rs"
host_control_relative = "daemon/src/host_control.rs"


def rust_matching_brace(source: str, opening: int) -> int:
    depth = 1
    index = opening + 1
    block_comment_depth = 0
    quote: str | None = None
    raw_hashes: int | None = None
    while index < len(source):
        if block_comment_depth:
            if source.startswith("/*", index):
                block_comment_depth += 1
                index += 2
            elif source.startswith("*/", index):
                block_comment_depth -= 1
                index += 2
            else:
                index += 1
            continue
        if raw_hashes is not None:
            closing = '"' + ('#' * raw_hashes)
            if source.startswith(closing, index):
                index += len(closing)
                raw_hashes = None
            else:
                index += 1
            continue
        if quote is not None:
            if source[index] == "\\":
                index += 2
            elif source[index] == quote:
                quote = None
                index += 1
            else:
                index += 1
            continue
        if source.startswith("//", index):
            newline = source.find("\n", index + 2)
            index = len(source) if newline < 0 else newline + 1
            continue
        if source.startswith("/*", index):
            block_comment_depth = 1
            index += 2
            continue
        raw = re.match(r"(?:br|r)(?P<hashes>#{0,255})\"", source[index:])
        if raw is not None:
            raw_hashes = len(raw.group("hashes"))
            index += raw.end()
            continue
        if source[index] == '"':
            quote = '"'
            index += 1
            continue
        # Treat only a complete Rust character literal as quoted. Lifetimes
        # such as 'static must remain ordinary source for brace accounting.
        char = re.match(r"'(?:\\.|[^'\\])'", source[index:])
        if char is not None:
            index += char.end()
            continue
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    die("unterminated #[cfg(test)] Rust module")


def rust_production_source(source: str) -> str:
    pattern = re.compile(r"#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*mod\s+\w+\s*\{")
    ranges: list[tuple[int, int]] = []
    for match in pattern.finditer(source):
        opening = source.find("{", match.start(), match.end())
        ranges.append((match.start(), rust_matching_brace(source, opening) + 1))
    for start, end in reversed(ranges):
        source = source[:start] + "\n" + source[end:]
    return source


expected_command_ast_hashes = {
    "daemon/src/cli.rs": "5dacbe4dd7415f7bdc2f6a6f2a37aaec914dc13a3863e7a27e5036474187ca09",
    "daemon/src/host_tools.rs": "4b4418ab7218e49c522013fb7c1b7a55d80fd1f5580512c8cc7ab7dd769cf8ef",
    "daemon/src/main.rs": "b96fa7f9a1ad9f52e4be6a98923ca643d37da2e0be0d97d487ec77d25b6f3e05",
    "daemon/src/run.rs": "8368b2552f9e556565126e077da47e2e755e222f4abfb659fcb29f1bad182b74",
    "daemon/src/worker_backend.rs": "7b3d600b3ba7e0553a405e50c3b35e9120b3f000198efd7ed90541fef8b99baa",
}
rust_exec_api = re.compile(
    r"\b(?:execl|execle|execlp|execv|execve|execveat|execvp|execvpe|fexecve|posix_spawn|posix_spawnp)\b"
    r"|\bSYS_execve(?:at)?\b"
    r"|\b(?:nix::)?libc::(?:system|popen)\b"
)
found_command_sources = {
    relative
    for relative, source in sources.items()
    if relative.startswith("daemon/src/")
    and relative.endswith(".rs")
    and (
        re.search(r"\bCommand\b", rust_production_source(source))
        or rust_exec_api.search(rust_production_source(source))
    )
}
if found_command_sources != expected_command_ast_hashes.keys():
    die(f"daemon process-launch source inventory changed: {sorted(found_command_sources)!r}")
for relative, expected_hash in expected_command_ast_hashes.items():
    production = rust_production_source(sources[relative])
    try:
        parsed = subprocess.run(
            [
                "rustc", "--edition", "2021", "--crate-type", "lib",
                "-Z", "unpretty=ast-tree", "-",
            ],
            input=production,
            text=True,
            capture_output=True,
            env={**os.environ, "RUSTC_BOOTSTRAP": "1"},
            check=False,
        )
    except OSError as exc:
        die(f"cannot parse reviewed Rust process-launch source {relative}: {exc}")
    if parsed.returncode != 0:
        die(f"cannot parse reviewed Rust process-launch source {relative}: {parsed.stderr.strip()}")
    found_hash = hashlib.sha256(parsed.stdout.encode()).hexdigest()
    if found_hash != expected_hash:
        die(
            f"reviewed Rust process-launch AST changed in {relative}: "
            f"expected {expected_hash}, found {found_hash}"
        )


daemon_shell_evals = Counter()
daemon_login_shell_symbols = Counter()
for relative, source in sources.items():
    if not relative.startswith("daemon/src/") or not relative.endswith(".rs"):
        continue
    production = rust_production_source(source)
    if relative != host_control_relative and re.search(r"['\"]tool\.(?:check|install)['\"]", production):
        die(f"endpoint operation dispatch moved outside host_control.rs into {relative}")
    shell_evals = re.findall(
        r"Command\s*::\s*new\s*\(\s*['\"](?:ba)?sh['\"]\s*,?\s*\).*?\.arg\s*\(\s*['\"]-c['\"]\s*,?\s*\)",
        production,
        re.S,
    )
    if shell_evals:
        daemon_shell_evals[relative] += len(shell_evals)
    for symbol in (
        "resolved_command_env", "shell_path_entries", "probe_shell_path", "candidate_shells",
    ):
        count = len(re.findall(rf"\b{symbol}\b", production))
        if count:
            daemon_login_shell_symbols[(relative, symbol)] += count
    sensitivity_source = re.sub(r"^\s*mod\s+host_tools\s*;\s*$", "", production, flags=re.M)
    sensitive = re.search(r"HostTool|host_tool|tool\.(?:check|install)|TOOL_", sensitivity_source)
    if not sensitive:
        continue
    if re.search(r"\b(?:run_shell|shell_command|eval_command)\b", production):
        die(f"endpoint tool path delegates to shell evaluation in {relative}")
    if relative != "daemon/src/run.rs" and re.search(
        r"\b(?:tracing::|println!|eprintln!)", production
    ):
        die(f"endpoint tool path logs protected detail in {relative}")

# The only production shell evaluation is the exact HOST-03B compatibility
# runner. Scanning every Rust file prevents a generic dependency/helper from
# bypassing a name-based host-tool check.
if daemon_shell_evals != Counter({"daemon/src/run.rs": 2}):
    die(f"daemon production shell evaluation inventory changed: {daemon_shell_evals!r}")
expected_login_shell_symbols = Counter({
    ("daemon/src/run.rs", "resolved_command_env"): 3,
    ("daemon/src/run.rs", "shell_path_entries"): 2,
    ("daemon/src/run.rs", "probe_shell_path"): 2,
    ("daemon/src/run.rs", "candidate_shells"): 2,
})
if daemon_login_shell_symbols != expected_login_shell_symbols:
    die(f"daemon login-shell dependency inventory changed: {daemon_login_shell_symbols!r}")
run_production = rust_production_source(sources["daemon/src/run.rs"])
if run_production.count("async fn run_shell_capture(") != 1:
    die("HOST-03B daemon shell compatibility scope changed in daemon/src/run.rs")

policy_source = sources[host_tools_relative].split("fn policy_for", 1)[0]
daemon_tools = re.findall(r"\btool:\s*['\"]([^'\"]+)['\"]", policy_source)
if daemon_tools != ["claude-code", "codex", "opencode", "aider", "shell"]:
    die(f"daemon direct-argv policy changed or is non-canonical: {daemon_tools!r}")
for needle in (
    "struct HostToolOperations",
    "struct CancelOperationOnDrop",
    "async fn run_owned",
    "async fn finish_tail",
):
    require_count(host_tools_relative, needle)
for needle in ("wait_for_idle_until", "child.wait().await"):
    require_present(host_tools_relative, needle)
host_tools_production = rust_production_source(sources[host_tools_relative])
for forbidden in (
    "resolved_command_env", "shell_path_entries", "probe_shell_path", "candidate_shells",
):
    if forbidden in host_tools_production:
        die(f"endpoint host-tools path regained a login-shell dependency: {forbidden}")
for needle, expected in (
    ("fn endpoint_command_env()", 1),
    ("status.error.is_none()", 1),
    ("status.version.is_some()", 2),
    ("status.latest_version.is_some()", 2),
    ("status.update_available == Some(false)", 1),
):
    require_count(host_tools_relative, needle, expected)
for needle in (
    "tool_operations: Arc<HostToolOperations>",
    "tool_operations.wait_for_idle_until(deadline)",
):
    require_count(host_control_relative, needle)

preset_source = sources["server/spawn_server/presets.py"]
if not re.search(
    r"['\"]name['\"]:\s*['\"]aider-sonnet['\"].*?['\"]agent_kind['\"]:\s*['\"]aider['\"]",
    preset_source,
    re.S,
):
    die("server Aider preset no longer discloses canonical agent_kind='aider'")
PY

  node - "$repo_root" "$inventory" "$(cd "$(dirname "$script_path")/.." && pwd)/web/node_modules/typescript/lib/typescript.js" <<'JS'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2]);
const inventoryPath = process.argv[3];
const typescriptPath = process.argv[4];
let ts;
try {
  ts = require(typescriptPath);
} catch (error) {
  throw new Error(`host-tool-e2e-boundary: cannot load TypeScript parser: ${error}`);
}

function die(message) {
  throw new Error(`host-tool-e2e-boundary: ${message}`);
}

const relativePaths = fs
  .readFileSync(inventoryPath, "utf8")
  .split(/\r?\n/)
  .map((value) => value.trim().replaceAll("\\", "/"))
  .filter(
    (relative) =>
      relative.startsWith("web/src/") &&
      /\.(?:ts|tsx)$/.test(relative) &&
      !/\.(?:test|spec)\.[^.]+$/.test(relative),
  );
const files = new Map();
for (const relative of relativePaths) {
  const sourceText = fs.readFileSync(path.join(root, relative), "utf8");
  const sourceFile = ts.createSourceFile(
    relative,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  if (sourceFile.parseDiagnostics.length > 0) {
    die(`cannot parse browser production source ${relative}`);
  }
  files.set(relative, sourceFile);
}

const apiRelative = "web/src/lib/api.ts";
const controlRelative = "web/src/lib/hostControl.ts";
const panelRelative = "web/src/components/hosts/HostToolsPanel.tsx";
for (const required of [apiRelative, controlRelative, panelRelative]) {
  if (!files.has(required)) die(`required browser source is missing: ${required}`);
}

function walk(node, visitor) {
  visitor(node);
  ts.forEachChild(node, (child) => walk(child, visitor));
}

function collectBindings(sourceFile) {
  const bindings = new Map();
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    walk(sourceFile, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
      const value = staticString(node.initializer, bindings) ?? staticArray(node.initializer, bindings);
      if (
        value !== null &&
        JSON.stringify(bindings.get(node.name.text)) !== JSON.stringify(value)
      ) {
        bindings.set(node.name.text, value);
        changed = true;
      }
    });
    if (!changed) break;
  }
  return bindings;
}

function staticString(node, bindings) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const value = bindings.get(node.text);
    return typeof value === "string" ? value : null;
  }
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression, bindings);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return staticString(node.expression, bindings);
  }
  if (ts.isSatisfiesExpression?.(node)) return staticString(node.expression, bindings);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left, bindings);
    const right = staticString(node.right, bindings);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticString(span.expression, bindings);
      if (expression === null) return null;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join"
  ) {
    const separator = node.arguments.length === 0 ? "" : staticString(node.arguments[0], bindings);
    const values = staticArray(node.expression.expression, bindings);
    return separator === null || values === null ? null : values.join(separator);
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "String" &&
    node.expression.name.text === "fromCharCode" &&
    node.arguments.every((argument) => ts.isNumericLiteral(argument))
  ) {
    return String.fromCharCode(...node.arguments.map((argument) => Number(argument.text)));
  }
  return null;
}

function staticArray(node, bindings) {
  if (!node) return null;
  if (ts.isIdentifier(node)) {
    const value = bindings.get(node.text);
    return Array.isArray(value) ? value : null;
  }
  if (ts.isParenthesizedExpression(node)) return staticArray(node.expression, bindings);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return staticArray(node.expression, bindings);
  }
  if (ts.isSatisfiesExpression?.(node)) return staticArray(node.expression, bindings);
  if (!ts.isArrayLiteralExpression(node)) return null;
  const values = [];
  for (const element of node.elements) {
    if (ts.isSpreadElement(element)) {
      const spread = staticArray(element.expression, bindings);
      if (spread === null) return null;
      values.push(...spread);
      continue;
    }
    const value = staticString(element, bindings);
    if (value === null) return null;
    values.push(value);
  }
  return values;
}

function staticLaunchValue(node, bindings) {
  const string = staticString(node, bindings);
  if (string !== null) return [string];
  return staticArray(node, bindings);
}

const printer = ts.createPrinter({ removeComments: true });
function structuralHash(node, sourceFile) {
  return crypto
    .createHash("sha256")
    .update(printer.printNode(ts.EmitHint.Unspecified, node, sourceFile))
    .digest("hex");
}
function propertyName(node, sourceFile, bindings) {
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  if (ts.isComputedPropertyName(node.name)) return staticString(node.name.expression, bindings);
  return node.name?.getText(sourceFile) ?? null;
}
function requireHash(label, node, sourceFile, expected) {
  if (!node) die(`reviewed browser structure is missing: ${label}`);
  const found = structuralHash(node, sourceFile);
  if (found !== expected) die(`reviewed browser AST changed for ${label}: expected ${expected}, found ${found}`);
}

// Freeze the legacy API surface structurally. Comments, unreachable sentinels,
// aliases, and computed property names cannot satisfy this inventory.
const apiFile = files.get(apiRelative);
const apiBindings = collectBindings(apiFile);
let hostsDeclaration;
walk(apiFile, (node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "hosts") {
    if (hostsDeclaration) die("api.ts defines hosts more than once");
    hostsDeclaration = node;
  }
});
if (!hostsDeclaration || !hostsDeclaration.initializer || !ts.isObjectLiteralExpression(hostsDeclaration.initializer)) {
  die("api.ts hosts object is missing or computed");
}
const hostProperties = new Map();
for (const property of hostsDeclaration.initializer.properties) {
  const name = propertyName(property, apiFile, apiBindings);
  if (!name || hostProperties.has(name)) die("api.ts hosts object has a computed or duplicate property");
  hostProperties.set(name, property);
}
const expectedHostKeys = ["list", "get", "rename", "remove", "tools", "toolTargets", "installTool", "updateToolPolicy"];
if (JSON.stringify([...hostProperties.keys()]) !== JSON.stringify(expectedHostKeys)) {
  die(`api.ts hosts property inventory changed: ${JSON.stringify([...hostProperties.keys()])}`);
}
for (const [name, expected] of Object.entries({
  tools: "d548a191bf1d1c5038847f9da02d1326f73eb4dd988d0c1fe13f094e6b034898",
  toolTargets: "8d711092e496dcbc59efc65551579b09afe17ecc401821d5a94781984f4c1db1",
  installTool: "18ffe0e4da1222a19ee5e186ab69d0d53a258ca650698460ab9bb66273fcf770",
  updateToolPolicy: "131a2d0355019697efd8e8bb2e2e0137cc882fd24bb5b3e16600eef83fda6f13",
})) requireHash(`api.hosts.${name}`, hostProperties.get(name), apiFile, expected);

for (const [relative, sourceFile] of files) {
  const bindings = collectBindings(sourceFile);
  const aliases = new Set(["hosts"]);
  const launchAliases = new Set(["spawn", "exec", "execFile"]);
  const launchNamespaces = new Set();
  walk(sourceFile, (node) => {
    if (ts.isImportSpecifier(node) && (node.propertyName?.text ?? node.name.text) === "hosts") aliases.add(node.name.text);
    if (
      ts.isImportSpecifier(node) &&
      launchAliases.has(node.propertyName?.text ?? node.name.text)
    ) {
      launchAliases.add(node.name.text);
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      ["child_process", "node:child_process"].includes(node.moduleSpecifier.text) &&
      node.importClause?.namedBindings &&
      ts.isNamespaceImport(node.importClause.namedBindings)
    ) {
      launchNamespaces.add(node.importClause.namedBindings.name.text);
    }
  });
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    walk(sourceFile, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        aliases.has(node.initializer.text) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        launchAliases.has(node.initializer.text) &&
        !launchAliases.has(node.name.text)
      ) {
        launchAliases.add(node.name.text);
        changed = true;
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        launchNamespaces.has(node.initializer.text) &&
        !launchNamespaces.has(node.name.text)
      ) {
        launchNamespaces.add(node.name.text);
        changed = true;
      }
    });
    if (!changed) break;
  }
  walk(sourceFile, (node) => {
    const computed = staticString(node, bindings);
    if (relative !== controlRelative && (computed === "tool.check" || computed === "tool.install")) {
      die(`endpoint-only tool operation escaped hostControl.ts in ${relative}`);
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && ts.isIdentifier(node.initializer) && aliases.has(node.initializer.text)) {
      die(`browser production destructures the hosts API in ${relative}`);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) {
      if (["tools", "installTool"].includes(node.name.text) && relative !== apiRelative) {
        die(`browser production references legacy hosts.${node.name.text} in ${relative}`);
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && aliases.has(node.expression.text)) {
      die(`browser production uses computed hosts API access in ${relative}`);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const calleeName = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : "";
      if (calleeName === "eval" || calleeName === "Function") {
        die(`browser production contains dynamic evaluation in ${relative}`);
      }
      const processLaunch =
        (ts.isIdentifier(callee) && launchAliases.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          launchNamespaces.has(callee.expression.text) &&
          launchAliases.has(callee.name.text));
      if (processLaunch) {
        const launchStrings = [];
        for (const argument of node.arguments ?? []) {
          const value = staticLaunchValue(argument, bindings);
          if (value === null) {
            die(`browser production contains an unresolved process-launch argument in ${relative}`);
          }
          launchStrings.push(...value);
        }
        if (
          launchStrings.some((value) => value === "sh" || value === "bash") &&
          launchStrings.includes("-c")
        ) {
          die(`browser production contains shell evaluation in ${relative}`);
        }
      }
      const strings = [];
      for (const argument of node.arguments ?? []) {
        walk(argument, (part) => {
          const value = staticString(part, bindings);
          if (value !== null) strings.push(value);
        });
      }
      if (strings.some((value) => value === "sh" || value === "bash") && strings.includes("-c")) {
        die(`browser production contains shell evaluation in ${relative}`);
      }
    }
  });
}

function namedNodes(sourceFile) {
  const result = new Map();
  walk(sourceFile, (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name) {
      const name = node.name.getText(sourceFile);
      if (!result.has(name)) result.set(name, node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !result.has(node.name.text)) {
      result.set(node.name.text, node);
    }
  });
  return result;
}
const panelFile = files.get(panelRelative);
const panelNodes = namedNodes(panelFile);
for (const [name, expected] of Object.entries({
  HostToolsPanel: "bac5a95fa42b9fc28039cb41243bfaa9d6b0963bb9d06f35dc3ce09a7cb36fca",
  reconciliationQ: "6aefd5966c2f6ee70ea4d77e52499f6050a07a1ff626c75ed7c9279562a1d4e5",
  installM: "f8c298d7c32c1ca420dc417ce0ef503e5b0c5823f97a08c19a6cfee24901e449",
  reconcileM: "35c8d86ff89866ef5f58e0d74c59b1b7c682d7b682404fe4c6ae649eb9663c38",
  authoritativeTarget: "886e79c530a5aa3b270d29f89f16c7de843e1aa30de4b6bafa2a0a8b16829f6e",
  isDefinitiveReconciliation: "91bd98e42a127af99f0c52d5abbbc10cf8820f954e460a94358f5a492bb3527b",
  sameTarget: "d51a557bdd8d1c51b9f485902f7039cac6c902fd9e5bc295765c920ea4fc0137",
})) requireHash(`HostToolsPanel.${name}`, panelNodes.get(name), panelFile, expected);

const controlFile = files.get(controlRelative);
const controlNodes = namedNodes(controlFile);
for (const [name, expected] of Object.entries({
  checkTools: "0c8e4ff7c8eaf7cdcd532b82ffc1d7229f500d8d28d6ef91ee2cf5ee02ef49dc",
  installTool: "56f663efe01395322537c2bdb8ccc26db4df7ccd490ba5bb23a6e21359b10284",
  parseToolStatus: "bafce8efc628f2bf58975b87c87add95b3096f6648d1c21814bb607ed6249c36",
  parseToolInstallResult: "633146e70ea7cfaf14835c398f01f3abcd36c6ba9bf22757fbf48c7b414d5164",
  parseNumericVersion: "dd65dd03d102bd6b66050843ad83ed79d60c09fe150ca14a2aa9d9a8c813685d",
  versionSuggestsUpdate: "eba099db5d0e73eb02efbde29a53392f5bbc6634e32e0267a97ebd62a2aa8866",
})) requireHash(`hostControl.${name}`, controlNodes.get(name), controlFile, expected);

function requestOperation(method) {
  const operations = [];
  walk(method, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "request"
    ) {
      operations.push(staticString(node.arguments[0], collectBindings(controlFile)));
    }
  });
  return operations;
}
if (JSON.stringify(requestOperation(controlNodes.get("checkTools"))) !== JSON.stringify(["tool.check"])) {
  die("HostControlClient.checkTools no longer performs the exact tool.check request");
}
if (JSON.stringify(requestOperation(controlNodes.get("installTool"))) !== JSON.stringify(["tool.install"])) {
  die("HostControlClient.installTool no longer performs the exact tool.install request");
}

let commandPolicy;
walk(controlFile, (node) => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "TOOL_COMMANDS") {
    commandPolicy = node.initializer;
  }
});
if (ts.isAsExpression(commandPolicy)) commandPolicy = commandPolicy.expression;
if (!commandPolicy || !ts.isObjectLiteralExpression(commandPolicy)) die("browser canonical tool policy is missing");
const commands = {};
for (const property of commandPolicy.properties) {
  if (!ts.isPropertyAssignment(property)) die("browser canonical tool policy contains a computed member");
  const name = propertyName(property, controlFile, collectBindings(controlFile));
  const value = staticString(property.initializer, collectBindings(controlFile));
  if (!name || value === null || Object.hasOwn(commands, name)) die("browser canonical tool policy is dynamic");
  commands[name] = value;
}
const expectedCommands = { "claude-code": "claude", codex: "codex", opencode: "opencode", aider: "aider", shell: "bash" };
if (JSON.stringify(commands) !== JSON.stringify(expectedCommands)) {
  die(`browser canonical tool policy changed: ${JSON.stringify(commands)}`);
}
JS

  printf '%s\n' "host-tool-e2e-boundary: passed"
}

run_self_test() {
  require_tool git
  require_tool python3
  require_tool cp
  require_tool mktemp

  local temp base case_dir fake_rg
  temp="$(mktemp -d)"
  trap 'rm -rf "${temp:-}"' EXIT
  base="$temp/base"
  mkdir -p "$base/server" "$base/daemon" "$base/web"
  cp -R "$repo_root/server/spawn_server" "$base/server/spawn_server"
  cp -R "$repo_root/daemon/src" "$base/daemon/src"
  cp -R "$repo_root/web/src" "$base/web/src"
  git -C "$base" init -q
  git -C "$base" add server/spawn_server daemon/src web/src

  HOST_TOOL_E2E_ROOT="$base" "$script_path" >/dev/null \
    || fail "self-test baseline was rejected"

  expect_rejected() {
    local label="$1"
    if HOST_TOOL_E2E_ROOT="$case_dir" "$script_path" >"$temp/$label.out" 2>&1; then
      fail "self-test accepted adversarial case: $label"
    fi
  }

  new_case() {
    case_dir="$temp/$1"
    cp -R "$base" "$case_dir"
  }

  new_case server-moved-helper
  python3 - "$case_dir/server/spawn_server/routes/tool_shadow.py" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''async def leak_tool_metadata(preset, log, Response, get_backend):
    log.warning(preset.default_argv)
    await get_backend().publish("tool", preset.install)
    return Response({"command": preset.default_argv, "output": preset.output})
''')
PY
  expect_rejected server-moved-helper

  new_case server-generic-helper
  python3 - "$case_dir/server/spawn_server/routes/relay.py" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''def relay(value):
    return {"argv": value.default_argv, "installer": value.install}
''')
PY
  expect_rejected server-generic-helper

  new_case server-extra-allowed-literal
  python3 - "$case_dir/server/spawn_server/ws/broker.py" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace(
    '"type": "host.tools.install",',
    '"duplicate": "host.tools.install",\n                "type": "host.tools.install",',
    1,
))
PY
  expect_rejected server-extra-allowed-literal

  new_case server-extra-route
  python3 - "$case_dir/server/spawn_server/routes/hosts.py" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text() + '\n@router.get("/{host_id}/tool-detail")\nasync def extra_tool_detail():\n    return {}\n')
PY
  expect_rejected server-extra-route

  new_case server-computed-route
  python3 - "$case_dir/server/spawn_server/routes/hosts.py" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text() + '''
DETAIL_ROUTE = "/{host_id}/to" + "ol-detail"
@router.get(DETAIL_ROUTE)
async def computed_tool_detail():
    return {}
''')
PY
  expect_rejected server-computed-route

  new_case server-endpoint-operation
  printf '%s\n' 'ENDPOINT_TOOL_OPERATION = "tool.install"' \
    >>"$case_dir/server/spawn_server/routes/hosts.py"
  expect_rejected server-endpoint-operation

  new_case server-encoded-endpoint-operation
  printf '%s\n' 'ENDPOINT = "".join([chr(116), chr(111), chr(111), chr(108), ".install"])' \
    >>"$case_dir/server/spawn_server/routes/hosts.py"
  expect_rejected server-encoded-endpoint-operation

  new_case server-protected-subscript
  printf '%s\n' 'def relay(value): return value["default_argv"]' \
    >"$case_dir/server/spawn_server/routes/relay.py"
  expect_rejected server-protected-subscript

  new_case server-vars-access
  printf '%s\n' 'def relay(value): return vars(value).get("install")' \
    >"$case_dir/server/spawn_server/routes/relay.py"
  expect_rejected server-vars-access

  new_case server-attrgetter-access
  printf '%s\n' 'import operator' 'def relay(value): return operator.attrgetter("install")(value)' \
    >"$case_dir/server/spawn_server/routes/relay.py"
  expect_rejected server-attrgetter-access

  new_case web-legacy-alias
  printf '%s\n' 'export const hostToolFallback = hosts["installTool"];' \
    >"$case_dir/web/src/lib/hostToolFallback.ts"
  expect_rejected web-legacy-alias

  new_case web-direct-property-alias
  printf '%s\n' 'export const relay = hosts.installTool;' \
    >"$case_dir/web/src/lib/relay.ts"
  expect_rejected web-direct-property-alias

  new_case web-computed-property-alias
  printf '%s\n' 'export const relay = hosts["install" + "Tool"];' \
    >"$case_dir/web/src/lib/relay.ts"
  expect_rejected web-computed-property-alias

  new_case web-transitive-property-alias
  printf '%s\n' 'const apiAlias = hosts; export const relay = apiAlias.installTool;' \
    >"$case_dir/web/src/lib/relay.ts"
  expect_rejected web-transitive-property-alias

  new_case web-legacy-route
  printf '%s\n' 'export const hostToolFallback = (id: string) => fetch(`/api/hosts/${id}/tools`);' \
    >"$case_dir/web/src/lib/hostToolFallback.ts"
  expect_rejected web-legacy-route

  new_case web-computed-route
  printf '%s\n' \
    'export const relay = (id: string) => fetch(["/api/hosts/", id, "/to", "ols"].join(""));' \
    >"$case_dir/web/src/lib/relay.ts"
  expect_rejected web-computed-route

  new_case web-computed-operation
  printf '%s\n' 'export const relay = "tool." + "install";' \
    >"$case_dir/web/src/lib/relay.ts"
  expect_rejected web-computed-operation

  new_case web-encoded-operation
  printf '%s\n' \
    'export const relay = String.fromCharCode(116, 111, 111, 108, 46, 105, 110, 115, 116, 97, 108, 108);' \
    >"$case_dir/web/src/lib/relay.ts"
  expect_rejected web-encoded-operation

  new_case web-shell-fallback
  printf '%s\n' 'export const hostToolFallback = () => spawn(["sh", "-c", "npm install"])' \
    >"$case_dir/web/src/lib/hostToolFallback.ts"
  expect_rejected web-shell-fallback

  new_case web-generic-shell-helper
  printf '%s\n' 'export const run = () => spawn(["sh", "-c", "echo unsafe"])' \
    >"$case_dir/web/src/lib/worker.ts"
  expect_rejected web-generic-shell-helper

  new_case web-encoded-shell-helper
  printf '%s\n' \
    'const shell = ["s", "h"].join(""); const flag = String.fromCharCode(45, 99); export const run = () => spawn([shell, flag, "echo unsafe"]);' \
    >"$case_dir/web/src/lib/worker.ts"
  expect_rejected web-encoded-shell-helper

  new_case web-array-alias-shell-helper
  printf '%s\n' \
    'const shellParts = ["s", "h"]; const shellAlias = shellParts; const flagParts = ["-", "c"]; const flagAlias = flagParts; const launch = spawn; function dormant() { return launch([shellAlias.join(""), flagAlias.join(""), "echo unsafe"]); }' \
    >"$case_dir/web/src/lib/worker.ts"
  expect_rejected web-array-alias-shell-helper

  new_case web-unresolved-spawn-helper
  printf '%s\n' \
    'declare function buildArgs(): string[]; export const run = () => spawn(buildArgs());' \
    >"$case_dir/web/src/lib/worker.ts"
  expect_rejected web-unresolved-spawn-helper

  new_case daemon-multiline-shell
  python3 - "$case_dir/daemon/src/host_tool_fallback.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn host_tool_fallback() {
    Command::new(
        "bash",
    )
    .arg(
        "-c",
    );
}
''')
PY
  expect_rejected daemon-multiline-shell

  new_case daemon-generic-shell-helper
  python3 - "$case_dir/daemon/src/helpers.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn run() {
    Command::new("sh").arg("-c");
}
''')
PY
  expect_rejected daemon-generic-shell-helper

  new_case daemon-command-alias
  python3 - "$case_dir/daemon/src/helpers.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''use tokio::process::Command as Runner;
fn run() { Runner::new("sh").args(["-c", "echo unsafe"]); }
''')
PY
  expect_rejected daemon-command-alias

  new_case daemon-raw-exec
  python3 - "$case_dir/daemon/src/raw_exec.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn dormant() {
    unsafe { nix::libc::execl(std::ptr::null(), std::ptr::null()); }
}
''')
PY
  expect_rejected daemon-raw-exec

  new_case daemon-args-shell
  python3 - "$case_dir/daemon/src/helpers.rs" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).write_text('''fn run() {
    Command::new("sh").args(["-c", "echo unsafe"]);
}
''')
PY
  expect_rejected daemon-args-shell

  new_case daemon-computed-shell
  python3 - "$case_dir/daemon/src/host_tools.rs" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace(
    'Command::new(program)',
    'Command::new(["s", "h"].concat()).args(["-c", program])',
    1,
))
PY
  expect_rejected daemon-computed-shell

  new_case daemon-login-shell-dependency
  printf '%s\n' \
    'async fn load_environment() { let _ = crate::run::resolved_command_env().await; }' \
    >>"$case_dir/daemon/src/host_tools.rs"
  expect_rejected daemon-login-shell-dependency

  new_case daemon-generic-login-shell-dependency
  printf '%s\n' \
    'async fn load_environment() { let _ = crate::run::resolved_command_env().await; }' \
    >"$case_dir/daemon/src/helpers.rs"
  expect_rejected daemon-generic-login-shell-dependency

  new_case missing-sentinel
  python3 - "$case_dir/web/src/components/hosts/HostToolsPanel.tsx" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace("client.installTool(", "client['installTool'](", 1))
PY
  expect_rejected missing-sentinel

  new_case dead-sentinel-cannot-mask-change
  python3 - "$case_dir/web/src/components/hosts/HostToolsPanel.tsx" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
source = p.read_text().replace("client.installTool(", "client['installTool'](", 1)
p.write_text(source + '\n// client.installTool( dead sentinel must not satisfy the guard\n')
PY
  expect_rejected dead-sentinel-cannot-mask-change

  new_case missing-reconciliation-sentinel
  python3 - "$case_dir/web/src/components/hosts/HostToolsPanel.tsx" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace('"host-tool-reconciliation"', '"temporary-result"', 1))
PY
  expect_rejected missing-reconciliation-sentinel

  new_case rg-failure
  fake_rg="$temp/rg-broken"
  printf '%s\n' '#!/usr/bin/env bash' 'exit 2' >"$fake_rg"
  chmod +x "$fake_rg"
  if HOST_TOOL_E2E_ROOT="$case_dir" HOST_TOOL_E2E_RG="$fake_rg" \
    "$script_path" >"$temp/rg-failure.out" 2>&1; then
    fail "self-test accepted a failing inventory/search tool"
  fi

  printf '%s\n' "host-tool-e2e-boundary self-test: passed"
}

case "${1:-}" in
  "") run_guard ;;
  --self-test) run_self_test ;;
  *) fail "usage: $0 [--self-test]" ;;
esac
