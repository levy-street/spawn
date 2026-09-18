#!/usr/bin/env python3
"""Reject paid, self-hosted, or dynamic runner choices in repository workflows."""

from pathlib import Path
import re

import yaml

STANDARD_RUNNERS = {
    "ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04", "ubuntu-22.04-arm",
    "ubuntu-24.04-arm", "windows-latest", "windows-2025", "windows-2022",
    "macos-latest", "macos-15", "macos-14",
}


class WorkflowLoader(yaml.BaseLoader):
    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if key in result:
                raise ValueError(f"duplicate workflow key: {key}")
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def validate_runner(value):
    if not isinstance(value, str) or value not in STANDARD_RUNNERS:
        raise ValueError("runner must be an explicitly approved standard GitHub-hosted runner")


def validate_workflow(source):
    workflow = yaml.load(source, Loader=WorkflowLoader)
    if not isinstance(workflow, dict) or not isinstance(workflow.get("jobs"), dict):
        raise ValueError("workflow must declare its jobs")
    checked = 0
    for job in workflow["jobs"].values():
        if not isinstance(job, dict):
            raise ValueError("job must be a mapping")
        if "uses" in job:
            if not re.fullmatch(r"\./\.github/workflows/[A-Za-z0-9_-]+\.ya?ml", str(job["uses"])):
                raise ValueError("reusable workflow must be local so its runners are checked")
            continue
        runner = job.get("runs-on")
        if runner == "${{ matrix.runner }}":
            matrix = job.get("strategy", {}).get("matrix", {})
            if set(matrix) != {"include"} or not isinstance(matrix["include"], list) or not matrix["include"]:
                raise ValueError("runner matrix requires explicit include choices")
            for candidate in matrix["include"]:
                validate_runner(candidate.get("runner") if isinstance(candidate, dict) else None)
                checked += 1
        else:
            validate_runner(runner)
            checked += 1
    if not checked:
        raise ValueError("workflow has no checked hosted jobs")
    return checked


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[2]
    count = 0
    for workflow in sorted((root / ".github/workflows").glob("*.y*ml")):
        try:
            count += validate_workflow(workflow.read_text())
        except (ValueError, yaml.YAMLError) as exc:
            raise SystemExit(f"{workflow.name}: {exc}") from exc
    print(f"hosted CI: all {count} platform jobs use standard GitHub-hosted runners")
