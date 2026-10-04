import { createWindow, LauncherError, toWireTile } from "@/components/launcher/create-window";
import { autoPlaceWorkspaceTiles } from "@/components/launcher/launcher-selection";
import type { PendingLaunchStore } from "@/components/launcher/pending-launch";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionCreate, SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceLayoutV3, WorkspaceOut } from "@/data/api/schemas/workspaces";

export { LauncherError };

export type LaunchAvailabilityReason = "host_offline" | "tab_full" | null;

export interface LaunchRequest {
  workspaceId: string;
  tabId: string;
  hostId: string;
  cwd: string;
  name?: string;
  agent?: AgentOut;
}

export interface WidgetRequest {
  workspaceId: string;
  tabId: string;
  hostId: string;
  path: string;
}

export interface LaunchDependencies {
  getWorkspace(workspaceId: string): Promise<WorkspaceOut>;
  patchWorkspace(workspaceId: string, patch: { layout: WorkspaceLayoutV3 }): Promise<WorkspaceOut>;
  createSession(input: SessionCreate): Promise<SessionOut>;
  deleteSession(sessionId: string): Promise<void>;
  /** Ids for widget tiles, which the server never mints one for — and for
   *  the conversation an agent is started under, which SPAWN D names so a
   *  restart can resume it. */
  newId(): string;
  pending: PendingLaunchStore;
}

export type LaunchResult =
  | { status: "launched"; session: SessionOut; pendingCommand: boolean }
  | { status: "created_unqueued"; session: SessionOut; command: string; message: string };

export function launchAvailability(
  tab: WorkspaceOut["layout"]["tabs"][number],
  host: HostOut,
): LaunchAvailabilityReason {
  if (host.status !== "online") return "host_offline";
  return autoPlaceWorkspaceTiles(tab.layout.tiles).tile === null ? "tab_full" : null;
}

export function createLaunchOrchestrator(dependencies: LaunchDependencies) {
  return {
    async launch(request: LaunchRequest): Promise<LaunchResult> {
      // The tab is made room in and saved first, then the window is made in
      // it: the one way a window is opened (`create-window.ts`).
      const result = await createWindow(
        {
          host: { id: request.hostId },
          cwd: request.cwd,
          ...(request.agent ? { agent: request.agent } : {}),
          ...(request.name === undefined ? {} : { name: request.name }),
          workspace: { kind: "workspace", workspaceId: request.workspaceId, tabId: request.tabId },
        },
        dependencies,
      );
      if (result.status === "created_unqueued") {
        const { session, command, message } = result;
        return { status: "created_unqueued", session, command, message };
      }
      return { status: "launched", session: result.session, pendingCommand: result.pendingCommand };
    },

    /**
     * A file explorer is layout, not a session: it is placed and saved in the
     * same PATCH, and there is nothing to create afterwards.
     */
    async addFilesWidget(request: WidgetRequest): Promise<WorkspaceOut> {
      const workspace = await dependencies.getWorkspace(request.workspaceId);
      const target = workspace.layout.tabs.find((tab) => tab.id === request.tabId);
      if (!target) throw new LauncherError("tab_missing", "The selected tab no longer exists.");
      const placement = autoPlaceWorkspaceTiles(target.layout.tiles);
      if (!placement.tile) {
        throw new LauncherError("tab_full", "The selected tab has no room for another pane.");
      }

      const widget = {
        ...placement.tile,
        session_id: dependencies.newId(),
        widget: { kind: "files" as const, host_id: request.hostId, path: request.path },
      };
      const layout: WorkspaceLayoutV3 = {
        ...workspace.layout,
        active_tab: target.id,
        tabs: workspace.layout.tabs.map((tab) =>
          tab.id === target.id
            ? {
                ...tab,
                layout: {
                  ...tab.layout,
                  tiles: [...placement.tiles.map(toWireTile), toWireTile(widget)],
                },
              }
            : tab,
        ),
      };
      return dependencies.patchWorkspace(workspace.id, { layout });
    },

    async discard(sessionId: string): Promise<void> {
      let clearError: unknown;
      try {
        await dependencies.pending.clear(sessionId);
      } catch (error) {
        clearError = error;
      }
      await dependencies.deleteSession(sessionId);
      if (clearError !== undefined) throw clearError;
    },

    async keepShell(sessionId: string): Promise<void> {
      if (dependencies.pending.abandon) await dependencies.pending.abandon(sessionId);
      else await dependencies.pending.clear(sessionId);
    },
  };
}

export type LaunchOrchestrator = ReturnType<typeof createLaunchOrchestrator>;
