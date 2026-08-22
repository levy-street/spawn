import { useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { useCallback } from "react";
import { pendingLaunches } from "@/components/launcher/pending-launch";

import {
  createSession,
  deleteSession,
  getSessionAccess,
  patchSession,
  restartSession,
} from "@/data/api/endpoints/sessions";
import { patchWorkspace } from "@/data/api/endpoints/workspaces";
import { applyMobileOrder, readingOrder } from "@/data/layout/mobile-order";
import {
  addTab,
  movePaneToTab,
  removePane,
  removeTab,
  renameTab,
  reorderTab,
} from "@/data/layout/tabs";
import { addTile } from "@/data/layout/tiles";
import {
  normalizeWorkspace,
  useWorkspaceLayoutCommit,
  useWorkspaceReorder,
} from "@/data/queries/workspace-detail";
import { qk } from "@/data/queryKeys";
import { agentRunCommand, runningAgent } from "@/data/selectors/agent";
import type { AgentDef, Session, Workspace } from "@/data/types/domain";
import type { PaneId, TabId, Tile, WorkspaceLayoutV3 } from "@/data/types/layout";

function replaceTabLayout(
  workspace: Workspace,
  tabId: TabId,
  nextTab: ReturnType<typeof applyMobileOrder>,
): WorkspaceLayoutV3 {
  return {
    ...workspace.layout,
    tabs: workspace.layout.tabs.map((tab) => (tab.id === tabId ? nextTab : tab)),
  };
}

export function reorderPaneLayout(
  workspace: Workspace,
  tabId: TabId,
  paneId: PaneId,
  offset: -1 | 1,
): WorkspaceLayoutV3 {
  const tab = workspace.layout.tabs.find((candidate) => candidate.id === tabId);
  if (!tab) return workspace.layout;
  const ids = readingOrder(tab).map((tile) => tile.session_id);
  const from = ids.indexOf(paneId);
  const to = Math.min(Math.max(0, from + offset), ids.length - 1);
  if (from < 0 || from === to) return workspace.layout;
  const [moved] = ids.splice(from, 1);
  if (!moved) return workspace.layout;
  ids.splice(to, 0, moved);
  return replaceTabLayout(workspace, tabId, applyMobileOrder(tab, ids));
}

export async function deleteSessionsForTab(
  sessionIds: readonly string[],
  removeSession: (sessionId: string) => Promise<unknown> = deleteSession,
): Promise<void> {
  const deletions = await Promise.allSettled(
    sessionIds.map((sessionId) => removeSession(sessionId)),
  );
  const failure = deletions.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
}

export function useWorkspaceActions(onReorderError: (error: unknown) => void) {
  const client = useQueryClient();
  const commit = useWorkspaceLayoutCommit();
  const reorder = useWorkspaceReorder(onReorderError);

  const invalidateSessions = useCallback(async () => {
    await client.invalidateQueries({ queryKey: qk.sessions() });
  }, [client]);

  return {
    createTab: async (workspace: Workspace) => {
      const layout = addTab(workspace.layout, randomUUID());
      if (!layout) throw new Error("A workspace can have up to 8 tabs.");
      return commit(workspace, layout);
    },
    renameWorkspace: async (workspace: Workspace, name: string) => {
      const saved = normalizeWorkspace(await patchWorkspace(workspace.id, { name }));
      client.setQueryData(qk.workspace(workspace.id), saved);
      await client.invalidateQueries({ queryKey: qk.workspaces() });
      return saved;
    },
    renameTab: (workspace: Workspace, tabId: TabId, name: string) =>
      commit(workspace, renameTab(workspace.layout, tabId, name)),
    reorderTab: (workspace: Workspace, tabId: TabId, toIndex: number) => {
      const layout = reorderTab(workspace.layout, tabId, toIndex);
      if (layout !== workspace.layout) reorder.schedule(workspace, layout);
    },
    deleteTab: async (workspace: Workspace, tabId: TabId) => {
      const tab = workspace.layout.tabs.find((candidate) => candidate.id === tabId);
      const layout = removeTab(workspace.layout, tabId);
      if (!tab || !layout) throw new Error("The last tab cannot be deleted.");
      const sessionIds = tab.layout.tiles
        .filter((tile) => !tile.widget)
        .map((tile) => tile.session_id);
      try {
        await deleteSessionsForTab(sessionIds);
      } finally {
        await invalidateSessions();
      }
      return commit(workspace, layout);
    },
    renameSession: async (session: Session, name: string) => {
      const saved = await patchSession(session.id, { name });
      client.setQueryData(qk.session(session.id), saved);
      await invalidateSessions();
      return saved;
    },
    restartSession: async (session: Session) => {
      const saved = await restartSession(session.id);
      client.setQueryData(qk.session(session.id), saved);
      await invalidateSessions();
      return saved;
    },
    movePane: (workspace: Workspace, paneId: PaneId, targetTabId: TabId) => {
      const layout = movePaneToTab(workspace.layout, paneId, targetTabId);
      if (!layout) throw new Error("There is no room in that tab.");
      return commit(workspace, layout);
    },
    reorderPane: (workspace: Workspace, tabId: TabId, paneId: PaneId, offset: -1 | 1) => {
      const layout = reorderPaneLayout(workspace, tabId, paneId, offset);
      reorder.schedule(workspace, layout);
    },
    removePane: async (workspace: Workspace, tile: Tile) => {
      if (!tile.widget) {
        await deleteSession(tile.session_id);
        await invalidateSessions();
      }
      return commit(workspace, removePane(workspace.layout, tile.session_id));
    },
    duplicatePane: async (
      workspace: Workspace,
      tile: Tile,
      session: Session | null,
      agents: readonly AgentDef[],
    ) => {
      const sourceTab = workspace.layout.tabs.find((tab) =>
        tab.layout.tiles.some((candidate) => candidate.session_id === tile.session_id),
      );
      if (!sourceTab) throw new Error("That pane is no longer in this workspace.");

      if (tile.widget) {
        const layout = addTile(sourceTab.layout, {
          session_id: randomUUID(),
          widget: { ...tile.widget },
        });
        if (!layout)
          throw new Error("This tab is full — close a window before duplicating another.");
        return commit(
          workspace,
          replaceTabLayout(workspace, sourceTab.id, { ...sourceTab, layout }),
        );
      }

      if (!session) throw new Error("Session unavailable.");
      const access = await getSessionAccess(session.id);
      const duplicate = await createSession({
        host_id: session.host_id,
        cwd: session.cwd,
        name: session.name,
        skill_ids: access.skills.map((skill) => skill.id),
      });
      const layout = addTile(sourceTab.layout, { session_id: duplicate.id });
      if (!layout) {
        await deleteSession(duplicate.id);
        throw new Error("This tab is full — close a window before duplicating another.");
      }
      let saved: Workspace;
      try {
        saved = await commit(
          workspace,
          replaceTabLayout(workspace, sourceTab.id, { ...sourceTab, layout }),
        );
      } catch (error) {
        await deleteSession(duplicate.id).catch(() => undefined);
        throw error;
      }
      const agent = runningAgent(session.foreground_command, agents);
      if (agent) {
        try {
          await pendingLaunches.persist(duplicate.id, agentRunCommand(agent));
        } catch {
          await invalidateSessions();
          throw new Error(
            "The session was duplicated as a shell, but the agent command could not be saved.",
          );
        }
      }
      await invalidateSessions();
      return saved;
    },
    flushReorders: () => reorder.flush(),
  };
}
