"""Tab groups: named, coloured runs of adjacent tabs in a workspace's tab strip.

proto/README.md ("Tab groups") is the contract and proto/tab-groups-fixtures.json
the conformance suite; web/src/lib/tab-groups.ts and
mobile/src/data/layout/tab-groups.ts implement the same rules and run the same
cases. Everything here is pure: inputs are never mutated.

A group is ``{"id", "name", "color", "collapsed", "tab_ids"}``. ``tab_ids`` are
listed in strip order and always sit next to each other in the strip; a tab
belongs to at most one group.
"""

from __future__ import annotations

import re

PRESET_COLORS = (
    "blue",
    "purple",
    "cyan",
    "orange",
    "yellow",
    "pink",
    "green",
    "gray",
    "red",
)
DEFAULT_COLOR = "blue"
MAX_ID_LENGTH = 64
MAX_NAME_LENGTH = 64

_HEX_COLOR = re.compile(r"\A#[0-9a-fA-F]{6}\Z")


def normalize_color(value: object) -> str | None:
    """The stored form of a group colour: a preset name, or a custom colour as
    lowercase ``#rrggbb``. None when ``value`` is neither."""
    if not isinstance(value, str):
        return None
    if value in PRESET_COLORS:
        return value
    if _HEX_COLOR.match(value):
        return value.lower()
    return None


def _runs(positions: list[int]) -> list[list[int]]:
    """Sorted positions split into runs of consecutive integers."""
    runs: list[list[int]] = []
    for position in sorted(positions):
        if runs and runs[-1][-1] == position - 1:
            runs[-1].append(position)
        else:
            runs.append([position])
    return runs


def normalize_groups(tab_ids: list[str], groups: object) -> list[dict]:
    """The lenient read: what a stored or carried-over ``groups`` value becomes
    against the strip ``tab_ids``.

    Malformed groups are skipped and malformed fields read as their defaults;
    a tab that is gone leaves its group, a tab claimed twice stays with the
    first group listed, a split group keeps its longest run (the first, on a
    tie), an empty group is dropped, and groups come back in strip order.
    """
    if not isinstance(groups, list):
        return []
    position = {tab_id: index for index, tab_id in enumerate(tab_ids)}
    seen_ids: set[str] = set()
    claimed: set[str] = set()
    result: list[dict] = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        group_id = group.get("id")
        if not isinstance(group_id, str) or not group_id or len(group_id) > MAX_ID_LENGTH:
            continue
        if group_id in seen_ids:
            continue
        seen_ids.add(group_id)
        raw_tabs = group.get("tab_ids")
        members = [
            position[tab_id]
            for tab_id in (raw_tabs if isinstance(raw_tabs, list) else [])
            if isinstance(tab_id, str) and tab_id in position and tab_id not in claimed
        ]
        members = sorted(set(members))
        claimed.update(tab_ids[index] for index in members)
        runs = _runs(members)
        if not runs:
            continue
        longest = max(runs, key=len)  # max() keeps the first of equal runs
        name = group.get("name")
        collapsed = group.get("collapsed")
        result.append(
            {
                "id": group_id,
                "name": name[:MAX_NAME_LENGTH] if isinstance(name, str) else "",
                "color": normalize_color(group.get("color")) or DEFAULT_COLOR,
                "collapsed": collapsed if isinstance(collapsed, bool) else False,
                "tab_ids": [tab_ids[index] for index in longest],
            }
        )
    result.sort(key=lambda group: position[group["tab_ids"][0]])
    return result


def validate_groups(tab_ids: list[str], groups: list[dict]) -> str | None:
    """The strict write check for groups a client sent: None when valid, else
    the first problem's code. Shapes (types, lengths) are the schema's job;
    this checks what only the strip can answer."""
    position = {tab_id: index for index, tab_id in enumerate(tab_ids)}
    seen_ids: set[str] = set()
    claimed: set[str] = set()
    for group in groups:
        if group["id"] in seen_ids:
            return "duplicate_group_id"
        seen_ids.add(group["id"])
        if normalize_color(group["color"]) is None:
            return "bad_color"
        members = group["tab_ids"]
        if not members:
            return "empty_group"
        for tab_id in members:
            if tab_id not in position:
                return "unknown_tab"
            if tab_id in claimed:
                return "tab_in_two_groups"
            claimed.add(tab_id)
        if len(_runs([position[tab_id] for tab_id in members])) > 1:
            return "split_group"
    return None


def regroup(tab_ids: list[str], groups: list[dict], moved: str) -> list[dict]:
    """Group membership after ``moved`` lands at its slot in ``tab_ids``.

    A tab between two tabs of one group joins that group; a grouped tab still
    touching its group stays; a group's only tab carries the group with it;
    any other grouped tab leaves. ``groups`` are valid for the strip before
    the move. The clients call this on every reorder and insert; the server
    runs it only for the shared fixtures.
    """
    group_of = {tab_id: group["id"] for group in groups for tab_id in group["tab_ids"]}
    index = tab_ids.index(moved)
    left = group_of.get(tab_ids[index - 1]) if index > 0 else None
    right = group_of.get(tab_ids[index + 1]) if index + 1 < len(tab_ids) else None
    own = group_of.get(moved)
    target = own
    if left is not None and left == right:
        target = left
    elif own is not None and own not in (left, right):
        alone = sum(1 for group_id in group_of.values() if group_id == own) == 1
        target = own if alone else None
    regrouped = [
        {
            **group,
            "tab_ids": [tab_id for tab_id in group["tab_ids"] if tab_id != moved]
            + ([moved] if group["id"] == target else []),
        }
        for group in groups
    ]
    return normalize_groups(tab_ids, regrouped)
