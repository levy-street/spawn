import { randomUUID } from "expo-crypto";

import { type PendingLaunchStore, pendingLaunches } from "@/components/launcher/pending-launch";
import { createSession, getSessionAccess } from "@/data/api/endpoints/sessions";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  patchWorkspace,
} from "@/data/api/endpoints/workspaces";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceTemplateOut } from "@/data/api/schemas/templates";
import type {
  WorkspaceIconSource,
  WorkspaceLayoutV3,
  WorkspaceOut,
  WorkspaceTile,
} from "@/data/api/schemas/workspaces";
import { agentRunCommand, runningAgent, sessionAgent } from "@/data/selectors/agent";

export interface WorkspaceOperationResult {
  workspace: WorkspaceOut;
  agentLaunchesSkipped: number;
}

export interface InstantiateTemplateInput {
  template: WorkspaceTemplateOut;
  agents: readonly AgentOut[];
  name: string;
  icon?: string | null;
  iconSource?: WorkspaceIconSource | null;
}

export interface DuplicateWorkspaceInput {
  workspace: WorkspaceOut;
  sessions: readonly SessionOut[];
  agents: readonly AgentOut[];
  existingNames: readonly string[];
}

export interface WorkspaceOperationDependencies {
  randomId: () => string;
  createWorkspace: typeof createWorkspace;
  getWorkspace: typeof getWorkspace;
  patchWorkspace: typeof patchWorkspace;
  deleteWorkspace: typeof deleteWorkspace;
  createSession: typeof createSession;
  getSessionAccess: typeof getSessionAccess;
  pending: PendingLaunchStore;
}

const DEFAULT_DEPENDENCIES: WorkspaceOperationDependencies = {
  randomId: randomUUID,
  createWorkspace,
  getWorkspace,
  patchWorkspace,
  deleteWorkspace,
  createSession,
  getSessionAccess,
  pending: pendingLaunches,
};

export function nextWorkspaceCopyName(name: string, existingNames: readonly string[]): string {
  const occupied = new Set(existingNames);
  const first = `${name} copy`;
  if (!occupied.has(first)) return first;
  let suffix = 2;
  while (occupied.has(`${first} ${suffix}`)) suffix += 1;
  return `${first} ${suffix}`;
}

function initialTemplateLayout(
  template: WorkspaceTemplateOut,
  hostId: string | null,
  cwd: string | null,
  randomId: () => string,
): WorkspaceLayoutV3 {
  const tabs = template.spec.tabs.map((tab) => ({
    id: randomId(),
    name: tab.name,
    host_id: null,
    cwd: null,
    layout: {
      version: 3 as const,
      tiles: (tab.tiles ?? []).flatMap((tile): WorkspaceTile[] =>
        tile.run.kind === "files" && hostId && cwd
          ? [
              {
                session_id: randomId(),
                x: tile.x,
                y: tile.y,
                w: tile.w,
                h: tile.h,
                widget: { kind: "files", host_id: hostId, path: cwd },
              },
            ]
          : [],
      ),
    },
  }));
  return { version: 3, active_tab: tabs[0]?.id ?? null, tabs };
}

async function activateTab(
  workspaceId: string,
  tabId: string,
  dependencies: WorkspaceOperationDependencies,
): Promise<WorkspaceOut> {
  const latest = await dependencies.getWorkspace(workspaceId);
  return dependencies.patchWorkspace(workspaceId, {
    layout: { ...latest.layout, active_tab: tabId },
  });
}

async function restoreFirstTab(
  workspaceId: string,
  firstTabId: string,
  dependencies: WorkspaceOperationDependencies,
): Promise<WorkspaceOut> {
  const latest = await dependencies.getWorkspace(workspaceId);
  if (latest.layout.active_tab === firstTabId) return latest;
  return dependencies.patchWorkspace(workspaceId, {
    layout: { ...latest.layout, active_tab: firstTabId },
  });
}

export async function instantiateWorkspaceTemplate(
  input: InstantiateTemplateInput,
  dependencies: WorkspaceOperationDependencies = DEFAULT_DEPENDENCIES,
): Promise<WorkspaceOperationResult> {
  const { template } = input;
  const hasTiles = template.spec.tabs.some((tab) => (tab.tiles?.length ?? 0) > 0);
  if (hasTiles && (!template.host_id || !template.cwd)) {
    throw new Error("This template needs a host and folder before it can be created.");
  }

  const result = await dependencies.createWorkspace({
    name: input.name.trim(),
    host_id: template.host_id,
    cwd: template.cwd,
    icon: input.icon === undefined ? template.icon : input.icon,
    icon_source: input.iconSource === undefined ? template.icon_source : input.iconSource,
  });
  const workspaceId = result.workspace.id;
  const layout = initialTemplateLayout(
    template,
    template.host_id,
    template.cwd,
    dependencies.randomId,
  );
  let workspace = await dependencies.patchWorkspace(workspaceId, { layout });
  let agentLaunchesSkipped = 0;

  for (let tabIndex = 0; tabIndex < template.spec.tabs.length; tabIndex += 1) {
    const templateTab = template.spec.tabs[tabIndex];
    const targetTab = layout.tabs[tabIndex];
    if (!templateTab || !targetTab || !template.host_id || !template.cwd) continue;
    workspace = await activateTab(workspaceId, targetTab.id, dependencies);
    for (const tile of templateTab.tiles ?? []) {
      if (tile.run.kind === "files") continue;
      const storedCommand = tile.run.kind === "agent" ? tile.run.command?.trim() : undefined;
      const templateAgent = runningAgent(storedCommand ?? null, input.agents);
      const session = await dependencies.createSession({
        host_id: template.host_id,
        cwd: template.cwd,
        ...(templateAgent ? { agent_id: templateAgent.id } : {}),
        workspace_id: workspaceId,
        tile: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
      });
      if (tile.run.kind === "agent") {
        const command = templateAgent ? agentRunCommand(templateAgent) : storedCommand;
        if (command) {
          try {
            await dependencies.pending.persist(session.id, command);
          } catch {
            agentLaunchesSkipped += 1;
          }
        }
      }
    }
  }

  const firstTabId = layout.tabs[0]?.id;
  if (firstTabId) workspace = await restoreFirstTab(workspaceId, firstTabId, dependencies);
  return { workspace, agentLaunchesSkipped };
}

function initialDuplicateLayout(
  workspace: WorkspaceOut,
  randomId: () => string,
): WorkspaceLayoutV3 {
  const tabs = workspace.layout.tabs.map((tab) => ({
    id: randomId(),
    name: tab.name,
    host_id: tab.host_id,
    cwd: tab.cwd,
    layout: {
      version: 3 as const,
      tiles: tab.layout.tiles.flatMap((tile): WorkspaceTile[] =>
        tile.widget ? [{ ...tile, session_id: randomId(), widget: { ...tile.widget } }] : [],
      ),
    },
  }));
  const activeIndex = workspace.layout.tabs.findIndex(
    (tab) => tab.id === workspace.layout.active_tab,
  );
  return {
    version: 3,
    active_tab: tabs[activeIndex]?.id ?? tabs[0]?.id ?? null,
    tabs,
  };
}

export async function duplicateWorkspaceDeep(
  input: DuplicateWorkspaceInput,
  dependencies: WorkspaceOperationDependencies = DEFAULT_DEPENDENCIES,
): Promise<WorkspaceOperationResult> {
  const { workspace: source } = input;
  const created = await dependencies.createWorkspace({
    name: nextWorkspaceCopyName(source.name, input.existingNames),
    host_id: source.host_id,
    cwd: source.cwd,
    icon: source.icon,
    icon_source: source.icon_source,
  });
  const workspaceId = created.workspace.id;
  const sessionsById = new Map(input.sessions.map((session) => [session.id, session]));
  const layout = initialDuplicateLayout(source, dependencies.randomId);
  let agentLaunchesSkipped = 0;
  const queuedSessionIds: string[] = [];

  try {
    let workspace = await dependencies.patchWorkspace(workspaceId, { layout });
    for (let tabIndex = 0; tabIndex < source.layout.tabs.length; tabIndex += 1) {
      const sourceTab = source.layout.tabs[tabIndex];
      const targetTab = layout.tabs[tabIndex];
      if (!sourceTab || !targetTab) continue;
      workspace = await activateTab(workspaceId, targetTab.id, dependencies);
      for (const tile of sourceTab.layout.tiles) {
        if (tile.widget) continue;
        const session = sessionsById.get(tile.session_id);
        if (!session) continue;
        const access = await dependencies.getSessionAccess(session.id);
        const currentAgent = sessionAgent(session, input.agents);
        const createdSession = await dependencies.createSession({
          host_id: session.host_id,
          cwd: session.cwd,
          name: session.name,
          ...(currentAgent ? { agent_id: currentAgent.id } : {}),
          skill_ids: access.skills.map((skill) => skill.id),
          workspace_id: workspaceId,
          tile: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
        });
        if (currentAgent) {
          try {
            await dependencies.pending.persist(createdSession.id, agentRunCommand(currentAgent));
            queuedSessionIds.push(createdSession.id);
          } catch {
            agentLaunchesSkipped += 1;
          }
        }
      }
    }
    if (layout.active_tab) {
      workspace = await restoreFirstTab(workspaceId, layout.active_tab, dependencies);
    }
    return { workspace, agentLaunchesSkipped };
  } catch (error) {
    await Promise.allSettled(
      queuedSessionIds.map((sessionId) => dependencies.pending.clear(sessionId)),
    );
    await dependencies.deleteWorkspace(workspaceId).catch(() => undefined);
    throw error;
  }
}
