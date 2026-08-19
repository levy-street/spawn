import { describe, expect, test } from "bun:test";
import type { Tile } from "./grid";
import {
  activeTab,
  addTab,
  allSessionIds,
  type LayoutV3,
  MAX_TABS,
  moveSessionToTab,
  nextTabName,
  removeTab,
  renameTab,
  reorderTab,
  tabOfSession,
  tabTiles,
  withActiveTab,
  withTabTiles,
} from "./tabs";

function tile(id: string, x: number, y: number, w: number, h: number): Tile {
  return { session_id: id, x, y, w, h };
}

function envelope(tabs: Array<{ id: string; name?: string; tiles?: Tile[] }>): LayoutV3 {
  return {
    version: 3,
    active_tab: tabs[0]?.id ?? null,
    tabs: tabs.map(({ id, name, tiles }) => ({
      id,
      name: name ?? id,
      layout: { version: 2, tiles: tiles ?? [] },
    })),
  };
}

describe("tab envelope", () => {
  test("activeTab falls back to the first when active_tab is stale", () => {
    const layout = { ...envelope([{ id: "a" }, { id: "b" }]), active_tab: "ghost" };
    expect(activeTab(layout).id).toBe("a");
    expect(activeTab(withActiveTab(layout, "b")).id).toBe("b");
    // Unknown ids leave the envelope unchanged.
    expect(withActiveTab(layout, "ghost").active_tab).toBe("ghost");
  });

  test("allSessionIds walks tabs in order, reading order within", () => {
    const layout = envelope([
      { id: "a", tiles: [tile("s2", 6, 0, 6, 12), tile("s1", 0, 0, 6, 12)] },
      { id: "b", tiles: [tile("s3", 0, 0, 12, 12)] },
    ]);
    expect(allSessionIds(layout)).toEqual(["s1", "s2", "s3"]);
    expect(tabOfSession(layout, "s3")?.id).toBe("b");
    expect(tabOfSession(layout, "nope")).toBeNull();
  });

  test("addTab appends, activates, and refuses duplicates and overflow", () => {
    const layout = envelope([{ id: "a" }]);
    const next = addTab(layout, "b", "Tab 2");
    expect(next?.active_tab).toBe("b");
    expect(next?.tabs.map((tab) => tab.id)).toEqual(["a", "b"]);
    expect(addTab(layout, "a", "dup")).toBeNull();
    const full = envelope(Array.from({ length: MAX_TABS }, (_, i) => ({ id: `t${i}` })));
    expect(addTab(full, "extra", "x")).toBeNull();
  });

  test("removeTab keeps at least one tab and re-homes the active pointer", () => {
    const layout = withActiveTab(envelope([{ id: "a" }, { id: "b" }, { id: "c" }]), "b");
    const next = removeTab(layout, "b");
    expect(next?.tabs.map((tab) => tab.id)).toEqual(["a", "c"]);
    // The neighbour before the removed tab becomes active.
    expect(next?.active_tab).toBe("a");
    // Removing an inactive tab leaves the pointer alone.
    expect(removeTab(layout, "c")?.active_tab).toBe("b");
    expect(removeTab(envelope([{ id: "only" }]), "only")).toBeNull();
    expect(removeTab(layout, "ghost")).toBeNull();
  });

  test("renameTab and withTabTiles touch only their tab", () => {
    const layout = envelope([{ id: "a", tiles: [tile("s1", 0, 0, 12, 12)] }, { id: "b" }]);
    const renamed = renameTab(layout, "b", "Logs");
    expect(renamed.tabs[1]?.name).toBe("Logs");
    expect(renamed.tabs[0]).toBe(layout.tabs[0]);
    const swapped = withTabTiles(layout, "b", [tile("s2", 0, 0, 12, 12)]);
    expect(tabTiles(swapped, "b").map((t) => t.session_id)).toEqual(["s2"]);
    expect(tabTiles(swapped, "a").map((t) => t.session_id)).toEqual(["s1"]);
  });

  test("reorderTab moves a tab, clamping the index and keeping the rest in order", () => {
    const layout = withActiveTab(envelope([{ id: "a" }, { id: "b" }, { id: "c" }]), "b");
    expect(reorderTab(layout, "a", 2)?.tabs.map((tab) => tab.id)).toEqual(["b", "c", "a"]);
    expect(reorderTab(layout, "c", 0)?.tabs.map((tab) => tab.id)).toEqual(["c", "a", "b"]);
    // Past either end lands in the end slot; the selection rides along.
    const clamped = reorderTab(layout, "b", 9);
    expect(clamped?.tabs.map((tab) => tab.id)).toEqual(["a", "c", "b"]);
    expect(clamped?.active_tab).toBe("b");
    // Nothing to persist: a no-op move, an unknown id, a single tab.
    expect(reorderTab(layout, "b", 1)).toBeNull();
    expect(reorderTab(layout, "a", -3)).toBeNull();
    expect(reorderTab(layout, "ghost", 0)).toBeNull();
    expect(reorderTab(envelope([{ id: "only" }]), "only", 1)).toBeNull();
    // The input is untouched.
    expect(layout.tabs.map((tab) => tab.id)).toEqual(["a", "b", "c"]);
  });

  test("nextTabName picks the next free number", () => {
    expect(nextTabName(envelope([{ id: "a", name: "Tab 1" }]))).toBe("Tab 2");
    expect(
      nextTabName(
        envelope([
          { id: "a", name: "Tab 1" },
          { id: "b", name: "Tab 3" },
        ]),
      ),
    ).toBe("Tab 4");
  });

  test("moveSessionToTab removes from the source and auto-places in the target", () => {
    const layout = envelope([
      { id: "a", tiles: [tile("s1", 0, 0, 6, 12), tile("s2", 6, 0, 6, 12)] },
      { id: "b", tiles: [tile("s3", 0, 0, 12, 12)] },
    ]);
    const moved = moveSessionToTab(layout, "s1", "b");
    expect(moved).not.toBeNull();
    expect(tabTiles(moved as LayoutV3, "a").map((t) => t.session_id)).toEqual(["s2"]);
    const target = tabTiles(moved as LayoutV3, "b");
    expect(target.map((t) => t.session_id).sort()).toEqual(["s1", "s3"]);
    // The input is untouched.
    expect(tabTiles(layout, "a")).toHaveLength(2);
  });

  test("moveSessionToTab answers null for no-ops and full targets", () => {
    const layout = envelope([
      { id: "a", tiles: [tile("s1", 0, 0, 12, 12)] },
      {
        id: "full",
        tiles: Array.from({ length: 8 }, (_, i) => tile(`f${i}`, (i % 4) * 3, i < 4 ? 0 : 3, 3, 3)),
      },
    ]);
    expect(moveSessionToTab(layout, "s1", "a")).toBeNull();
    expect(moveSessionToTab(layout, "s1", "ghost")).toBeNull();
    expect(moveSessionToTab(layout, "ghost", "a")).toBeNull();
    expect(moveSessionToTab(layout, "s1", "full")).toBeNull();
  });
});
