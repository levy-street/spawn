import { describe, expect, test } from "bun:test";
import { type Tile, validate } from "@/lib/grid";
import {
  moveIdInOrder,
  moveSwapTarget,
  repackMobileTiles,
  tilePixelRect,
} from "./workspace-grid-helpers";

describe("workspace grid view helpers", () => {
  test("converts units to gutter-inset pixels", () => {
    expect(tilePixelRect({ x: 3, y: 6, w: 6, h: 3 }, 1200, 600, 6)).toEqual({
      left: 303,
      top: 303,
      width: 594,
      height: 144,
    });
  });

  test("recognizes a size-exchanging swap", () => {
    const before: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 3, h: 12 },
      { session_id: "b", x: 3, y: 0, w: 9, h: 12 },
    ];
    const after: Tile[] = [
      { session_id: "b", x: 0, y: 0, w: 3, h: 12 },
      { session_id: "a", x: 3, y: 0, w: 9, h: 12 },
    ];
    expect(moveSwapTarget(before, after, "a")).toBe("b");
  });

  test("builds a valid full-width mobile stack", () => {
    const tiles: Tile[] = [
      { session_id: "a", x: 0, y: 0, w: 6, h: 12 },
      { session_id: "b", x: 6, y: 0, w: 6, h: 12 },
      { session_id: "c", x: 0, y: 6, w: 6, h: 6 },
    ];
    const packed = repackMobileTiles(tiles, ["c", "a", "b"]);
    expect(packed.map((tile) => [tile.session_id, tile.x, tile.y, tile.w, tile.h])).toEqual([
      ["c", 0, 0, 12, 4],
      ["a", 0, 4, 12, 4],
      ["b", 0, 8, 12, 4],
    ]);
    expect(validate({ version: 2, tiles: packed }).ok).toBe(true);
  });

  test("preserves valid geometry when more than four panes are reordered", () => {
    const tiles: Tile[] = Array.from({ length: 8 }, (_, index) => ({
      session_id: String(index),
      x: (index % 4) * 3,
      y: index < 4 ? 0 : 6,
      w: 3,
      h: 6,
    }));
    const packed = repackMobileTiles(tiles, [...tiles.map((tile) => tile.session_id)].reverse());
    expect(validate({ version: 2, tiles: packed }).ok).toBe(true);
    expect(packed[0]?.session_id).toBe("7");
  });

  test("moves ids without mutating the source", () => {
    const ids = ["a", "b", "c"];
    expect(moveIdInOrder(ids, "b", -1)).toEqual(["b", "a", "c"]);
    expect(ids).toEqual(["a", "b", "c"]);
  });
});
