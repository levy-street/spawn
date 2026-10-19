"""Unit tests for the pure tab-group rules (proto/README.md, "Tab groups").

The Python and TypeScript implementations must stay identical; the shared
fixture suite ``proto/tab-groups-fixtures.json`` is authoritative and every
case runs here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from spawn_server import tab_groups

FIXTURES_PATH = Path(__file__).resolve().parents[2] / "proto" / "tab-groups-fixtures.json"
CASES = json.loads(FIXTURES_PATH.read_text())["cases"]


@pytest.mark.parametrize("case", CASES, ids=[f"{c['op']}: {c['name']}" for c in CASES])
def test_shared_fixture(case: dict) -> None:
    op = case["op"]
    if op == "color":
        assert tab_groups.normalize_color(case["input"]) == case["expected"]
    elif op == "normalize":
        assert tab_groups.normalize_groups(case["tab_ids"], case["groups"]) == case["expected"]
    elif op == "validate":
        assert tab_groups.validate_groups(case["tab_ids"], case["groups"]) == case["expected"]
    elif op == "regroup":
        result = tab_groups.regroup(case["tab_ids"], case["groups"], case["moved"])
        assert result == case["expected"]
    else:
        pytest.fail(f"unknown op {op}")


def test_fixture_ops_are_all_covered() -> None:
    assert {case["op"] for case in CASES} == {"color", "normalize", "validate", "regroup"}


def test_inputs_are_not_mutated() -> None:
    groups = [
        {"id": "g", "name": "", "color": "#ABCDEF", "collapsed": False, "tab_ids": ["b", "a"]}
    ]
    snapshot = json.loads(json.dumps(groups))
    tab_groups.normalize_groups(["a", "b"], groups)
    tab_groups.regroup(["a", "b"], tab_groups.normalize_groups(["a", "b"], groups), "a")
    assert groups == snapshot
