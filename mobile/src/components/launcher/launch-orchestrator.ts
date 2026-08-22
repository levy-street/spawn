import { agentRunCommand } from "@/components/launcher/agent-command";
import { autoPlaceWorkspaceTiles } from "@/components/launcher/launcher-selection";
import type { PendingLaunchRead, PendingLaunchStore } from "@/components/launcher/pending-launch";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceLayoutV3, WorkspaceOut } from "@/data/api/schemas/workspaces";
import { isFilesWidget } from "@/data/types/layout";

export type LaunchAvailabilityReason = "host_offline" | "tab_full" | null;

export interface LaunchRequest {
  workspaceId: string;
  tabId: string;
  hostId: string;
  cwd: string;
  name?: string;
  agent?: AgentOut;
}

export interface LaunchDependencies {
  getWorkspace(workspaceId: string): Promise<WorkspaceOut>;
  patchWorkspace(workspaceId: string, patch: { layout: WorkspaceLayoutV3 }): Promise<WorkspaceOut>;
  createSession(input: {
    host_id: string;
    cwd: string;
    name?: string;
    workspace_id: string;
    tile: { x: number; y: number; w: number; h: number };
  }): Promise<SessionOut>;
  deleteSession(sessionId: string): Promise<void>;
  pending: PendingLaunchStore;
}

export type LaunchResult =
  | { status: "launched"; session: SessionOut; pendingCommand: boolean }
  | { status: "created_unqueued"; session: SessionOut; command: string; message: string };

export type PendingDeliveryResult =
  | { status: "sent" }
  | { status: "missing" }
  | { status: "stale" }
  | { status: "lost"; message: string };

export interface TerminalCommandSink {
  sendInput(data: string): void;
  focus(): void;
}

export class LauncherError extends Error {
  constructor(
    readonly code: "tab_missing" | "tab_full",
    message: string,
  ) {
    super(message);
    this.name = "LauncherError";
  }
}

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
      const workspace = await dependencies.getWorkspace(request.workspaceId);
      const target = workspace.layout.tabs.find((tab) => tab.id === request.tabId);
      if (!target) throw new LauncherError("tab_missing", "The selected tab no longer exists.");
      const placement = autoPlaceWorkspaceTiles(target.layout.tiles);
      if (!placement.tile) {
        throw new LauncherError("tab_full", "The selected tab has no room for another terminal.");
      }

      const layout: WorkspaceLayoutV3 = {
        ...workspace.layout,
        active_tab: target.id,
        tabs: workspace.layout.tabs.map((tab) =>
          tab.id === target.id
            ? {
                ...tab,
                layout: {
                  ...tab.layout,
                  tiles: placement.tiles.map((tile) => ({
                    session_id: tile.session_id,
                    x: tile.x,
                    y: tile.y,
                    w: tile.w,
                    h: tile.h,
                    ...(isFilesWidget(tile.widget) ? { widget: tile.widget } : {}),
                  })),
                },
              }
            : tab,
        ),
      };
      await dependencies.patchWorkspace(workspace.id, { layout });

      const trimmedName = request.name?.trim();
      const session = await dependencies.createSession({
        host_id: request.hostId,
        cwd: request.cwd,
        workspace_id: request.workspaceId,
        tile: placement.tile,
        ...(trimmedName ? { name: trimmedName } : {}),
      });
      if (!request.agent) return { status: "launched", session, pendingCommand: false };

      const command = agentRunCommand(request.agent);
      try {
        await dependencies.pending.persist(session.id, command);
        return { status: "launched", session, pendingCommand: true };
      } catch (error) {
        return {
          status: "created_unqueued",
          session,
          command,
          message:
            error instanceof Error
              ? error.message
              : "The agent command could not be saved after the shell was created.",
        };
      }
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
      await dependencies.pending.clear(sessionId);
    },

    async deliverPending(
      sessionId: string,
      terminal: TerminalCommandSink,
    ): Promise<PendingDeliveryResult> {
      let pending: PendingLaunchRead;
      try {
        pending = await dependencies.pending.take(sessionId);
      } catch (error) {
        return {
          status: "lost",
          message:
            error instanceof Error
              ? error.message
              : "The saved agent command could not be consumed safely.",
        };
      }
      if (pending.status === "missing") return { status: "missing" };
      if (pending.status === "stale") return { status: "stale" };
      if (pending.status === "lost") return { status: "lost", message: pending.reason };
      try {
        terminal.sendInput(`${pending.record.command}\r`);
        terminal.focus();
        return { status: "sent" };
      } catch (error) {
        return {
          status: "lost",
          message:
            error instanceof Error
              ? error.message
              : "The saved agent command could not be sent to the terminal.",
        };
      }
    },
  };
}

export type LaunchOrchestrator = ReturnType<typeof createLaunchOrchestrator>;
