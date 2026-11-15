import { describe, expect, test } from "bun:test";
import { drawnColumns, evenSizes, MIN_COLUMN_PX } from "@/lib/split-group";
import {
  type DropZone,
  dragModeAt,
  dropZones,
  groupRows,
  layoutColumns,
  type PaneTarget,
  pointInRect,
  type Rect,
  reorderShift,
  reorderTargetIndex,
  reorderWrites,
  type ShownWindow,
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

/** The workspaces a zone's release would leave on screen, left to right. */
function drawnAfter(zone: DropZone | undefined): string[] {
  return (zone?.columns ?? []).map((column) => column.workspaceId);
}

/** The canvas of a 1440 window beside an expanded sidebar: 1164px, room for four. */
const CANVAS = rect(268, 56, 1432, 892);

/** Columns laid across `CANVAS` at these shares, as panes the carry would measure. */
function panesAt(members: readonly string[], sizes: readonly number[], canvas = CANVAS) {
  return layoutColumns(canvas, { members, sizes }, { start: 0, ids: members });
}

/** The window a drop sees when these columns are all on screen, the URL on the first. */
function shown(members: string[], sizes: number[]): ShownWindow {
  return { members, sizes, drawn: members, routed: members[0] ?? null };
}

describe("dropZones: one workspace on screen", () => {
  const alone = shown(["a"], [1]);
  const panes = panesAt(["a"], [1]);

  test("offers its canvas as two halves: take the front, or open beside", () => {
    const zones = dropZones("b", alone, panes);
    expect(zones.map((zone) => zone.rect)).toEqual([
      rect(268, 56, 850, 892),
      rect(850, 56, 1432, 892),
    ]);
    expect(zones.map((zone) => zone.next?.members)).toEqual([
      ["b", "a"],
      ["a", "b"],
    ]);
    expect(zones[1]?.next?.sizes).toEqual([0.5, 0.5]);
  });

  test("the halves are cut where the seam will land, so the preview is the hit region", () => {
    const zones = dropZones("b", alone, panes);
    for (const zone of zones) {
      const placed = zone.columns.find((column) => column.workspaceId === "b");
      expect(placed?.rect).toEqual(zone.rect);
    }
  });

  test("dropping the workspace already on screen changes nothing", () => {
    const zones = dropZones("a", alone, panes);
    expect(zones).toHaveLength(1);
    expect(zones[0]?.next).toBeNull();
    expect(drawnAfter(zones[0])).toEqual(["a"]);
  });

  test("a narrow window still splits: two always fit", () => {
    const narrow = panesAt(["a"], [1], rect(320, 56, 900, 792));
    expect(dropZones("b", alone, narrow).map((zone) => zone.next?.members)).toEqual([
      ["b", "a"],
      ["a", "b"],
    ]);
  });
});

describe("dropZones: a split with room for another column", () => {
  const two = shown(["a", "b"], [0.5, 0.5]);
  const panes = panesAt(two.members, two.sizes);

  test("a workspace from outside is added, before, between or after", () => {
    const zones = dropZones("c", two, panes);
    expect(zones.map((zone) => zone.next?.members)).toEqual([
      ["c", "a", "b"],
      ["a", "c", "b"],
      ["a", "b", "c"],
    ]);
    expect(zones.map((zone) => drawnAfter(zone))).toEqual([
      ["c", "a", "b"],
      ["a", "c", "b"],
      ["a", "b", "c"],
    ]);
  });

  test("the cuts are at the middle of each column on screen, and tile the canvas", () => {
    const zones = dropZones("c", two, panes);
    expect(zones.map((zone) => [zone.rect.left, zone.rect.right])).toEqual([
      [268, 559],
      [559, 1141],
      [1141, 1432],
    ]);
  });

  test("an off-centre seam moves the cuts with the columns it divides", () => {
    const uneven = shown(["a", "b"], [0.25, 0.75]);
    const zones = dropZones("c", uneven, panesAt(uneven.members, uneven.sizes));
    expect(zones.map((zone) => [zone.rect.left, zone.rect.right])).toEqual([
      [268, 413.5],
      [413.5, 995.5],
      [995.5, 1432],
    ]);
  });

  test("three become four the same way", () => {
    const three = shown(["a", "b", "c"], [1 / 3, 1 / 3, 1 / 3]);
    const zones = dropZones("d", three, panesAt(three.members, three.sizes));
    expect(zones).toHaveLength(4);
    expect(zones[3]?.next?.members).toEqual(["a", "b", "c", "d"]);
    expect(zones[3]?.columns.map((column) => column.rect.right - column.rect.left)).toEqual([
      291, 291, 291, 291,
    ]);
  });

  test("a member dropped on another column moves there; on its own, nothing happens", () => {
    const three = shown(["a", "b", "c"], [0.5, 0.25, 0.25]);
    const zones = dropZones("a", three, panesAt(three.members, three.sizes));
    expect(zones).toHaveLength(3);
    expect(zones[0]?.next).toBeNull();
    expect(zones[2]?.next).toEqual({ members: ["b", "c", "a"], sizes: [0.5, 0.25, 0.25] });
  });

  test("with two columns, moving a member is the pair trading sides", () => {
    const zones = dropZones("b", two, panes);
    expect(zones.map((zone) => zone.next?.members ?? null)).toEqual([["b", "a"], null]);
  });
});

describe("dropZones: a full window", () => {
  test("four columns: a workspace from outside displaces the one it is dropped on", () => {
    const four = shown(["a", "b", "c", "d"], [0.25, 0.25, 0.25, 0.25]);
    const zones = dropZones("e", four, panesAt(four.members, four.sizes));
    expect(zones).toHaveLength(4);
    expect(zones.map((zone) => zone.next?.members)).toEqual([
      ["e", "b", "c", "d"],
      ["a", "e", "c", "d"],
      ["a", "b", "e", "d"],
      ["a", "b", "c", "e"],
    ]);
    // Each zone is the column itself, so the half you aim at is the one that goes.
    expect(zones[1]?.rect).toEqual(rect(559, 56, 850, 892));
  });

  test("a window too narrow for another column replaces rather than squeezing one in", () => {
    // 580px holds two columns of the minimum width, not three.
    const two = shown(["a", "b"], [0.5, 0.5]);
    const narrow = panesAt(two.members, two.sizes, rect(320, 56, 900, 792));
    expect(dropZones("c", two, narrow).map((zone) => zone.next?.members)).toEqual([
      ["c", "b"],
      ["a", "c"],
    ]);
  });

  test("the columns keep their widths when their occupants change", () => {
    const four = shown(["a", "b", "c", "d"], [0.5, 0.25, 0.125, 0.125]);
    const zones = dropZones("e", four, panesAt(four.members, four.sizes));
    expect(zones[2]?.next?.sizes).toEqual([0.5, 0.25, 0.125, 0.125]);
  });
});

describe("dropZones: a group folded on a narrow window", () => {
  // Four in the group, two drawn: b and c.
  const folded: ShownWindow = {
    members: ["a", "b", "c", "d"],
    sizes: [0.25, 0.25, 0.25, 0.25],
    drawn: ["b", "c"],
    routed: "b",
  };
  const canvas = rect(320, 56, 900, 792);
  const panes = layoutColumns(
    canvas,
    { members: ["b", "c"], sizes: [0.5, 0.5] },
    { start: 0, ids: ["b", "c"] },
  );

  test("only the drawn columns are zones", () => {
    expect(dropZones("z", folded, panes).map((zone) => zone.next?.members)).toEqual([
      ["a", "z", "c", "d"],
      ["a", "b", "z", "d"],
    ]);
  });

  test("a member that is not drawn moves to where it is dropped, and the window follows it", () => {
    const zones = dropZones("d", folded, panes);
    expect(zones[0]?.next?.members).toEqual(["a", "d", "b", "c"]);
    expect(drawnAfter(zones[0])).toEqual(["d", "b"]);
  });
});

describe("dropZones: the preview is the window the drop gives you", () => {
  /**
   * What the window draws once a drop has landed: the drop arranges the
   * group, makes the dropped workspace the active column, and moves the
   * address bar to `zone.route`; the window then asks `drawnColumns` — the
   * same rule it always draws by — starting from the run it was showing.
   */
  function windowAfter(zone: DropZone, dragged: string, capacity: number, start: number) {
    const next = zone.next;
    if (!next) throw new Error("no change to draw");
    return drawnColumns(next.members, capacity, start, dragged, zone.route).ids;
  }

  test("a hidden member dropped where the address bar's column would scroll off takes the route", () => {
    // Two fit; the split is a, b, c with a and b drawn and the URL on b. The
    // hidden c dropped onto a: the preview shows c and a. Before, the store
    // held c, a, b but the window kept drawing a and b, so c never appeared.
    const canvas = rect(0, 0, 2 * MIN_COLUMN_PX + 10, 800);
    const members = ["a", "b", "c"];
    const drawn = drawnColumns(members, 2, 0, "b", "b").ids;
    expect(drawn).toEqual(["a", "b"]);
    const panes = layoutColumns(
      canvas,
      { members: drawn, sizes: [0.5, 0.5] },
      { start: 0, ids: drawn },
    );
    const zones = dropZones("c", { members, sizes: evenSizes(3), drawn, routed: "b" }, panes);
    const ontoA = zones[0];
    expect(ontoA?.columns.map((column) => column.workspaceId)).toEqual(["c", "a"]);
    expect(ontoA?.route).toBe("c");
    expect(ontoA ? windowAfter(ontoA, "c", 2, 0) : []).toEqual(["c", "a"]);
  });

  test("every drop on a narrow window draws exactly its preview", () => {
    // The reviewer's sweep: two and three columns fitting, groups of three
    // and four, the URL on each member, every member and an outsider dragged
    // onto every zone. 98 drops, of which 11 used to draw another window.
    let drops = 0;
    for (const capacity of [2, 3]) {
      const canvas = rect(0, 0, capacity * MIN_COLUMN_PX + 10, 800);
      for (const members of [
        ["a", "b", "c"],
        ["a", "b", "c", "d"],
      ]) {
        if (members.length <= capacity) continue;
        for (const routed of members) {
          const { start, ids: drawn } = drawnColumns(members, capacity, 0, routed, routed);
          const panes = layoutColumns(
            canvas,
            { members: drawn, sizes: evenSizes(drawn.length) },
            { start: 0, ids: drawn },
          );
          const shown: ShownWindow = { members, sizes: evenSizes(members.length), drawn, routed };
          for (const dragged of [...members, "z"]) {
            for (const zone of dropZones(dragged, shown, panes)) {
              if (!zone.next) continue;
              drops += 1;
              const preview = zone.columns.map((column) => column.workspaceId);
              expect(windowAfter(zone, dragged, capacity, start)).toEqual(preview);
              // And what was dropped is on screen afterwards.
              expect(preview).toContain(dragged);
            }
          }
        }
      }
    }
    expect(drops).toBe(98);
  });
});

describe("dropZones: nothing to drop onto", () => {
  test("no workspace on screen, or no workspace in hand, offers nothing", () => {
    expect(dropZones("b", shown(["a"], [1]), [])).toEqual([]);
    expect(dropZones("", shown(["a"], [1]), panesAt(["a"], [1]))).toEqual([]);
  });
});

describe("zoneAt", () => {
  const zones = dropZones("b", shown(["a"], [1]), panesAt(["a"], [1]));

  test("picks the zone the pointer is in", () => {
    expect(zoneAt(400, 400, zones)?.next?.members).toEqual(["b", "a"]);
    expect(zoneAt(1200, 400, zones)?.next?.members).toEqual(["a", "b"]);
  });

  test("a cut between two zones belongs to the left one", () => {
    // The two zones share the cut and both claim it; taking the first keeps
    // the boundary from being a dead pixel neither zone answers for.
    expect(zoneAt(850, 400, zones)).toBe(zones[0] ?? null);
    expect(zoneAt(850.5, 400, zones)).toBe(zones[1] ?? null);
  });

  test("a pointer outside every zone is over nothing", () => {
    expect(zoneAt(120, 400, zones)).toBeNull();
    expect(zoneAt(700, 20, zones)).toBeNull();
    expect(zoneAt(700, 1000, zones)).toBeNull();
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

  const live: PaneTarget[] = [
    { workspaceId: "a", rect: new ProtoRect(200, 0, 600, 600) },
    { workspaceId: "b", rect: new ProtoRect(600, 0, 1400, 600) },
  ];

  test("a rect whose edges are prototype getters still yields real zones", () => {
    // The trap itself: spreading such a rect carries none of the four edges
    // the zone maths reads, so every comparison against the result is
    // `x >= undefined` and no point is ever inside anything.
    expect({ ...new ProtoRect(0, 0, 800, 600) }).not.toHaveProperty("left");

    const zones = dropZones("c", shown(["a", "b"], [1 / 3, 2 / 3]), live);
    expect(zones.map((zone) => zone.rect)).toEqual([
      { left: 200, top: 0, right: 400, bottom: 600 },
      { left: 400, top: 0, right: 1000, bottom: 600 },
      { left: 1000, top: 0, right: 1400, bottom: 600 },
    ]);
    // And a full window's zones are the columns' own boxes, copied out.
    const full = dropZones(
      "e",
      shown(["a", "b"], [1 / 3, 2 / 3]),
      live.map((pane) => ({
        ...pane,
        rect: new ProtoRect(pane.rect.left, 0, pane.rect.left + 140, 600),
      })),
    );
    expect(full[0]?.rect).toEqual({ left: 200, top: 0, right: 340, bottom: 600 });
  });

  test("a point over the canvas always finds a zone, either side of a cut", () => {
    const zones = dropZones("c", shown(["a", "b"], [1 / 3, 2 / 3]), live);
    expect(zoneAt(300, 300, zones)?.next?.members).toEqual(["c", "a", "b"]);
    expect(zoneAt(900, 300, zones)?.next?.members).toEqual(["a", "c", "b"]);
    expect(zoneAt(1300, 300, zones)?.next?.members).toEqual(["a", "b", "c"]);
    // The cut itself belongs to a zone rather than to neither.
    expect(zoneAt(400, 300, zones)).not.toBeNull();
  });
});

describe("layoutColumns", () => {
  test("lays the columns edge to edge at their shares, the last one closing on the canvas edge", () => {
    expect(
      layoutColumns(
        rect(0, 0, 1500, 500),
        { members: ["a", "b", "c"], sizes: [0.5, 0.3, 0.2] },
        { start: 0, ids: ["a", "b", "c"] },
      ),
    ).toEqual([
      { workspaceId: "a", rect: rect(0, 0, 750, 500) },
      { workspaceId: "b", rect: rect(750, 0, 1200, 500) },
      { workspaceId: "c", rect: rect(1200, 0, 1500, 500) },
    ]);
  });

  test("a run of a wider group fills the canvas between its own columns", () => {
    const laid = layoutColumns(
      rect(0, 0, 600, 500),
      { members: ["a", "b", "c", "d"], sizes: [0.25, 0.25, 0.25, 0.25] },
      { start: 2, ids: ["c", "d"] },
    );
    expect(laid).toEqual([
      { workspaceId: "c", rect: rect(0, 0, 300, 500) },
      { workspaceId: "d", rect: rect(300, 0, 600, 500) },
    ]);
  });

  test("columns are drawn no narrower than the minimum, whatever is stored", () => {
    // Stored at an eighth after the window was wider: 1416px still draws
    // them at 280.
    const laid = layoutColumns(
      rect(0, 0, 1416, 500),
      { members: ["a", "b", "c", "d"], sizes: [0.125, 0.125, 0.375, 0.375] },
      { start: 0, ids: ["a", "b", "c", "d"] },
    );
    for (const column of laid) {
      expect(Math.round(column.rect.right - column.rect.left)).toBeGreaterThanOrEqual(280);
    }
  });
});

describe("groupRows", () => {
  const ids = ["a", "b", "c", "d", "e"];

  test("no split leaves every workspace in a row of its own", () => {
    expect(groupRows(ids, null)).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
    expect(groupRows(ids, ["b"])).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
  });

  test("a pair collapses to one row where the upper of the two was", () => {
    expect(groupRows(ids, ["b", "d"])).toEqual([["a"], ["b", "d"], ["c"], ["e"]]);
  });

  test("the row sits at the upper slot even when a later column is the upper one", () => {
    // Anchored at b's slot, but listed in the group's own order: the row is
    // drawn to match the columns on screen.
    expect(groupRows(ids, ["d", "b"])).toEqual([["a"], ["d", "b"], ["c"], ["e"]]);
  });

  test("three and four collapse the same way, wherever they are in the list", () => {
    expect(groupRows(ids, ["e", "a", "c"])).toEqual([["e", "a", "c"], ["b"], ["d"]]);
    expect(groupRows(ids, ["b", "c", "d", "e"])).toEqual([["a"], ["b", "c", "d", "e"]]);
  });

  test("adjacent workspaces group without disturbing anything around them", () => {
    expect(groupRows(ids, ["b", "c"])).toEqual([["a"], ["b", "c"], ["d"], ["e"]]);
  });

  test("a member the list cannot see leaves all of them as ordinary rows", () => {
    expect(groupRows(ids, ["b", "zz"])).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
    expect(groupRows(ids, ["a", "b", "zz"])).toEqual([["a"], ["b"], ["c"], ["d"], ["e"]]);
  });
});

describe("reorderWrites", () => {
  const singles = (...ids: string[]) => ids.map((id) => [id]);

  test("a row of one workspace writes exactly the one position it always did", () => {
    // The guarantee the existing gesture rests on: with no split in the rail this
    // is the single `{id, position: targetRowIndex}` write it has always made.
    expect(reorderWrites(singles("a", "b", "c"), 0, 2)).toEqual([{ id: "a", position: 2 }]);
    expect(reorderWrites(singles("a", "b", "c"), 2, 0)).toEqual([{ id: "c", position: 0 }]);
    expect(reorderWrites(singles("a", "b", "c"), 1, 1)).toEqual([{ id: "b", position: 1 }]);
  });

  test("rows above a split count the workspaces it holds, not the row", () => {
    // [a,b] is one row but two positions, so dropping d below it is position 3.
    const rows = [["a", "b"], ["c"], ["d"]];
    expect(reorderWrites(rows, 2, 1)).toEqual([{ id: "d", position: 2 }]);
    expect(reorderWrites(rows, 2, 0)).toEqual([{ id: "d", position: 0 }]);
  });

  test("a split dragged to the front lands every member, in order", () => {
    const rows = [["x"], ["a", "b"], ["y"]];
    expect(reorderWrites(rows, 1, 0)).toEqual([
      { id: "a", position: 0 },
      { id: "b", position: 1 },
    ]);
  });

  test("a split dragged to the end lands every member, in order", () => {
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
      // A group of four carried as one row, either way through the list.
      [[["x"], ["a", "b", "c", "d"], ["y"]], 1, 2, ["x", "y", "a", "b", "c", "d"]],
      [[["x"], ["y"], ["a", "b", "c"]], 2, 0, ["a", "b", "c", "x", "y"]],
    ];
    for (const [rows, from, target, expected] of cases) {
      expect(replay(rows.flat(), reorderWrites(rows, from, target))).toEqual(expected);
    }
  });

  test("a row index that holds nothing asks for no writes at all", () => {
    expect(reorderWrites([["a"], ["b"]], 5, 0)).toEqual([]);
  });
});
