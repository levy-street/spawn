import { describe, expect, test } from "bun:test";
import { type Tile, validate } from "@/lib/grid";
import {
  dockPane,
  dockZoneAt,
  freeRects,
  type GridDivider,
  gridDividers,
  moveDivider,
  moveIdInOrder,
  movePane,
  repackMobileTiles,
  resizeEdges,
  tilePixelRect,
} from "./workspace-grid-helpers";

describe("workspace grid view helpers", () => {
  test("converts units to edge-to-edge pixels", () => {
    expect(tilePixelRect({ x: 3, y: 6, w: 6, h: 3 }, 1200, 600)).toEqual({
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
      { session_id: "a", x: 0, y: 0, w: 6, h: 12 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 12 },
    ];
    // b dropped on a's bottom zone: a absorbs b's vacated column (growing to
    // full width), then splits horizontally — b takes the bottom half.
    expect(dockPane(columns, "b", "a", "bottom")).toEqual([
      { session_id: "a", x: 0, y: 0, w: 12, h: 6 },
      { session_id: "b", x: 0, y: 6, w: 12, h: 6 },
    ]);
  });

  test("dockPane against a side splits the target vertically", () => {
    const rows: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 6 },
      { session_id: "b", x: 0, y: 6, w: 12, h: 6 },
    ];
    expect(dockPane(rows, "b", "a", "left")).toEqual([
      { session_id: "b", x: 0, y: 0, w: 6, h: 12 },
      { session_id: "a", x: 6, y: 0, w: 6, h: 12 },
    ]);
  });

  test("dockPane keeps the odd cell on the target and carries widgets", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 7, h: 12 },
      {
        session_id: "w",
        x: 7,
        y: 0,
        w: 5,
        h: 12,
        widget: { kind: "files", host_id: "h", path: "/tmp" },
      },
    ];
    const result = dockPane(tiles, "w", "a", "right");
    // a's rect after absorbing w's column is 12 wide; w takes the right 6.
    expect(result).toContainEqual({
      session_id: "w",
      x: 6,
      y: 0,
      w: 6,
      h: 12,
      widget: { kind: "files", host_id: "h", path: "/tmp" },
    });
    expect(result).toContainEqual({ session_id: "a", x: 0, y: 0, w: 6, h: 12 });
  });

  test("dockPane refuses targets too small to split", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 12 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 9 },
      { session_id: "c", x: 6, y: 9, w: 6, h: 3 },
    ];
    // Even after absorbing a's column, c is 3 tall — a vertical split would
    // break the 2-cell minimum, so the dock is refused.
    expect(dockPane(tiles, "a", "c", "top")).toBeNull();
  });

  test("movePane onto empty canvas simply relocates the tile", () => {
    const tiles: Tile[] = [{ session_id: "a", x: 0, y: 0, w: 6, h: 6 }];
    expect(movePane(tiles, "a", 6, 6)).toEqual([{ session_id: "a", x: 6, y: 6, w: 6, h: 6 }]);
  });

  test("movePane compresses against the far edge instead of pinning", () => {
    const tiles: Tile[] = [{ session_id: "a", x: 0, y: 0, w: 6, h: 6 }];
    // Dragged past the bottom: the pane keeps moving and gives up height.
    expect(movePane(tiles, "a", 0, 9)).toEqual([{ session_id: "a", x: 0, y: 9, w: 6, h: 3 }]);
    // At the very edge it bottoms out at the minimum size.
    expect(movePane(tiles, "a", 0, 20)).toEqual([{ session_id: "a", x: 0, y: 10, w: 6, h: 2 }]);
    expect(movePane(tiles, "a", 11, 0)).toEqual([{ session_id: "a", x: 10, y: 0, w: 2, h: 6 }]);
  });

  test("movePane pushes an overlapped pane aside instead of swapping", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 12 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 12 },
    ];
    // Full overlap: b slides into the space a vacated; sizes stay put.
    expect(movePane(tiles, "a", 6, 0)).toEqual([
      { session_id: "b", x: 0, y: 0, w: 6, h: 12 },
      { session_id: "a", x: 6, y: 0, w: 6, h: 12 },
    ]);
  });

  test("movePane cascades pushes through a chain of panes", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 6 },
      { session_id: "b", x: 6, y: 0, w: 3, h: 6 },
      { session_id: "c", x: 9, y: 0, w: 3, h: 6 },
    ];
    // a lands on b; b shoves right into c, which drops below.
    const result = movePane(tiles, "a", 6, 0);
    expect(result).toContainEqual({ session_id: "a", x: 6, y: 0, w: 6, h: 6 });
    expect(validate({ version: 2, tiles: result }).ok).toBe(true);
  });

  test("movePane refuses a push that cannot resolve in bounds", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 12 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 12 },
    ];
    // Half-overlap: b cannot slide anywhere, so nothing moves.
    expect(movePane(tiles, "a", 3, 0)).toEqual(tiles);
  });

  test("builds a valid full-width mobile stack", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 12 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 12 },
      { session_id: "c", x: 0, y: 6, w: 6, h: 6 },
    ];
    const packed = repackMobileTiles(tiles, ["c", "a", "b"]);
    expect(packed.map((tile) => [tile.session_id, tile.x, tile.y, tile.w, tile.h])).toEqual([
      ["c", 0, 0, 12, 4],
      ["a", 0, 4, 12, 4],
      ["b", 0, 8, 12, 4],
    ]);
    expect(validate({ version: 2, tiles: packed }).ok).toBe(true);
  });

  test("preserves valid geometry when more than four panes are reordered", () => {
    const tiles: Tile[] = Array.from({ length: 8 }, (_, index) => ({
      session_id: String(index),
      x: (index % 4) * 3,
      y: index < 4 ? 0 : 6,
      w: 3,
      h: 6,
    }));
    const packed = repackMobileTiles(tiles, [...tiles.map((tile) => tile.session_id)].reverse());
    expect(validate({ version: 2, tiles: packed }).ok).toBe(true);
    expect(packed[0]?.session_id).toBe("7");
  });

  test("finds the seam two side-by-side panes share", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 12 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 12 },
    ];
    expect(gridDividers(tiles)).toEqual([
      {
        id: "vertical-6-0",
        axis: "vertical",
        line: 6,
        start: 0,
        end: 12,
        before: ["a"],
        after: ["b"],
        min: 2,
        max: 10,
      },
    ]);
  });

  test("a seam spans only the run where panes actually meet", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 6 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 6 },
      { session_id: "c", x: 0, y: 6, w: 12, h: 6 },
    ];
    const vertical = gridDividers(tiles).filter((divider) => divider.axis === "vertical");
    expect(vertical.map((divider) => [divider.line, divider.start, divider.end])).toEqual([
      [6, 0, 6],
    ]);
  });

  test("dragging a seam trades width between both sides", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 12 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 12 },
    ];
    const [divider] = gridDividers(tiles) as [GridDivider];
    expect(moveDivider(tiles, divider, 8)).toEqual([
      { session_id: "a", x: 0, y: 0, w: 8, h: 12 },
      { session_id: "b", x: 8, y: 0, w: 4, h: 12 },
    ]);
    // Past the 2-cell minimum the drag clamps instead of producing junk.
    expect(moveDivider(tiles, divider, 11)).toEqual([
      { session_id: "a", x: 0, y: 0, w: 10, h: 12 },
      { session_id: "b", x: 10, y: 0, w: 2, h: 12 },
    ]);
    expect(validate({ version: 2, tiles: moveDivider(tiles, divider, 11) }).ok).toBe(true);
  });

  test("a shared row seam moves every pane that touches it", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 6 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 6 },
      { session_id: "c", x: 0, y: 6, w: 6, h: 6 },
      { session_id: "d", x: 6, y: 6, w: 6, h: 6 },
    ];
    const divider = gridDividers(tiles).find(
      (candidate) => candidate.axis === "horizontal",
    ) as GridDivider;
    expect(moveDivider(tiles, divider, 4)).toEqual([
      { session_id: "a", x: 0, y: 0, w: 6, h: 4 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 4 },
      { session_id: "c", x: 0, y: 4, w: 6, h: 8 },
      { session_id: "d", x: 6, y: 4, w: 6, h: 8 },
    ]);
  });

  test("carves the empty canvas into placeable rectangles", () => {
    const tiles: Tile[] = [{ session_id: "a", x: 0, y: 0, w: 6, h: 6 }];
    // Largest first: the right column, then what is left below the tile.
    expect(freeRects(tiles)).toEqual([
      { x: 6, y: 0, w: 6, h: 12 },
      { x: 0, y: 6, w: 6, h: 6 },
    ]);
  });

  test("a full canvas has nowhere to drop a pane", () => {
    expect(freeRects([{ session_id: "a", x: 0, y: 0, w: 12, h: 12 }])).toEqual([]);
    // Gaps under 2 cells cannot hold a tile, so they are not offered.
    expect(freeRects([{ session_id: "a", x: 0, y: 0, w: 11, h: 12 }])).toEqual([]);
    expect(freeRects([{ session_id: "a", x: 0, y: 0, w: 10, h: 12 }])).toEqual([
      { x: 10, y: 0, w: 2, h: 12 },
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
    { session_id: "a", x: 0, y: 0, w: 6, h: 12 },
    { session_id: "b", x: 6, y: 0, w: 6, h: 12 },
  ];

  test("growing an edge into a flush neighbour shrinks it like a splitter", () => {
    expect(resizeEdges(columns, "a", { right: 8 })).toEqual([
      { session_id: "a", x: 0, y: 0, w: 8, h: 12 },
      { session_id: "b", x: 8, y: 0, w: 4, h: 12 },
    ]);
  });

  test("shrinking an edge lets the flush neighbour follow and keep the seam", () => {
    expect(resizeEdges(columns, "b", { left: 8 })).toEqual([
      { session_id: "a", x: 0, y: 0, w: 8, h: 12 },
      { session_id: "b", x: 8, y: 0, w: 4, h: 12 },
    ]);
  });

  test("clamps at the neighbour's 2-cell minimum", () => {
    expect(resizeEdges(columns, "a", { right: 12 })).toEqual([
      { session_id: "a", x: 0, y: 0, w: 10, h: 12 },
      { session_id: "b", x: 10, y: 0, w: 2, h: 12 },
    ]);
  });

  test("an edge facing empty canvas grows freely and stops at a gapped tile", () => {
    const gapped: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 3, h: 12 },
      { session_id: "b", x: 9, y: 0, w: 3, h: 12 },
    ];
    expect(resizeEdges(gapped, "a", { right: 11 })).toEqual([
      { session_id: "a", x: 0, y: 0, w: 9, h: 12 },
      { session_id: "b", x: 9, y: 0, w: 3, h: 12 },
    ]);
  });

  test("a follower wider than the dragged tile stays put when growth would overlap", () => {
    // c spans the full height to the right; above-right of a sits d, which
    // blocks c from following a's shrinking right edge.
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 6, w: 6, h: 6 },
      { session_id: "c", x: 6, y: 0, w: 6, h: 12 },
      { session_id: "d", x: 0, y: 0, w: 6, h: 6 },
    ];
    const result = resizeEdges(tiles, "a", { right: 4 });
    expect(result).toContainEqual({ session_id: "a", x: 0, y: 6, w: 4, h: 6 });
    expect(result).toContainEqual({ session_id: "c", x: 6, y: 0, w: 6, h: 12 });
    expect(validate({ version: 2, tiles: result }).ok).toBe(true);
  });

  test("a corner drag moves both axes; a blocked axis does not stop the other", () => {
    const stack: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 12, h: 6 },
      { session_id: "b", x: 0, y: 6, w: 12, h: 6 },
    ];
    // Bottom-right corner of a: width is pinned (full row), height trades.
    expect(resizeEdges(stack, "a", { right: 12, bottom: 8 })).toEqual([
      { session_id: "a", x: 0, y: 0, w: 12, h: 8 },
      { session_id: "b", x: 0, y: 8, w: 12, h: 4 },
    ]);
  });

  test("unknown ids and no-op targets return the input unchanged", () => {
    expect(resizeEdges(columns, "nope", { right: 8 })).toEqual(columns);
    expect(resizeEdges(columns, "a", { right: 6 })).toEqual(columns);
  });

  test("every result stays valid across a fuzz of single-edge drags", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 6 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 8 },
      { session_id: "c", x: 0, y: 6, w: 6, h: 6 },
      { session_id: "d", x: 6, y: 8, w: 6, h: 4 },
    ];
    for (const id of ["a", "b", "c", "d"]) {
      for (const edge of ["left", "right", "top", "bottom"] as const) {
        for (let line = -2; line <= 14; line++) {
          const result = resizeEdges(tiles, id, { [edge]: line });
          expect(validate({ version: 2, tiles: result }).ok).toBe(true);
        }
      }
    }
  });
});
