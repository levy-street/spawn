import type { HostOut } from "@/data/api/schemas/hosts";
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

export interface LaunchHome {
  host: HostOut;
  cwd: string;
}

/**
 * Where a window added to `tabId` opens: the tab's own home when it has one,
 * else the workspace's (chosen when it was created). With either, adding a
 * window never asks where — picking what to run creates it there. Null means
 * the launcher has to ask, which is the pre-migration case (a workspace whose
 * home host has been removed) and the explicit "somewhere else" choice.
 */
export function resolveLaunchHome(
  workspace: WorkspaceOut,
  tabId: string,
  hosts: readonly HostOut[],
): LaunchHome | null {
  const tab = workspace.layout.tabs.find((candidate) => candidate.id === tabId);
  const pair =
    tab?.host_id && tab.cwd
      ? { hostId: tab.host_id, cwd: tab.cwd }
      : workspace.host_id && workspace.cwd
        ? { hostId: workspace.host_id, cwd: workspace.cwd }
        : null;
  if (!pair) return null;
  const host = hosts.find((candidate) => candidate.id === pair.hostId);
  return host ? { host, cwd: pair.cwd } : null;
}
