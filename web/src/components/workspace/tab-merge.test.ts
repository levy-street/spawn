import { describe, expect, test } from "bun:test";
import { GRID_SIZE, MAX_TILES, MIN_TILE_SIZE, type Tile } from "@/lib/grid";
import type { LayoutV3 } from "@/lib/tabs";
import { blockMinSize, planMerge, scaleBlock, WHOLE_CANVAS } from "./tab-merge";

function tile(id: string, x: number, y: number, w: number, h: number): Tile {
  return { session_id: id, x, y, w, h };
}

function envelope(tabs: Array<{ id: string; tiles?: Tile[] }>): LayoutV3 {
  return {
    version: 3,
    active_tab: tabs[0]?.id ?? null,
    tabs: tabs.map(({ id, tiles }) => ({
      id,
      name: id,
      layout: { version: 3, tiles: tiles ?? [] },
    })),
  };
}

/** A row of `n` equal columns filling the canvas. */
function columns(n: number): Tile[] {
  const width = GRID_SIZE / n;
  return Array.from({ length: n }, (_, i) => tile(`c${i}`, i * width, 0, width, GRID_SIZE));
}

/** A stack of `n` equal rows filling the canvas. */
function rows(n: number): Tile[] {
  const height = GRID_SIZE / n;
  return Array.from({ length: n }, (_, i) => tile(`r${i}`, 0, i * height, GRID_SIZE, height));
}

const QUAD: Tile[] = [
  tile("q0", 0, 0, 12, 12),
  tile("q1", 12, 0, 12, 12),
  tile("q2", 0, 12, 12, 12),
  tile("q3", 12, 12, 12, 12),
];

describe("blockMinSize", () => {
  test("one window needs no more than the canvas minimum", () => {
    expect(blockMinSize([tile("a", 0, 0, GRID_SIZE, GRID_SIZE)])).toEqual({
      w: MIN_TILE_SIZE,
      h: MIN_TILE_SIZE,
    });
  });

  test("the arrangement decides, not the count: a row needs width, a stack height", () => {
    // Four in a row: four minimums across, one down. The same four stacked is
    // that answer turned on its side.
    expect(blockMinSize(columns(4))).toEqual({ w: 4 * MIN_TILE_SIZE, h: MIN_TILE_SIZE });
    expect(blockMinSize(rows(4))).toEqual({ w: MIN_TILE_SIZE, h: 4 * MIN_TILE_SIZE });
    // And four in a square needs twice the minimum each way — half the width
    // of the same four in a row, for the same number of windows.
    expect(blockMinSize(QUAD)).toEqual({ w: 2 * MIN_TILE_SIZE, h: 2 * MIN_TILE_SIZE });
  });

  test("an empty block asks for nothing", () => {
    expect(blockMinSize([])).toEqual({ w: MIN_TILE_SIZE, h: MIN_TILE_SIZE });
  });

  test("every size from the minimum up really does fit", () => {
    // The point of the definition: not "the first size that works" but "the
    // size above every one that fails", so a caller can gate on `>=`.
    for (const block of [columns(3), rows(3), QUAD, columns(6)]) {
      const min = blockMinSize(block);
      for (let w = min.w; w <= GRID_SIZE; w++) {
        for (let h = min.h; h <= GRID_SIZE; h++) {
          expect(scaleBlock(block, { x: 0, y: 0, w, h })).not.toBeNull();
        }
      }
      // And a cell under the minimum on either axis is genuinely refused.
      if (min.w > MIN_TILE_SIZE) {
        expect(scaleBlock(block, { x: 0, y: 0, w: min.w - 1, h: GRID_SIZE })).toBeNull();
      }
      if (min.h > MIN_TILE_SIZE) {
        expect(scaleBlock(block, { x: 0, y: 0, w: GRID_SIZE, h: min.h - 1 })).toBeNull();
      }
    }
  });
});

describe("scaleBlock", () => {
  test("a whole-canvas block laid on the whole canvas is unchanged", () => {
    expect(scaleBlock(QUAD, WHOLE_CANVAS)).toEqual(QUAD);
  });

  test("windows keep their share of the tab they came from", () => {
    const block = [tile("a", 0, 0, 6, 24), tile("b", 6, 0, 18, 24)];
    // A quarter and three quarters, in a two-thirds-width region: 4 cells
    // and 12.
    expect(scaleBlock(block, { x: 8, y: 0, w: 16, h: 24 })).toEqual([
      tile("a", 8, 0, 4, 24),
      tile("b", 12, 0, 12, 24),
    ]);
    // Narrow enough that the quarter falls under the canvas minimum and the
    // whole block is refused, rather than one window being crushed.
    expect(blockMinSize(block)).toEqual({ w: 14, h: MIN_TILE_SIZE });
    expect(scaleBlock(block, { x: 11, y: 0, w: 13, h: 24 })).toBeNull();
  });

  test("windows that met still meet — no seam, no overlap", () => {
    const scaled = scaleBlock(QUAD, { x: 5, y: 5, w: 13, h: 13 }) as Tile[];
    const [q0, q1, q2, q3] = scaled;
    expect(q0.x + q0.w).toBe(q1.x);
    expect(q0.y + q0.h).toBe(q2.y);
    expect(q1.x).toBe(q3.x);
    // And the block fills exactly what it was given.
    expect(Math.min(...scaled.map((t) => t.x))).toBe(5);
    expect(Math.max(...scaled.map((t) => t.x + t.w))).toBe(18);
    expect(Math.max(...scaled.map((t) => t.y + t.h))).toBe(18);
  });

  test("a widget rides along with its tile", () => {
    const files = { kind: "files" as const, host_id: "h", path: "/tmp" };
    const scaled = scaleBlock([{ ...tile("w", 0, 0, 24, 24), widget: files }], {
      x: 0,
      y: 0,
      w: 12,
      h: 24,
    });
    expect(scaled?.[0]).toEqual({ ...tile("w", 0, 0, 12, 24), widget: files });
  });
});

describe("planMerge", () => {
  const twoTabs = (targetTiles: Tile[], sourceTiles: Tile[]) =>
    envelope([
      { id: "target", tiles: targetTiles },
      { id: "source", tiles: sourceTiles },
    ]);

  test("a region takes the block whole and closes the emptied tab", () => {
    const layout = twoTabs([tile("t0", 0, 0, 12, 24)], columns(2));
    const { plan } = planMerge(layout, "source", "target", {
      kind: "region",
      rect: { x: 12, y: 0, w: 12, h: 24 },
    });
    expect(plan?.layout.tabs.map((tab) => tab.id)).toEqual(["target"]);
    expect(plan?.layout.active_tab).toBe("target");
    expect(plan?.incoming).toEqual([tile("c0", 12, 0, 6, 24), tile("c1", 18, 0, 6, 24)]);
    // The target's own window is untouched — free canvas was filled, nothing
    // was pushed aside.
    expect(plan?.resting).toContainEqual(tile("t0", 0, 0, 12, 24));
  });

  test("a dock halves the window it lands on and takes that half", () => {
    const layout = twoTabs([tile("t0", 0, 0, 24, 24)], columns(2));
    const { plan } = planMerge(layout, "source", "target", {
      kind: "dock",
      paneId: "t0",
      zone: "right",
    });
    expect(plan?.resting).toContainEqual(tile("t0", 0, 0, 12, 24));
    expect(plan?.incoming).toEqual([tile("c0", 12, 0, 6, 24), tile("c1", 18, 0, 6, 24)]);
  });

  test("an empty tab takes the block exactly as it was", () => {
    const layout = twoTabs([], QUAD);
    const { plan } = planMerge(layout, "source", "target", {
      kind: "region",
      rect: WHOLE_CANVAS,
    });
    expect(plan?.incoming).toEqual(QUAD);
  });

  test("aiming at a region under the block's minimum is refused, not squeezed", () => {
    const layout = twoTabs([tile("t0", 0, 0, 18, 24)], columns(4));
    // Four columns need 16 cells across; the opening left here is 6.
    const { plan, refusal } = planMerge(layout, "source", "target", {
      kind: "region",
      rect: { x: 18, y: 0, w: 6, h: 24 },
    });
    expect(plan).toBeNull();
    expect(refusal).toBe("fit");
  });

  test("a canvas already at its window limit refuses before any aiming", () => {
    const size = GRID_SIZE / 4;
    const packed = Array.from({ length: MAX_TILES }, (_, i) =>
      tile(`f${i}`, (i % size) * 4, Math.floor(i / size) * 4, 4, 4),
    );
    const layout = twoTabs(packed, [tile("s0", 0, 0, 24, 24)]);
    const { plan, refusal } = planMerge(layout, "source", "target", { kind: "auto" });
    expect(plan).toBeNull();
    expect(refusal).toBe("capacity");
  });

  test("aimed at nothing, the windows are auto-placed one by one", () => {
    const layout = twoTabs([tile("t0", 0, 0, 24, 24)], columns(2));
    const { plan } = planMerge(layout, "source", "target", { kind: "auto" });
    expect(plan?.layout.tabs.map((tab) => tab.id)).toEqual(["target"]);
    expect(plan?.incoming.map((t) => t.session_id).sort()).toEqual(["c0", "c1"]);
    expect(plan?.resting).toHaveLength(3);
  });

  test("an unknown or self-directed merge is not a refusal, just nothing", () => {
    const layout = twoTabs([], columns(2));
    expect(planMerge(layout, "ghost", "target", { kind: "auto" })).toEqual({
      plan: null,
      refusal: null,
    });
    expect(planMerge(layout, "target", "target", { kind: "auto" })).toEqual({
      plan: null,
      refusal: null,
    });
  });
});
