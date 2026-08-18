"""Workspace grid algebra — layout schema v2 (§4.4 of docs/OVERHAUL.md).

Pure and deterministic: the same functions exist in TypeScript as
``web/src/lib/grid.ts``, and both implementations must pass the shared
fixture suite ``proto/layout-v2-fixtures.json`` — where prose and fixtures
disagree, the fixtures win. Used by layout validation, server-side
auto-placement, and migration 0031.

Tiles are plain dicts ``{"session_id", "x", "y", "w", "h"}`` so they
round-trip JSON unchanged. Every function returns new structures, never
mutates its inputs, and returns tile lists sorted in reading order (y, x).
"""

from __future__ import annotations

import math
from typing import Any

GRID_COLS = 12
GRID_ROWS = 12
MIN_TILE_SIZE = 3
MAX_TILES = 8

Tile = dict[str, Any]
Rect = dict[str, int]


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _overlaps(a: Tile, b: Tile) -> bool:
    return (
        a["x"] < b["x"] + b["w"]
        and b["x"] < a["x"] + a["w"]
        and a["y"] < b["y"] + b["h"]
        and b["y"] < a["y"] + a["h"]
    )


def _in_bounds(tile: Tile) -> bool:
    return (
        tile["x"] >= 0
        and tile["y"] >= 0
        and tile["x"] + tile["w"] <= GRID_COLS
        and tile["y"] + tile["h"] <= GRID_ROWS
    )


def _sorted_reading(tiles: list[Tile]) -> list[Tile]:
    return sorted(tiles, key=lambda tile: (tile["y"], tile["x"]))


def _copy_sorted(tiles: list[Tile]) -> list[Tile]:
    return [dict(tile) for tile in _sorted_reading(tiles)]


def validate_layout(layout: object) -> dict[str, Any]:
    """The §4.4 invariants as ``{ok, errors}`` with fixture-exact error codes.

    Emission order: version, count, per-tile errors in tile order
    (session_id, integer, bounds, size — an integer failure suppresses
    bounds/size), duplicates in tile order, then overlaps for index pairs
    i<j in lexicographic order. Tiles failing integer or bounds checks are
    excluded from overlap checking.
    """
    errors: list[dict[str, Any]] = []
    if not isinstance(layout, dict) or not isinstance(layout.get("tiles"), list):
        return {"ok": False, "errors": [{"code": "shape"}]}
    tiles = layout["tiles"]

    if layout.get("version") != 2:
        errors.append({"code": "version"})
    if len(tiles) > MAX_TILES:
        errors.append({"code": "count"})

    geometry_ok: list[bool] = []
    for index, tile in enumerate(tiles):
        if not isinstance(tile, dict):
            errors.append({"code": "session_id", "index": index})
            errors.append({"code": "integer", "index": index})
            geometry_ok.append(False)
            continue
        session_id = tile.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            errors.append({"code": "session_id", "index": index})
        if not all(_is_int(tile.get(key)) for key in ("x", "y", "w", "h")):
            errors.append({"code": "integer", "index": index})
            geometry_ok.append(False)
            continue
        ok = True
        if not _in_bounds(tile):
            errors.append({"code": "bounds", "index": index})
            ok = False
        if tile["w"] < MIN_TILE_SIZE or tile["h"] < MIN_TILE_SIZE:
            errors.append({"code": "size", "index": index})
        geometry_ok.append(ok)

    seen: dict[str, int] = {}
    for index, tile in enumerate(tiles):
        session_id = tile.get("session_id") if isinstance(tile, dict) else None
        if not isinstance(session_id, str) or not session_id:
            continue
        if session_id in seen:
            errors.append({"code": "duplicate", "index": index, "other_index": seen[session_id]})
        else:
            seen[session_id] = index

    for i in range(len(tiles)):
        for j in range(i + 1, len(tiles)):
            if geometry_ok[i] and geometry_ok[j] and _overlaps(tiles[i], tiles[j]):
                errors.append({"code": "overlap", "index": i, "other_index": j})

    return {"ok": not errors, "errors": errors}


def validate(layout: object) -> bool:
    """Boolean convenience over :func:`validate_layout` (route validation)."""
    return bool(validate_layout(layout)["ok"])


def validate_tiles(tiles: object) -> bool:
    """Validate a bare tile list against the invariants."""
    if not isinstance(tiles, list):
        return False
    return validate({"version": 2, "tiles": tiles})


def reading_order(tiles: list[Tile]) -> list[str]:
    """Session ids sorted by ``(y, x)`` — mobile stack and focus order."""
    return [tile["session_id"] for tile in _sorted_reading(tiles)]


def _occupied_cells(tiles: list[Tile]) -> set[tuple[int, int]]:
    cells: set[tuple[int, int]] = set()
    for tile in tiles:
        for cx in range(tile["x"], tile["x"] + tile["w"]):
            for cy in range(tile["y"], tile["y"] + tile["h"]):
                cells.add((cx, cy))
    return cells


def _area_free(cells: set[tuple[int, int]], x: int, y: int, w: int, h: int) -> bool:
    if x < 0 or y < 0 or x + w > GRID_COLS or y + h > GRID_ROWS:
        return False
    return all(
        (cx, cy) not in cells for cx in range(x, x + w) for cy in range(y, y + h)
    )


def auto_place(tiles: list[Tile]) -> tuple[list[Tile], Rect | None]:
    """Place a new tile: first free 3×3 scanning y then x, greedily grown.

    Returns ``(tiles, rect)`` — the possibly-updated list plus the new
    geometry (no session_id; the caller appends it). When no 3×3 is free,
    the largest splittable tile (``max(w, h) >= 6``; ties broken by reading
    order) is cut along its longer axis (vertical cut when ``w >= h``): it
    keeps ``ceil(side/2)`` and the new rect gets ``floor(side/2)``. At the
    MAX_TILES cap, or when nothing is splittable, the rect is ``None`` —
    the workspace is full (HTTP surface: 409 ``workspace_full``).
    """
    ordered = _copy_sorted(tiles)
    if len(ordered) >= MAX_TILES:
        return ordered, None

    cells = _occupied_cells(ordered)
    for y in range(GRID_ROWS - MIN_TILE_SIZE + 1):
        for x in range(GRID_COLS - MIN_TILE_SIZE + 1):
            if not _area_free(cells, x, y, MIN_TILE_SIZE, MIN_TILE_SIZE):
                continue
            w = MIN_TILE_SIZE
            h = MIN_TILE_SIZE
            while x + w < GRID_COLS and _area_free(cells, x + w, y, 1, h):
                w += 1
            while y + h < GRID_ROWS and _area_free(cells, x, y + h, w, 1):
                h += 1
            return ordered, {"x": x, "y": y, "w": w, "h": h}

    candidates = [tile for tile in ordered if max(tile["w"], tile["h"]) >= 2 * MIN_TILE_SIZE]
    if not candidates:
        return ordered, None
    largest = candidates[0]
    for tile in candidates[1:]:
        if tile["w"] * tile["h"] > largest["w"] * largest["h"]:
            largest = tile
    if largest["w"] >= largest["h"]:
        keep = math.ceil(largest["w"] / 2)
        rect: Rect = {
            "x": largest["x"] + keep,
            "y": largest["y"],
            "w": largest["w"] - keep,
            "h": largest["h"],
        }
        largest["w"] = keep
    else:
        keep = math.ceil(largest["h"] / 2)
        rect = {
            "x": largest["x"],
            "y": largest["y"] + keep,
            "w": largest["w"],
            "h": largest["h"] - keep,
        }
        largest["h"] = keep
    return ordered, rect


def _push_down(tiles: list[Tile], fixed_id: str) -> list[Tile]:
    """Cascade tiles overlapping a fixed tile downward (x preserved),
    transiently allowed past the last row."""
    out = [dict(tile) for tile in tiles]
    fixed = {fixed_id}
    changed = True
    while changed:
        changed = False
        for tile in _sorted_reading(out):
            if tile["session_id"] in fixed:
                continue
            blockers = [
                other
                for other in out
                if other["session_id"] in fixed and _overlaps(tile, other)
            ]
            if blockers:
                tile["y"] = max(other["y"] + other["h"] for other in blockers)
                fixed.add(tile["session_id"])
                changed = True
    return out


def compact(tiles: list[Tile]) -> list[Tile]:
    """Sequential physical gravity in ``(y, x)`` order: each tile slides up
    then left through space that is free at the moment it moves."""
    out = [dict(tile) for tile in tiles]
    for tile in _sorted_reading(out):
        others = [other for other in out if other is not tile]
        while tile["y"] > 0 and not any(
            _overlaps({**tile, "y": tile["y"] - 1}, other) for other in others
        ):
            tile["y"] -= 1
        while tile["x"] > 0 and not any(
            _overlaps({**tile, "x": tile["x"] - 1}, other) for other in others
        ):
            tile["x"] -= 1
    return _sorted_reading(out)


def _intersection_area(a: Tile, b: Rect) -> int:
    dx = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    dy = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return dx * dy if dx > 0 and dy > 0 else 0


def move(tiles: list[Tile], session_id: str, x: int, y: int) -> list[Tile]:
    """Cascade-and-compact packing reorder with a swap fallback.

    The target is clamped into the canvas; overlapped tiles cascade down and
    everything compacts (the moved tile is not pinned). When the cascade
    cannot resolve inside the canvas, or the compacted result is identical
    to the input, the move falls back to swapping rects with the tile that
    overlaps the target rect most (ties → reading order). No overlapped tile
    either → no-op. Unknown id → input unchanged (sorted).
    """
    original = _copy_sorted(tiles)
    target = next((tile for tile in original if tile["session_id"] == session_id), None)
    if target is None:
        return original
    original_rect: Rect = {k: target[k] for k in ("x", "y", "w", "h")}
    tx = max(0, min(x, GRID_COLS - target["w"]))
    ty = max(0, min(y, GRID_ROWS - target["h"]))
    target_rect: Rect = {"x": tx, "y": ty, "w": target["w"], "h": target["h"]}

    working = [dict(tile) for tile in original]
    for tile in working:
        if tile["session_id"] == session_id:
            tile["x"] = tx
            tile["y"] = ty
    candidate = compact(_push_down(working, session_id))
    if all(_in_bounds(tile) for tile in candidate) and candidate != original:
        return candidate

    overlapped = [
        tile
        for tile in original
        if tile["session_id"] != session_id and _intersection_area(tile, target_rect) > 0
    ]
    if not overlapped:
        return original
    best = overlapped[0]
    for tile in overlapped[1:]:
        if _intersection_area(tile, target_rect) > _intersection_area(best, target_rect):
            best = tile
    swapped: list[Tile] = []
    for tile in original:
        if tile["session_id"] == session_id:
            swapped.append({**tile, **{k: best[k] for k in ("x", "y", "w", "h")}})
        elif tile["session_id"] == best["session_id"]:
            swapped.append({**tile, **original_rect})
        else:
            swapped.append(dict(tile))
    return _sorted_reading(swapped)


def resize(tiles: list[Tile], session_id: str, w: int, h: int) -> list[Tile]:
    """Clamp to the invariants, cascade collisions down, compact. No swap
    fallback: an unresolvable cascade returns the input unchanged (sorted)."""
    original = _copy_sorted(tiles)
    target = next((tile for tile in original if tile["session_id"] == session_id), None)
    if target is None:
        return original
    working = [dict(tile) for tile in original]
    for tile in working:
        if tile["session_id"] == session_id:
            tile["w"] = max(MIN_TILE_SIZE, min(w, GRID_COLS - tile["x"]))
            tile["h"] = max(MIN_TILE_SIZE, min(h, GRID_ROWS - tile["y"]))
    candidate = compact(_push_down(working, session_id))
    if not all(_in_bounds(tile) for tile in candidate):
        return original
    return candidate


def _expand_into_free_space(tiles: list[Tile]) -> list[Tile]:
    """One expansion pass in reading order: grow right, then down, against
    the current (already expanded) sizes of the others."""
    out = [dict(tile) for tile in tiles]
    for tile in _sorted_reading(out):
        others = [other for other in out if other is not tile]
        cells = _occupied_cells(others)
        while tile["x"] + tile["w"] < GRID_COLS and _area_free(
            cells, tile["x"] + tile["w"], tile["y"], 1, tile["h"]
        ):
            tile["w"] += 1
        while tile["y"] + tile["h"] < GRID_ROWS and _area_free(
            cells, tile["x"], tile["y"] + tile["h"], tile["w"], 1
        ):
            tile["h"] += 1
    return _sorted_reading(out)


def remove(tiles: list[Tile], session_id: str) -> list[Tile]:
    """Drop a tile, compact, then expand survivors to keep the canvas
    filled. Unknown id → input unchanged (sorted), no compaction."""
    original = _copy_sorted(tiles)
    if not any(tile["session_id"] == session_id for tile in original):
        return original
    remaining = [tile for tile in original if tile["session_id"] != session_id]
    return _expand_into_free_space(compact(remaining))


def _round_half_up(value: float) -> int:
    return math.floor(value + 0.5)


def _split_tree_rects(
    node: dict[str, Any] | None,
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    out: list[tuple[str, float, float, float, float]],
) -> None:
    if not isinstance(node, dict):
        return
    if node.get("type") == "pane":
        pane_id = node.get("agent_id")
        if isinstance(pane_id, str) and pane_id:
            out.append((pane_id, x0, y0, x1, y1))
        return
    ratio = node.get("ratio", 0.5)
    if not isinstance(ratio, int | float) or isinstance(ratio, bool):
        ratio = 0.5
    ratio = max(0.0, min(1.0, float(ratio)))
    a = node.get("a")
    b = node.get("b")
    # The split coordinate is computed once and shared by both children.
    if node.get("direction") == "row":
        s = x0 + ratio * (x1 - x0)
        _split_tree_rects(a, x0, y0, s, y1, out)
        _split_tree_rects(b, s, y0, x1, y1, out)
    else:
        s = y0 + ratio * (y1 - y0)
        _split_tree_rects(a, x0, y0, x1, s, out)
        _split_tree_rects(b, x0, s, x1, y1, out)


def _split_tree_panes(node: dict[str, Any] | None, out: list[str]) -> None:
    """Pane ids in v1 DFS order (a then b) for the auto-place fallback."""
    if not isinstance(node, dict):
        return
    if node.get("type") == "pane":
        pane_id = node.get("agent_id")
        if isinstance(pane_id, str) and pane_id:
            out.append(pane_id)
        return
    _split_tree_panes(node.get("a"), out)
    _split_tree_panes(node.get("b"), out)


def from_split_tree(root: dict[str, Any] | None) -> list[Tile]:
    """Convert a v1 split tree to v2 tiles (migration 0031).

    Float edges are assigned recursively from ``(0, 0, 12, 12)`` and rounded
    with ``floor(v + 0.5)``. If any rounded tile ends below the 3×3 minimum,
    out of bounds, or overlapping, the whole layout falls back to repeated
    ``auto_place`` over the panes in v1 DFS order. Trees with more than 8
    panes keep the first 8. The v1 pane ``agent_id`` becomes the tile
    ``session_id`` verbatim.
    """
    float_rects: list[tuple[str, float, float, float, float]] = []
    _split_tree_rects(root, 0.0, 0.0, float(GRID_COLS), float(GRID_ROWS), float_rects)
    if not float_rects:
        return []

    tiles: list[Tile] = []
    for pane_id, fx0, fy0, fx1, fy1 in float_rects:
        x0 = _round_half_up(fx0)
        y0 = _round_half_up(fy0)
        x1 = _round_half_up(fx1)
        y1 = _round_half_up(fy1)
        tiles.append({"session_id": pane_id, "x": x0, "y": y0, "w": x1 - x0, "h": y1 - y0})
    if len(tiles) <= MAX_TILES and validate_tiles(tiles):
        return _sorted_reading(tiles)

    panes: list[str] = []
    _split_tree_panes(root, panes)
    panes = list(dict.fromkeys(panes))
    placed: list[Tile] = []
    for pane_id in panes[:MAX_TILES]:
        placed, rect = auto_place(placed)
        if rect is None:
            break
        placed.append({"session_id": pane_id, **rect})
    return _sorted_reading(placed)
