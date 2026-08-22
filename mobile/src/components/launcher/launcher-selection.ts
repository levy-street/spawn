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

export function resolveInitialDirectory(
  workspace: WorkspaceOut,
  tabId: string,
  hostId: string,
): string | null {
  const tab = workspace.layout.tabs.find((candidate) => candidate.id === tabId);
  if (tab?.host_id === hostId && tab.cwd) return tab.cwd;
  if (workspace.host_id === hostId && workspace.cwd) return workspace.cwd;
  return null;
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
