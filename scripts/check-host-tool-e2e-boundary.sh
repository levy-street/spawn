#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if rg -n "[\"']tool\\.(check|install)[\"']" server/spawn_server; then
  printf '%s\n' "server production code names an endpoint-only tool operation" >&2
  exit 1
fi

if rg -n 'hosts\.(tools|installTool)\(' web/src/components/hosts/HostToolsPanel.tsx; then
  printf '%s\n' "interactive tool UI calls the legacy content route" >&2
  exit 1
fi

if sed -n '1,/^#\[cfg(test)\]/p' daemon/src/host_tools.rs \
  | rg -n "(bash|sh).*-[cC]|\\.arg\\([\"']-c[\"']\\)|run_shell"; then
  printf '%s\n' "endpoint interactive tool policy contains shell evaluation" >&2
  exit 1
fi

if sed -n '1,/^#\[cfg(test)\]/p' daemon/src/host_tools.rs \
  | rg -n 'tracing::|println!|eprintln!'; then
  printf '%s\n' "endpoint interactive tool path logs protected detail" >&2
  exit 1
fi

python3 - <<'PY'
import ast
from pathlib import Path

path = Path("server/spawn_server/routes/hosts.py")
tree = ast.parse(path.read_text())
function = next(
    node
    for node in tree.body
    if isinstance(node, ast.AsyncFunctionDef) and node.name == "list_host_tool_metadata"
)
forbidden_attributes = {
    "default_argv",
    "install",
    "last_auto_update_error",
    "command",
    "path",
    "version",
    "output",
    "error",
}
attributes = {node.attr for node in ast.walk(function) if isinstance(node, ast.Attribute)}
names = {node.id for node in ast.walk(function) if isinstance(node, ast.Name)}
leaks = sorted(attributes & forbidden_attributes)
if leaks:
    raise SystemExit(f"metadata route reads protected attributes: {leaks}")
if "get_broker" in names or "log" in names:
    raise SystemExit("metadata route touches a server broker or logger")
PY

for required in \
  'hosts.toolTargets(' \
  'client.checkTools(' \
  'client.installTool(' \
  '"tool.check"' \
  '"tool.install"'; do
  if ! rg -Fq "$required" web/src/components/hosts/HostToolsPanel.tsx web/src/lib/hostControl.ts; then
    printf 'interactive E2E tool boundary is missing %s\n' "$required" >&2
    exit 1
  fi
done

printf '%s\n' "host-tool-e2e-boundary: passed"
