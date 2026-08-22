import { canAddTab, getActiveTab } from "@/data/layout/tabs";
import { canAddTile, orderedTiles } from "@/data/layout/tiles";
import { identifyAgent } from "@/data/selectors/agent";
import {
  activityTone,
  sessionAttention,
  sessionTitle,
  sessionTitleDetail,
} from "@/data/selectors/session";
import type {
  DomainSnapshot,
  PaneListItem,
  Session,
  TabId,
  TabStats,
  Workspace,
  WorkspaceId,
  WorkspaceStats,
} from "@/data/types/domain";
import { isFilesWidget, type PaneId, type WorkspaceTab } from "@/data/types/layout";

function live(session: Session): boolean {
  return session.status !== "exited" && session.status !== "killed";
}

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function tabStats(tab: WorkspaceTab, sessionsById: ReadonlyMap<string, Session>): TabStats {
  let terminals = 0;
  let widgets = 0;
  let running = 0;
  let waiting = 0;
  let dead = 0;
  let attention = 0;

  for (const tile of tab.layout.tiles) {
    if (tile.widget) {
      widgets += 1;
      continue;
    }
    const session = sessionsById.get(tile.session_id);
    if (!session) continue;
    terminals += 1;
    if (live(session)) running += 1;
    if (live(session) && session.activity_state === "waiting") waiting += 1;
    if (!live(session)) dead += 1;
    if (sessionAttention(session) !== null) attention += 1;
  }

  return {
    tiles: tab.layout.tiles.length,
    terminals,
    widgets,
    running,
    waiting,
    dead,
    attention,
    nominalRemaining: Math.max(0, 16 - tab.layout.tiles.length),
    canAdd: canAddTile(tab.layout),
  };
}

export function workspaceSessionIds(workspace: Workspace): string[] {
  return workspace.layout.tabs.flatMap((tab) =>
    orderedTiles(tab.layout.tiles)
      .filter((tile) => !tile.widget)
      .map((tile) => tile.session_id),
  );
}

export function workspaceRecency(
  workspace: Workspace,
  sessionsById: ReadonlyMap<string, Session>,
): number {
  return Math.max(
    timestamp(workspace.updated_at),
    ...workspaceSessionIds(workspace).map((id) =>
      timestamp(sessionsById.get(id)?.last_input_at ?? null),
    ),
  );
}

export function workspaceStats(
  workspace: Workspace,
  sessionsById: ReadonlyMap<string, Session>,
): WorkspaceStats {
  const tabs = workspace.layout.tabs.map((tab) => tabStats(tab, sessionsById));
  const sum = (field: keyof Omit<TabStats, "canAdd">) =>
    tabs.reduce((total, stats) => total + stats[field], 0);
  return {
    tabs: tabs.length,
    tiles: sum("tiles"),
    terminals: sum("terminals"),
    widgets: sum("widgets"),
    running: sum("running"),
    waiting: sum("waiting"),
    dead: sum("dead"),
    attention: sum("attention"),
    remainingTabs: Math.max(0, 8 - tabs.length),
    nominalRemainingPanes: sum("nominalRemaining"),
    archived: workspace.archived_at !== null,
    recency: workspaceRecency(workspace, sessionsById),
  };
}

export function sortWorkspaces(workspaces: readonly Workspace[], archived: boolean): Workspace[] {
  return [...workspaces].sort((a, b) => {
    if (archived) {
      return (
        timestamp(b.archived_at) - timestamp(a.archived_at) ||
        timestamp(b.created_at) - timestamp(a.created_at) ||
        a.id.localeCompare(b.id)
      );
    }
    return (
      a.position - b.position ||
      timestamp(a.created_at) - timestamp(b.created_at) ||
      a.id.localeCompare(b.id)
    );
  });
}

export function filterWorkspaces(workspaces: readonly Workspace[], query: string): Workspace[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...workspaces];
  return workspaces.filter((workspace) => workspace.name.toLocaleLowerCase().includes(normalized));
}

function validTabId(workspace: Workspace, tabId: TabId | null | undefined): tabId is TabId {
  return typeof tabId === "string" && workspace.layout.tabs.some((tab) => tab.id === tabId);
}

export function selectActiveTabId(
  workspace: Workspace,
  input: {
    explicitTabId?: TabId | null;
    focusPaneId?: PaneId | null;
    deviceTabId?: TabId | null;
  },
): TabId {
  if (validTabId(workspace, input.explicitTabId)) return input.explicitTabId;
  if (input.focusPaneId) {
    const owner = workspace.layout.tabs.find((tab) =>
      tab.layout.tiles.some((tile) => tile.session_id === input.focusPaneId),
    );
    if (owner) return owner.id;
  }
  if (validTabId(workspace, input.deviceTabId)) return input.deviceTabId;
  return getActiveTab(workspace.layout).id;
}

export function selectActivePaneId(tab: WorkspaceTab, priorPaneId?: PaneId | null): PaneId | null {
  const ids = orderedTiles(tab.layout.tiles).map((tile) => tile.session_id);
  return priorPaneId && ids.includes(priorPaneId) ? priorPaneId : (ids[0] ?? null);
}

export function selectActiveSession(
  tab: WorkspaceTab,
  sessionsById: ReadonlyMap<string, Session>,
  preferredId?: PaneId | null,
): Session | null {
  if (preferredId) {
    const preferred = sessionsById.get(preferredId);
    if (
      preferred &&
      tab.layout.tiles.some((tile) => !tile.widget && tile.session_id === preferredId)
    ) {
      return preferred;
    }
  }
  for (const tile of orderedTiles(tab.layout.tiles)) {
    if (tile.widget) continue;
    const session = sessionsById.get(tile.session_id);
    if (session) return session;
  }
  return null;
}

export function selectTabHome(
  workspace: Workspace,
  tabId: TabId,
): { host_id: string; cwd: string } | null {
  const tab = workspace.layout.tabs.find((candidate) => candidate.id === tabId);
  if (tab?.host_id && tab.cwd) return { host_id: tab.host_id, cwd: tab.cwd };
  if (workspace.host_id && workspace.cwd) return { host_id: workspace.host_id, cwd: workspace.cwd };
  return null;
}

export function selectTabItems(
  state: DomainSnapshot,
  workspaceId: WorkspaceId,
  tabId: TabId,
): PaneListItem[] {
  const workspace = state.workspacesById.get(workspaceId);
  const tab = workspace?.layout.tabs.find((candidate) => candidate.id === tabId);
  if (!workspace || !tab) return [];

  return orderedTiles(tab.layout.tiles).map((tile, order): PaneListItem => {
    const base = {
      paneId: tile.session_id,
      workspaceId,
      tabId,
      order,
      geometry: { x: tile.x, y: tile.y, w: tile.w, h: tile.h },
    };
    if (isFilesWidget(tile.widget)) {
      return {
        ...base,
        kind: "files",
        hostId: tile.widget.host_id,
        path: tile.widget.path,
        hostOnline: state.hostsById.get(tile.widget.host_id)?.status === "online",
      };
    }
    if (tile.widget) return { ...base, kind: "missing", statusTone: "offline" };

    const session = state.sessionsById.get(tile.session_id);
    if (!session) return { ...base, kind: "missing", statusTone: "offline" };
    const identity = identifyAgent(session.foreground_command, state.agents);
    return {
      ...base,
      kind: "terminal",
      sessionId: session.id,
      title: sessionTitle(session, state.agents),
      detail: sessionTitleDetail(session),
      typeLabel: identity.displayName,
      identity,
      statusLabel: session.activity_label || session.status.toUpperCase(),
      statusTone: activityTone(session),
      statusPulse: session.activity_state === "active",
      attention: sessionAttention(session),
      running: live(session),
    };
  });
}

export function selectOrderedWorkspaces(state: DomainSnapshot, archived: boolean): Workspace[] {
  return sortWorkspaces(
    [...state.workspacesById.values()].filter(
      (workspace) => (workspace.archived_at !== null) === archived,
    ),
    archived,
  );
}

export function selectTabStats(
  state: DomainSnapshot,
  workspaceId: WorkspaceId,
  tabId: TabId,
): TabStats | null {
  const tab = state.workspacesById.get(workspaceId)?.layout.tabs.find((item) => item.id === tabId);
  return tab ? tabStats(tab, state.sessionsById) : null;
}

export function selectWorkspaceStats(
  state: DomainSnapshot,
  workspaceId: WorkspaceId,
): WorkspaceStats | null {
  const workspace = state.workspacesById.get(workspaceId);
  return workspace ? workspaceStats(workspace, state.sessionsById) : null;
}

export function workspaceBadgeCount(
  workspace: Workspace,
  sessionsById: ReadonlyMap<string, Session>,
): number {
  return workspaceStats(workspace, sessionsById).attention;
}

export function workspaceCanAddTab(workspace: Workspace): boolean {
  return canAddTab(workspace.layout);
}
