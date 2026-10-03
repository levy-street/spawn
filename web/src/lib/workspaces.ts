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

/**
 * The folder a workspace is "about", for what still wants one — its icon is
 * looked for there. A workspace has no host or folder of its own; this is
 * where its first window runs (tabs in order, reading order within), falling
 * back to the home older workspaces were created with.
 */
export function workspaceFolder(
  workspace: Workspace,
  sessions: readonly Session[],
): { host_id: string; cwd: string } | null {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  for (const id of workspaceSessionIds(workspace)) {
    const session = byId.get(id);
    if (session) return { host_id: session.host_id, cwd: session.cwd };
  }
  for (const tile of allTiles(workspace.layout)) {
    if (tile.widget) return { host_id: tile.widget.host_id, cwd: tile.widget.path };
  }
  return workspace.host_id && workspace.cwd
    ? { host_id: workspace.host_id, cwd: workspace.cwd }
    : null;
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

/** The most urgent thing among some sessions: a window that died outranks
 *  one that is waiting on you. Null when none needs anything. */
export type AttentionLevel = "dead" | "waiting";

function worstAttention(sessions: Iterable<Session | undefined>): AttentionLevel | null {
  let worst: AttentionLevel | null = null;
  for (const session of sessions) {
    const level = session ? sessionNeedsAttention(session) : null;
    if (level === "dead") return "dead";
    if (level === "waiting") worst = "waiting";
  }
  return worst;
}

export function workspaceAttentionLevel(
  workspace: Workspace,
  sessionsById: Map<string, Session>,
): AttentionLevel | null {
  return worstAttention(workspaceSessionIds(workspace).map((id) => sessionsById.get(id)));
}

export function tabAttentionLevel(
  tab: WorkspaceTab,
  sessionsById: Map<string, Session>,
): AttentionLevel | null {
  return worstAttention(
    tab.layout.tiles
      .filter((tile) => !tile.widget)
      .map((tile) => sessionsById.get(tile.session_id)),
  );
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
