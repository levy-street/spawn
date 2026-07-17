export type BrowserTrustInvalidationReason =
  | "logout"
  | "unauthorized"
  | "session_expired"
  | "auth_error"
  | "account_change"
  | "registration_error"
  | "registration_revoked";

export type BrowserTrustInvalidationSource = "local" | "peer";

export type BrowserTrustSessionSnapshot =
  | { serial: number; status: "neutral"; ownerUserId: null; reason: null; source: null }
  | {
      serial: number;
      status: "invalidated";
      ownerUserId: null;
      reason: BrowserTrustInvalidationReason;
      source: BrowserTrustInvalidationSource;
    }
  | {
      serial: number;
      status: "established";
      ownerUserId: string;
      reason: null;
      source: null;
    };

type Listener = () => void;

const TRUST_CHANNEL = "spawn.browser-trust.v1";
const TRUST_STORAGE_KEY = "spawn.browser-trust.invalidation.v1";
const MAX_PROTOCOL_BYTES = 512;
const MAX_SEEN_EVENTS = 64;
const MAX_EVENT_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;

interface BrowserTrustInvalidationEnvelope {
  version: 1;
  eventId: string;
  senderId: string;
  reason: BrowserTrustInvalidationReason;
  issuedAt: number;
}

const INVALIDATION_REASONS = new Set<BrowserTrustInvalidationReason>([
  "logout",
  "unauthorized",
  "session_expired",
  "auth_error",
  "account_change",
  "registration_error",
  "registration_revoked",
]);

let snapshot: BrowserTrustSessionSnapshot = {
  serial: 0,
  status: "neutral",
  ownerUserId: null,
  reason: null,
  source: null,
};
const listeners = new Set<Listener>();

function publish(next: Omit<BrowserTrustSessionSnapshot, "serial">): void {
  snapshot = { ...next, serial: snapshot.serial + 1 } as BrowserTrustSessionSnapshot;
  for (const listener of listeners) listener();
}

function randomId(): string {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("Browser trust invalidation requires crypto.randomUUID");
  }
  return crypto.randomUUID();
}

function exactEnvelope(value: unknown): BrowserTrustInvalidationEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "eventId,issuedAt,reason,senderId,version") return null;
  if (
    record.version !== 1 ||
    typeof record.eventId !== "string" ||
    typeof record.senderId !== "string" ||
    typeof record.reason !== "string" ||
    !INVALIDATION_REASONS.has(record.reason as BrowserTrustInvalidationReason) ||
    typeof record.issuedAt !== "number" ||
    !Number.isSafeInteger(record.issuedAt) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      record.eventId,
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(record.senderId)
  ) {
    return null;
  }
  return record as unknown as BrowserTrustInvalidationEnvelope;
}

/** Bounded, invalidation-only protocol. A message can never establish trust. */
export class BrowserTrustInvalidationProtocol {
  private readonly seen = new Set<string>();

  constructor(
    readonly senderId: string,
    private readonly onPeerInvalidation: (reason: BrowserTrustInvalidationReason) => void,
    private readonly now: () => number = Date.now,
  ) {}

  create(reason: BrowserTrustInvalidationReason): string {
    const envelope: BrowserTrustInvalidationEnvelope = {
      version: 1,
      eventId: randomId(),
      senderId: this.senderId,
      reason,
      issuedAt: this.now(),
    };
    this.remember(envelope.eventId);
    const encoded = JSON.stringify(envelope);
    if (new TextEncoder().encode(encoded).byteLength > MAX_PROTOCOL_BYTES) {
      throw new Error("Browser trust invalidation envelope exceeded its bound");
    }
    return encoded;
  }

  receive(raw: unknown): boolean {
    let encoded: string;
    try {
      encoded = typeof raw === "string" ? raw : JSON.stringify(raw);
    } catch {
      return false;
    }
    if (new TextEncoder().encode(encoded).byteLength > MAX_PROTOCOL_BYTES) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(encoded);
    } catch {
      return false;
    }
    const envelope = exactEnvelope(parsed);
    if (!envelope || envelope.senderId === this.senderId || this.seen.has(envelope.eventId)) {
      return false;
    }
    const age = this.now() - envelope.issuedAt;
    if (age > MAX_EVENT_AGE_MS || age < -MAX_FUTURE_SKEW_MS) return false;
    this.remember(envelope.eventId);
    this.onPeerInvalidation(envelope.reason);
    return true;
  }

  seenEventCount(): number {
    return this.seen.size;
  }

  private remember(eventId: string): void {
    this.seen.add(eventId);
    while (this.seen.size > MAX_SEEN_EVENTS) {
      const oldest = this.seen.values().next().value;
      if (typeof oldest !== "string") break;
      this.seen.delete(oldest);
    }
  }
}

type ActiveBridge = {
  refs: number;
  channel: BroadcastChannel | null;
  protocol: BrowserTrustInvalidationProtocol;
  onStorage: (event: StorageEvent) => void;
};

let bridge: ActiveBridge | null = null;

/** Mount once near the application root; multiple providers share one bounded bridge. */
export function startBrowserTrustInvalidationBridge(): () => void {
  if (typeof window === "undefined") return () => {};
  if (bridge) {
    bridge.refs += 1;
    return stopBridgeReference;
  }
  const protocol = new BrowserTrustInvalidationProtocol(randomId(), (reason) => {
    invalidateBrowserTrust(reason, { broadcast: false, source: "peer" });
  });
  const channel =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(TRUST_CHANNEL);
  if (channel) channel.onmessage = (event) => void protocol.receive(event.data);
  const onStorage = (event: StorageEvent) => {
    if (event.key === TRUST_STORAGE_KEY && event.newValue !== null) {
      protocol.receive(event.newValue);
    }
  };
  window.addEventListener("storage", onStorage);
  bridge = { refs: 1, channel, protocol, onStorage };
  return stopBridgeReference;
}

function stopBridgeReference(): void {
  if (!bridge) return;
  bridge.refs -= 1;
  if (bridge.refs > 0) return;
  bridge.channel?.close();
  window.removeEventListener("storage", bridge.onStorage);
  bridge = null;
}

/** Best-effort fanout after the caller's authoritative state change succeeds. */
export function broadcastBrowserTrustInvalidation(reason: BrowserTrustInvalidationReason): void {
  if (!bridge) return;
  const encoded = bridge.protocol.create(reason);
  fanoutBrowserTrustInvalidation(encoded, {
    broadcast: (value) => bridge?.channel?.postMessage(value),
    store: (value) => window.localStorage.setItem(TRUST_STORAGE_KEY, value),
  });
}

/** Independent sinks keep BroadcastChannel revocation working if Web Storage is unavailable. */
export function fanoutBrowserTrustInvalidation(
  encoded: string,
  sinks: { broadcast: (value: string) => void; store: (value: string) => void },
): void {
  try {
    sinks.broadcast(encoded);
  } catch {
    // The storage path remains available.
  }
  try {
    sinks.store(encoded);
  } catch {
    // Local invalidation is already complete; storage failure cannot restore trust.
  }
}

/**
 * Synchronously closes the browser trust boundary. Consumers must treat this
 * as a hard capability revocation, independently of React route lifetimes.
 */
export function invalidateBrowserTrust(
  reason: BrowserTrustInvalidationReason,
  options: { broadcast?: boolean; source?: BrowserTrustInvalidationSource } = {},
): void {
  publish({
    status: "invalidated",
    ownerUserId: null,
    reason,
    source: options.source ?? "local",
  });
  if (options.broadcast !== false && (options.source ?? "local") === "local") {
    broadcastBrowserTrustInvalidation(reason);
  }
}

/** A fresh authenticated identity plus fresh registration establishes a new local epoch. */
export function establishBrowserTrustSession(ownerUserId: string): void {
  publish({ status: "established", ownerUserId, reason: null, source: null });
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
  source: null,
};
