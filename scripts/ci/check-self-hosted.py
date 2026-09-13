#!/usr/bin/env python3
"""Fail when a workflow can schedule a job on an unapproved runner pool."""

import ast
import json
from pathlib import Path
import re

ROLES = {
    "Linux": {"spawn-linux-build", "spawn-linux-android", "spawn-linux-control",
              "spawn-linux-wait", "spawn-linux-release"},
    "macOS": {"spawn-macos-build", "spawn-macos-release"},
    "Windows": {"spawn-windows-build", "spawn-windows-release"},
}
MAC_ROLE = "${{ github.ref == 'refs/heads/master' && 'spawn-macos-release' || 'spawn-macos-build' }}"


def validate_labels(labels):
    if len(labels) not in (4, 5) or labels[0] != "self-hosted" or labels[1] not in ROLES:
        raise ValueError("runner must specify self-hosted, platform, architecture and a SPAWN D pool")
    platform, arch, role = labels[1:4]
    placement = labels[4:]
    if platform == "Linux" and role in ("spawn-linux-build", "spawn-linux-android"):
        if placement != ["spawn-minivac"]:
            raise ValueError("Linux x64 builders require explicit Minivac placement")
    elif placement:
        raise ValueError("unexpected runner placement label")
    if role == MAC_ROLE and platform == "macOS" and arch == "ARM64":
        return
    if role not in ROLES[platform]:
        raise ValueError("unknown or mismatched runner pool")
    expected = "ARM64" if platform == "macOS" else "X64"
    if arch != expected:
        raise ValueError("runner architecture does not match its pool")


def validate_workflow(source):
    checked = 0
    matrix = False
    for line in source.splitlines():
        match = re.match(r"^\s+runs-on:\s*(.*?)\s*$", line)
        if not match:
            continue
        expression = match.group(1)
        if expression == "${{ fromJSON(matrix.runner) }}":
            matrix = True
            continue
        if not (expression.startswith("[") and expression.endswith("]")):
            raise ValueError("runs-on must use the explicit self-hosted label list")
        labels = [part.strip().strip('"') for part in expression[1:-1].split(",")]
        validate_labels(labels)
        checked += 1
    if matrix:
        candidates = re.findall(r"^\s+runner:\s*(.+)$", source, re.MULTILINE)
        if not candidates:
            raise ValueError("native matrix has no explicit runner labels")
        for candidate in candidates:
            validate_labels(json.loads(ast.literal_eval(candidate)))
            checked += 1
    if not checked:
        raise ValueError("workflow has no checked self-hosted jobs")
    return checked


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    count = 0
    for workflow in sorted((root / ".github/workflows").glob("*.y*ml")):
        try:
            count += validate_workflow(workflow.read_text())
        except (ValueError, SyntaxError) as exc:
            raise SystemExit(f"{workflow.name}: {exc}") from exc
    print(f"self-hosted CI: all {count} platform jobs use dedicated runner pools")
