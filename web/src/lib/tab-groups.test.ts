import { describe, expect, test } from "bun:test";
import fixturesJson from "../../../proto/tab-groups-fixtures.json";
import {
  addTabToGroup,
  createGroup,
  type GroupError,
  groupOfTab,
  hiddenTabIds,
  layoutGroups,
  nextGroupColor,
  normalizeColor,
  normalizeGroups,
  PRESET_COLORS,
  regroup,
  removeTabFromGroup,
  stripIndexForGap,
  stripIndexForSlot,
  ungroup,
  updateGroup,
  validateGroups,
} from "./tab-groups";
import type { LayoutV3, TabGroup } from "./tabs";

// ---------------------------------------------------------------------------
// Conformance: every case in proto/tab-groups-fixtures.json must pass. The
// fixture file is the shared contract with spawn_server/tab_groups.py and the
// phone's data/layout/tab-groups.ts.
// ---------------------------------------------------------------------------

type FixtureCase = {
  op: "color" | "normalize" | "validate" | "regroup";
  name: string;
  input?: unknown;
  tab_ids?: string[];
  groups?: unknown;
  moved?: string;
  expected: unknown;
};

const fixtures = fixturesJson as unknown as { version: number; cases: FixtureCase[] };

describe("tab-groups-fixtures.json", () => {
  test("is the version this client implements, and has cases for every op", () => {
    expect(fixtures.version).toBe(1);
    const ops = new Set(fixtures.cases.map((item) => item.op));
    expect([...ops].sort()).toEqual(["color", "normalize", "regroup", "validate"]);
  });

  for (const item of fixtures.cases) {
    test(`${item.op}: ${item.name}`, () => {
      const tabIds = item.tab_ids ?? [];
      switch (item.op) {
        case "color":
          expect(normalizeColor(item.input)).toEqual(item.expected as string | null);
          return;
        case "normalize":
          expect(normalizeGroups(tabIds, item.groups)).toEqual(item.expected as TabGroup[]);
          return;
        case "validate":
          expect(validateGroups(tabIds, item.groups as TabGroup[])).toEqual(
            item.expected as GroupError | null,
          );
          return;
        case "regroup": {
          const groups = item.groups as TabGroup[];
          const before = structuredClone(groups);
          expect(regroup(tabIds, groups, item.moved as string)).toEqual(
            item.expected as TabGroup[],
          );
          // Pure: the input is never touched.
          expect(groups).toEqual(before);
          return;
        }
        default:
          throw new Error(`unknown fixture op ${String(item.op)}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Envelope operations.
// ---------------------------------------------------------------------------

function group(id: string, tabIds: string[], extra: Partial<TabGroup> = {}): TabGroup {
  return { id, name: "", color: "blue", collapsed: false, tab_ids: tabIds, ...extra };
}

function strip(ids: string[], groups: TabGroup[] = [], active: string | null = null): LayoutV3 {
  return {
    version: 3,
    active_tab: active ?? ids[0] ?? null,
    tabs: ids.map((id) => ({ id, name: id, layout: { version: 3, tiles: [] } })),
    groups,
  };
}

const order = (layout: LayoutV3 | null) => layout?.tabs.map((tab) => tab.id);
const members = (layout: LayoutV3 | null) =>
  Object.fromEntries((layout?.groups ?? []).map((item) => [item.id, item.tab_ids]));

describe("createGroup", () => {
  test("an ungrouped tab gets a group of its own, in place", () => {
    const layout = strip(["a", "b", "c"]);
    const next = createGroup(layout, "b", { id: "g", name: "Agents", color: "orange" });
    expect(order(next)).toEqual(["a", "b", "c"]);
    expect(next?.groups).toEqual([group("g", ["b"], { name: "Agents", color: "orange" })]);
    // Pure.
    expect(layout.groups).toEqual([]);
  });

  test("a tab in the middle of a group steps out past its end first", () => {
    const layout = strip(["a", "b", "c", "d"], [group("old", ["a", "b", "c"])]);
    const next = createGroup(layout, "b", { id: "g" });
    expect(order(next)).toEqual(["a", "c", "b", "d"]);
    expect(members(next)).toEqual({ old: ["a", "c"], g: ["b"] });
  });

  test("a tab at a group's edge just leaves it", () => {
    const layout = strip(["a", "b", "c"], [group("old", ["a", "b"])]);
    const next = createGroup(layout, "b", { id: "g" });
    expect(order(next)).toEqual(["a", "b", "c"]);
    expect(members(next)).toEqual({ old: ["a"], g: ["b"] });
  });

  test("refuses an unknown tab, a taken id, and stores only valid colours", () => {
    const layout = strip(["a"], [group("g", ["a"])]);
    expect(createGroup(layout, "zz", { id: "new" })).toBeNull();
    expect(createGroup(layout, "a", { id: "g" })).toBeNull();
    expect(createGroup(strip(["a"]), "a", { id: "n", color: "teal" })?.groups?.[0]?.color).toBe(
      "blue",
    );
    expect(
      createGroup(strip(["a"]), "a", { id: "n", name: "x".repeat(80) })?.groups?.[0]?.name,
    ).toHaveLength(64);
  });
});

describe("addTabToGroup", () => {
  test("the tab moves to the group's end, from either side", () => {
    const layout = strip(["a", "b", "c", "d", "e"], [group("g", ["b", "c"])]);
    const fromRight = addTabToGroup(layout, "e", "g");
    expect(order(fromRight)).toEqual(["a", "b", "c", "e", "d"]);
    expect(members(fromRight)).toEqual({ g: ["b", "c", "e"] });
    const fromLeft = addTabToGroup(layout, "a", "g");
    expect(order(fromLeft)).toEqual(["b", "c", "a", "d", "e"]);
    expect(members(fromLeft)).toEqual({ g: ["b", "c", "a"] });
  });

  test("leaving its old group on the way", () => {
    const layout = strip(
      ["a", "b", "c", "d", "e"],
      [group("one", ["a", "b", "c"]), group("two", ["e"])],
    );
    const next = addTabToGroup(layout, "b", "two");
    expect(order(next)).toEqual(["a", "c", "d", "e", "b"]);
    expect(members(next)).toEqual({ one: ["a", "c"], two: ["e", "b"] });
  });

  test("null when already there or unknown", () => {
    const layout = strip(["a", "b"], [group("g", ["a"])]);
    expect(addTabToGroup(layout, "a", "g")).toBeNull();
    expect(addTabToGroup(layout, "b", "nope")).toBeNull();
    expect(addTabToGroup(layout, "zz", "g")).toBeNull();
  });
});

describe("removeTabFromGroup", () => {
  test("from the middle it steps past the group's end", () => {
    const layout = strip(["a", "b", "c", "d"], [group("g", ["a", "b", "c"])]);
    const next = removeTabFromGroup(layout, "b");
    expect(order(next)).toEqual(["a", "c", "b", "d"]);
    expect(members(next)).toEqual({ g: ["a", "c"] });
  });

  test("from an edge it stays put, and a group's last tab takes the group with it", () => {
    const layout = strip(["a", "b", "c"], [group("g", ["a", "b"]), group("solo", ["c"])]);
    expect(order(removeTabFromGroup(layout, "a"))).toEqual(["a", "b", "c"]);
    expect(members(removeTabFromGroup(layout, "a"))).toEqual({ g: ["b"], solo: ["c"] });
    expect(members(removeTabFromGroup(layout, "c"))).toEqual({ g: ["a", "b"] });
    expect(removeTabFromGroup(strip(["a"]), "a")).toBeNull();
  });
});

describe("ungroup and updateGroup", () => {
  test("ungroup keeps the tabs where they are", () => {
    const layout = strip(["a", "b", "c"], [group("g", ["b", "c"])]);
    const next = ungroup(layout, "g");
    expect(order(next)).toEqual(["a", "b", "c"]);
    expect(next?.groups).toEqual([]);
    expect(ungroup(layout, "nope")).toBeNull();
  });

  test("updateGroup renames, recolours and folds, refusing bad colours", () => {
    const layout = strip(["a"], [group("g", ["a"])]);
    const next = updateGroup(layout, "g", { name: "Build", color: "#A1B2C3", collapsed: true });
    expect(next?.groups).toEqual([
      group("g", ["a"], { name: "Build", color: "#a1b2c3", collapsed: true }),
    ]);
    expect(updateGroup(layout, "g", { color: "teal" })?.groups?.[0]?.color).toBe("blue");
    expect(updateGroup(layout, "nope", { name: "x" })).toBeNull();
  });
});

describe("reading the envelope", () => {
  test("groupOfTab, layoutGroups and a layout with no groups key", () => {
    const layout = strip(["a", "b"], [group("g", ["b"])]);
    expect(groupOfTab(layout, "b")?.id).toBe("g");
    expect(groupOfTab(layout, "a")).toBeNull();
    const { groups: _, ...old } = layout;
    expect(layoutGroups(old)).toEqual([]);
  });

  test("nextGroupColor takes the first unused preset, then cycles", () => {
    expect(nextGroupColor(strip(["a"]))).toBe("blue");
    expect(nextGroupColor(strip(["a", "b"], [group("g", ["a"])]))).toBe("purple");
    const ids = PRESET_COLORS.map((_, index) => `t${index}`);
    const full = strip(
      [...ids, "x"],
      PRESET_COLORS.map((color, index) => group(`g${index}`, [ids[index] as string], { color })),
    );
    expect(nextGroupColor(full)).toBe("blue");
  });

  test("a collapsed group hides all but the open tab", () => {
    const layout = strip(
      ["a", "b", "c", "d"],
      [group("g", ["b", "c"], { collapsed: true }), group("h", ["d"])],
      "c",
    );
    expect([...hiddenTabIds(layout, "c")]).toEqual(["b"]);
    expect([...hiddenTabIds(layout, "a")]).toEqual(["b", "c"]);
  });
});

describe("dragging past collapsed groups", () => {
  // a | g(collapsed): b c d | e — with c open, b and d are out of sight.
  const layout = strip(
    ["a", "b", "c", "d", "e"],
    [group("g", ["b", "c", "d"], { collapsed: true })],
    "c",
  );
  const visible = ["a", "c", "e"];

  test("landing after a visible tab lands after the hidden tabs it carries", () => {
    // a dragged one slot right lands after c — so after d, out of the group.
    expect(stripIndexForSlot(layout, visible, "a", 1)).toBe(3);
    expect(stripIndexForSlot(layout, visible, "a", 2)).toBe(4);
  });

  test("landing before a visible tab lands before the hidden tabs it carries", () => {
    // e dragged one slot left lands before c — so before b, out of the group.
    expect(stripIndexForSlot(layout, visible, "e", 1)).toBe(1);
    expect(stripIndexForSlot(layout, visible, "e", 0)).toBe(0);
  });

  test("a group with nothing on show is stepped over whole", () => {
    const folded = strip(["a", "b", "c", "e"], [group("g", ["b", "c"], { collapsed: true })], "a");
    expect(stripIndexForSlot(folded, ["a", "e"], "a", 1)).toBe(3);
    expect(stripIndexForSlot(folded, ["a", "e"], "e", 0)).toBe(0);
  });

  test("no move answers the tab's own index", () => {
    expect(stripIndexForSlot(layout, visible, "c", 1)).toBe(2);
  });

  test("a copy's gap maps before the block of the tab it sits in front of", () => {
    expect(stripIndexForGap(layout, visible, 0)).toBe(0);
    expect(stripIndexForGap(layout, visible, 1)).toBe(1);
    expect(stripIndexForGap(layout, visible, 2)).toBe(4);
    expect(stripIndexForGap(layout, visible, 3)).toBe(5);
  });
});
