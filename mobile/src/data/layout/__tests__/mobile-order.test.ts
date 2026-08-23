import { applyMobileOrder, isValidMobileOrder, readingOrder } from "@/data/layout/mobile-order";
import type { Tile, WorkspaceTab } from "@/data/types/layout";

function tabWith(tiles: Tile[]): WorkspaceTab {
  return { id: "tab", name: "Tab", host_id: null, cwd: null, layout: { version: 3, tiles } };
}

describe("mobile/desktop order bridge", () => {
  it("sorts by geometry with a stable pane-ID tie-break", () => {
    const tab = tabWith([
      { session_id: "c", x: 0, y: 12, w: 24, h: 12 },
      { session_id: "b", x: 12, y: 0, w: 12, h: 12 },
      { session_id: "a", x: 0, y: 0, w: 12, h: 12 },
    ]);

    expect(readingOrder(tab).map((tile) => tile.session_id)).toEqual(["a", "b", "c"]);
  });

  it("stacks up to six panes and preserves attached payloads", () => {
    const tab = tabWith([
      { session_id: "a", x: 0, y: 0, w: 12, h: 12, custom: { keep: true } },
      {
        session_id: "b",
        x: 12,
        y: 0,
        w: 12,
        h: 12,
        widget: { kind: "files", host_id: "host", path: "/tmp" },
      },
      { session_id: "c", x: 0, y: 12, w: 24, h: 12 },
    ]);

    const ordered = applyMobileOrder(tab, ["c", "b", "a"]);
    expect(readingOrder(ordered).map((tile) => tile.session_id)).toEqual(["c", "b", "a"]);
    expect(ordered.layout.tiles.map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual([
      { x: 0, y: 0, w: 24, h: 8 },
      { x: 0, y: 8, w: 24, h: 8 },
      { x: 0, y: 16, w: 24, h: 8 },
    ]);
    expect(ordered.layout.tiles[1]?.widget).toEqual({
      kind: "files",
      host_id: "host",
      path: "/tmp",
    });
    expect(ordered.layout.tiles[2]?.["custom"]).toEqual({ keep: true });
  });

  it("reassigns the existing rectangle multiset for seven or more panes", () => {
    const tiles = Array.from(
      { length: 7 },
      (_, index): Tile => ({
        session_id: String(index),
        x: (index % 4) * 6,
        y: Math.floor(index / 4) * 6,
        w: 6,
        h: 6,
        payload: `pane-${index}`,
      }),
    );
    const tab = tabWith(tiles);
    const order = ["6", "5", "4", "3", "2", "1", "0"];
    const rectangles = readingOrder(tab).map(({ x, y, w, h }) => ({ x, y, w, h }));
    const ordered = applyMobileOrder(tab, order);

    expect(readingOrder(ordered).map((tile) => tile.session_id)).toEqual(order);
    expect(readingOrder(ordered).map(({ x, y, w, h }) => ({ x, y, w, h }))).toEqual(rectangles);
    expect(ordered.layout.tiles[0]?.["payload"]).toBe("pane-6");
  });

  it("rejects partial, duplicate, or unknown orders without rewriting geometry", () => {
    const tab = tabWith([{ session_id: "a", x: 0, y: 0, w: 24, h: 24 }]);
    expect(isValidMobileOrder(tab, [])).toBe(false);
    expect(applyMobileOrder(tab, ["unknown"])).toBe(tab);
  });
});
