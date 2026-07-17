export type BrowserTrustInvalidationReason = "logout" | "unauthorized" | "account_change";

export type BrowserTrustSessionSnapshot =
  | { serial: number; status: "neutral"; ownerUserId: null; reason: null }
  | {
      serial: number;
      status: "invalidated";
      ownerUserId: null;
      reason: BrowserTrustInvalidationReason;
    }
  | { serial: number; status: "established"; ownerUserId: string; reason: null };

type Listener = () => void;

let snapshot: BrowserTrustSessionSnapshot = {
  serial: 0,
  status: "neutral",
  ownerUserId: null,
  reason: null,
};
const listeners = new Set<Listener>();

function publish(next: Omit<BrowserTrustSessionSnapshot, "serial">): void {
  snapshot = { ...next, serial: snapshot.serial + 1 } as BrowserTrustSessionSnapshot;
  for (const listener of listeners) listener();
}

/**
 * Synchronously closes the browser trust boundary. Consumers must treat this
 * as a hard capability revocation, independently of React route lifetimes.
 */
export function invalidateBrowserTrust(reason: BrowserTrustInvalidationReason): void {
  publish({ status: "invalidated", ownerUserId: null, reason });
}

/** A successful login/signup establishes a new candidate account context. */
export function establishBrowserTrustSession(ownerUserId: string): void {
  publish({ status: "established", ownerUserId, reason: null });
}

export function getBrowserTrustSessionSnapshot(): BrowserTrustSessionSnapshot {
  return snapshot;
}

export function subscribeBrowserTrustSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable SSR snapshot: server rendering never owns browser capabilities. */
export const SERVER_BROWSER_TRUST_SESSION_SNAPSHOT: BrowserTrustSessionSnapshot = {
  serial: 0,
  status: "neutral",
  ownerUserId: null,
  reason: null,
};
