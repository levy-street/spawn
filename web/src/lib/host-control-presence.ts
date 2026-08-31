import type { HostControlState } from "@/lib/hostControl";

export type HostControlPresence = "connecting" | "ready" | "failed";
export type HostControlPresenceClientId = string | symbol;

const clients = new Map<string, Map<HostControlPresenceClientId, HostControlState>>();
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of listeners) listener();
}

/** Publish one client's latest channel state for passive UI consumers. */
export function reportHostControlState(
  hostId: string,
  clientId: HostControlPresenceClientId,
  state: HostControlState,
): void {
  let hostClients = clients.get(hostId);
  if (!hostClients) {
    hostClients = new Map();
    clients.set(hostId, hostClients);
  }
  if (hostClients.get(clientId) === state) return;
  hostClients.set(clientId, state);
  publish();
}

/** Retire a client entirely so unmounted consumers do not linger in memory. */
export function dropHostControlClient(hostId: string, clientId: HostControlPresenceClientId): void {
  const hostClients = clients.get(hostId);
  if (!hostClients?.delete(clientId)) return;
  if (hostClients.size === 0) clients.delete(hostId);
  publish();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The useful truth across every mounted client for one host. Healthy wins,
 * then progress, then terminal failure; idle/closed clients make no claim.
 */
export function hostControlPresence(hostId: string): HostControlPresence | null {
  const states = clients.get(hostId)?.values();
  if (!states) return null;

  let connecting = false;
  let failed = false;
  for (const state of states) {
    if (state === "ready") return "ready";
    if (state === "connecting" || state === "open") connecting = true;
    else if (state === "error" || state === "unauthorized") failed = true;
  }
  if (connecting) return "connecting";
  if (failed) return "failed";
  return null;
}
