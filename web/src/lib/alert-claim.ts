"use client";

/**
 * Decides which tab gets to make noise.
 *
 * Every spawn tab on this browser holds its own alert socket and receives the
 * same publish, so without this two windows means two buzzes for one event.
 * Toasts are exempt on purpose — a toast is in-page UI and belongs in every
 * visible tab. Sound, haptics and the OS notification are the ones that must
 * happen once.
 *
 * The protocol is deliberately dumb: everybody announces, everybody waits a
 * beat, lowest id wins. No leader, no heartbeat, no state to go stale — a tab
 * that closes mid-round simply stops announcing. The cost is one 60 ms delay
 * on a path where nothing else is measured in less than a second.
 *
 * Note this is same-browser only, by design. Your laptop and your phone are
 * supposed to both alert you; they are different places you might be.
 */

const CLAIM_CHANNEL = "spawn.alerts.claim";
/** Long enough to cover BroadcastChannel delivery between tabs, short enough
 *  that nobody perceives it. */
export const CLAIM_WINDOW_MS = 60;
/** Claims older than this are swept; an event key is never revisited. */
const CLAIM_TTL_MS = 30_000;

const tabId = makeTabId();
const seen = new Map<string, { ids: Set<string>; at: number }>();

let channel: BroadcastChannel | null = null;
let initialised = false;

function makeTabId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function ensureChannel(): BroadcastChannel | null {
  if (initialised) return channel;
  initialised = true;
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel(CLAIM_CHANNEL);
    // A persistent listener, not one attached per claim: a tab that receives
    // the event a few milliseconds late must still find the earlier tab's
    // announcement waiting for it.
    channel.onmessage = (message) => {
      const data = message.data as { key?: unknown; id?: unknown } | null;
      if (!data || typeof data.key !== "string" || typeof data.id !== "string") return;
      record(data.key, data.id);
    };
  } catch {
    channel = null;
  }
  return channel;
}

function record(key: string, id: string): void {
  const now = Date.now();
  for (const [existing, entry] of seen) {
    if (now - entry.at > CLAIM_TTL_MS) seen.delete(existing);
  }
  const entry = seen.get(key);
  if (entry) entry.ids.add(id);
  else seen.set(key, { ids: new Set([id]), at: now });
}

/**
 * Announce interest in an event and resolve true if this tab should be the
 * one to alert. A browser with no BroadcastChannel resolves true immediately:
 * one tab that alerts twice is better than no tab that alerts at all.
 */
export async function claimAlert(key: string): Promise<boolean> {
  const bus = ensureChannel();
  if (!bus) return true;
  record(key, tabId);
  try {
    bus.postMessage({ key, id: tabId });
  } catch {
    return true;
  }
  await new Promise((resolve) => setTimeout(resolve, CLAIM_WINDOW_MS));
  const entry = seen.get(key);
  if (!entry) return true;
  return [...entry.ids].sort()[0] === tabId;
}

/** Test seam: the id this tab announces with. */
export function claimTabId(): string {
  return tabId;
}

/** Pure winner rule, exposed so the tie-break is testable without tabs. */
export function claimWinner(ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  return [...ids].sort()[0];
}
