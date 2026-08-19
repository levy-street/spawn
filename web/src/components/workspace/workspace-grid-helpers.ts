import { GRID_SIZE, type Tile } from "@/lib/grid";

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Convert 12×12 units into the inset pixel geometry used by tile slots. */
export function tilePixelRect(
  tile: Pick<Tile, "x" | "y" | "w" | "h">,
  width: number,
  height: number,
  gap: number,
): PixelRect {
  return {
    left: (tile.x / GRID_SIZE) * width + gap / 2,
    top: (tile.y / GRID_SIZE) * height + gap / 2,
    width: (tile.w / GRID_SIZE) * width - gap,
    height: (tile.h / GRID_SIZE) * height - gap,
  };
}

function sameRect(a: Tile, b: Tile): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Identify the exchange partner when grid.move used its swap fallback. */
export function moveSwapTarget(before: Tile[], after: Tile[], movedId: string): string | null {
  const movedBefore = before.find((tile) => tile.session_id === movedId);
  const movedAfter = after.find((tile) => tile.session_id === movedId);
  if (!movedBefore || !movedAfter || sameRect(movedBefore, movedAfter)) return null;

  for (const candidate of before) {
    if (candidate.session_id === movedId || !sameRect(candidate, movedAfter)) continue;
    const candidateAfter = after.find((tile) => tile.session_id === candidate.session_id);
    if (candidateAfter && sameRect(candidateAfter, movedBefore)) return candidate.session_id;
  }
  return null;
}

/**
 * Persist a mobile reorder. Four or fewer panes can be represented as a
 * valid full-width stack in the 12-row wire format. Above four, a full-width
 * stack is mathematically impossible with the 3-row minimum, so preserve the
 * valid rect multiset and assign ids to those rects in the requested order.
 */
export function repackMobileTiles(tiles: Tile[], orderedIds: string[]): Tile[] {
  const ids = orderedIds.filter((id) => tiles.some((tile) => tile.session_id === id));
  if (ids.length === 0) return [];

  if (ids.length <= 4) {
    const baseHeight = Math.floor(GRID_SIZE / ids.length);
    let remainder = GRID_SIZE % ids.length;
    let y = 0;
    return ids.map((sessionId) => {
      const h = baseHeight + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      const tile = { session_id: sessionId, x: 0, y, w: GRID_SIZE, h };
      y += h;
      return tile;
    });
  }

  const rects = [...tiles]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(({ x, y, w, h }) => ({ x, y, w, h }));
  return ids.map((sessionId, index) => ({ session_id: sessionId, ...rects[index] }));
}

export function moveIdInOrder(ids: string[], id: string, delta: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
