import { randomUUID } from "expo-crypto";

import { type CreateWindowDependencies, createWindow } from "@/components/launcher/create-window";
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
import { runningAgent, sessionAgent } from "@/data/selectors/agent";
import { isFilesWidget } from "@/data/types/layout";

export interface WorkspaceOperationResult {
  workspace: WorkspaceOut;
  agentLaunchesSkipped: number;
}

export interface InstantiateTemplateInput {
  template: WorkspaceTemplateOut;
  agents: readonly AgentOut[];
  name: string;
  /** Where the template's windows run. A workspace has no host or folder of
   *  its own, so this is chosen when the template is replayed. */
  place: { hostId: string; cwd: string } | null;
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

/** The window maker's share of these dependencies (`create-window.ts`). */
function windowDependencies(
  dependencies: WorkspaceOperationDependencies,
): CreateWindowDependencies {
  return {
    createSession: dependencies.createSession,
    newId: dependencies.randomId,
    pending: dependencies.pending,
  };
}

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
  const { template, place } = input;
  const hasTiles = template.spec.tabs.some((tab) => (tab.tiles?.length ?? 0) > 0);
  if (hasTiles && !place) {
    throw new Error("Choose where this template's windows run.");
  }

  const result = await dependencies.createWorkspace({
    name: input.name.trim(),
    icon: input.icon === undefined ? template.icon : input.icon,
    icon_source: input.iconSource === undefined ? template.icon_source : input.iconSource,
  });
  const workspaceId = result.workspace.id;
  const layout = initialTemplateLayout(
    template,
    place?.hostId ?? null,
    place?.cwd ?? null,
    dependencies.randomId,
  );
  let workspace = await dependencies.patchWorkspace(workspaceId, { layout });
  let agentLaunchesSkipped = 0;

  for (let tabIndex = 0; tabIndex < template.spec.tabs.length; tabIndex += 1) {
    const templateTab = template.spec.tabs[tabIndex];
    const targetTab = layout.tabs[tabIndex];
    if (!templateTab || !targetTab || !place) continue;
    workspace = await activateTab(workspaceId, targetTab.id, dependencies);
    for (const tile of templateTab.tiles ?? []) {
      if (tile.run.kind === "files") continue;
      const storedCommand = tile.run.kind === "agent" ? tile.run.command?.trim() : undefined;
      const templateAgent = runningAgent(storedCommand ?? null, input.agents);
      // The tab is active and the tile is the template's own, so the window
      // lands exactly there; an agent this account no longer defines is still
      // typed, by the command the template stored.
      const opened = await createWindow(
        {
          host: { id: place.hostId },
          cwd: place.cwd,
          ...(templateAgent ? { agent: templateAgent } : {}),
          ...(tile.run.kind === "agent" && !templateAgent
            ? { command: storedCommand ?? null }
            : {}),
          workspace: {
            kind: "workspace",
            workspaceId,
            tile: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
          },
        },
        windowDependencies(dependencies),
      );
      if (opened.status === "created_unqueued") agentLaunchesSkipped += 1;
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
      // Sessions are recreated below. A pane from a newer SPAWN D is left out,
      // as a template leaves it out: this app cannot know what copying it means.
      tiles: tab.layout.tiles.flatMap((tile): WorkspaceTile[] =>
        isFilesWidget(tile.widget)
          ? [{ ...tile, session_id: randomId(), widget: { ...tile.widget } }]
          : [],
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
        // The same kind of window as its source, in a conversation of its own.
        const opened = await createWindow(
          {
            host: { id: session.host_id },
            cwd: session.cwd,
            name: session.name,
            ...(currentAgent ? { agent: currentAgent } : {}),
            skillIds: access.skills.map((skill) => skill.id),
            workspace: {
              kind: "workspace",
              workspaceId,
              tile: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
            },
          },
          windowDependencies(dependencies),
        );
        if (opened.status === "created_unqueued") agentLaunchesSkipped += 1;
        else if (opened.pendingCommand) queuedSessionIds.push(opened.session.id);
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
