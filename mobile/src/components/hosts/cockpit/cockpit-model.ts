import { relativeSeen } from "@/components/hosts/host-model";
import {
  HOST_IDENTITY_BLOCKED_REASON,
  HOST_IDENTITY_BLOCKED_STATUS,
} from "@/components/hosts/host-trust-copy";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import type { HostLiveStatus } from "@/data/selectors/host-live";
import { displayPath, HOST_HOME } from "@/data/selectors/places";
import { attentionRank } from "@/data/selectors/session";

/**
 * A host's page, in tabs. The browser gives each its own address
 * (/hosts/[id], /hosts/[id]/files, /hosts/[id]/sessions, /hosts/[id]/access);
 * here the tab is the screen's `?tab=`, so back still leaves the page.
 */
export const COCKPIT_TABS = ["overview", "files", "sessions", "access"] as const;
export type CockpitTab = (typeof COCKPIT_TABS)[number];

export const COCKPIT_TAB_LABELS: Readonly<Record<CockpitTab, string>> = {
  overview: "Overview",
  files: "Files",
  sessions: "Sessions",
  access: "Access",
};

/** The tab a link asks for; anything else — the retired `agents` included — is Overview. */
export function cockpitTab(value: string | string[] | undefined): CockpitTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return (COCKPIT_TABS as readonly string[]).includes(raw ?? "") ? (raw as CockpitTab) : "overview";
}

/** The neighbouring tab a swipe of `delta` lands on, or null past either end. */
export function stepCockpitTab(current: CockpitTab, delta: -1 | 1): CockpitTab | null {
  return COCKPIT_TABS[COCKPIT_TABS.indexOf(current) + delta] ?? null;
}

/**
 * The line under the host's name: whether this device can reach it right now.
 * The server's word decides offline; this device's own connection decides
 * whether an online host is reachable from here. A host whose identity changed
 * is blocked before anything else — every connection would be refused again,
 * so it is not "reconnecting" and there is nothing to retry. The browser's
 * line says the same.
 */
export function cockpitStatusLine(
  host: Pick<HostOut, "status" | "last_seen_at">,
  live: Pick<HostLiveStatus, "reconnecting">,
  identityConflict = false,
  now = Date.now(),
): string {
  if (identityConflict) return HOST_IDENTITY_BLOCKED_STATUS;
  if (host.status !== "online") {
    return host.last_seen_at === null
      ? "Offline · never connected"
      : `Offline · last seen ${relativeSeen(host.last_seen_at, now)}`;
  }
  return live.reconnecting ? "Reconnecting…" : "Online";
}

/**
 * Why a window cannot be opened on the host from here — "New window here…"
 * and a folder's menu — or null when it can. The browser says the same.
 */
export function windowBlockedReason(
  host: Pick<HostOut, "name" | "status">,
  identityConflict: boolean,
): string | null {
  if (identityConflict) return HOST_IDENTITY_BLOCKED_REASON;
  if (host.status !== "online") return `${host.name} is offline.`;
  return null;
}

export function isLiveSession(session: Pick<SessionOut, "status">): boolean {
  return session.status !== "exited" && session.status !== "killed";
}

function lastActive(session: SessionOut): number {
  const stamps = [session.last_activity_at, session.last_input_at, session.started_at];
  return Math.max(0, ...stamps.map((stamp) => (stamp ? Date.parse(stamp) || 0 : 0)));
}

/**
 * What is running on the host, most urgent first: a window waiting on a person,
 * then one at work, then the rest by when they were last busy.
 */
export function runningHere(sessions: readonly SessionOut[], limit = 6): SessionOut[] {
  return sessions
    .filter(isLiveSession)
    .sort(
      (left, right) =>
        attentionRank(right) - attentionRank(left) ||
        Number(right.activity_state === "active") - Number(left.activity_state === "active") ||
        lastActive(right) - lastActive(left) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, limit);
}

export interface HostFolder {
  /** As the host names it; `~` for the home folder. */
  path: string;
  /** How many of the host's live windows run in it. */
  windows: number;
}

/**
 * The folders worth opening on a host: wherever its live windows run, the
 * most recently used first — places are ranked by recency everywhere else —
 * then its home, once. Only what the server already holds about windows; the
 * server's own list of recent folders is deliberately not read. The browser
 * lists the same folders in the same order (web/src/lib/host-cockpit.ts).
 */
export function hostFolders(sessions: readonly SessionOut[]): HostFolder[] {
  const byPath = new Map<string, { path: string; windows: number; usedAt: number }>();
  for (const session of sessions) {
    if (!isLiveSession(session) || !session.cwd.trim()) continue;
    const usedAt = lastActive(session);
    const held = byPath.get(session.cwd);
    if (held) {
      held.windows += 1;
      held.usedAt = Math.max(held.usedAt, usedAt);
    } else {
      byPath.set(session.cwd, { path: session.cwd, windows: 1, usedAt });
    }
  }
  const folders = [...byPath.values()]
    .sort((left, right) => right.usedAt - left.usedAt || left.path.localeCompare(right.path))
    .map(({ path, windows }) => ({ path, windows }));
  // Home is always there, once: a window already open in it stands for it.
  return folders.some((folder) => isHomeFolder(folder.path))
    ? folders
    : [...folders, { path: HOST_HOME, windows: 0 }];
}

/** The host's home, however a window names it (`~`, `/Users/me`, `C:\Users\me`). */
export function isHomeFolder(path: string): boolean {
  return displayPath(path) === HOST_HOME;
}

type GroupedWorkspace = Pick<WorkspaceOut, "id" | "name" | "layout" | "archived_at">;

export interface WorkspaceGroup {
  /** Null for windows in no workspace. */
  workspace: Pick<WorkspaceOut, "id" | "name" | "archived_at"> | null;
  sessions: SessionOut[];
}

/** The workspace a window's pane is in, by session id. */
export function workspaceBySession(
  workspaces: readonly GroupedWorkspace[],
): Map<string, Pick<WorkspaceOut, "id" | "name" | "archived_at">> {
  const owners = new Map<string, Pick<WorkspaceOut, "id" | "name" | "archived_at">>();
  for (const workspace of workspaces) {
    for (const tab of workspace.layout.tabs) {
      for (const tile of tab.layout.tiles) {
        if (!tile.widget && !owners.has(tile.session_id)) {
          owners.set(tile.session_id, {
            id: workspace.id,
            name: workspace.name,
            archived_at: workspace.archived_at,
          });
        }
      }
    }
  }
  return owners;
}

/**
 * A host's windows under the workspaces that hold them, in the order the
 * workspaces are given (open ones before archived ones, as the caller lists
 * them), with windows in no workspace last. Within a group, live windows come
 * before ones that have ended.
 */
export function groupSessionsByWorkspace(
  sessions: readonly SessionOut[],
  workspaces: readonly GroupedWorkspace[],
): WorkspaceGroup[] {
  const owners = workspaceBySession(workspaces);
  const groups = new Map<string | null, WorkspaceGroup>();
  for (const workspace of workspaces) {
    if (groups.has(workspace.id)) continue;
    groups.set(workspace.id, {
      workspace: { id: workspace.id, name: workspace.name, archived_at: workspace.archived_at },
      sessions: [],
    });
  }
  groups.set(null, { workspace: null, sessions: [] });
  for (const session of sessions) {
    const owner = owners.get(session.id) ?? null;
    groups.get(owner?.id ?? null)?.sessions.push(session);
  }
  return [...groups.values()]
    .filter((group) => group.sessions.length > 0)
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort(
        (left, right) =>
          Number(isLiveSession(right)) - Number(isLiveSession(left)) ||
          lastActive(right) - lastActive(left) ||
          left.id.localeCompare(right.id),
      ),
    }));
}
