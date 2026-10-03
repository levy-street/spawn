import type { WorkspaceOut, WorkspaceTile } from "@/data/api/schemas/workspaces";
import { type AutoPlaceResult, autoPlace } from "@/data/layout/tiles";
import type { Tile } from "@/data/types/layout";

export function autoPlaceWorkspaceTiles(tiles: readonly WorkspaceTile[]): AutoPlaceResult {
  const domainTiles: Tile[] = tiles.map((tile) => ({
    session_id: tile.session_id,
    x: tile.x,
    y: tile.y,
    w: tile.w,
    h: tile.h,
    ...(tile.widget ? { widget: tile.widget } : {}),
  }));
  return autoPlace(domainTiles);
}

export function firstAvailableTabId(
  workspace: WorkspaceOut,
  preferredTabId?: string | null,
): string | null {
  const preferred = workspace.layout.tabs.find((tab) => tab.id === preferredTabId);
  if (preferred && autoPlaceWorkspaceTiles(preferred.layout.tiles).tile) return preferred.id;
  return (
    workspace.layout.tabs.find((tab) => autoPlaceWorkspaceTiles(tab.layout.tiles).tile !== null)
      ?.id ?? null
  );
}
