import { WorkerBridge } from "@/terminal/transport/bridge";
import { createHostTransport } from "@/terminal/transport/host-transport";
import type { HostTransportOptions, StreamingHostTransport } from "@/terminal/transport/types";

interface SharedHostTransport {
  readonly bridge: WorkerBridge;
  readonly transport: StreamingHostTransport;
  refs: number;
  owner: symbol | null;
  readonly ownershipListeners: Map<symbol, (ownsWorker: boolean) => void>;
}

export interface HostTransportLease {
  readonly shared: SharedHostTransport;
  readonly ownerId: symbol;
  release(): void;
  subscribeOwnership(listener: (ownsWorker: boolean) => void): () => void;
}

const registry = new Map<string, SharedHostTransport>();

function publishOwnership(shared: SharedHostTransport): void {
  for (const [id, listener] of shared.ownershipListeners) listener(id === shared.owner);
}

/** One WKWebView/RTC control channel per host, shared by every mounted consumer. */
export function retainHostTransport(
  options: Omit<HostTransportOptions, "bridge">,
): HostTransportLease {
  let shared = registry.get(options.hostId);
  if (!shared) {
    const bridge = new WorkerBridge();
    shared = {
      bridge,
      transport: createHostTransport({ ...options, bridge }),
      refs: 0,
      owner: null,
      ownershipListeners: new Map(),
    };
    registry.set(options.hostId, shared);
  }
  shared.refs += 1;
  const ownerId = Symbol(options.hostId);
  shared.owner ??= ownerId;
  let released = false;

  return {
    shared,
    ownerId,
    subscribeOwnership(listener) {
      shared.ownershipListeners.set(ownerId, listener);
      // A seat can be vacant here. Retaining a lease and subscribing to it are
      // two steps, and when a consumer is swapped for another in the same
      // commit the newcomer retains before the outgoing one releases — so the
      // release finds no listener to hand ownership to and leaves `owner`
      // null. Nothing else ever fills it: every later subscriber would just be
      // told `false` and wait for an owner who is never coming, and the shared
      // worker would stay closed for a host that plainly has a consumer.
      // Whoever notices the vacancy takes it.
      if (shared.owner === null) {
        shared.owner = ownerId;
        publishOwnership(shared);
      } else {
        listener(shared.owner === ownerId);
      }
      return () => shared.ownershipListeners.delete(ownerId);
    },
    release() {
      if (released) return;
      released = true;
      shared.ownershipListeners.delete(ownerId);
      shared.refs -= 1;
      if (shared.refs === 0) {
        shared.transport.close();
        registry.delete(options.hostId);
        return;
      }
      if (shared.owner === ownerId) {
        shared.transport.close();
        shared.owner = shared.ownershipListeners.keys().next().value ?? null;
        publishOwnership(shared);
      }
    },
  };
}
