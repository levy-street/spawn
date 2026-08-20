import { describe, expect, test } from "bun:test";
import { MAX_TILES, type Tile, validate } from "@/lib/grid";
import {
  addPaneTiles,
  dockInsert,
  dockPane,
  dockZoneAt,
  freeRects,
  type GridDivider,
  gridDividers,
  insertPane,
  moveDivider,
  moveIdInOrder,
  movePane,
  repackMobileTiles,
  resizeEdges,
  tilePixelRect,
} from "./workspace-grid-helpers";

describe("workspace grid view helpers", () => {
  test("converts units to edge-to-edge pixels", () => {
    expect(tilePixelRect({ x: 6, y: 12, w: 12, h: 6 }, 1200, 600)).toEqual({
      left: 300,
      top: 300,
      width: 600,
      height: 150,
    });
  });

  test("dockZoneAt picks the nearest edge", () => {
    expect(dockZoneAt(0.1, 0.5)).toBe("left");
    expect(dockZoneAt(0.9, 0.5)).toBe("right");
    expect(dockZoneAt(0.5, 0.1)).toBe("top");
    expect(dockZoneAt(0.5, 0.9)).toBe("bottom");
  });

  test("dockPane stacks two columns vertically when dropped on the lower half", () => {
    const columns: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 24 },
    ];
    // b dropped on a's bottom zone: a absorbs b's vacated column (growing to
    // full width), then splits horizontally — b takes the bottom half.
    expect(dockPane(columns, "b", "a", "bottom")).toEqual([
      { session_id: "a", x: 0, y: 0, w: 24, h: 12 },
      { session_id: "b", x: 0, y: 12, w: 24, h: 12 },
    ]);
  });

  test("dockPane against a side splits the target vertically", () => {
    const rows: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 24, h: 12 },
      { session_id: "b", x: 0, y: 12, w: 24, h: 12 },
    ];
    expect(dockPane(rows, "b", "a", "left")).toEqual([
      { session_id: "b", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "a", x: 12, y: 0, w: 12, h: 24 },
    ]);
  });

  test("dockPane keeps the odd cell on the target and carries widgets", () => {
    // Deliberately not a band (w and c are half-height), so the split path
    // runs rather than the even rebalance.
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 15, h: 24 },
      {
        session_id: "w",
        x: 15,
        y: 0,
        w: 9,
        h: 12,
        widget: { kind: "files", host_id: "h", path: "/tmp" },
      },
      { session_id: "c", x: 15, y: 12, w: 9, h: 12 },
    ];
    const result = dockPane(tiles, "w", "a", "right");
    // c absorbs w's rect, then a's odd 15 splits 8 / 7 — the target keeps the
    // odd cell, and the widget rides along untouched.
    expect(result).toContainEqual({
      session_id: "w",
      x: 8,
      y: 0,
      w: 7,
      h: 24,
      widget: { kind: "files", host_id: "h", path: "/tmp" },
    });
    expect(result).toContainEqual({ session_id: "a", x: 0, y: 0, w: 8, h: 24 });
  });

  test("dockPane refuses targets too small to split", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 18 },
      { session_id: "c", x: 12, y: 18, w: 12, h: 6 },
    ];
    // Even after absorbing a's column, c is 3 tall — a vertical split would
    // break the 2-cell minimum, so the dock is refused.
    expect(dockPane(tiles, "a", "c", "top")).toBeNull();
  });

  test("movePane onto empty canvas simply relocates the tile", () => {
    const tiles: Tile[] = [{ session_id: "a", x: 0, y: 0, w: 12, h: 12 }];
    expect(movePane(tiles, "a", 12, 12)).toEqual([{ session_id: "a", x: 12, y: 12, w: 12, h: 12 }]);
  });

  test("movePane compresses against the far edge instead of pinning", () => {
    const tiles: Tile[] = [{ session_id: "a", x: 0, y: 0, w: 12, h: 12 }];
    // Dragged past the bottom: the pane keeps moving and gives up height.
    expect(movePane(tiles, "a", 0, 18)).toEqual([{ session_id: "a", x: 0, y: 18, w: 12, h: 6 }]);
    // At the very edge it bottoms out at the minimum size.
    expect(movePane(tiles, "a", 0, 40)).toEqual([{ session_id: "a", x: 0, y: 20, w: 12, h: 4 }]);
    expect(movePane(tiles, "a", 22, 0)).toEqual([{ session_id: "a", x: 20, y: 0, w: 4, h: 12 }]);
  });

  test("movePane pushes an overlapped pane aside instead of swapping", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 24 },
    ];
    // Full overlap: b slides into the space a vacated; sizes stay put.
    expect(movePane(tiles, "a", 12, 0)).toEqual([
      { session_id: "b", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "a", x: 12, y: 0, w: 12, h: 24 },
    ]);
  });

  test("movePane cascades pushes through a chain of panes", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 12 },
      { session_id: "b", x: 12, y: 0, w: 6, h: 12 },
      { session_id: "c", x: 18, y: 0, w: 6, h: 12 },
    ];
    // a lands on b; b shoves right into c, which drops below.
    const result = movePane(tiles, "a", 12, 0);
    expect(result).toContainEqual({ session_id: "a", x: 12, y: 0, w: 12, h: 12 });
    expect(validate({ version: 3, tiles: result }).ok).toBe(true);
  });

  test("movePane refuses a push that cannot resolve in bounds", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 24 },
    ];
    // Half-overlap: b cannot slide anywhere, so nothing moves.
    expect(movePane(tiles, "a", 6, 0)).toEqual(tiles);
  });

  test("builds a valid full-width mobile stack", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 24 },
      { session_id: "c", x: 0, y: 12, w: 12, h: 12 },
    ];
    const packed = repackMobileTiles(tiles, ["c", "a", "b"]);
    expect(packed.map((tile) => [tile.session_id, tile.x, tile.y, tile.w, tile.h])).toEqual([
      ["c", 0, 0, 24, 8],
      ["a", 0, 8, 24, 8],
      ["b", 0, 16, 24, 8],
    ]);
    expect(validate({ version: 3, tiles: packed }).ok).toBe(true);
  });

  test("preserves valid geometry when more than four panes are reordered", () => {
    const tiles: Tile[] = Array.from({ length: 8 }, (_, index) => ({
      session_id: String(index),
      x: (index % 4) * 6,
      y: index < 4 ? 0 : 12,
      w: 6,
      h: 12,
    }));
    const packed = repackMobileTiles(tiles, [...tiles.map((tile) => tile.session_id)].reverse());
    expect(validate({ version: 3, tiles: packed }).ok).toBe(true);
    expect(packed[0]?.session_id).toBe("7");
  });

  test("finds the seam two side-by-side panes share", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 24 },
    ];
    expect(gridDividers(tiles)).toEqual([
      {
        id: "vertical-12-0",
        axis: "vertical",
        line: 12,
        start: 0,
        end: 24,
        before: ["a"],
        after: ["b"],
        min: 4,
        max: 20,
      },
    ]);
  });

  test("a seam spans only the run where panes actually meet", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 12 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 12 },
      { session_id: "c", x: 0, y: 12, w: 24, h: 12 },
    ];
    const vertical = gridDividers(tiles).filter((divider) => divider.axis === "vertical");
    expect(vertical.map((divider) => [divider.line, divider.start, divider.end])).toEqual([
      [12, 0, 12],
    ]);
  });

  test("dragging a seam trades width between both sides", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 24 },
    ];
    const [divider] = gridDividers(tiles) as [GridDivider];
    expect(moveDivider(tiles, divider, 16)).toEqual([
      { session_id: "a", x: 0, y: 0, w: 16, h: 24 },
      { session_id: "b", x: 16, y: 0, w: 8, h: 24 },
    ]);
    // Past the 2-cell minimum the drag clamps instead of producing junk.
    expect(moveDivider(tiles, divider, 22)).toEqual([
      { session_id: "a", x: 0, y: 0, w: 20, h: 24 },
      { session_id: "b", x: 20, y: 0, w: 4, h: 24 },
    ]);
    expect(validate({ version: 3, tiles: moveDivider(tiles, divider, 22) }).ok).toBe(true);
  });

  test("a shared row seam moves every pane that touches it", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 12 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 12 },
      { session_id: "c", x: 0, y: 12, w: 12, h: 12 },
      { session_id: "d", x: 12, y: 12, w: 12, h: 12 },
    ];
    const divider = gridDividers(tiles).find(
      (candidate) => candidate.axis === "horizontal",
    ) as GridDivider;
    expect(moveDivider(tiles, divider, 8)).toEqual([
      { session_id: "a", x: 0, y: 0, w: 12, h: 8 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 8 },
      { session_id: "c", x: 0, y: 8, w: 12, h: 16 },
      { session_id: "d", x: 12, y: 8, w: 12, h: 16 },
    ]);
  });

  test("carves the empty canvas into placeable rectangles", () => {
    const tiles: Tile[] = [{ session_id: "a", x: 0, y: 0, w: 12, h: 12 }];
    // Largest first: the right column, then what is left below the tile.
    expect(freeRects(tiles)).toEqual([
      { x: 12, y: 0, w: 12, h: 24 },
      { x: 0, y: 12, w: 12, h: 12 },
    ]);
  });

  test("a full canvas has nowhere to drop a pane", () => {
    expect(freeRects([{ session_id: "a", x: 0, y: 0, w: 24, h: 24 }])).toEqual([]);
    // Gaps under 2 cells cannot hold a tile, so they are not offered.
    expect(freeRects([{ session_id: "a", x: 0, y: 0, w: 22, h: 24 }])).toEqual([]);
    expect(freeRects([{ session_id: "a", x: 0, y: 0, w: 20, h: 24 }])).toEqual([
      { x: 20, y: 0, w: 4, h: 24 },
    ]);
  });

  test("moves ids without mutating the source", () => {
    const ids = ["a", "b", "c"];
    expect(moveIdInOrder(ids, "b", -1)).toEqual(["b", "a", "c"]);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});

describe("resizeEdges", () => {
  const columns: Tile[] = [
    { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
    { session_id: "b", x: 12, y: 0, w: 12, h: 24 },
  ];

  test("growing an edge into a flush neighbour shrinks it like a splitter", () => {
    expect(resizeEdges(columns, "a", { right: 16 })).toEqual([
      { session_id: "a", x: 0, y: 0, w: 16, h: 24 },
      { session_id: "b", x: 16, y: 0, w: 8, h: 24 },
    ]);
  });

  test("shrinking an edge lets the flush neighbour follow and keep the seam", () => {
    expect(resizeEdges(columns, "b", { left: 16 })).toEqual([
      { session_id: "a", x: 0, y: 0, w: 16, h: 24 },
      { session_id: "b", x: 16, y: 0, w: 8, h: 24 },
    ]);
  });

  test("clamps at the neighbour's 2-cell minimum", () => {
    expect(resizeEdges(columns, "a", { right: 24 })).toEqual([
      { session_id: "a", x: 0, y: 0, w: 20, h: 24 },
      { session_id: "b", x: 20, y: 0, w: 4, h: 24 },
    ]);
  });

  test("an edge facing empty canvas grows freely and stops at a gapped tile", () => {
    const gapped: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 24 },
      { session_id: "b", x: 18, y: 0, w: 6, h: 24 },
    ];
    expect(resizeEdges(gapped, "a", { right: 22 })).toEqual([
      { session_id: "a", x: 0, y: 0, w: 18, h: 24 },
      { session_id: "b", x: 18, y: 0, w: 6, h: 24 },
    ]);
  });

  test("a follower wider than the dragged tile stays put when growth would overlap", () => {
    // c spans the full height to the right; above-right of a sits d, which
    // blocks c from following a's shrinking right edge.
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 12, w: 12, h: 12 },
      { session_id: "c", x: 12, y: 0, w: 12, h: 24 },
      { session_id: "d", x: 0, y: 0, w: 12, h: 12 },
    ];
    const result = resizeEdges(tiles, "a", { right: 8 });
    expect(result).toContainEqual({ session_id: "a", x: 0, y: 12, w: 8, h: 12 });
    expect(result).toContainEqual({ session_id: "c", x: 12, y: 0, w: 12, h: 24 });
    expect(validate({ version: 3, tiles: result }).ok).toBe(true);
  });

  test("a corner drag moves both axes; a blocked axis does not stop the other", () => {
    const stack: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 24, h: 12 },
      { session_id: "b", x: 0, y: 12, w: 24, h: 12 },
    ];
    // Bottom-right corner of a: width is pinned (full row), height trades.
    expect(resizeEdges(stack, "a", { right: 24, bottom: 16 })).toEqual([
      { session_id: "a", x: 0, y: 0, w: 24, h: 16 },
      { session_id: "b", x: 0, y: 16, w: 24, h: 8 },
    ]);
  });

  test("unknown ids and no-op targets return the input unchanged", () => {
    expect(resizeEdges(columns, "nope", { right: 16 })).toEqual(columns);
    expect(resizeEdges(columns, "a", { right: 12 })).toEqual(columns);
  });

  test("every result stays valid across a fuzz of single-edge drags", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 12 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 16 },
      { session_id: "c", x: 0, y: 12, w: 12, h: 12 },
      { session_id: "d", x: 12, y: 16, w: 12, h: 8 },
    ];
    for (const id of ["a", "b", "c", "d"]) {
      for (const edge of ["left", "right", "top", "bottom"] as const) {
        for (let line = -2; line <= 14; line++) {
          const result = resizeEdges(tiles, id, { [edge]: line });
          expect(validate({ version: 3, tiles: result }).ok).toBe(true);
        }
      }
    }
  });
});

describe("duplicating a pane onto the canvas", () => {
  const columns: Tile[] = [
    { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
    { session_id: "b", x: 12, y: 0, w: 12, h: 24 },
  ];

  test("dockInsert splits the target and leaves everything else alone", () => {
    const result = dockInsert(columns, "copy", "a", "bottom");
    expect(result).toEqual([
      { session_id: "a", x: 0, y: 0, w: 12, h: 12 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 24 },
      { session_id: "copy", x: 0, y: 12, w: 12, h: 12 },
    ]);
  });

  test("dockInsert refuses a target too small to halve", () => {
    const tight: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 6 },
      { session_id: "b", x: 6, y: 0, w: 18, h: 24 },
    ];
    expect(dockInsert(tight, "copy", "a", "left")).toBeNull();
  });

  test("dockInsert refuses once the canvas is at the tile cap", () => {
    const full: Tile[] = Array.from({ length: MAX_TILES }, (_, index) => ({
      session_id: `t${index}`,
      x: (index % 4) * 6,
      y: index < 4 ? 0 : 12,
      w: 6,
      h: 12,
    }));
    expect(dockInsert(full, "copy", "t0", "bottom")).toBeNull();
  });

  test("insertPane drops a new tile at the cell, pushing what it lands on", () => {
    const result = insertPane(
      [{ session_id: "a", x: 0, y: 0, w: 12, h: 12 }],
      "copy",
      { w: 4, h: 4 },
      2,
      0,
    );
    expect(result).not.toBeNull();
    expect(validate({ version: 3, tiles: result ?? [] }).ok).toBe(true);
    expect(result?.find((tile) => tile.session_id === "copy")).toEqual({
      session_id: "copy",
      x: 2,
      y: 0,
      w: 4,
      h: 4,
    });
  });

  test("insertPane keeps the source pane on the canvas — a copy displaces, never replaces", () => {
    const single: Tile[] = [{ session_id: "a", x: 0, y: 0, w: 12, h: 12 }];
    const result = insertPane(single, "copy", { w: 6, h: 6 }, 0, 0);
    expect(result?.map((tile) => tile.session_id).sort()).toEqual(["a", "copy"]);
  });

  test("insertPane refuses when the newcomer has nowhere to push the occupants", () => {
    // Two full-height halves: a third full-height half cannot fit, and the
    // cascade would have to shove a column off the canvas.
    expect(insertPane(columns, "copy", { w: 6, h: 12 }, 0, 0)).toBeNull();
  });

  test("insertPane refuses an id that is already placed", () => {
    expect(insertPane(columns, "a", { w: 2, h: 2 }, 0, 0)).toBeNull();
  });

  test("insertPane refuses once the canvas is at the tile cap", () => {
    const full: Tile[] = Array.from({ length: MAX_TILES }, (_, index) => ({
      session_id: `t${index}`,
      x: (index % 4) * 6,
      y: index < 4 ? 0 : 12,
      w: 6,
      h: 12,
    }));
    expect(insertPane(full, "copy", { w: 2, h: 2 }, 0, 0)).toBeNull();
  });

  test("every insert lands a valid layout across a sweep of drop cells", () => {
    for (let x = -2; x <= 13; x++) {
      for (let y = -2; y <= 13; y++) {
        const result = insertPane(columns, "copy", { w: 4, h: 4 }, x, y);
        if (result === null) continue;
        expect(validate({ version: 3, tiles: result }).ok).toBe(true);
        expect(result.some((tile) => tile.session_id === "copy")).toBe(true);
      }
    }
  });
});

describe("even redistribution across a band", () => {
  /** Three equal full-height columns — the shape the packed grid settles into. */
  const thirds: Tile[] = [
    { session_id: "a", x: 0, y: 0, w: 8, h: 24 },
    { session_id: "b", x: 8, y: 0, w: 8, h: 24 },
    { session_id: "c", x: 16, y: 0, w: 8, h: 24 },
  ];

  test("a fourth column joins as an equal quarter instead of halving one", () => {
    expect(dockInsert(thirds, "copy", "b", "right")).toEqual([
      { session_id: "a", x: 0, y: 0, w: 6, h: 24 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 24 },
      { session_id: "copy", x: 12, y: 0, w: 6, h: 24 },
      { session_id: "c", x: 18, y: 0, w: 6, h: 24 },
    ]);
  });

  test("the zone picks the side, so a left drop lands before the target", () => {
    const ids = dockInsert(thirds, "copy", "b", "left")?.map((tile) => tile.session_id);
    expect(ids).toEqual(["a", "copy", "b", "c"]);
  });

  test("a fifth column shares out the canvas as evenly as it divides", () => {
    const quarters: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 24 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 24 },
      { session_id: "c", x: 12, y: 0, w: 6, h: 24 },
      { session_id: "d", x: 18, y: 0, w: 6, h: 24 },
    ];
    expect(dockInsert(quarters, "copy", "d", "right")?.map((tile) => tile.w)).toEqual([
      5, 5, 5, 5, 4,
    ]);
  });

  test("rows rebalance the same way", () => {
    const rows: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 24, h: 12 },
      { session_id: "b", x: 0, y: 12, w: 24, h: 12 },
    ];
    expect(dockInsert(rows, "copy", "a", "bottom")).toEqual([
      { session_id: "a", x: 0, y: 0, w: 24, h: 8 },
      { session_id: "copy", x: 0, y: 8, w: 24, h: 8 },
      { session_id: "b", x: 0, y: 16, w: 24, h: 8 },
    ]);
  });

  test("a band too crowded to split evenly falls back to halving the target", () => {
    const sixths: Tile[] = Array.from({ length: 6 }, (_, index) => ({
      session_id: `t${index}`,
      x: index * 2,
      y: 0,
      w: 2,
      h: 12,
    }));
    // A seventh column would be under the 4-cell minimum, and a 4-wide target
    // cannot be halved either — so there is nowhere to put it.
    expect(dockInsert(sixths, "copy", "t0", "right")).toBeNull();
  });

  test("an irregular canvas still just halves the target", () => {
    const ragged: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 12 },
      { session_id: "c", x: 12, y: 12, w: 12, h: 12 },
    ];
    expect(dockInsert(ragged, "copy", "a", "right")).toEqual([
      { session_id: "a", x: 0, y: 0, w: 6, h: 24 },
      { session_id: "copy", x: 6, y: 0, w: 6, h: 24 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 12 },
      { session_id: "c", x: 12, y: 12, w: 12, h: 12 },
    ]);
  });

  test("moving a pane inside a band reorders it and keeps the columns even", () => {
    const ids = dockPane(thirds, "c", "a", "left")?.map((tile) => tile.session_id);
    expect(ids).toEqual(["c", "a", "b"]);
    expect(dockPane(thirds, "c", "a", "left")?.map((tile) => tile.w)).toEqual([8, 8, 8]);
  });

  test("docking across the band's grain still splits the occupant", () => {
    // Columns are not a row-band, so a top drop halves the column it lands in.
    expect(dockPane(thirds, "c", "a", "top")).toEqual([
      { session_id: "c", x: 0, y: 0, w: 8, h: 12 },
      { session_id: "b", x: 8, y: 0, w: 16, h: 24 },
      { session_id: "a", x: 0, y: 12, w: 8, h: 12 },
    ]);
  });
});

describe("adding a pane with nothing aimed at", () => {
  test("a band takes one more equal slice rather than halving its widest", () => {
    const thirds: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 8, h: 24 },
      { session_id: "b", x: 8, y: 0, w: 8, h: 24 },
      { session_id: "c", x: 16, y: 0, w: 8, h: 24 },
    ];
    expect(addPaneTiles(thirds, "new")).toEqual([
      { session_id: "a", x: 0, y: 0, w: 6, h: 24 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 24 },
      { session_id: "c", x: 12, y: 0, w: 6, h: 24 },
      { session_id: "new", x: 18, y: 0, w: 6, h: 24 },
    ]);
  });

  test("a row band grows downward", () => {
    const rows: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 24, h: 12 },
      { session_id: "b", x: 0, y: 12, w: 24, h: 12 },
    ];
    expect(addPaneTiles(rows, "new")?.map((tile) => [tile.session_id, tile.y, tile.h])).toEqual([
      ["a", 0, 8],
      ["b", 8, 8],
      ["new", 16, 8],
    ]);
  });

  test("open canvas is still filled by the wire algebra", () => {
    expect(addPaneTiles([], "new")).toEqual([{ session_id: "new", x: 0, y: 0, w: 24, h: 24 }]);
  });

  test("an irregular canvas falls back to auto-place", () => {
    const ragged: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 24 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 12 },
    ];
    const added = addPaneTiles(ragged, "new");
    expect(validate({ version: 3, tiles: added ?? [] }).ok).toBe(true);
    expect(added?.find((tile) => tile.session_id === "new")).toEqual({
      session_id: "new",
      x: 12,
      y: 12,
      w: 12,
      h: 12,
    });
  });

  test("a full canvas has nowhere to put one", () => {
    const full: Tile[] = Array.from({ length: MAX_TILES }, (_, index) => ({
      session_id: `t${index}`,
      x: (index % 4) * 6,
      y: Math.floor(index / 4) * 6,
      w: 6,
      h: 6,
    }));
    expect(addPaneTiles(full, "new")).toBeNull();
  });
});
