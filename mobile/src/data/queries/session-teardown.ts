import type { QueryClient } from "@tanstack/react-query";

import { ApiError } from "@/data/api/client";
import { deleteSession } from "@/data/api/endpoints/sessions";
import { listWorkspaces } from "@/data/api/endpoints/workspaces";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { removePane } from "@/data/layout/tabs";
import { commitWorkspaceLayout, normalizeWorkspace } from "@/data/queries/workspace-detail";
import { qk } from "@/data/queryKeys";
import type { Workspace } from "@/data/types/domain";

/**
 * A session the server has already dropped. Every teardown path reads this as
 * the outcome it asked for rather than as a failure: the caller wanted the
 * session gone, and it is — a pane left addressing it is the only thing still
 * worth clearing up.
 */
export function isMissingSessionError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export interface KillSessionResult {
  /** True when the server had already dropped the session before we asked. */
  alreadyGone: boolean;
}

export async function killSession(sessionId: string): Promise<KillSessionResult> {
  try {
    await deleteSession(sessionId);
    return { alreadyGone: false };
  } catch (error) {
    if (!isMissingSessionError(error)) throw error;
    return { alreadyGone: true };
  }
}

function holdsPane(workspace: Workspace, sessionId: string): boolean {
  return workspace.layout.tabs.some((tab) =>
    tab.layout.tiles.some((tile) => !tile.widget && tile.session_id === sessionId),
  );
}

/** Every workspace already on the device, detail rows preferred over list rows. */
function cachedWorkspaces(client: QueryClient): Workspace[] {
  const byId = new Map<string, Workspace>();
  for (const [, workspace] of client.getQueriesData<Workspace>({ queryKey: ["workspace"] })) {
    if (workspace) byId.set(workspace.id, workspace);
  }
  for (const key of [qk.workspaces(), qk.archivedWorkspaces()]) {
    for (const row of client.getQueryData<WorkspaceOut[]>(key) ?? []) {
      if (!byId.has(row.id)) byId.set(row.id, normalizeWorkspace(row));
    }
  }
  return [...byId.values()];
}

/**
 * Takes a dead session's pane out of every layout still pointing at it.
 *
 * Deleting a session leaves a tile addressing a row that no longer exists, and
 * a workspace draws that as the unusable "Session unavailable" pane. The server
 * keeps layouts as opaque documents it never edits on the client's behalf, so
 * whoever killed the session is the one that has to tidy up after it.
 *
 * @returns how many workspaces were rewritten.
 */
export async function removeSessionPanes(client: QueryClient, sessionId: string): Promise<number> {
  let holders = cachedWorkspaces(client).filter((workspace) => holdsPane(workspace, sessionId));
  if (holders.length === 0) {
    // A terminal reached by deep link has never opened a workspace, so the
    // layout holding this pane may not be on the device at all yet.
    const rows = await client.fetchQuery({
      queryKey: qk.workspaces(),
      queryFn: () => listWorkspaces(),
    });
    holders = rows.map(normalizeWorkspace).filter((workspace) => holdsPane(workspace, sessionId));
  }
  for (const workspace of holders) {
    await commitWorkspaceLayout(client, workspace, removePane(workspace.layout, sessionId));
  }
  return holders.length;
}
