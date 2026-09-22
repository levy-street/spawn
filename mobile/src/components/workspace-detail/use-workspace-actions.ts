import { useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { useCallback } from "react";
import { restartSessionAgent } from "@/components/launcher/agent-restart";
import { pendingLaunches } from "@/components/launcher/pending-launch";

import {
  createSession,
  deleteSession,
  getSession,
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
import { killSession } from "@/data/queries/session-teardown";
import {
  normalizeWorkspace,
  useWorkspaceLayoutCommit,
  useWorkspaceReorder,
} from "@/data/queries/workspace-detail";
import { qk } from "@/data/queryKeys";
import { agentLaunchCommand, newAgentConversationId, sessionAgent } from "@/data/selectors/agent";
import type { AgentDef, Host, Session, Workspace } from "@/data/types/domain";
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
  removeSession: (sessionId: string) => Promise<unknown> = killSession,
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
    /**
     * Bring the window back as what it was opened as: its agent resumed in
     * the same conversation where the CLI can, a login shell otherwise. From
     * the workspace there is no terminal open to type into, so the shell is
     * restarted and the agent's resume command waits for the terminal to
     * open (`agent-restart.ts`).
     */
    restartSession: async (session: Session, agents: readonly AgentDef[]) => {
      const result = await restartSessionAgent({
        session,
        agents,
        terminal: null,
        restart: async (sessionId) => {
          const saved = await restartSession(sessionId);
          client.setQueryData(qk.session(sessionId), saved);
          return saved;
        },
        pending: pendingLaunches,
        getSession,
      });
      await invalidateSessions();
      return result;
    },
    movePane: (workspace: Workspace, paneId: PaneId, targetTabId: TabId) => {
      const layout = movePaneToTab(workspace.layout, paneId, targetTabId);
      if (!layout) throw new Error("There is no room in that tab.");
      return commit(workspace, layout);
    },
    /**
     * Re-point a pane at another machine. The shell cannot be carried across, so
     * a fresh one is started on the new host — created before anything is torn
     * down, so a host that has just dropped offline leaves the pane as it was —
     * the tile keeps its place, and whatever agent was running is queued to run
     * again over there.
     */
    movePaneToHost: async (
      workspace: Workspace,
      tile: Tile,
      host: Host,
      session: Session | null,
      agents: readonly AgentDef[],
    ) => {
      const sourceTab = workspace.layout.tabs.find((tab) =>
        tab.layout.tiles.some((candidate) => candidate.session_id === tile.session_id),
      );
      if (!sourceTab) throw new Error("That pane is no longer in this workspace.");
      const movedAgent = sessionAgent(session ?? undefined, agents);
      // Another host is another conversation: the agent's own state does not
      // travel, so the window over there starts a fresh one under a new id.
      const movedConversation = movedAgent
        ? newAgentConversationId(movedAgent.kind, randomUUID)
        : null;
      const created = await createSession({
        host_id: host.id,
        cwd: "~",
        ...(session?.name ? { name: session.name } : {}),
        // The window arrives on the new host as the same kind of window, so it
        // is one even before its agent has taken the foreground over there.
        ...(movedAgent ? { agent_id: movedAgent.id, agent_session_id: movedConversation } : {}),
      });
      const nextTab = {
        ...sourceTab,
        layout: {
          ...sourceTab.layout,
          tiles: sourceTab.layout.tiles.map((candidate) =>
            candidate.session_id === tile.session_id
              ? { ...candidate, session_id: created.id }
              : candidate,
          ),
        },
      };
      let saved: Workspace;
      try {
        saved = await commit(workspace, replaceTabLayout(workspace, sourceTab.id, nextTab));
      } catch (error) {
        await deleteSession(created.id).catch(() => undefined);
        throw error;
      }

      const agent = movedAgent;
      let launchError: Error | null = null;
      if (agent) {
        try {
          await pendingLaunches.persist(created.id, agentLaunchCommand(agent, movedConversation));
        } catch {
          launchError = new Error(
            `The window moved to ${host.name} as a shell, but ${agent.name} could not be queued.`,
          );
        }
      }
      await deleteSession(tile.session_id).catch(() => undefined);
      await invalidateSessions();
      if (launchError) throw launchError;
      return { workspace: saved, session: created };
    },
    reorderPane: (workspace: Workspace, tabId: TabId, paneId: PaneId, offset: -1 | 1) => {
      const layout = reorderPaneLayout(workspace, tabId, paneId, offset);
      reorder.schedule(workspace, layout);
    },
    removePane: async (workspace: Workspace, tile: Tile) => {
      if (!tile.widget) {
        // A pane whose session the server has already dropped is precisely the
        // dead row this action exists to clear, so a session that is missing is
        // the goal rather than a failure — treating it as one is what left
        // "Session unavailable" rows that could not be removed at all.
        await killSession(tile.session_id);
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
      const agent = sessionAgent(session, agents);
      // A copy is the same kind of window in a conversation of its own.
      const conversation = agent ? newAgentConversationId(agent.kind, randomUUID) : null;
      const duplicate = await createSession({
        host_id: session.host_id,
        cwd: session.cwd,
        name: session.name,
        // The copy is the same kind of window as its source — a Hermes window
        // duplicates as a Hermes window — whatever process happens to hold the
        // source's foreground right now.
        ...(agent ? { agent_id: agent.id, agent_session_id: conversation } : {}),
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
      if (agent) {
        try {
          await pendingLaunches.persist(duplicate.id, agentLaunchCommand(agent, conversation));
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
