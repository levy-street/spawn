import { GRID_SIZE, MAX_TILES, MIN_TILE_SIZE, type Rect, type Tile, validate } from "@/lib/grid";
import { foldTabInto, type LayoutV3, mergeTabs, tabById } from "@/lib/tabs";
import { type DockZone, dockSplitRect } from "./workspace-grid-helpers";

/**
 * Aiming a whole tab at another tab's canvas — the drop at the end of dragging
 * a tab down out of the strip.
 *
 * A tab arrives as a *block*, not as loose windows: the arrangement is the
 * thing worth keeping, so the windows land in the region you aimed at with
 * every one of them holding the share of the tab it came from. Two panes side
 * by side stay side by side, at half the region's width each.
 *
 * That is what gives the block a minimum size, and why the minimum is a fact
 * about the arrangement rather than about the count: four windows in a row
 * need four times the canvas minimum across and one down, while the same four
 * in a square need twice the minimum each way. `blockMinSize` works it out,
 * and a region under it is refused rather than being filled with windows too
 * small to use.
 *
 * Everything here is pure. The envelope rules stay in `lib/tabs.ts`
 * (`foldTabInto` closes the emptied tab); this file only decides geometry.
 */

/** Where a dragged tab's windows land. */
export type MergeDrop =
  /** Filling a region of free canvas — an opening, or an empty tab's whole grid. */
  | { kind: "region"; rect: Rect }
  /** Taking half of the window under the pointer, which keeps the other half. */
  | { kind: "dock"; paneId: string; zone: DockZone }
  /** Nothing aimed at: the windows are auto-placed one by one, as the menu's are. */
  | { kind: "auto" };

/** The whole canvas — where a block lands in a tab that is still empty. */
export const WHOLE_CANVAS: Rect = { x: 0, y: 0, w: GRID_SIZE, h: GRID_SIZE };

/** The block's own bounds in the tab it came from; null when it holds nothing. */
function blockBounds(tiles: Tile[]): Rect | null {
  if (tiles.length === 0) return null;
  let x0 = GRID_SIZE;
  let y0 = GRID_SIZE;
  let x1 = 0;
  let y1 = 0;
  for (const tile of tiles) {
    x0 = Math.min(x0, tile.x);
    y0 = Math.min(y0, tile.y);
    x1 = Math.max(x1, tile.x + tile.w);
    y1 = Math.max(y1, tile.y + tile.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * One edge carried from the source's bounds into a region of `size` cells.
 *
 * Edges are mapped, never sizes: two windows that met at cell 12 both map that
 * same 12, so they still meet exactly wherever the block lands — no seam opens
 * between them and neither creeps over the other. Rounding sizes instead would
 * do both.
 */
function mapEdge(value: number, from: number, span: number, size: number): number {
  return Math.round(((value - from) * size) / span);
}

/** Whether every window still clears the canvas minimum along one axis. */
function axisFits(
  tiles: Tile[],
  from: number,
  span: number,
  size: number,
  axis: "x" | "y",
): boolean {
  return tiles.every((tile) => {
    const start = axis === "x" ? tile.x : tile.y;
    const end = start + (axis === "x" ? tile.w : tile.h);
    return mapEdge(end, from, span, size) - mapEdge(start, from, span, size) >= MIN_TILE_SIZE;
  });
}

/**
 * The smallest region this block can be laid into with every window still at
 * the canvas minimum.
 *
 * Read as "the largest size that still crushes a window, plus one" rather than
 * as the first size that works, because the rounding that shares cells out is
 * not monotone: a region a cell wider can hand a window a cell less. Defined
 * this way, every size at or above the answer is genuinely safe, which is what
 * a caller gating a drop needs.
 */
export function blockMinSize(tiles: Tile[]): { w: number; h: number } {
  const bounds = blockBounds(tiles);
  if (!bounds) return { w: MIN_TILE_SIZE, h: MIN_TILE_SIZE };
  let w = MIN_TILE_SIZE;
  let h = MIN_TILE_SIZE;
  for (let size = MIN_TILE_SIZE; size <= GRID_SIZE; size++) {
    if (!axisFits(tiles, bounds.x, bounds.w, size, "x")) w = size + 1;
    if (!axisFits(tiles, bounds.y, bounds.h, size, "y")) h = size + 1;
  }
  return { w: Math.min(w, GRID_SIZE), h: Math.min(h, GRID_SIZE) };
}

/**
 * The block laid into `rect`, each window keeping its share of the tab it came
 * from and everything it carried (its widget, its session). Null when `rect` is
 * under `blockMinSize` — an empty block lays into anything and yields nothing.
 */
export function scaleBlock(tiles: Tile[], rect: Rect): Tile[] | null {
  const bounds = blockBounds(tiles);
  if (!bounds) return [];
  const scaled = tiles.map((tile) => {
    const x = rect.x + mapEdge(tile.x, bounds.x, bounds.w, rect.w);
    const y = rect.y + mapEdge(tile.y, bounds.y, bounds.h, rect.h);
    return {
      ...tile,
      x,
      y,
      w: rect.x + mapEdge(tile.x + tile.w, bounds.x, bounds.w, rect.w) - x,
      h: rect.y + mapEdge(tile.y + tile.h, bounds.y, bounds.h, rect.h) - y,
    };
  });
  const fits = scaled.every((tile) => tile.w >= MIN_TILE_SIZE && tile.h >= MIN_TILE_SIZE);
  return fits ? scaled : null;
}

/**
 * Why a drop cannot be taken — so the drag can say which it is rather than
 * just going dead under the hand.
 */
export type MergeRefusal = "capacity" | "fit";

export type MergePlan = {
  /** The envelope to persist: target holding both sets, source tab gone. */
  layout: LayoutV3;
  /** Where the arriving windows land, for the outline the drag draws. */
  incoming: Tile[];
  /** The target's own windows at the geometry the drop leaves them, for the
   *  live preview — a dock halves the window it lands on. */
  resting: Tile[];
};

/**
 * Work out the whole drop: what the canvas would look like, and what to write.
 * `refusal` says why when there is no plan — the canvas is already carrying as
 * many windows as it can, or the region aimed at is under the block's minimum.
 */
export function planMerge(
  layout: LayoutV3,
  sourceTabId: string,
  targetTabId: string,
  drop: MergeDrop,
): { plan: MergePlan | null; refusal: MergeRefusal | null } {
  const source = tabById(layout, sourceTabId);
  const target = tabById(layout, targetTabId);
  if (!source || !target || source.id === target.id) return { plan: null, refusal: null };
  const arriving = source.layout.tiles;
  if (target.layout.tiles.length + arriving.length > MAX_TILES) {
    return { plan: null, refusal: "capacity" };
  }

  if (drop.kind === "auto") {
    const next = mergeTabs(layout, sourceTabId, targetTabId);
    if (!next) return { plan: null, refusal: "capacity" };
    const placed = tabById(next, targetTabId)?.layout.tiles ?? [];
    const ids = new Set(arriving.map((tile) => tile.session_id));
    return {
      plan: {
        layout: next,
        incoming: placed.filter((tile) => ids.has(tile.session_id)),
        resting: placed,
      },
      refusal: null,
    };
  }

  let resting = target.layout.tiles;
  let rect: Rect;
  if (drop.kind === "region") {
    rect = drop.rect;
  } else {
    const pane = resting.find((tile) => tile.session_id === drop.paneId);
    if (!pane) return { plan: null, refusal: null };
    const split = dockSplitRect(pane, drop.zone);
    if (!split) return { plan: null, refusal: "fit" };
    rect = split.moved;
    resting = resting.map((tile) =>
      tile.session_id === pane.session_id ? { ...tile, ...split.kept } : tile,
    );
  }

  const incoming = scaleBlock(arriving, rect);
  if (!incoming) return { plan: null, refusal: "fit" };
  const tiles = [...resting, ...incoming].sort((a, b) => a.y - b.y || a.x - b.x);
  if (!validate({ version: 3, tiles }).ok) return { plan: null, refusal: "fit" };
  const next = foldTabInto(layout, sourceTabId, targetTabId, tiles);
  if (!next) return { plan: null, refusal: null };
  return { plan: { layout: next, incoming, resting: tiles }, refusal: null };
}
