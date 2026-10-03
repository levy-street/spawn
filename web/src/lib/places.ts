import type { Host, Session } from "./api";

/**
 * Where a window runs: a host and a folder on it. A workspace no longer has
 * one — it is a layout of windows, each of which says where it runs — so
 * every "add a window" asks this, with the likeliest answer first.
 */
export type Place = { hostId: string; cwd: string };

/** Why a place is suggested, said in the order a person reaches for them. */
export type PlaceReason = "focused" | "tab" | "workspace" | "recent" | "home";

export type PlaceSuggestion = Place & {
  reason: PlaceReason;
  /** Offline hosts are listed, but a window cannot open there. */
  online: boolean;
};

/** The home folder a host's shells start in, as the daemon expands it. */
export const HOST_HOME = "~";

const REASON_RANK: Record<PlaceReason, number> = {
  focused: 0,
  tab: 1,
  workspace: 2,
  recent: 3,
  home: 4,
};

function lastUsed(session: Session): number {
  const stamps = [session.last_input_at, session.last_activity_at, session.started_at];
  return Math.max(0, ...stamps.map((stamp) => (stamp ? Date.parse(stamp) || 0 : 0)));
}

function placeKey(place: Place): string {
  return `${place.hostId}\u0000${place.cwd}`;
}

/**
 * Rank the places a new window could open, likeliest first.
 *
 * Next to the pane in focus, then beside the other windows of this tab and
 * workspace, then wherever windows were opened recently, then each host's home
 * folder. Each place appears once, under its strongest reason; reachable hosts
 * sort ahead of offline ones so the default is always somewhere a window can
 * open.
 */
export function suggestPlaces(input: {
  sessions: readonly Session[];
  hosts: readonly Host[];
  focusedSessionId?: string | null;
  tabSessionIds?: readonly string[];
  workspaceSessionIds?: readonly string[];
  /** A place to leave out — the one a pane being moved is already in. */
  exclude?: Place | null;
  limit?: number;
}): PlaceSuggestion[] {
  const hostsById = new Map(input.hosts.map((host) => [host.id, host]));
  const tab = new Set(input.tabSessionIds ?? []);
  const workspace = new Set(input.workspaceSessionIds ?? []);
  const best = new Map<string, { place: Place; reason: PlaceReason; usedAt: number }>();

  const offer = (place: Place, reason: PlaceReason, usedAt: number) => {
    if (!hostsById.has(place.hostId) || !place.cwd.trim()) return;
    if (input.exclude && placeKey(input.exclude) === placeKey(place)) return;
    const key = placeKey(place);
    const held = best.get(key);
    if (
      !held ||
      REASON_RANK[reason] < REASON_RANK[held.reason] ||
      (reason === held.reason && usedAt > held.usedAt)
    ) {
      best.set(key, { place, reason, usedAt });
    }
  };

  for (const session of input.sessions) {
    const place = { hostId: session.host_id, cwd: session.cwd };
    const reason: PlaceReason =
      session.id === input.focusedSessionId
        ? "focused"
        : tab.has(session.id)
          ? "tab"
          : workspace.has(session.id)
            ? "workspace"
            : "recent";
    offer(place, reason, lastUsed(session));
  }
  for (const host of input.hosts) offer({ hostId: host.id, cwd: HOST_HOME }, "home", 0);

  const ranked = [...best.values()]
    .map(({ place, reason, usedAt }) => ({
      ...place,
      reason,
      online: hostsById.get(place.hostId)?.status === "online",
      usedAt,
    }))
    .sort(
      (left, right) =>
        Number(right.online) - Number(left.online) ||
        REASON_RANK[left.reason] - REASON_RANK[right.reason] ||
        right.usedAt - left.usedAt ||
        placeKey(left).localeCompare(placeKey(right)),
    )
    .map(({ usedAt: _usedAt, ...suggestion }) => suggestion);
  return ranked.slice(0, input.limit ?? 6);
}

/** A path as a person reads it: the home directory as `~`. */
export function displayPath(cwd: string): string {
  const path = cwd.replaceAll("\\", "/");
  const home = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/.exec(path);
  return home ? `~${path.slice(home[0].length)}` : path;
}

/** How each suggestion explains itself next to the path. */
export function placeReasonLabel(reason: PlaceReason): string {
  switch (reason) {
    case "focused":
      return "this pane";
    case "tab":
      return "this tab";
    case "workspace":
      return "this workspace";
    case "recent":
      return "recent";
    case "home":
      return "home";
  }
}
