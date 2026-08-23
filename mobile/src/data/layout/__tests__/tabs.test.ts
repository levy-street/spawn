import {
  addTab,
  canAddTab,
  canMovePaneToTab,
  getActiveTab,
  movePaneToTab,
  removeTab,
  renameTab,
  reorderTab,
  setTabHome,
} from "@/data/layout/tabs";
import type { WorkspaceLayoutV3 } from "@/data/types/layout";

function layout(): WorkspaceLayoutV3 {
  return {
    version: 3,
    active_tab: "one",
    tabs: [
      {
        id: "one",
        name: "One",
        host_id: null,
        cwd: null,
        layout: {
          version: 3,
          tiles: [
            {
              session_id: "files-1",
              x: 0,
              y: 0,
              w: 24,
              h: 24,
              extension: "retained",
              widget: { kind: "files", host_id: "host-1", path: "/work" },
            },
          ],
        },
      },
      { id: "two", name: "Two", host_id: null, cwd: null, layout: { version: 3, tiles: [] } },
    ],
  };
}

describe("tab algebra", () => {
  it("adds, activates, names, renames, and reorders immutably", () => {
    const original = layout();
    const added = addTab(original, "three");

    expect(added?.active_tab).toBe("three");
    expect(added?.tabs[2]?.name).toBe("Tab 3");
    const renamed = renameTab(added as WorkspaceLayoutV3, "three", "  Build  ");
    expect(reorderTab(renamed, "three", 0).tabs.map((tab) => tab.id)).toEqual([
      "three",
      "one",
      "two",
    ]);
    expect(original.tabs).toHaveLength(2);
  });

  it("enforces the eight-tab ceiling and unique IDs", () => {
    const full: WorkspaceLayoutV3 = {
      ...layout(),
      tabs: Array.from({ length: 8 }, (_, index) => ({
        id: `tab-${index}`,
        name: `Tab ${index}`,
        host_id: null,
        cwd: null,
        layout: { version: 3, tiles: [] },
      })),
    };

    expect(canAddTab(full)).toBe(false);
    expect(addTab(full, "ninth")).toBeNull();
    expect(addTab(layout(), "one")).toBeNull();
  });

  it("does not remove the final tab and chooses the previous survivor when active", () => {
    const source = { ...layout(), active_tab: "two" };
    const removed = removeTab(source, "two");

    expect(removed?.active_tab).toBe("one");
    expect(removeTab(removed as WorkspaceLayoutV3, "one")).toBeNull();
    expect(getActiveTab({ ...layout(), active_tab: "missing" }).id).toBe("one");
  });

  it("sets and clears paired tab homes", () => {
    const homed = setTabHome(layout(), "two", { host_id: "host-2", cwd: "/code" });
    expect(homed.tabs[1]).toMatchObject({ host_id: "host-2", cwd: "/code" });
    expect(setTabHome(homed, "two", null).tabs[1]).toMatchObject({ host_id: null, cwd: null });
  });

  it("moves a pane while preserving payload and replacing only its geometry", () => {
    const original = layout();

    expect(canMovePaneToTab(original, "files-1", "two")).toBe(true);
    const moved = movePaneToTab(original, "files-1", "two");
    const tile = moved?.tabs[1]?.layout.tiles[0];
    expect(moved?.tabs[0]?.layout.tiles).toEqual([]);
    expect(tile).toMatchObject({
      session_id: "files-1",
      extension: "retained",
      widget: { kind: "files", host_id: "host-1", path: "/work" },
      x: 0,
      y: 0,
      w: 24,
      h: 24,
    });
    expect(original.tabs[0]?.layout.tiles).toHaveLength(1);
  });
});
