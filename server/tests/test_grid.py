"""Unit tests for the pure grid algebra (docs/OVERHAUL.md §4.4).

The Python and TypeScript implementations must stay identical; the shared
fixture suite ``proto/layout-v2-fixtures.json`` is authoritative and every
case runs here. The prose-derived tests below cover behavior and edge cases
around the fixtures.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from spawn_server import grid

FIXTURES_PATH = Path(__file__).resolve().parents[2] / "proto" / "layout-v2-fixtures.json"


def t(session_id: str, x: int, y: int, w: int, h: int) -> dict:
    return {"session_id": session_id, "x": x, "y": y, "w": w, "h": h}


def layout(*tiles: dict) -> dict:
    return {"version": 2, "tiles": list(tiles)}


# ---------- validate ----------


def test_validate_accepts_empty_and_full_layouts():
    assert grid.validate(layout())
    assert grid.validate(layout(t("a", 0, 0, 12, 12)))
    assert grid.validate(layout(t("a", 0, 0, 6, 12), t("b", 6, 0, 6, 12)))


def test_validate_layout_error_codes():
    assert grid.validate_layout("nope") == {"ok": False, "errors": [{"code": "shape"}]}
    assert grid.validate_layout({"version": 2}) == {
        "ok": False, "errors": [{"code": "shape"}]
    }
    assert grid.validate_layout({"version": 1, "tiles": []}) == {
        "ok": False, "errors": [{"code": "version"}]
    }
    result = grid.validate_layout(layout(t("a", 0, 0, 6, 6), t("b", 3, 3, 6, 6)))
    assert result["errors"] == [{"code": "overlap", "index": 0, "other_index": 1}]
    result = grid.validate_layout(layout(t("a", 0, 0, 2, 2)))
    assert result["errors"] == [{"code": "size", "index": 0}]
    result = grid.validate_layout(layout({"session_id": "a", "x": 0.5, "y": 0, "w": 6, "h": 6}))
    assert result["errors"] == [{"code": "integer", "index": 0}]
    result = grid.validate_layout(layout(t("a", 0, 0, 3, 3), t("a", 3, 0, 3, 3)))
    assert result["errors"] == [{"code": "duplicate", "index": 1, "other_index": 0}]
    nine = [t(f"s{i}", (i % 4) * 3, (i // 4) * 3, 3, 3) for i in range(9)]
    assert grid.validate_layout({"version": 2, "tiles": nine})["errors"] == [{"code": "count"}]


def test_validate_rejects_non_integer_and_boolean_geometry():
    assert not grid.validate(layout({"session_id": "a", "x": True, "y": 0, "w": 3, "h": 3}))
    assert not grid.validate(layout({"session_id": "a", "x": 0, "y": 0, "w": "3", "h": 3}))


# ---------- auto_place ----------


def test_auto_place_on_empty_canvas_takes_everything():
    tiles, rect = grid.auto_place([])
    assert tiles == []
    assert rect == {"x": 0, "y": 0, "w": 12, "h": 12}


def test_auto_place_scans_y_then_x_and_expands_right_then_down():
    _, rect = grid.auto_place([t("a", 0, 0, 6, 12)])
    assert rect == {"x": 6, "y": 0, "w": 6, "h": 12}

    _, rect = grid.auto_place([t("a", 0, 0, 12, 4)])
    assert rect == {"x": 0, "y": 4, "w": 12, "h": 8}


def test_auto_place_split_shrinks_existing_tile():
    tiles, rect = grid.auto_place([t("a", 0, 0, 12, 12)])
    assert tiles == [t("a", 0, 0, 6, 12)]
    assert rect == {"x": 6, "y": 0, "w": 6, "h": 12}


def test_auto_place_split_odd_side_keeps_ceil():
    # 9-wide full canvas pair: "a" (9x12) splits along its taller axis? No —
    # h=12 > w=9, horizontal cut: keeps ceil(12/2)=6.
    tiles, rect = grid.auto_place([t("a", 0, 0, 9, 12), t("b", 9, 0, 3, 12)])
    by_id = {tile["session_id"]: tile for tile in tiles}
    assert by_id["a"] == t("a", 0, 0, 9, 6)
    assert rect == {"x": 0, "y": 6, "w": 9, "h": 6}


def test_auto_place_returns_null_when_nothing_is_splittable():
    quads = [
        t("a", 0, 0, 5, 5),
        t("b", 5, 0, 5, 5),
        t("c", 0, 5, 5, 5),
        t("d", 5, 5, 5, 5),
    ]
    tiles, rect = grid.auto_place(quads)
    assert rect is None
    assert tiles == quads


def test_auto_place_returns_null_at_tile_cap():
    eight = [t(f"s{i}", (i % 4) * 3, (i // 4) * 3, 3, 3) for i in range(8)]
    tiles, rect = grid.auto_place(eight)
    assert rect is None
    assert len(tiles) == 8


def test_auto_place_never_mutates_input():
    tiles = [t("a", 0, 0, 12, 12)]
    snapshot = json.loads(json.dumps(tiles))
    grid.auto_place(tiles)
    assert tiles == snapshot


# ---------- compact ----------


def test_compact_moves_up_then_left_and_sorts():
    assert grid.compact([t("a", 3, 3, 3, 3)]) == [t("a", 0, 0, 3, 3)]


def test_compact_is_physical_no_pass_through():
    tiles = grid.compact([t("a", 0, 6, 6, 3), t("b", 6, 3, 6, 3)])
    by_id = {tile["session_id"]: tile for tile in tiles}
    assert by_id["b"] == t("b", 0, 0, 6, 3)
    assert by_id["a"] == t("a", 0, 3, 6, 3)


def test_compact_is_idempotent():
    tiles = [t("a", 0, 0, 6, 12), t("b", 6, 0, 6, 6), t("c", 6, 6, 6, 6)]
    once = grid.compact(tiles)
    assert grid.compact(once) == once


# ---------- move ----------


def test_move_pushes_overlapped_tiles_down_then_compacts():
    tiles = [t("a", 0, 0, 12, 6), t("b", 0, 6, 12, 6)]
    result = grid.move(tiles, "b", 0, 0)
    assert result == [t("b", 0, 0, 12, 6), t("a", 0, 6, 12, 6)]


def test_move_swaps_full_height_columns():
    tiles = [t("a", 0, 0, 6, 12), t("b", 6, 0, 6, 12)]
    result = grid.move(tiles, "b", 0, 0)
    assert result == [t("b", 0, 0, 6, 12), t("a", 6, 0, 6, 12)]


def test_move_swap_exchanges_sizes():
    tiles = [t("a", 0, 0, 8, 12), t("b", 8, 0, 4, 12)]
    result = grid.move(tiles, "b", 0, 0)
    assert result == [t("b", 0, 0, 8, 12), t("a", 8, 0, 4, 12)]


def test_move_into_empty_space_is_a_no_op_after_compact():
    tiles = [t("a", 0, 0, 6, 6)]
    assert grid.move(tiles, "a", 6, 6) == [t("a", 0, 0, 6, 6)]


def test_move_unknown_id_returns_sorted_input():
    tiles = [t("b", 6, 0, 6, 12), t("a", 0, 0, 6, 12)]
    assert grid.move(tiles, "zz", 0, 0) == [t("a", 0, 0, 6, 12), t("b", 6, 0, 6, 12)]


# ---------- resize ----------


def test_resize_clamps_to_invariants():
    result = grid.resize([t("a", 6, 6, 3, 3)], "a", 99, 99)
    assert result == [t("a", 0, 0, 6, 6)]
    result = grid.resize([t("a", 0, 0, 6, 6)], "a", 1, 1)
    assert result == [t("a", 0, 0, 3, 3)]


def test_resize_pushes_collisions_down():
    tiles = [t("a", 0, 0, 12, 4), t("b", 0, 4, 12, 4)]
    result = grid.resize(tiles, "a", 12, 8)
    assert result == [t("a", 0, 0, 12, 8), t("b", 0, 8, 12, 4)]


def test_resize_unresolvable_cascade_is_a_no_op():
    tiles = [
        t("a", 0, 0, 12, 4),
        t("b", 0, 4, 12, 4),
        t("c", 0, 8, 12, 4),
    ]
    # Growing a to h=8 forces b and c past the canvas with nowhere to go.
    assert grid.resize(tiles, "a", 12, 8) == tiles


def test_resize_unknown_id_returns_sorted_input():
    tiles = [t("a", 0, 0, 12, 12)]
    assert grid.resize(tiles, "zz", 3, 3) == tiles


# ---------- remove ----------


def test_remove_expands_survivors_into_freed_space():
    tiles = [t("a", 0, 0, 6, 12), t("b", 6, 0, 6, 12)]
    assert grid.remove(tiles, "b") == [t("a", 0, 0, 12, 12)]


def test_remove_last_tile_leaves_empty_layout():
    assert grid.remove([t("a", 0, 0, 12, 12)], "a") == []


def test_remove_unknown_id_returns_sorted_input_uncompacted():
    tiles = [t("a", 3, 3, 3, 3)]
    assert grid.remove(tiles, "zz") == [t("a", 3, 3, 3, 3)]


# ---------- reading_order ----------


def test_reading_order_sorts_by_y_then_x():
    tiles = [
        t("bottom", 0, 6, 6, 6),
        t("right", 6, 0, 6, 6),
        t("left", 0, 0, 6, 6),
    ]
    assert grid.reading_order(tiles) == ["left", "right", "bottom"]


# ---------- from_split_tree ----------


def pane(pane_id: str) -> dict:
    return {"type": "pane", "agent_id": pane_id}


def split(direction: str, ratio: float, a: dict, b: dict) -> dict:
    return {"type": "split", "direction": direction, "ratio": ratio, "a": a, "b": b}


def test_from_split_tree_empty_and_single_pane():
    assert grid.from_split_tree(None) == []
    assert grid.from_split_tree(pane("a")) == [t("a", 0, 0, 12, 12)]


def test_from_split_tree_even_splits():
    assert grid.from_split_tree(split("row", 0.5, pane("a"), pane("b"))) == [
        t("a", 0, 0, 6, 12),
        t("b", 6, 0, 6, 12),
    ]
    assert grid.from_split_tree(split("column", 0.5, pane("a"), pane("b"))) == [
        t("a", 0, 0, 12, 6),
        t("b", 0, 6, 12, 6),
    ]


def test_from_split_tree_uneven_ratio_rounds_edges_half_up():
    # 0.3 * 12 = 3.6 -> edge rounds to 4.
    assert grid.from_split_tree(split("row", 0.3, pane("a"), pane("b"))) == [
        t("a", 0, 0, 4, 12),
        t("b", 4, 0, 8, 12),
    ]


def test_from_split_tree_ratio_heavy_tree_falls_back_to_auto_place():
    tiles = grid.from_split_tree(split("row", 0.1, pane("a"), pane("b")))
    assert tiles == [t("a", 0, 0, 6, 12), t("b", 6, 0, 6, 12)]


def test_from_split_tree_deep_tree_stays_valid():
    tree = pane("p0")
    for i in range(1, 8):
        tree = split("row" if i % 2 else "column", 0.5, tree, pane(f"p{i}"))
    tiles = grid.from_split_tree(tree)
    assert grid.validate_tiles(tiles)
    assert len(tiles) == 8


def test_from_split_tree_deduplicates_panes_in_fallback():
    tiles = grid.from_split_tree(split("row", 0.1, pane("a"), pane("a")))
    assert tiles == [t("a", 0, 0, 12, 12)]


def test_from_split_tree_caps_at_eight_panes():
    tree = pane("p0")
    for i in range(1, 12):
        tree = split("row", 0.5, tree, pane(f"p{i}"))
    tiles = grid.from_split_tree(tree)
    assert grid.validate_tiles(tiles)
    assert len(tiles) == 8


# ---------- shared fixture suite (authoritative) ----------


def _load_fixture_cases() -> list[dict]:
    data = json.loads(FIXTURES_PATH.read_text())
    return list(data["cases"])


_CASES = _load_fixture_cases()


@pytest.mark.parametrize(
    "case", _CASES, ids=[case.get("name", str(i)) for i, case in enumerate(_CASES)]
)
def test_shared_layout_fixtures(case: dict):
    op = case["op"]
    inp = case["input"]
    expected = case["expected"]

    if op == "validate":
        assert grid.validate_layout(inp["layout"]) == {
            "ok": expected["ok"],
            "errors": expected["errors"],
        }, case["name"]
    elif op == "autoPlace":
        tiles, rect = grid.auto_place(inp["tiles"])
        assert rect == expected["tile"], case["name"]
        assert tiles == expected["tiles"], case["name"]
    elif op == "move":
        assert grid.move(inp["tiles"], inp["id"], inp["x"], inp["y"]) == expected["tiles"], (
            case["name"]
        )
    elif op == "resize":
        assert grid.resize(inp["tiles"], inp["id"], inp["w"], inp["h"]) == expected["tiles"], (
            case["name"]
        )
    elif op == "remove":
        assert grid.remove(inp["tiles"], inp["id"]) == expected["tiles"], case["name"]
    elif op == "compact":
        assert grid.compact(inp["tiles"]) == expected["tiles"], case["name"]
    elif op == "readingOrder":
        assert grid.reading_order(inp["tiles"]) == expected["order"], case["name"]
    elif op == "fromSplitTree":
        assert grid.from_split_tree(inp["root"]) == expected["tiles"], case["name"]
    else:
        pytest.fail(f"unknown fixture op {op!r}")
