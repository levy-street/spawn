import {
  addTabToGroup,
  createGroup,
  groupLabel,
  groupOfTab,
  nextGroupColor,
  normalizeColor,
  normalizeGroups,
  PRESET_COLORS,
  regroup,
  removeTabFromGroup,
  ungroup,
  updateGroup,
  validateGroups,
} from "@/data/layout/tab-groups";
import type { TabGroup, WorkspaceLayoutV3, WorkspaceTab } from "@/data/types/layout";
import fixtureDocument from "../../../../tests/fixtures/tab-groups-fixtures.json";

interface FixtureCase {
  op: "color" | "normalize" | "validate" | "regroup";
  name: string;
  input?: unknown;
  tab_ids?: string[];
  groups?: unknown;
  moved?: string;
  expected: unknown;
}

const cases = fixtureDocument.cases as FixtureCase[];

describe("shared tab group fixtures", () => {
  it("covers every op the suite names", () => {
    expect(new Set(cases.map((fixture) => fixture.op))).toEqual(
      new Set(["color", "normalize", "validate", "regroup"]),
    );
  });

  it.each(cases)("$op: $name", (fixture) => {
    const before = JSON.parse(JSON.stringify(fixture)) as FixtureCase;
    const tabIds = fixture.tab_ids ?? [];
    let actual: unknown;
    switch (fixture.op) {
      case "color":
        actual = normalizeColor(fixture.input);
        break;
      case "normalize":
        actual = normalizeGroups(tabIds, fixture.groups);
        break;
      case "validate":
        actual = validateGroups(tabIds, fixture.groups as TabGroup[]);
        break;
      case "regroup":
        actual = regroup(tabIds, fixture.groups as TabGroup[], fixture.moved as string);
        break;
    }
    expect(actual).toEqual(fixture.expected);
    // Deep equality on parsed JSON: no undefined keys sneaking in.
    expect(JSON.parse(JSON.stringify(actual ?? null))).toEqual(fixture.expected);
    expect(fixture).toEqual(before);
  });
});

function tab(id: string): WorkspaceTab {
  return { id, name: id, host_id: null, cwd: null, layout: { version: 3, tiles: [] } };
}

function layoutOf(ids: string[], groups: TabGroup[] = []): WorkspaceLayoutV3 {
  return { version: 3, active_tab: ids[0] ?? null, tabs: ids.map(tab), groups };
}

function group(id: string, tabIds: string[], overrides: Partial<TabGroup> = {}): TabGroup {
  return { id, name: "", color: "blue", collapsed: false, tab_ids: tabIds, ...overrides };
}

function strip(layout: WorkspaceLayoutV3): string[] {
  return layout.tabs.map((candidate) => candidate.id);
}

describe("tab group layout operations", () => {
  it("puts a tab in a new group of its own", () => {
    const next = createGroup(layoutOf(["a", "b"]), "b", { id: "g", name: "Agents", color: "red" });
    expect(next?.groups).toEqual([group("g", ["b"], { name: "Agents", color: "red" })]);
    expect(strip(next as WorkspaceLayoutV3)).toEqual(["a", "b"]);
  });

  it("refuses a new group for a missing tab, a taken id or a colour that is not one", () => {
    const layout = layoutOf(["a", "b"], [group("g", ["a"])]);
    expect(createGroup(layout, "zz", { id: "n", name: "", color: "blue" })).toBeNull();
    expect(createGroup(layout, "b", { id: "g", name: "", color: "blue" })).toBeNull();
    expect(createGroup(layout, "b", { id: "n", name: "", color: "teal" })).toBeNull();
    expect(createGroup(layout, "b", { id: "", name: "", color: "blue" })).toBeNull();
  });

  it("moves a tab out of the middle of its group before grouping it anew", () => {
    const layout = layoutOf(["a", "b", "c", "d"], [group("g", ["a", "b", "c"])]);
    const next = createGroup(layout, "b", { id: "n", name: "", color: "cyan" });
    expect(strip(next as WorkspaceLayoutV3)).toEqual(["a", "c", "b", "d"]);
    expect(next?.groups).toEqual([group("g", ["a", "c"]), group("n", ["b"], { color: "cyan" })]);
  });

  it("leaves a tab at its group's edge where it is", () => {
    const layout = layoutOf(["a", "b", "c"], [group("g", ["a", "b", "c"])]);
    const next = createGroup(layout, "c", { id: "n", name: "", color: "pink" });
    expect(strip(next as WorkspaceLayoutV3)).toEqual(["a", "b", "c"]);
    expect(next?.groups).toEqual([group("g", ["a", "b"]), group("n", ["c"], { color: "pink" })]);
  });

  it("adds a tab after a group's last tab", () => {
    const layout = layoutOf(["x", "a", "b", "y"], [group("g", ["a", "b"])]);
    const next = addTabToGroup(layout, "x", "g");
    expect(strip(next)).toEqual(["a", "b", "x", "y"]);
    expect(next.groups).toEqual([group("g", ["a", "b", "x"])]);
    expect(addTabToGroup(next, "x", "g")).toBe(next);
    expect(addTabToGroup(next, "x", "missing")).toBe(next);
  });

  it("moves a tab from one group to another", () => {
    const layout = layoutOf(
      ["a", "b", "c", "d"],
      [group("g1", ["a", "b", "c"]), group("g2", ["d"])],
    );
    const next = addTabToGroup(layout, "b", "g2");
    expect(strip(next)).toEqual(["a", "c", "d", "b"]);
    expect(next.groups).toEqual([group("g1", ["a", "c"]), group("g2", ["d", "b"])]);
  });

  it("removes a tab from its group, out past the end when it was inside", () => {
    const layout = layoutOf(["a", "b", "c", "d"], [group("g", ["a", "b", "c"])]);
    const inside = removeTabFromGroup(layout, "b");
    expect(strip(inside)).toEqual(["a", "c", "b", "d"]);
    expect(inside.groups).toEqual([group("g", ["a", "c"])]);
    const edge = removeTabFromGroup(layout, "a");
    expect(strip(edge)).toEqual(["a", "b", "c", "d"]);
    expect(edge.groups).toEqual([group("g", ["b", "c"])]);
    expect(removeTabFromGroup(layout, "d")).toBe(layout);
  });

  it("drops a group whose last tab leaves", () => {
    const layout = layoutOf(["a", "b"], [group("g", ["a"])]);
    expect(removeTabFromGroup(layout, "a").groups).toEqual([]);
  });

  it("ungroups without moving a tab", () => {
    const layout = layoutOf(["a", "b"], [group("g", ["a", "b"])]);
    const next = ungroup(layout, "g");
    expect(strip(next)).toEqual(["a", "b"]);
    expect(next.groups).toEqual([]);
    expect(ungroup(layout, "missing")).toBe(layout);
  });

  it("renames, recolours and collapses, ignoring a colour that is not one", () => {
    const layout = layoutOf(["a"], [group("g", ["a"])]);
    const next = updateGroup(layout, "g", { name: "Agents", color: "#FF8800", collapsed: true });
    expect(next.groups).toEqual([
      group("g", ["a"], { name: "Agents", color: "#ff8800", collapsed: true }),
    ]);
    expect(updateGroup(next, "g", { color: "teal" })).toBe(next);
    expect(updateGroup(next, "missing", { name: "x" })).toBe(next);
    expect(updateGroup(layout, "g", { name: "n".repeat(80) }).groups?.[0]?.name).toHaveLength(64);
  });

  it("finds a tab's group and reads an unnamed one", () => {
    const layout = layoutOf(["a", "b"], [group("g", ["b"], { name: "" })]);
    expect(groupOfTab(layout, "b")?.id).toBe("g");
    expect(groupOfTab(layout, "a")).toBeNull();
    expect(groupLabel({ name: "" })).toBe("Unnamed group");
    expect(groupLabel({ name: "Agents" })).toBe("Agents");
  });

  it("reads a layout without groups as having none", () => {
    const layout: WorkspaceLayoutV3 = { version: 3, active_tab: "a", tabs: [tab("a")] };
    expect(groupOfTab(layout, "a")).toBeNull();
  });

  it("offers the first unused preset, then rounds again", () => {
    expect(nextGroupColor([])).toBe("blue");
    expect(nextGroupColor([{ color: "blue" }, { color: "#123456" }])).toBe("purple");
    const all = PRESET_COLORS.map((color) => ({ color }));
    expect(nextGroupColor(all)).toBe("blue");
    expect(nextGroupColor([...all, { color: "red" }])).toBe("purple");
  });
});
