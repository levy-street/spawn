import assert from "node:assert/strict";
import fixturesJson from "../../../proto/layout-v2-fixtures.json";
import {
  autoPlace,
  compact,
  fromSplitTree,
  GRID_SIZE,
  MAX_TILES,
  MIN_TILE_SIZE,
  move,
  readingOrder,
  remove,
  resize,
  type SplitTreeNode,
  type Tile,
  validate,
} from "./grid";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void | Promise<void>): void;

function T(session_id: string, x: number, y: number, w: number, h: number): Tile {
  return { session_id, x, y, w, h };
}

function pane(agent_id: string): SplitTreeNode {
  return { type: "pane", agent_id };
}

function split(
  direction: "row" | "column",
  ratio: number,
  a: SplitTreeNode,
  b: SplitTreeNode,
): SplitTreeNode {
  return { type: "split", direction, ratio, a, b };
}

function assertValid(tiles: Tile[], context: string): void {
  const result = validate({ version: 2, tiles });
  assert.deepStrictEqual(result, { ok: true, errors: [] }, `${context}: ${JSON.stringify(tiles)}`);
}

// ---------------------------------------------------------------------------
// Conformance: every case in proto/layout-v2-fixtures.json must pass. The
// fixture file is the shared contract with server/spawn_server/grid.py.
// ---------------------------------------------------------------------------

interface FixtureCase {
  name: string;
  op: string;
  input: {
    layout?: unknown;
    tiles?: Tile[];
    id?: string;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    root?: SplitTreeNode | null;
  };
  expected: unknown;
}

const fixtures = fixturesJson as unknown as {
  _doc: string;
  _rules: string[];
  cases: FixtureCase[];
};

function runFixture(c: FixtureCase): unknown {
  const input = c.input;
  switch (c.op) {
    case "validate":
      return validate(input.layout);
    case "autoPlace":
      return autoPlace(input.tiles as Tile[]);
    case "move":
      return {
        tiles: move(
          input.tiles as Tile[],
          input.id as string,
          input.x as number,
          input.y as number,
        ),
      };
    case "resize":
      return {
        tiles: resize(
          input.tiles as Tile[],
          input.id as string,
          input.w as number,
          input.h as number,
        ),
      };
    case "remove":
      return { tiles: remove(input.tiles as Tile[], input.id as string) };
    case "compact":
      return { tiles: compact(input.tiles as Tile[]) };
    case "readingOrder":
      return { order: readingOrder(input.tiles as Tile[]) };
    case "fromSplitTree":
      return { tiles: fromSplitTree(input.root ?? null) };
    default:
      throw new Error(`unknown fixture op: ${c.op}`);
  }
}

describe("layout-v2 fixture conformance", () => {
  test("suite is present and complete", () => {
    assert.ok(fixtures.cases.length >= 40, `expected >= 40 cases, got ${fixtures.cases.length}`);
    const ops = new Set(fixtures.cases.map((c) => c.op));
    for (const op of [
      "validate",
      "autoPlace",
      "move",
      "resize",
      "remove",
      "compact",
      "readingOrder",
      "fromSplitTree",
    ]) {
      assert.ok(ops.has(op), `no fixture cases for ${op}`);
    }
    const names = new Set(fixtures.cases.map((c) => c.name));
    assert.strictEqual(names.size, fixtures.cases.length, "duplicate fixture case names");
  });

  for (const c of fixtures.cases) {
    test(`fixture: ${c.name}`, () => {
      const snapshot = structuredClone(c.input);
      assert.deepStrictEqual(runFixture(c), c.expected);
      assert.deepStrictEqual(c.input, snapshot, "operation mutated its input");
    });
  }
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

describe("validate", () => {
  test("rejects non-object layouts", () => {
    for (const bad of [null, undefined, 42, "layout", [T("a", 0, 0, 3, 3)]]) {
      assert.deepStrictEqual(validate(bad), { ok: false, errors: [{ code: "shape" }] });
    }
  });

  test("rejects non-object and malformed tile entries", () => {
    const result = validate({ version: 2, tiles: [null] });
    assert.deepStrictEqual(result.errors, [
      { code: "session_id", index: 0 },
      { code: "integer", index: 0 },
    ]);
  });

  test("NaN and non-number fields are integer errors", () => {
    for (const x of [Number.NaN, "3", undefined]) {
      const result = validate({ version: 2, tiles: [{ session_id: "a", x, y: 0, w: 3, h: 3 }] });
      assert.deepStrictEqual(result.errors, [{ code: "integer", index: 0 }]);
    }
  });

  test("integer failure suppresses bounds and size for that tile", () => {
    const result = validate({
      version: 2,
      tiles: [{ session_id: "a", x: 0.5, y: -4, w: 99, h: 1 }],
    });
    assert.deepStrictEqual(result.errors, [{ code: "integer", index: 0 }]);
  });

  test("out-of-bounds tiles are excluded from overlap checks", () => {
    const result = validate({
      version: 2,
      tiles: [T("a", 9, 0, 6, 6), T("b", 9, 0, 3, 12)],
    });
    assert.deepStrictEqual(result.errors, [{ code: "bounds", index: 0 }]);
  });

  test("reports every overlapping pair in index order", () => {
    const result = validate({
      version: 2,
      tiles: [T("a", 0, 0, 12, 12), T("b", 0, 0, 6, 6), T("c", 6, 6, 6, 6)],
    });
    assert.deepStrictEqual(result.errors, [
      { code: "overlap", index: 0, other_index: 1 },
      { code: "overlap", index: 0, other_index: 2 },
    ]);
  });

  test("empty-string session_id is rejected", () => {
    const result = validate({ version: 2, tiles: [T("", 0, 0, 3, 3)] });
    assert.deepStrictEqual(result.errors, [{ code: "session_id", index: 0 }]);
  });
});

// ---------------------------------------------------------------------------
// autoPlace
// ---------------------------------------------------------------------------

describe("autoPlace", () => {
  test("width expansion runs at height 3; height expansion stops at obstacles", () => {
    // The 3×3 scan hit at (0,0) widens across the full top band (the obstacle
    // starts at row 3), then the downward expansion is blocked by it.
    const placed = autoPlace([T("a", 6, 3, 3, 3)]);
    assert.deepStrictEqual(placed.tile, { x: 0, y: 0, w: 12, h: 3 });
  });

  test("returned tile carries no session_id and tiles come back sorted", () => {
    const placed = autoPlace([T("b", 6, 0, 6, 12), T("a", 0, 0, 6, 6)]);
    assert.deepStrictEqual(placed.tile, { x: 0, y: 6, w: 6, h: 6 });
    assert.deepStrictEqual(
      placed.tiles.map((t) => t.session_id),
      ["a", "b"],
    );
  });

  test("filling an empty grid one tile at a time reaches 8 valid tiles", () => {
    let tiles: Tile[] = [];
    for (let i = 0; i < MAX_TILES; i++) {
      const placed = autoPlace(tiles);
      assert.ok(placed.tile, `placement ${i + 1} returned null`);
      tiles = [...placed.tiles, { session_id: `s${i}`, ...placed.tile }];
      assertValid(tiles, `after placement ${i + 1}`);
    }
    assert.strictEqual(tiles.length, MAX_TILES);
    assert.deepStrictEqual(autoPlace(tiles).tile, null);
  });

  test("split fallback keeps both halves at least 3 wide", () => {
    // Full canvas of 7 tiles; the 6×6 victim splits into 3+3.
    const tiles = [
      T("a", 0, 0, 3, 6),
      T("b", 3, 0, 3, 6),
      T("c", 6, 0, 3, 6),
      T("d", 9, 0, 3, 6),
      T("e", 0, 6, 3, 6),
      T("f", 3, 6, 3, 6),
      T("g", 6, 6, 6, 6),
    ];
    const placed = autoPlace(tiles);
    assert.ok(placed.tile);
    const appended = [...placed.tiles, { session_id: "h", ...placed.tile }];
    assertValid(appended, "after split fallback");
    assert.strictEqual(appended.length, 8);
  });
});

// ---------------------------------------------------------------------------
// move / resize
// ---------------------------------------------------------------------------

describe("move", () => {
  test("moving a tile onto its own spot in a packed layout is the identity", () => {
    const tiles = [T("a", 0, 0, 6, 12), T("b", 6, 0, 6, 12)];
    assert.deepStrictEqual(move(tiles, "a", 0, 0), tiles);
  });

  test("a pipeline move (no swap) preserves every tile's size", () => {
    const tiles = [T("a", 0, 0, 12, 3), T("b", 0, 3, 12, 3), T("c", 0, 6, 6, 6)];
    const moved = move(tiles, "b", 0, 0);
    for (const t of tiles) {
      const after = moved.find((m) => m.session_id === t.session_id);
      assert.ok(after);
      assert.strictEqual(after.w, t.w);
      assert.strictEqual(after.h, t.h);
    }
  });

  test("swap fallback exchanges rects wholesale, including sizes", () => {
    const tiles = [T("a", 0, 0, 4, 12), T("b", 4, 0, 8, 12)];
    assert.deepStrictEqual(move(tiles, "a", 4, 0), [T("b", 0, 0, 4, 12), T("a", 4, 0, 8, 12)]);
  });

  test("swap fallback is skipped when the pipeline produces a real change", () => {
    // Reordering rows succeeds via push-down, so no rects are exchanged even
    // though the dragged tile fully overlaps another at its target.
    const tiles = [T("a", 0, 0, 12, 3), T("b", 0, 3, 12, 3), T("c", 0, 6, 12, 3)];
    assert.deepStrictEqual(move(tiles, "c", 0, 0), [
      T("c", 0, 0, 12, 3),
      T("a", 0, 3, 12, 3),
      T("b", 0, 6, 12, 3),
    ]);
  });
});

describe("resize", () => {
  test("growing into free space needs no cascade", () => {
    assert.deepStrictEqual(resize([T("a", 0, 0, 6, 6)], "a", 12, 12), [T("a", 0, 0, 12, 12)]);
  });

  test("only the target tile's size may change", () => {
    const tiles = [T("a", 0, 0, 12, 3), T("b", 0, 3, 12, 3), T("c", 0, 6, 12, 3)];
    const resized = resize(tiles, "a", 12, 9);
    for (const t of tiles) {
      const after = resized.find((m) => m.session_id === t.session_id);
      assert.ok(after);
      if (t.session_id !== "a") {
        assert.strictEqual(after.w, t.w);
        assert.strictEqual(after.h, t.h);
      }
    }
    assertValid(resized, "after resize");
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("remove", () => {
  test("expansion happens in reading order against already-expanded neighbors", () => {
    // Removing h frees (9,6)-(11,11); d (earlier in reading order) claims it
    // downward before g gets the chance to widen.
    const tiles = [
      T("a", 0, 0, 3, 6),
      T("b", 3, 0, 3, 6),
      T("c", 6, 0, 3, 6),
      T("d", 9, 0, 3, 6),
      T("e", 0, 6, 3, 6),
      T("f", 3, 6, 3, 6),
      T("g", 6, 6, 3, 6),
      T("h", 9, 6, 3, 6),
    ];
    const removed = remove(tiles, "h");
    assert.deepStrictEqual(
      removed.find((t) => t.session_id === "d"),
      T("d", 9, 0, 3, 12),
    );
    assert.deepStrictEqual(
      removed.find((t) => t.session_id === "g"),
      T("g", 6, 6, 3, 6),
    );
    assertValid(removed, "after remove");
  });
});

// ---------------------------------------------------------------------------
// fromSplitTree
// ---------------------------------------------------------------------------

describe("fromSplitTree", () => {
  test("every ratio-extreme combination yields a valid layout", () => {
    const ratios = [0.05, 0.15, 0.25, 0.3333333333333333, 0.5, 0.6, 0.75, 0.85, 0.95];
    for (const r1 of ratios) {
      for (const r2 of ratios) {
        const tiles = fromSplitTree(
          split("row", r1, pane("a"), split("column", r2, pane("b"), pane("c"))),
        );
        assertValid(tiles, `ratios ${r1}/${r2}`);
        assert.deepStrictEqual(readingOrder(tiles).slice().sort(), ["a", "b", "c"]);
      }
    }
  });

  test("depth-12 alternating tree caps at 8 tiles, first 8 in DFS order", () => {
    let tree: SplitTreeNode = pane("p13");
    for (let depth = 12; depth >= 1; depth--) {
      const direction = depth % 2 === 0 ? "column" : "row";
      tree = split(direction, 0.5, pane(`p${String(depth).padStart(2, "0")}`), tree);
    }
    const tiles = fromSplitTree(tree);
    assert.strictEqual(tiles.length, MAX_TILES);
    assert.deepStrictEqual(tiles.map((t) => t.session_id).sort(), [
      "p01",
      "p02",
      "p03",
      "p04",
      "p05",
      "p06",
      "p07",
      "p08",
    ]);
    assertValid(tiles, "depth-12 tree");
  });

  test("clean rounding keeps all pane ids and the split proportions", () => {
    const tiles = fromSplitTree(split("row", 0.25, pane("left"), pane("right")));
    assert.deepStrictEqual(tiles, [T("left", 0, 0, 3, 12), T("right", 3, 0, 9, 12)]);
  });

  test("out-of-range ratios are clamped, then rescued by the fallback", () => {
    const tiles = fromSplitTree(split("row", 1.5, pane("a"), pane("b")));
    assertValid(tiles, "ratio 1.5");
    assert.strictEqual(tiles.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Property: any sequence of operations preserves the invariants.
// Deterministic seeded LCG — the module itself stays randomness-free.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("property: op sequences", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`every layout stays valid across 200 random ops (seed ${seed})`, () => {
      const rng = makeRng(seed);
      const int = (n: number) => Math.floor(rng() * n);
      let tiles: Tile[] = [];
      let counter = 0;
      for (let step = 0; step < 200; step++) {
        const op = tiles.length === 0 ? 0 : int(4);
        if (op === 0) {
          if (tiles.length < MAX_TILES) {
            const placed = autoPlace(tiles);
            if (placed.tile) {
              tiles = [...placed.tiles, { session_id: `s${counter++}`, ...placed.tile }];
            }
          }
        } else {
          const id = tiles[int(tiles.length)].session_id;
          if (op === 1) {
            // A swap may exchange sizes between two tiles, so move preserves
            // the multiset of sizes and the set of ids, not per-tile sizes.
            const sizesOf = (list: Tile[]) => list.map((t) => `${t.w}x${t.h}`).sort();
            const idsOf = (list: Tile[]) => list.map((t) => t.session_id).sort();
            const sizesBefore = sizesOf(tiles);
            const idsBefore = idsOf(tiles);
            tiles = move(tiles, id, int(GRID_SIZE + 2) - 1, int(GRID_SIZE + 2) - 1);
            assert.deepStrictEqual(sizesOf(tiles), sizesBefore, `step ${step}: sizes changed`);
            assert.deepStrictEqual(idsOf(tiles), idsBefore, `step ${step}: ids changed`);
          } else if (op === 2) {
            tiles = resize(tiles, id, int(GRID_SIZE + 2), int(GRID_SIZE + 2));
          } else {
            const countBefore = tiles.length;
            tiles = remove(tiles, id);
            assert.strictEqual(tiles.length, countBefore - 1);
            assert.ok(!tiles.some((t) => t.session_id === id));
          }
        }
        assertValid(tiles, `seed ${seed} step ${step}`);
        assert.ok(tiles.length <= MAX_TILES);
        for (const t of tiles) {
          assert.ok(t.w >= MIN_TILE_SIZE && t.h >= MIN_TILE_SIZE);
        }
        const order = readingOrder(tiles);
        assert.strictEqual(new Set(order).size, tiles.length);
      }
    });
  }
});
