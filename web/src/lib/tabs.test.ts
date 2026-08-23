import { describe, expect, test } from "bun:test";
import { MAX_TILES, type Tile } from "./grid";
import {
  activeTab,
  addTab,
  allSessionIds,
  copyTabName,
  duplicateTab,
  type LayoutV3,
  MAX_TABS,
  moveSessionToTab,
  nextTabName,
  removeTab,
  renameTab,
  reorderTab,
  tabHome,
  tabOfSession,
  tabTiles,
  withActiveTab,
  withTabHome,
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
      layout: { version: 3, tiles: tiles ?? [] },
    })),
  };
}

describe("tab home", () => {
  const workspace = { host_id: "ws-host", cwd: "/workspace" };

  test("a tab with no home of its own inherits the workspace's", () => {
    expect(tabHome(envelope([{ id: "a" }]), "a", workspace)).toEqual({
      host_id: "ws-host",
      cwd: "/workspace",
    });
  });

  test("a tab's own pair wins, and only its own tab is re-pointed", () => {
    const layout = withTabHome(envelope([{ id: "a" }, { id: "b" }]), "a", {
      host_id: "tab-host",
      cwd: "/tab",
    });
    expect(tabHome(layout, "a", workspace)).toEqual({ host_id: "tab-host", cwd: "/tab" });
    expect(tabHome(layout, "b", workspace)).toEqual({ host_id: "ws-host", cwd: "/workspace" });
  });

  test("clearing a tab's home puts it back to inheriting", () => {
    const owned = withTabHome(envelope([{ id: "a" }]), "a", {
      host_id: "tab-host",
      cwd: "/tab",
    });
    expect(tabHome(withTabHome(owned, "a", null), "a", workspace)).toEqual({
      host_id: "ws-host",
      cwd: "/workspace",
    });
  });

  test("half a pair is no home — neither the tab's nor the workspace's", () => {
    const layout = envelope([{ id: "a" }]);
    layout.tabs[0] = { ...(layout.tabs[0] as (typeof layout.tabs)[number]), host_id: "tab-host" };
    expect(tabHome(layout, "a", workspace)).toEqual({ host_id: "ws-host", cwd: "/workspace" });
    expect(tabHome(layout, "a", { host_id: "ws-host", cwd: null })).toBeNull();
  });

  test("an unknown tab still answers with the workspace's home", () => {
    expect(tabHome(envelope([{ id: "a" }]), "ghost", workspace)).toEqual({
      host_id: "ws-host",
      cwd: "/workspace",
    });
  });
});

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
      { id: "a", tiles: [tile("s2", 12, 0, 12, 24), tile("s1", 0, 0, 12, 24)] },
      { id: "b", tiles: [tile("s3", 0, 0, 24, 24)] },
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
    const layout = envelope([{ id: "a", tiles: [tile("s1", 0, 0, 24, 24)] }, { id: "b" }]);
    const renamed = renameTab(layout, "b", "Logs");
    expect(renamed.tabs[1]?.name).toBe("Logs");
    expect(renamed.tabs[0]).toBe(layout.tabs[0]);
    const swapped = withTabTiles(layout, "b", [tile("s2", 0, 0, 24, 24)]);
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
      { id: "a", tiles: [tile("s1", 0, 0, 12, 24), tile("s2", 12, 0, 12, 24)] },
      { id: "b", tiles: [tile("s3", 0, 0, 24, 24)] },
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
      { id: "a", tiles: [tile("s1", 0, 0, 24, 24)] },
      {
        id: "full",
        tiles: Array.from({ length: MAX_TILES }, (_, i) =>
          tile(`f${i}`, (i % 4) * 6, Math.floor(i / 4) * 6, 6, 6),
        ),
      },
    ]);
    expect(moveSessionToTab(layout, "s1", "a")).toBeNull();
    expect(moveSessionToTab(layout, "s1", "ghost")).toBeNull();
    expect(moveSessionToTab(layout, "ghost", "a")).toBeNull();
    expect(moveSessionToTab(layout, "s1", "full")).toBeNull();
  });
});

describe("duplicateTab", () => {
  const layout = envelope([
    { id: "t1", tiles: [tile("s1", 0, 0, 12, 24), tile("s2", 12, 0, 12, 24)] },
    { id: "t2", tiles: [tile("s3", 0, 0, 24, 24)] },
  ]);

  test("copies the geometry and swaps in the new session ids", () => {
    const next = duplicateTab(
      layout,
      "t1",
      "copy",
      "Build copy",
      new Map([
        ["s1", "n1"],
        ["s2", "n2"],
      ]),
    );
    expect(next?.tabs.at(-1)).toEqual({
      id: "copy",
      name: "Build copy",
      // The source inherits the workspace's home, so the copy does too.
      host_id: null,
      cwd: null,
      layout: {
        version: 3,
        tiles: [tile("n1", 0, 0, 12, 24), tile("n2", 12, 0, 12, 24)],
      },
    });
    // The copy opens: duplicating and then hunting for the result is silly.
    expect(next?.active_tab).toBe("copy");
    // The original is untouched.
    expect(next?.tabs[0]).toEqual(layout.tabs[0]);
  });

  test("lands the copy in the slot it is given, the source keeping its own", () => {
    const ids = new Map([
      ["s1", "n1"],
      ["s2", "n2"],
    ]);
    expect(duplicateTab(layout, "t1", "copy", "c", ids, 0)?.tabs.map((tab) => tab.id)).toEqual([
      "copy",
      "t1",
      "t2",
    ]);
    expect(duplicateTab(layout, "t1", "copy", "c", ids, 1)?.tabs.map((tab) => tab.id)).toEqual([
      "t1",
      "copy",
      "t2",
    ]);
    // Out of range clamps to an end rather than refusing the copy.
    expect(duplicateTab(layout, "t1", "copy", "c", ids, 9)?.tabs.map((tab) => tab.id)).toEqual([
      "t1",
      "t2",
      "copy",
    ]);
    expect(duplicateTab(layout, "t1", "copy", "c", ids, -3)?.tabs.map((tab) => tab.id)).toEqual([
      "copy",
      "t1",
      "t2",
    ]);
  });

  test("drops tiles with no id to copy onto", () => {
    const next = duplicateTab(layout, "t1", "copy", "c", new Map([["s2", "n2"]]));
    expect(next?.tabs.at(-1)?.layout.tiles).toEqual([tile("n2", 12, 0, 12, 24)]);
  });

  test("refuses an unknown tab, a used id, and a full envelope", () => {
    expect(duplicateTab(layout, "ghost", "copy", "c", new Map())).toBeNull();
    expect(duplicateTab(layout, "t1", "t2", "c", new Map())).toBeNull();
    const full = envelope(Array.from({ length: MAX_TABS }, (_, i) => ({ id: `t${i}`, tiles: [] })));
    expect(duplicateTab(full, "t0", "copy", "c", new Map())).toBeNull();
  });

  test("copy names step around the ones already taken", () => {
    const named = envelope([
      { id: "t1", tiles: [] },
      { id: "t2", tiles: [] },
    ]);
    named.tabs[0].name = "Build";
    named.tabs[1].name = "Build copy";
    expect(copyTabName(named, "Build")).toBe("Build copy 2");
    expect(copyTabName(named, "Ship")).toBe("Ship copy");
  });
});
