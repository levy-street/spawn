/**
 * Where a host's Files page opens, without the folder ever going into a URL.
 *
 * A host path is protected content (docs/TRUST.md). A path in the address bar
 * is sent to the server with every load, prefetch and RSC request, written to
 * request logs, kept in the browser's history (and synced wherever that goes),
 * and offered to the next site as a Referer. So the browser never writes one:
 *
 * - In-app links to a folder (a session's "Open in full browser", the pane's)
 *   hand the folder over in memory and navigate to the bare page.
 * - The folder on screen is kept in the tab's own `history.state`, so a
 *   reload, or Back to the page, comes back to it. That state stays with the
 *   tab: it is not part of the URL, the history list, or any request.
 * - An inbound `?path=` link (a phone's universal link, an older bookmark) is
 *   still honoured once, then dropped from the address.
 *
 * Pure apart from the one hand-over slot; the page does the DOM calls.
 */

/** The key this browser keeps in `history.state`. Never a URL parameter. */
export const FOLDER_STATE_KEY = "spawnFilesFolder";

/** A hand-over older than this belongs to a navigation that never arrived. */
export const HANDOFF_TTL_MS = 10_000;

interface Handoff {
  hostId: string;
  path: string;
  at: number;
}

let pending: Handoff | null = null;

/** Leave `path` for the next Files page of `hostId` to open at. */
export function handOffFolder(hostId: string, path: string, now: number = Date.now()): void {
  pending = { hostId, path, at: now };
}

/**
 * The folder handed over for `hostId`, once: taking it clears it. A hand-over
 * for another host, or one left too long, is not this page's to open.
 */
export function takeHandedOffFolder(hostId: string, now: number = Date.now()): string | null {
  const handoff = pending;
  if (!handoff) return null;
  if (now - handoff.at > HANDOFF_TTL_MS) {
    pending = null;
    return null;
  }
  if (handoff.hostId !== hostId) return null;
  pending = null;
  return handoff.path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The folder this tab's history entry was last showing for `hostId`, if any. */
export function folderFromHistoryState(state: unknown, hostId: string): string | null {
  if (!isRecord(state)) return null;
  const kept = state[FOLDER_STATE_KEY];
  if (!isRecord(kept) || kept.hostId !== hostId) return null;
  return typeof kept.path === "string" && kept.path.length > 0 ? kept.path : null;
}

/** `state` with the folder on screen recorded, everything else kept as it was. */
export function historyStateWithFolder(
  state: unknown,
  hostId: string,
  path: string,
): Record<string, unknown> {
  return { ...(isRecord(state) ? state : {}), [FOLDER_STATE_KEY]: { hostId, path } };
}

/**
 * Where the page opens, in order: a folder handed over by the navigation that
 * brought it here, then an inbound `?path=` link, then the folder this tab's
 * history entry was showing (a reload, or Back). Null opens home.
 */
export function initialFolder({
  handedOff,
  linked,
  kept,
}: {
  handedOff: string | null;
  linked: string | null;
  kept: string | null;
}): string | null {
  return handedOff || linked || kept || null;
}
