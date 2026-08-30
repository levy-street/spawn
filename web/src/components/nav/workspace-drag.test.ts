import { describe, expect, test } from "bun:test";
import {
  dragModeAt,
  dropZones,
  type PaneTarget,
  pairRows,
  pointInRect,
  type Rect,
  reorderShift,
  reorderTargetIndex,
  reorderWrites,
  sideOf,
  splitDrop,
  zoneAt,
} from "./workspace-drag";

/** A box from its two corners, so the cases below read as coordinates. */
function rect(left: number, top: number, right: number, bottom: number): Rect {
  return { left, top, right, bottom };
}

/** The rail as an expanded sidebar on a 1440 window. */
const RAIL = rect(0, 0, 260, 900);

/** Rows in a rail: 36px tall on the list's 8px rhythm, first one at y=100. */
function rows(count: number): Rect[] {
  return Array.from({ length: count }, (_, index) =>
    rect(8, 100 + index * 44, 252, 136 + index * 44),
  );
}

describe("pointInRect", () => {
  test("counts every edge as inside", () => {
    expect(pointInRect(0, 0, RAIL)).toBe(true);
    expect(pointInRect(260, 900, RAIL)).toBe(true);
    expect(pointInRect(260.5, 400, RAIL)).toBe(false);
    expect(pointInRect(-0.5, 400, RAIL)).toBe(false);
  });
});

describe("dragModeAt", () => {
  test("reorders while the pointer is over the rail", () => {
    expect(dragModeAt(120, 300, RAIL)).toBe("reorder");
  });

  test("carries once the pointer crosses out into the canvas", () => {
    expect(dragModeAt(400, 300, RAIL)).toBe("carry");
  });

  test("the rail's own edge is still the rail", () => {
    expect(dragModeAt(260, 300, RAIL)).toBe("reorder");
    expect(dragModeAt(261, 300, RAIL)).toBe("carry");
  });

  test("leaving the rail vertically carries too", () => {
    expect(dragModeAt(120, -20, RAIL)).toBe("carry");
    expect(dragModeAt(120, 1000, RAIL)).toBe("carry");
  });

  test("a rail that is not on screen keeps the gesture where it started", () => {
    expect(dragModeAt(900, 300, null)).toBe("reorder");
  });
});

describe("reorderTargetIndex", () => {
  const four = rows(4);

  test("a row released where it started keeps its index", () => {
    expect(reorderTargetIndex(118, four, 0)).toBe(0);
    expect(reorderTargetIndex(250, four, 2)).toBe(2);
  });

  test("counts the midpoints the release point has passed", () => {
    // Row 0 dragged past rows 1 and 2's midpoints (162 and 206) but not 3's.
    expect(reorderTargetIndex(210, four, 0)).toBe(2);
    expect(reorderTargetIndex(260, four, 0)).toBe(3);
  });

  test("dragging upward counts from the top", () => {
    expect(reorderTargetIndex(110, four, 3)).toBe(0);
    expect(reorderTargetIndex(150, four, 3)).toBe(1);
  });

  test("a midpoint exactly under the pointer has not been passed", () => {
    const midOfRowOne = four[1].top + 18;
    expect(reorderTargetIndex(midOfRowOne, four, 0)).toBe(0);
    expect(reorderTargetIndex(midOfRowOne + 0.5, four, 0)).toBe(1);
  });

  test("rows with no measured rect are skipped rather than counted", () => {
    expect(reorderTargetIndex(9999, [four[0], null, undefined, four[3]], 0)).toBe(1);
  });

  test("a release far outside the list clamps to the ends", () => {
    expect(reorderTargetIndex(-5000, four, 2)).toBe(0);
    expect(reorderTargetIndex(5000, four, 2)).toBe(3);
  });
});

describe("reorderShift", () => {
  test("the dragged row never shifts itself", () => {
    expect(reorderShift(1, 1, 3, 44)).toBe(0);
  });

  test("moving down lifts everything it passes", () => {
    expect(reorderShift(2, 1, 3, 44)).toBe(-44);
    expect(reorderShift(3, 1, 3, 44)).toBe(-44);
    expect(reorderShift(4, 1, 3, 44)).toBe(0);
    expect(reorderShift(0, 1, 3, 44)).toBe(0);
  });

  test("moving up drops everything it passes", () => {
    expect(reorderShift(1, 3, 1, 44)).toBe(44);
    expect(reorderShift(2, 3, 1, 44)).toBe(44);
    expect(reorderShift(0, 3, 1, 44)).toBe(0);
    expect(reorderShift(4, 3, 1, 44)).toBe(0);
  });

  test("a row dropped back where it came from leaves the list alone", () => {
    for (const index of [0, 1, 2, 3]) expect(reorderShift(index, 2, 2, 44)).toBe(0);
  });
});

describe("dropZones", () => {
  const whole: PaneTarget = { side: "primary", rect: rect(268, 56, 1432, 892) };

  test("one workspace on screen offers its root as two halves", () => {
    expect(dropZones([whole], 0.5)).toEqual([
      { side: "primary", rect: rect(268, 56, 850, 892) },
      { side: "secondary", rect: rect(850, 56, 1432, 892) },
    ]);
  });

  test("the halves are cut where the seam will land, not down the middle", () => {
    // The preview is drawn in these rectangles, so an off-centre seam has to
    // move the boundary the pointer flips at along with it.
    expect(dropZones([whole], 0.25)).toEqual([
      { side: "primary", rect: rect(268, 56, 559, 892) },
      { side: "secondary", rect: rect(559, 56, 1432, 892) },
    ]);
  });

  test("a ratio outside the seam's bounds is clamped, not obeyed", () => {
    expect(dropZones([whole], 0)[0]?.rect.right).toBe(559);
    expect(dropZones([whole], 5)[0]?.rect.right).toBe(1141);
  });

  test("two workspaces get one zone each, whole", () => {
    const panes: PaneTarget[] = [
      { side: "primary", rect: rect(268, 56, 850, 892) },
      { side: "secondary", rect: rect(858, 56, 1432, 892) },
    ];
    expect(dropZones(panes, 0.5)).toEqual(
      panes.map((pane) => ({ side: pane.side, rect: pane.rect })),
    );
  });

  test("two workspaces keep their own widths whatever the stored ratio says", () => {
    const panes: PaneTarget[] = [
      { side: "primary", rect: rect(268, 56, 850, 892) },
      { side: "secondary", rect: rect(858, 56, 1432, 892) },
    ];
    expect(dropZones(panes, 0.3)).toEqual(dropZones(panes, 0.7));
  });

  test("no workspace on screen offers nothing to drop onto", () => {
    expect(dropZones([], 0.5)).toEqual([]);
  });
});

describe("zoneAt", () => {
  const zones = dropZones([{ side: "primary", rect: rect(268, 56, 1432, 892) }], 0.5);

  test("picks the half the pointer is in", () => {
    expect(zoneAt(400, 400, zones)?.side).toBe("primary");
    expect(zoneAt(1200, 400, zones)?.side).toBe("secondary");
  });

  test("the seam between the halves belongs to the left one", () => {
    // The two halves share the midpoint and both claim it; taking the first
    // keeps the boundary from being a dead pixel neither zone answers for.
    expect(zoneAt(850, 400, zones)?.side).toBe("primary");
    expect(zoneAt(850.5, 400, zones)?.side).toBe("secondary");
  });

  test("a pointer outside every zone is over nothing", () => {
    expect(zoneAt(120, 400, zones)).toBeNull();
    expect(zoneAt(700, 20, zones)).toBeNull();
    expect(zoneAt(700, 1000, zones)).toBeNull();
  });
});

describe("splitDrop", () => {
  /** One workspace on the canvas, and two, as `splitDrop` is handed them. */
  const alone = { primary: "a", secondary: null };
  const split = { primary: "a", secondary: "b" };

  test("one workspace, dropped left: the dragged one takes the front and it moves across", () => {
    expect(splitDrop("primary", "b", alone)).toEqual({ primary: "b", secondary: "a" });
  });

  test("one workspace, dropped right: the split opens beside the one already up", () => {
    expect(splitDrop("secondary", "b", alone)).toEqual({ primary: "a", secondary: "b" });
  });

  test("one workspace, dropping the workspace already on screen changes nothing", () => {
    expect(splitDrop("primary", "a", alone)).toBeNull();
    expect(splitDrop("secondary", "a", alone)).toBeNull();
  });

  test("split, dropped left: the left occupant is displaced and the right holds", () => {
    expect(splitDrop("primary", "c", split)).toEqual({ primary: "c", secondary: "b" });
  });

  test("split, dropped right: the right occupant is displaced and the left holds", () => {
    expect(splitDrop("secondary", "c", split)).toEqual({ primary: "a", secondary: "c" });
  });

  test("split, dropped on the half it is already in: nothing to do", () => {
    expect(splitDrop("primary", "a", split)).toBeNull();
    expect(splitDrop("secondary", "b", split)).toBeNull();
  });

  test("split, dropped on the other half: the two swap and nobody is displaced", () => {
    expect(splitDrop("primary", "b", split)).toEqual({ primary: "b", secondary: "a" });
    expect(splitDrop("secondary", "a", split)).toEqual({ primary: "b", secondary: "a" });
  });

  test("the arrangement is read off the canvas, not off the route", () => {
    // A pair whose right-hand workspace is the one the URL is about: the drop
    // still lands where it was aimed, and the left half is still the left one.
    expect(splitDrop("secondary", "c", { primary: "a", secondary: "b" })).toEqual({
      primary: "a",
      secondary: "c",
    });
  });

  test("nothing on screen means there is nothing to split against", () => {
    expect(splitDrop("primary", "b", { primary: null, secondary: null })).toBeNull();
    expect(splitDrop("secondary", "b", { primary: null, secondary: null })).toBeNull();
    expect(splitDrop("primary", "", alone)).toBeNull();
  });
});

describe("sideOf", () => {
  test("names the half a workspace occupies", () => {
    expect(sideOf("a", { primary: "a", secondary: "b" })).toBe("primary");
    expect(sideOf("b", { primary: "a", secondary: "b" })).toBe("secondary");
  });

  test("a workspace that is in neither half is displaced, not defaulted to one", () => {
    expect(sideOf("c", { primary: "a", secondary: "b" })).toBeNull();
    expect(sideOf("b", { primary: "a", secondary: null })).toBeNull();
  });
});

describe("dropZones against a live DOMRect", () => {
  /**
   * A stand-in for `DOMRect`: edges on the prototype, nothing own-enumerable.
   * This is what `getBoundingClientRect` actually hands back, and building a
   * zone by spreading one silently produces a rect with no edges — which
   * typechecks, because it structurally satisfies `Rect`.
   */
  class ProtoRect {
    constructor(
      private readonly l: number,
      private readonly t: number,
      private readonly r: number,
      private readonly b: number,
    ) {}
    get left() {
      return this.l;
    }
    get top() {
      return this.t;
    }
    get right() {
      return this.r;
    }
    get bottom() {
      return this.b;
    }
  }

  test("a rect whose edges are prototype getters still yields real zones", () => {
    // The trap itself: spreading such a rect carries none of the four edges
    // the zone maths reads, so every comparison against the result is
    // `x >= undefined` and no point is ever inside anything.
    expect({ ...new ProtoRect(0, 0, 800, 600) }).not.toHaveProperty("left");

    const zones = dropZones([{ side: "primary", rect: new ProtoRect(200, 0, 1000, 600) }], 0.5);

    expect(zones).toEqual([
      { side: "primary", rect: { left: 200, top: 0, right: 600, bottom: 600 } },
      { side: "secondary", rect: { left: 600, top: 0, right: 1000, bottom: 600 } },
    ]);
  });

  test("a point over the pane always finds a zone, either side of the seam", () => {
    const zones = dropZones([{ side: "primary", rect: new ProtoRect(200, 0, 1000, 600) }], 0.5);
    expect(zoneAt(300, 300, zones)?.side).toBe("primary");
    expect(zoneAt(900, 300, zones)?.side).toBe("secondary");
    // The seam itself belongs to a half rather than to neither.
    expect(zoneAt(600, 300, zones)).not.toBeNull();
  });
});

describe("pairRows", () => {
  const ids = ["a", "b", "c", "d"];

  test("no split leaves every workspace in a row of its own", () => {
    expect(pairRows(ids, "b", null)).toEqual([["a"], ["b"], ["c"], ["d"]]);
    expect(pairRows(ids, null, null)).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });

  test("a split collapses to one row where the upper of the two was", () => {
    expect(pairRows(ids, "b", "d")).toEqual([["a"], ["b", "d"], ["c"]]);
  });

  test("the row sits at the upper slot even when the secondary is the upper one", () => {
    // Anchored at b's slot, but still listed primary-then-secondary: the two
    // containers are drawn left to right to match the halves on screen.
    expect(pairRows(ids, "d", "b")).toEqual([["a"], ["d", "b"], ["c"]]);
  });

  test("adjacent workspaces pair without disturbing anything around them", () => {
    expect(pairRows(ids, "b", "c")).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  test("a workspace the list cannot see leaves both of them as ordinary rows", () => {
    expect(pairRows(ids, "b", "zz")).toEqual([["a"], ["b"], ["c"], ["d"]]);
  });
});

describe("reorderWrites", () => {
  const singles = (...ids: string[]) => ids.map((id) => [id]);

  test("a row of one workspace writes exactly the one position it always did", () => {
    // The guarantee the existing gesture rests on: with no pair on screen this
    // is the single `{id, position: targetRowIndex}` write it has always made.
    expect(reorderWrites(singles("a", "b", "c"), 0, 2)).toEqual([{ id: "a", position: 2 }]);
    expect(reorderWrites(singles("a", "b", "c"), 2, 0)).toEqual([{ id: "c", position: 0 }]);
    expect(reorderWrites(singles("a", "b", "c"), 1, 1)).toEqual([{ id: "b", position: 1 }]);
  });

  test("rows above a pair count the workspaces it holds, not the row", () => {
    // [a,b] is one row but two positions, so dropping d below it is position 3.
    const rows = [["a", "b"], ["c"], ["d"]];
    expect(reorderWrites(rows, 2, 1)).toEqual([{ id: "d", position: 2 }]);
    expect(reorderWrites(rows, 2, 0)).toEqual([{ id: "d", position: 0 }]);
  });

  test("a pair dragged to the front lands both, in order", () => {
    const rows = [["x"], ["a", "b"], ["y"]];
    expect(reorderWrites(rows, 1, 0)).toEqual([
      { id: "a", position: 0 },
      { id: "b", position: 1 },
    ]);
  });

  test("a pair dragged to the end lands both, in order", () => {
    const rows = [["a", "b"], ["x"]];
    expect(reorderWrites(rows, 0, 1)).toEqual([
      { id: "a", position: 2 },
      { id: "b", position: 2 },
    ]);
  });

  test("the writes actually produce the intended order when replayed in sequence", () => {
    // Each write is a remove-and-reinsert, exactly as the server applies it.
    const replay = (start: string[], writes: { id: string; position: number }[]) =>
      writes.reduce((list, write) => {
        const without = list.filter((id) => id !== write.id);
        return [...without.slice(0, write.position), write.id, ...without.slice(write.position)];
      }, start);

    const cases: [string[][], number, number, string[]][] = [
      [[["a", "b"], ["x"]], 0, 1, ["x", "a", "b"]],
      [[["x"], ["a", "b"], ["y"]], 1, 0, ["a", "b", "x", "y"]],
      [[["x"], ["a", "b"], ["y"]], 1, 2, ["x", "y", "a", "b"]],
      [[["x"], ["y"], ["a", "b"]], 2, 1, ["x", "a", "b", "y"]],
      [[["a", "b"], ["x"], ["y"]], 0, 2, ["x", "y", "a", "b"]],
    ];
    for (const [rows, from, target, expected] of cases) {
      expect(replay(rows.flat(), reorderWrites(rows, from, target))).toEqual(expected);
    }
  });

  test("a row index that holds nothing asks for no writes at all", () => {
    expect(reorderWrites([["a"], ["b"]], 5, 0)).toEqual([]);
  });
});
