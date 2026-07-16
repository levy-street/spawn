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
  require_tool python3
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
import re
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

for relative, tree in server_trees.items():
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value in {"tool.check", "tool.install"}:
                die(f"server production code names endpoint-only operation in {relative}:{node.lineno}")

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
            if not decorator.args or not isinstance(decorator.args[0], ast.Constant):
                continue
            route = decorator.args[0].value
            if not isinstance(route, str) or "tool" not in route.lower():
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

allowed_legacy_string_scopes = {
    "server/spawn_server/ws/owner_dispatch.py": {"<module>"},
    "server/spawn_server/ws/broker.py": {
        "request_tool_check", "resolve_tool_check", "request_tool_install", "resolve_tool_install",
    },
    "server/spawn_server/ws/daemon.py": {"daemon_ws"},
}


class LegacyStringVisitor(ast.NodeVisitor):
    def __init__(self, relative: str) -> None:
        self.relative = relative
        self.scope = ["<module>"]

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.scope.append(node.name)
        self.generic_visit(node)
        self.scope.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Constant(self, node: ast.Constant) -> None:
        if isinstance(node.value, str) and node.value.startswith("host.tools."):
            if self.scope[-1] not in allowed_legacy_string_scopes.get(self.relative, set()):
                die(f"legacy server tool frame escaped its HOST-03B scope at {self.relative}:{node.lineno}")


for relative, tree in server_trees.items():
    LegacyStringVisitor(relative).visit(tree)


# Browser production has one public-metadata call and direct E2E check/install calls.
panel_relative = "web/src/components/hosts/HostToolsPanel.tsx"
control_relative = "web/src/lib/hostControl.ts"
api_relative = "web/src/lib/api.ts"
for needle in ("hosts.toolTargets(", "client.checkTools(", "client.installTool("):
    require_count(panel_relative, needle)
for relative, source in sources.items():
    if not relative.startswith("web/src/"):
        continue
    if re.search(r"\bhosts\s*\.\s*(?:tools|installTool)\s*\(", source):
        die(f"browser production calls a HOST-03B content helper in {relative}")
    if re.search(r"\bhosts\s*\[\s*['\"](?:tools|installTool)['\"]\s*\]", source):
        die(f"browser production aliases a HOST-03B content helper in {relative}")
    if re.search(r"\{[^}]*\b(?:tools|installTool)\b[^}]*\}\s*=\s*hosts\b", source, re.S):
        die(f"browser production destructures a HOST-03B content helper in {relative}")
    if relative != control_relative and re.search(r"['\"]tool\.(?:check|install)['\"]", source):
        die(f"endpoint-only tool operation moved outside hostControl.ts into {relative}")

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
all_web = "\n".join(source for relative, source in sources.items() if relative.startswith("web/src/"))
if all_web.count("/tool-targets`") != 1 or sources[api_relative].count("/tool-targets`") != 1:
    die("public tool metadata route must occur exactly once in api.ts")

for relative, source in sources.items():
    if not relative.startswith("web/src/"):
        continue
    sensitive = re.search(r"host.?tool|tool\.(?:check|install)|TOOL_(?:COMMANDS|INSTALL_ARGV)", source, re.I)
    if not sensitive:
        continue
    if re.search(r"['\"](?:ba)?sh['\"]\s*,\s*['\"]-c['\"]", source, re.S):
        die(f"browser tool path contains shell evaluation in {relative}")
    if re.search(r"\b(?:eval|Function)\s*\(", source):
        die(f"browser tool path contains dynamic evaluation in {relative}")

require_count(control_relative, "async checkTools(")
require_count(control_relative, "async installTool(")
require_count(control_relative, '"tool.check",')
if sources[control_relative].count('"tool.install"') < 4:
    die("hostControl.ts lost the bound install operation/cancellation sentinels")
require_count(control_relative, "TOOL_CANCEL_RESPONSE_TIMEOUT_MS", 2)
require_count(panel_relative, "new AbortController()")
require_count(panel_relative, "Check the tool status before retrying", 2)

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


for relative, source in sources.items():
    if not relative.startswith("daemon/src/") or not relative.endswith(".rs"):
        continue
    production = rust_production_source(source)
    if relative != host_control_relative and re.search(r"['\"]tool\.(?:check|install)['\"]", production):
        die(f"endpoint operation dispatch moved outside host_control.rs into {relative}")
    sensitivity_source = re.sub(r"^\s*mod\s+host_tools\s*;\s*$", "", production, flags=re.M)
    sensitive = re.search(
        r"HostTool|host_tool|tool\.(?:check|install)|TOOL_", sensitivity_source
    )
    if not sensitive:
        continue
    shell_evals = re.findall(
        r"Command\s*::\s*new\s*\(\s*['\"](?:ba)?sh['\"]\s*,?\s*\).*?\.arg\s*\(\s*['\"]-c['\"]\s*,?\s*\)",
        production,
        re.S,
    )
    if relative == "daemon/src/run.rs":
        # HOST-03B compatibility: the old server-mediated check/install and
        # auto-update runner remain until their separate retirement task.
        if len(shell_evals) != 2 or production.count("async fn run_shell_capture(") != 1:
            die("HOST-03B daemon shell compatibility scope changed in daemon/src/run.rs")
        continue
    if shell_evals or re.search(r"\b(?:run_shell|shell_command|eval_command)\b", production):
        die(f"endpoint tool path contains shell evaluation in {relative}")
    if re.search(r"\b(?:tracing::|println!|eprintln!)", production):
        die(f"endpoint tool path logs protected detail in {relative}")

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

  new_case server-extra-route
  python3 - "$case_dir/server/spawn_server/routes/hosts.py" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text() + '\n@router.get("/{host_id}/tool-detail")\nasync def extra_tool_detail():\n    return {}\n')
PY
  expect_rejected server-extra-route

  new_case server-endpoint-operation
  printf '%s\n' 'ENDPOINT_TOOL_OPERATION = "tool.install"' \
    >>"$case_dir/server/spawn_server/routes/hosts.py"
  expect_rejected server-endpoint-operation

  new_case web-legacy-alias
  printf '%s\n' 'export const hostToolFallback = hosts["installTool"];' \
    >"$case_dir/web/src/lib/hostToolFallback.ts"
  expect_rejected web-legacy-alias

  new_case web-legacy-route
  printf '%s\n' 'export const hostToolFallback = (id: string) => fetch(`/api/hosts/${id}/tools`);' \
    >"$case_dir/web/src/lib/hostToolFallback.ts"
  expect_rejected web-legacy-route

  new_case web-shell-fallback
  printf '%s\n' 'export const hostToolFallback = () => spawn(["sh", "-c", "npm install"])' \
    >"$case_dir/web/src/lib/hostToolFallback.ts"
  expect_rejected web-shell-fallback

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

  new_case missing-sentinel
  python3 - "$case_dir/web/src/components/hosts/HostToolsPanel.tsx" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace("client.installTool(", "client['installTool'](", 1))
PY
  expect_rejected missing-sentinel

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
