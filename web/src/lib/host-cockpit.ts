import type { Session, Workspace } from "./api";
import type { DaemonSnapshot } from "./daemon-connection";
import { formatBytes, orderSessions } from "./fleet";
import { hostLiveStatus } from "./host-live-status";
import { displayPath, HOST_HOME } from "./places";
import { relativeTime } from "./sessions";
import { HOST_IDENTITY_BLOCKED_STATUS } from "./signed-rtc-trust";
import { tabOfSession } from "./tabs";

/**
 * Pure derivations for a host's own page — the cockpit: its sections, the
 * line that says how this device reaches the host, what runs there and
 * where. The phone's host page reads the same facts the same way.
 *
 * Nothing here fetches. The host row, the sessions list, the workspaces list
 * and this device's connection snapshot are the whole input.
 */

export type HostTabId = "overview" | "files" | "sessions" | "access";

/** The sections every host has, in order. Capability-gated ones
 *  (`lib/host-offers.ts`) sit between Sessions and Access. */
export const HOST_TABS: readonly { id: HostTabId; label: string; segment: string }[] = [
  { id: "overview", label: "Overview", segment: "" },
  { id: "files", label: "Files", segment: "files" },
  { id: "sessions", label: "Sessions", segment: "sessions" },
  { id: "access", label: "Access", segment: "access" },
];

/** A section's address: Overview is the host's own, the rest sit under it. */
export function hostTabHref(hostId: string, segment: string): string {
  return segment ? `/hosts/${hostId}/${segment}` : `/hosts/${hostId}`;
}

/** Which section the address names, "" for Overview. */
export function hostTabSegment(pathname: string | null | undefined, hostId: string): string {
  const prefix = `/hosts/${hostId}`;
  if (!pathname || (pathname !== prefix && !pathname.startsWith(`${prefix}/`))) return "";
  return pathname.slice(prefix.length).split("/").find(Boolean) ?? "";
}

export interface HostStatusLine {
  text: string;
  tone: "active" | "warning" | "offline" | "blocked";
  /** This device lost a host the server still sees; Retry is the way back. */
  retry: boolean;
  /** Why, when the connection said: shown beside Retry, not in the line. */
  reason: string | null;
}

/**
 * How this device reaches the host, in one line under its name:
 * "Online · direct · 24 ms", "Online · relayed", "Reconnecting…", or
 * "Offline · last seen 3h ago". The line keeps to those few words; a
 * connection's own account of what went wrong is the `reason`, which sits
 * beside the Retry that fixes it.
 *
 * The server decides offline. This device's connection decides the rest: a
 * host the server sees is only reachable from here if the pair connection is
 * up, and the path it took is a fact about this device, not the host. A path
 * through a STUN-discovered address is still direct; only TURN is relayed.
 *
 * A host whose identity changed is blocked before anything else: its
 * connection would only be refused again, so the line says so and offers no
 * Retry, under the panel that says only removing it helps.
 */
export function hostStatusLine(
  host: { name: string; status: string; last_seen_at: string | null },
  snapshot: Pick<DaemonSnapshot, "state" | "error" | "info"> | null,
  identityBlocked = false,
): HostStatusLine {
  if (identityBlocked) {
    return { text: HOST_IDENTITY_BLOCKED_STATUS, tone: "blocked", retry: false, reason: null };
  }
  if (host.status !== "online") {
    const seen = relativeTime(host.last_seen_at);
    return {
      text: seen ? `Offline · last seen ${seen}` : "Offline · never connected",
      tone: "offline",
      retry: false,
      reason: null,
    };
  }
  const live = hostLiveStatus(host, snapshot);
  if (live.reconnecting) {
    return { text: "Reconnecting…", tone: "warning", retry: true, reason: live.problem };
  }
  const parts = ["Online"];
  const kind = snapshot?.info?.kind ?? null;
  if (kind === "relay") parts.push("relayed");
  else if (kind === "direct" || kind === "stun") parts.push("direct");
  const rtt = snapshot?.info?.rttMs;
  if (kind !== null && typeof rtt === "number" && Number.isFinite(rtt) && rtt >= 0) {
    parts.push(`${Math.round(rtt)} ms`);
  }
  return { text: parts.join(" · "), tone: "active", retry: false, reason: null };
}

/** A number and its unit on one line: "125 GB" never breaks between them. */
function unbroken(quantity: string): string {
  return quantity.replaceAll(" ", "\u00a0");
}

/**
 * "89 GB of 125 GB": the memory in use, worded so that a narrow Right now
 * wraps it between the two amounts, never inside one, and never cuts it
 * short. The phone words it the same.
 */
export function memoryFigure(usedBytes: number, totalBytes: number): string | null {
  const total = totalBytes > 0 ? formatBytes(totalBytes) : null;
  if (!total) return null;
  return `${unbroken(formatBytes(usedBytes) ?? "0 B")} of ${unbroken(total)}`;
}

/** Running here now: not over, and not on its way to another host. */
function isLive(session: Session): boolean {
  return session.status !== "exited" && session.status !== "killed" && session.status !== "moving";
}

function lastUsed(session: Session): number {
  const stamps = [session.last_input_at, session.last_activity_at, session.started_at];
  return Math.max(0, ...stamps.map((stamp) => (stamp ? Date.parse(stamp) || 0 : 0)));
}

/** What is running on this host right now, most urgent first. */
export function runningHere(sessions: readonly Session[], hostId: string, limit = 6): Session[] {
  return orderSessions(
    sessions.filter((session) => session.host_id === hostId && isLive(session)),
  ).slice(0, limit);
}

export interface HostFolder {
  /** As the window was opened there; `~` for the home folder. */
  cwd: string;
  /** Live windows open in it. */
  windows: number;
}

/**
 * The folders worth a shortcut on this host: where its live windows run,
 * most recently used first, then home.
 *
 * Only what is running now. The server's list of recent folders is left out
 * on purpose — no surface reads it any more (docs/INTERFACE_MATRIX.md): a
 * folder nobody works in is not a place, and the file browser is one tab away
 * for everything else.
 */
export function hostFolders(sessions: readonly Session[], hostId: string): HostFolder[] {
  const byPath = new Map<string, { cwd: string; windows: number; usedAt: number }>();
  for (const session of sessions) {
    if (session.host_id !== hostId || !isLive(session) || !session.cwd.trim()) continue;
    const held = byPath.get(session.cwd);
    const usedAt = lastUsed(session);
    if (held) {
      held.windows += 1;
      held.usedAt = Math.max(held.usedAt, usedAt);
    } else {
      byPath.set(session.cwd, { cwd: session.cwd, windows: 1, usedAt });
    }
  }
  const folders = [...byPath.values()]
    .sort((left, right) => right.usedAt - left.usedAt || left.cwd.localeCompare(right.cwd))
    .map(({ cwd, windows }) => ({ cwd, windows }));
  // Home is always there, once: a window already open in it stands for it.
  if (!folders.some((folder) => displayPath(folder.cwd) === HOST_HOME)) {
    folders.push({ cwd: HOST_HOME, windows: 0 });
  }
  return folders;
}

/** Under a folder's name: how many windows run in it, or "Home" for ~. */
export function folderSubtitle(folder: HostFolder): string {
  if (folder.windows === 0) return "Home";
  return `${folder.windows} ${folder.windows === 1 ? "window" : "windows"} here`;
}

export interface HostSessionGroup {
  /** Null for windows no workspace holds. */
  workspace: Pick<Workspace, "id" | "name"> | null;
  /** The workspace is put away; its windows are still in it. */
  archived: boolean;
  sessions: Session[];
}

/**
 * This host's windows under the workspace each sits in: the open workspaces
 * in the sidebar's order, then the archived ones (a window in an archived
 * workspace is still in a workspace), then the strays; most urgent first
 * within each. `workspaces` is both lists, each in its own order.
 */
export function groupHostSessions(
  sessions: readonly Session[],
  workspaces: readonly Pick<Workspace, "id" | "name" | "layout" | "archived_at">[],
): HostSessionGroup[] {
  const groups = new Map<string | null, Session[]>();
  for (const session of sessions) {
    const home = workspaces.find((workspace) => tabOfSession(workspace.layout, session.id));
    const key = home?.id ?? null;
    groups.set(key, [...(groups.get(key) ?? []), session]);
  }
  const ordered: HostSessionGroup[] = [];
  const open = workspaces.filter((workspace) => workspace.archived_at === null);
  const archived = workspaces.filter((workspace) => workspace.archived_at !== null);
  for (const workspace of [...open, ...archived]) {
    const held = groups.get(workspace.id);
    if (held) {
      ordered.push({
        workspace: { id: workspace.id, name: workspace.name },
        archived: workspace.archived_at !== null,
        sessions: held,
      });
    }
  }
  const strays = groups.get(null);
  if (strays) ordered.push({ workspace: null, archived: false, sessions: strays });
  return ordered.map((group) => ({ ...group, sessions: orderSessions(group.sessions) }));
}

/** What a group of the Sessions section is called — the phone's words too. */
export function hostSessionGroupTitle(group: Pick<HostSessionGroup, "workspace" | "archived">) {
  if (!group.workspace) return "Not in a workspace";
  return group.archived ? `${group.workspace.name} · archived` : group.workspace.name;
}

/**
 * The instant a server timestamp names. Postgres says its zone; SQLite hands
 * timestamps back without one, and they are UTC — read as local time they
 * would put a host's possession on the wrong day east or west of Greenwich.
 */
export function serverInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/iu.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** "Possessed September 14, 2026" — the day the host joined this account. */
export function possessedLabel(
  createdAt: string | null | undefined,
  locale?: string,
): string | null {
  const instant = serverInstant(createdAt);
  if (instant === null) return null;
  const day = new Date(instant).toLocaleDateString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return `Possessed ${day}`;
}
