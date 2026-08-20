import type { Session, Workspace } from "@/lib/api";
import { sessionNeedsAttention } from "@/lib/sessions";
import { allSessionIds, allTiles, type WorkspaceTab } from "@/lib/tabs";

/**
 * Pure derivation helpers for workspaces: default naming, per-workspace
 * session order, attention rollups, and recency for ordering heuristics.
 */

/** Next unused "Workspace N" default name. */
export function defaultWorkspaceName(existing: Workspace[]): string {
  const names = new Set(existing.map((workspace) => workspace.name));
  let n = existing.length + 1;
  while (names.has(`Workspace ${n}`)) n += 1;
  return `Workspace ${n}`;
}

/** Session ids across the workspace: tabs in order, reading order within. */
export function workspaceSessionIds(workspace: Workspace): string[] {
  return allSessionIds(workspace.layout);
}

export function workspaceTileCount(workspace: Workspace): number {
  return allTiles(workspace.layout).length;
}

/**
 * Workspaces whose name matches the sidebar search, in the order given.
 * Case- and whitespace-insensitive substring, not fuzzy: the sidebar is a
 * short list of names you chose, so a plain contains is both predictable and
 * enough. An empty query matches everything.
 */
export function filterWorkspacesByName(list: Workspace[], query: string): Workspace[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return list;
  return list.filter((workspace) => workspace.name.toLowerCase().includes(needle));
}

/** Put away rather than deleted: out of the sidebar's list, and stopped. */
export function isArchived(workspace: Workspace): boolean {
  return workspace.archived_at !== null;
}

/**
 * Sessions on the workspace that archiving would stop — the count the confirm
 * dialog warns about. Exited and killed panes are already over, so archiving a
 * workspace made only of those costs nothing and asks nothing.
 */
export function workspaceLiveSessionCount(
  workspace: Workspace,
  sessionsById: Map<string, Session>,
): number {
  return workspaceSessionIds(workspace).filter((id) => {
    const session = sessionsById.get(id);
    return session !== undefined && session.status !== "exited" && session.status !== "killed";
  }).length;
}

/** Sessions on the workspace that currently want the operator's attention. */
export function workspaceAttentionCount(
  workspace: Workspace,
  sessionsById: Map<string, Session>,
): number {
  return workspaceSessionIds(workspace).filter((id) => {
    const session = sessionsById.get(id);
    return session && sessionNeedsAttention(session) !== null;
  }).length;
}

/** Sessions in one tab that want attention — the same rollup as the sidebar's
 *  workspace badge, so a tab can say what is waiting behind it. */
export function tabAttentionCount(tab: WorkspaceTab, sessionsById: Map<string, Session>): number {
  return tab.layout.tiles.filter((tile) => {
    if (tile.widget) return false;
    const session = sessionsById.get(tile.session_id);
    return session ? sessionNeedsAttention(session) !== null : false;
  }).length;
}

/** Recency for ordering heuristics: the newest *input* across the workspace's
 *  sessions (user-driven, so it doesn't churn while panes stream), falling
 *  back to when the workspace itself last changed. */
export function workspaceRecency(workspace: Workspace, sessionsById: Map<string, Session>): number {
  const times = workspaceSessionIds(workspace)
    .map((id) => sessionsById.get(id)?.last_input_at)
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  const paneMax = times.length > 0 ? Math.max(...times) : 0;
  const updated = Date.parse(workspace.updated_at);
  return Math.max(paneMax, Number.isFinite(updated) ? updated : 0);
}
