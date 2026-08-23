import type { CreateWorkspaceDraft } from "@/components/workspaces/create-workspace-dialog";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import type { Workspace, WorkspaceStats } from "@/data/types/domain";

export interface WorkspaceRowModel {
  workspace: WorkspaceOut;
  stats: WorkspaceStats;
}

export type WorkspaceOperationInput =
  | {
      kind: "template";
      draft: CreateWorkspaceDraft;
      templateId: string;
      agents: readonly AgentOut[];
    }
  | {
      kind: "duplicate";
      workspace: WorkspaceOut;
      sessions: readonly SessionOut[];
      agents: readonly AgentOut[];
      existingNames: readonly string[];
    };

export function workspaceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

export function workspaceForSelectors(workspace: WorkspaceOut): Workspace {
  return {
    ...workspace,
    layout: {
      ...workspace.layout,
      tabs: workspace.layout.tabs.map((tab) => ({
        ...tab,
        layout: {
          ...tab.layout,
          tiles: tab.layout.tiles.map(({ widget, ...tile }) =>
            widget ? { ...tile, widget } : tile,
          ),
        },
      })),
    },
  };
}
