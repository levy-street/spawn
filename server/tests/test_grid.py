"""Unit tests for the pure grid algebra (docs/OVERHAUL.md §4.4).

The Python and TypeScript implementations must stay identical; the shared
fixture suite ``proto/layout-v3-fixtures.json`` is authoritative and every
case runs here. The prose-derived tests below cover behavior and edge cases
around the fixtures.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from spawn_server import grid

FIXTURES_PATH = Path(__file__).resolve().parents[2] / "proto" / "layout-v3-fixtures.json"


def t(session_id: str, x: int, y: int, w: int, h: int) -> dict:
    return {"session_id": session_id, "x": x, "y": y, "w": w, "h": h}


def layout(*tiles: dict) -> dict:
    return {"version": grid.LAYOUT_VERSION, "tiles": list(tiles)}


# ---------- validate ----------


def test_validate_accepts_empty_and_full_layouts():
    assert grid.validate(layout())
    assert grid.validate(layout(t("a", 0, 0, 24, 24)))
    assert grid.validate(layout(t("a", 0, 0, 12, 24), t("b", 12, 0, 12, 24)))


def test_validate_layout_error_codes():
    assert grid.validate_layout("nope") == {"ok": False, "errors": [{"code": "shape"}]}
    assert grid.validate_layout({"version": grid.LAYOUT_VERSION}) == {
        "ok": False, "errors": [{"code": "shape"}]
    }
    assert grid.validate_layout({"version": 1, "tiles": []}) == {
        "ok": False, "errors": [{"code": "version"}]
    }
    result = grid.validate_layout(layout(t("a", 0, 0, 12, 12), t("b", 6, 6, 12, 12)))
    assert result["errors"] == [{"code": "overlap", "index": 0, "other_index": 1}]
    result = grid.validate_layout(layout(t("a", 0, 0, 2, 2)))
    assert result["errors"] == [{"code": "size", "index": 0}]
    result = grid.validate_layout(layout({"session_id": "a", "x": 0.5, "y": 0, "w": 6, "h": 6}))
    assert result["errors"] == [{"code": "integer", "index": 0}]
    result = grid.validate_layout(layout(t("a", 0, 0, 6, 6), t("a", 6, 0, 6, 6)))
    assert result["errors"] == [{"code": "duplicate", "index": 1, "other_index": 0}]
    over_cap = [t(f"s{i}", (i % 6) * 4, (i // 6) * 4, 4, 4) for i in range(grid.MAX_TILES + 1)]
    assert grid.validate_layout({"version": grid.LAYOUT_VERSION, "tiles": over_cap})["errors"] == [{"code": "count"}]


def test_validate_rejects_non_integer_and_boolean_geometry():
    assert not grid.validate(layout({"session_id": "a", "x": True, "y": 0, "w": 6, "h": 6}))
    assert not grid.validate(layout({"session_id": "a", "x": 0, "y": 0, "w": "6", "h": 6}))


# ---------- auto_place ----------


def test_auto_place_on_empty_canvas_takes_everything():
    tiles, rect = grid.auto_place([])
    assert tiles == []
    assert rect == {"x": 0, "y": 0, "w": 24, "h": 24}


def test_auto_place_scans_y_then_x_and_expands_right_then_down():
    _, rect = grid.auto_place([t("a", 0, 0, 12, 24)])
    assert rect == {"x": 12, "y": 0, "w": 12, "h": 24}

    _, rect = grid.auto_place([t("a", 0, 0, 24, 8)])
    assert rect == {"x": 0, "y": 8, "w": 24, "h": 16}


def test_auto_place_split_shrinks_existing_tile():
    tiles, rect = grid.auto_place([t("a", 0, 0, 24, 24)])
    assert tiles == [t("a", 0, 0, 12, 24)]
    assert rect == {"x": 12, "y": 0, "w": 12, "h": 24}


def test_auto_place_split_odd_side_keeps_ceil():
    # 18-wide full-canvas pair: "a" (18x24) splits along its longer axis —
    # h=24 > w=18, so a horizontal cut, keeping ceil(24/2)=12.
    tiles, rect = grid.auto_place([t("a", 0, 0, 18, 24), t("b", 18, 0, 6, 24)])
    by_id = {tile["session_id"]: tile for tile in tiles}
    assert by_id["a"] == t("a", 0, 0, 18, 12)
    assert rect == {"x": 0, "y": 12, "w": 18, "h": 12}


def test_auto_place_uses_a_minimum_width_strip():
    # With the 4x4 minimum, the leftover strip beside four 10x10 quads is a
    # legal placement (an unsplittable-and-unplaceable canvas cannot exist
    # below the tile cap any more).
    quads = [
        t("a", 0, 0, 10, 10),
        t("b", 10, 0, 10, 10),
        t("c", 0, 10, 10, 10),
        t("d", 10, 10, 10, 10),
    ]
    tiles, rect = grid.auto_place(quads)
    assert rect == {"x": 20, "y": 0, "w": 4, "h": 24}
    assert tiles == quads


def test_auto_place_returns_null_at_tile_cap():
    at_cap = [t(f"s{i}", (i % 4) * 6, (i // 4) * 6, 6, 6) for i in range(grid.MAX_TILES)]
    tiles, rect = grid.auto_place(at_cap)
    assert rect is None
    assert len(tiles) == grid.MAX_TILES


def test_auto_place_never_mutates_input():
    tiles = [t("a", 0, 0, 24, 24)]
    snapshot = json.loads(json.dumps(tiles))
    grid.auto_place(tiles)
    assert tiles == snapshot


# ---------- compact ----------


def test_compact_moves_up_then_left_and_sorts():
    assert grid.compact([t("a", 6, 6, 6, 6)]) == [t("a", 0, 0, 6, 6)]


def test_compact_is_physical_no_pass_through():
    tiles = grid.compact([t("a", 0, 12, 12, 6), t("b", 12, 6, 12, 6)])
    by_id = {tile["session_id"]: tile for tile in tiles}
    assert by_id["b"] == t("b", 0, 0, 12, 6)
    assert by_id["a"] == t("a", 0, 6, 12, 6)


def test_compact_is_idempotent():
    tiles = [t("a", 0, 0, 12, 24), t("b", 12, 0, 12, 12), t("c", 12, 12, 12, 12)]
    once = grid.compact(tiles)
    assert grid.compact(once) == once


# ---------- move ----------


def test_move_pushes_overlapped_tiles_down_then_compacts():
    tiles = [t("a", 0, 0, 24, 12), t("b", 0, 12, 24, 12)]
    result = grid.move(tiles, "b", 0, 0)
    assert result == [t("b", 0, 0, 24, 12), t("a", 0, 12, 24, 12)]


def test_move_swaps_full_height_columns():
    tiles = [t("a", 0, 0, 12, 24), t("b", 12, 0, 12, 24)]
    result = grid.move(tiles, "b", 0, 0)
    assert result == [t("b", 0, 0, 12, 24), t("a", 12, 0, 12, 24)]


def test_move_swap_exchanges_sizes():
    tiles = [t("a", 0, 0, 16, 24), t("b", 16, 0, 8, 24)]
    result = grid.move(tiles, "b", 0, 0)
    assert result == [t("b", 0, 0, 16, 24), t("a", 16, 0, 8, 24)]


def test_move_into_empty_space_leaves_the_gap_behind():
    tiles = [t("a", 0, 0, 12, 12)]
    assert grid.move(tiles, "a", 12, 12) == [t("a", 12, 12, 12, 12)]


def test_move_unknown_id_returns_sorted_input():
    tiles = [t("b", 12, 0, 12, 24), t("a", 0, 0, 12, 24)]
    assert grid.move(tiles, "zz", 0, 0) == [t("a", 0, 0, 12, 24), t("b", 12, 0, 12, 24)]


# ---------- resize ----------


def test_resize_clamps_to_invariants_about_its_own_origin():
    # The tile grows in place; it does not slide back to the origin.
    result = grid.resize([t("a", 12, 12, 6, 6)], "a", 99, 99)
    assert result == [t("a", 12, 12, 12, 12)]
    result = grid.resize([t("a", 0, 0, 12, 12)], "a", 1, 1)
    assert result == [t("a", 0, 0, 4, 4)]


def test_resize_shrinking_leaves_empty_canvas():
    tiles = [t("a", 0, 0, 24, 8), t("b", 0, 8, 24, 16)]
    # b keeps its place: the freed strip stays empty, nothing repacks.
    assert grid.resize(tiles, "b", 24, 8) == [t("a", 0, 0, 24, 8), t("b", 0, 8, 24, 8)]


def test_resize_into_an_occupied_rect_is_a_no_op():
    tiles = [t("a", 0, 0, 24, 8), t("b", 0, 8, 24, 8)]
    # Growing a onto b is refused; only free canvas can be taken.
    assert grid.resize(tiles, "a", 24, 16) == tiles


def test_resize_unknown_id_returns_sorted_input():
    tiles = [t("a", 0, 0, 24, 24)]
    assert grid.resize(tiles, "zz", 6, 6) == tiles


# ---------- remove ----------


def test_remove_expands_survivors_into_freed_space():
    tiles = [t("a", 0, 0, 12, 24), t("b", 12, 0, 12, 24)]
    assert grid.remove(tiles, "b") == [t("a", 0, 0, 24, 24)]


def test_remove_last_tile_leaves_empty_layout():
    assert grid.remove([t("a", 0, 0, 24, 24)], "a") == []


def test_remove_unknown_id_returns_sorted_input_uncompacted():
    tiles = [t("a", 6, 6, 6, 6)]
    assert grid.remove(tiles, "zz") == [t("a", 6, 6, 6, 6)]


# ---------- reading_order ----------


def test_reading_order_sorts_by_y_then_x():
    tiles = [
        t("bottom", 0, 12, 12, 12),
        t("right", 12, 0, 12, 12),
        t("left", 0, 0, 12, 12),
    ]
    assert grid.reading_order(tiles) == ["left", "right", "bottom"]


# ---------- from_split_tree ----------


def pane(pane_id: str) -> dict:
    return {"type": "pane", "agent_id": pane_id}


def split(direction: str, ratio: float, a: dict, b: dict) -> dict:
    return {"type": "split", "direction": direction, "ratio": ratio, "a": a, "b": b}


def test_from_split_tree_empty_and_single_pane():
    assert grid.from_split_tree(None) == []
    assert grid.from_split_tree(pane("a")) == [t("a", 0, 0, 24, 24)]


def test_from_split_tree_even_splits():
    assert grid.from_split_tree(split("row", 0.5, pane("a"), pane("b"))) == [
        t("a", 0, 0, 12, 24),
        t("b", 12, 0, 12, 24),
    ]
    assert grid.from_split_tree(split("column", 0.5, pane("a"), pane("b"))) == [
        t("a", 0, 0, 24, 12),
        t("b", 0, 12, 24, 12),
    ]


def test_from_split_tree_uneven_ratio_rounds_edges_half_up():
    # 0.3 * 24 = 7.2 -> floor(7.2 + 0.5) = 7, so the edge rounds down here.
    assert grid.from_split_tree(split("row", 0.3, pane("a"), pane("b"))) == [
        t("a", 0, 0, 7, 24),
        t("b", 7, 0, 17, 24),
    ]


def test_from_split_tree_ratio_heavy_tree_falls_back_to_auto_place():
    tiles = grid.from_split_tree(split("row", 0.1, pane("a"), pane("b")))
    assert tiles == [t("a", 0, 0, 12, 24), t("b", 12, 0, 12, 24)]


def test_from_split_tree_deep_tree_stays_valid():
    tree = pane("p0")
    for i in range(1, 8):
        tree = split("row" if i % 2 else "column", 0.5, tree, pane(f"p{i}"))
    tiles = grid.from_split_tree(tree)
    assert grid.validate_tiles(tiles)
    assert len(tiles) == 8


def test_from_split_tree_deduplicates_panes_in_fallback():
    tiles = grid.from_split_tree(split("row", 0.1, pane("a"), pane("a")))
    assert tiles == [t("a", 0, 0, 24, 24)]


def test_from_split_tree_caps_at_max_tiles():
    tree = pane("p0")
    for i in range(1, grid.MAX_TILES + 5):
        tree = split("row", 0.5, tree, pane(f"p{i}"))
    tiles = grid.from_split_tree(tree)
    assert grid.validate_tiles(tiles)
    assert len(tiles) == grid.MAX_TILES


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
