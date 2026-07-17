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
const MAX_EVENT_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
export const MAX_BROWSER_TRUST_INVALIDATION_SENDERS = 32;

const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

interface BrowserTrustInvalidationEnvelope {
  version: 1;
  senderId: string;
  sequence: number;
  reason: BrowserTrustInvalidationReason;
  issuedAt: number;
}

interface SenderHighWater {
  sequence: number;
  /** No accepted envelope from this sender can remain valid after this instant. */
  retainUntil: number;
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
  if (keys.join(",") !== "issuedAt,reason,senderId,sequence,version") return null;
  if (
    record.version !== 1 ||
    typeof record.senderId !== "string" ||
    typeof record.sequence !== "number" ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 0 ||
    typeof record.reason !== "string" ||
    !INVALIDATION_REASONS.has(record.reason as BrowserTrustInvalidationReason) ||
    typeof record.issuedAt !== "number" ||
    !Number.isSafeInteger(record.issuedAt) ||
    record.issuedAt < 0 ||
    !CANONICAL_UUID_PATTERN.test(record.senderId)
  ) {
    return null;
  }
  return record as unknown as BrowserTrustInvalidationEnvelope;
}

/** Bounded, invalidation-only protocol. A message can never establish trust. */
export class BrowserTrustInvalidationProtocol {
  private readonly senderHighWater = new Map<string, SenderHighWater>();
  private nextSequence: number | null;

  constructor(
    readonly senderId: string,
    private readonly onPeerInvalidation: (reason: BrowserTrustInvalidationReason) => void,
    private readonly now: () => number = Date.now,
    initialSequence = 0,
  ) {
    if (!CANONICAL_UUID_PATTERN.test(senderId)) {
      throw new Error("Browser trust invalidation sender ID must be a canonical UUID");
    }
    if (!Number.isSafeInteger(initialSequence) || initialSequence < 0) {
      throw new Error("Browser trust invalidation sequence must be a non-negative safe integer");
    }
    this.nextSequence = initialSequence;
  }

  create(reason: BrowserTrustInvalidationReason): string {
    const sequence = this.nextSequence;
    if (sequence === null) {
      throw new Error("Browser trust invalidation sequence exhausted");
    }
    const issuedAt = this.now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw new Error("Browser trust invalidation timestamp must be a non-negative safe integer");
    }
    const envelope: BrowserTrustInvalidationEnvelope = {
      version: 1,
      senderId: this.senderId,
      sequence,
      reason,
      issuedAt,
    };
    const encoded = JSON.stringify(envelope);
    if (new TextEncoder().encode(encoded).byteLength > MAX_PROTOCOL_BYTES) {
      throw new Error("Browser trust invalidation envelope exceeded its bound");
    }
    this.nextSequence = sequence === Number.MAX_SAFE_INTEGER ? null : sequence + 1;
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
    if (!envelope || envelope.senderId === this.senderId) return false;
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) return false;
    this.pruneExpiredSenders(now);
    const age = now - envelope.issuedAt;
    if (!Number.isSafeInteger(age)) return false;
    if (age > MAX_EVENT_AGE_MS || age < -MAX_FUTURE_SKEW_MS) return false;
    const retainUntil = envelope.issuedAt + MAX_EVENT_AGE_MS;
    if (!Number.isSafeInteger(retainUntil)) return false;
    const sender = this.senderHighWater.get(envelope.senderId);
    if (sender) {
      if (envelope.sequence <= sender.sequence) return false;
      sender.sequence = envelope.sequence;
      sender.retainUntil = Math.max(sender.retainUntil, retainUntil);
    } else {
      if (this.senderHighWater.size >= MAX_BROWSER_TRUST_INVALIDATION_SENDERS) return false;
      this.senderHighWater.set(envelope.senderId, {
        sequence: envelope.sequence,
        retainUntil,
      });
    }
    this.onPeerInvalidation(envelope.reason);
    return true;
  }

  senderSlotCount(): number {
    const now = this.now();
    if (Number.isSafeInteger(now) && now >= 0) this.pruneExpiredSenders(now);
    return this.senderHighWater.size;
  }

  private pruneExpiredSenders(now: number): void {
    for (const [senderId, sender] of this.senderHighWater) {
      if (now > sender.retainUntil) this.senderHighWater.delete(senderId);
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
