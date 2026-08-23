import { GRID_SIZE, orderedTiles } from "@/data/layout/tiles";
import type { PaneId, Tile, WorkspaceTab } from "@/data/types/layout";

/** The phone list is top-to-bottom, then left-to-right, with pane ID as a legacy tie-break. */
export function readingOrder(tab: WorkspaceTab): Tile[] {
  return orderedTiles(tab.layout.tiles);
}

export function isValidMobileOrder(tab: WorkspaceTab, orderedIds: readonly PaneId[]): boolean {
  if (orderedIds.length !== tab.layout.tiles.length) return false;
  const existing = new Set(tab.layout.tiles.map((tile) => tile.session_id));
  return (
    new Set(orderedIds).size === orderedIds.length && orderedIds.every((id) => existing.has(id))
  );
}

/**
 * Rewrites only geometry. Payloads and unknown tile fields remain attached to their pane IDs.
 * Up to six panes become full-width rows; larger tabs reuse their existing rectangle multiset.
 */
export function applyMobileOrder(tab: WorkspaceTab, orderedIds: PaneId[]): WorkspaceTab {
  if (!isValidMobileOrder(tab, orderedIds)) return tab;
  if (orderedIds.length === 0) return { ...tab, layout: { ...tab.layout, tiles: [] } };
  const byId = new Map(tab.layout.tiles.map((tile) => [tile.session_id, tile]));
  const requested = orderedIds
    .map((id) => byId.get(id))
    .filter((tile): tile is Tile => tile !== undefined);

  let tiles: Tile[];
  if (requested.length <= 6) {
    const baseHeight = Math.floor(GRID_SIZE / requested.length);
    let remainder = GRID_SIZE % requested.length;
    let y = 0;
    tiles = requested.map((tile) => {
      const height = baseHeight + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      const ordered = { ...tile, x: 0, y, w: GRID_SIZE, h: height };
      y += height;
      return ordered;
    });
  } else {
    const rectangles = readingOrder(tab).map(({ x, y, w, h }) => ({ x, y, w, h }));
    tiles = requested.map((tile, index) => ({ ...tile, ...rectangles[index] }));
  }

  return { ...tab, layout: { ...tab.layout, tiles: orderedTiles(tiles) } };
}
