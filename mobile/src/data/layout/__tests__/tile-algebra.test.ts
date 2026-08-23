import { addTile, canAddTile, MAX_TILES_PER_TAB, MIN_TILE_SIZE } from "@/data/layout/tiles";
import type { GridLayoutV3, Tile } from "@/data/types/layout";

describe("tile capacity algebra", () => {
  it("adds a pane with valid geometry while retaining its payload", () => {
    const layout: GridLayoutV3 = { version: 3, tiles: [] };
    const added = addTile(layout, {
      session_id: "files",
      custom: { retained: true },
      widget: { kind: "files", host_id: "host", path: "/work" },
    });

    expect(added?.tiles[0]).toMatchObject({
      session_id: "files",
      x: 0,
      y: 0,
      w: 24,
      h: 24,
      custom: { retained: true },
      widget: { kind: "files", host_id: "host", path: "/work" },
    });
    expect(layout.tiles).toEqual([]);
  });

  it("exposes a false predicate and refuses additions at sixteen tiles", () => {
    const tiles: Tile[] = Array.from({ length: MAX_TILES_PER_TAB }, (_, index) => ({
      session_id: String(index),
      x: (index % 4) * MIN_TILE_SIZE,
      y: Math.floor(index / 4) * MIN_TILE_SIZE,
      w: MIN_TILE_SIZE,
      h: MIN_TILE_SIZE,
    }));
    const layout: GridLayoutV3 = { version: 3, tiles };

    expect(canAddTile(layout)).toBe(false);
    expect(addTile(layout, { session_id: "overflow" })).toBeNull();
  });
});
