import { HostTransferError } from "@/components/files/transfer";
import type { TransferPool } from "@/components/files/transfer-engine";
import type { TransferHost } from "@/data/stores/transfers";
import type { HostTransport, TransportError, TransportState } from "@/terminal/transport/types";

/** How long a transfer waits for a host's channel before saying it cannot reach the host. */
export const TRANSFER_CONNECT_TIMEOUT_MS = 45_000;

interface Waiter {
  resolve(transport: HostTransport): void;
  reject(error: Error): void;
}

interface Slot {
  transport: HostTransport | null;
  state: TransportState;
  error: TransportError | null;
  waiters: Set<Waiter>;
}

/**
 * The transfer queue's channels, one per host, fed by whichever component
 * holds them open (`transfers-runner.tsx`). A transfer asks for a host and
 * waits until its channel says ready — hello read, capabilities known — or
 * fails, or the wait runs out.
 */
export interface TransferChannels {
  readonly pool: TransferPool;
  attach(hostId: string, transport: HostTransport): void;
  setState(hostId: string, state: TransportState): void;
  setError(hostId: string, error: TransportError): void;
  /** The channel is gone: nothing waits on it as if it were coming back by itself. */
  detach(hostId: string): void;
}

export function createTransferChannels(timeoutMs = TRANSFER_CONNECT_TIMEOUT_MS): TransferChannels {
  const slots = new Map<string, Slot>();
  const slotFor = (hostId: string): Slot => {
    let slot = slots.get(hostId);
    if (!slot) {
      slot = { transport: null, state: "idle", error: null, waiters: new Set() };
      slots.set(hostId, slot);
    }
    return slot;
  };
  const settle = (hostId: string) => {
    const slot = slots.get(hostId);
    if (!slot) return;
    if (slot.transport && slot.state === "ready") {
      const ready = slot.transport;
      for (const waiter of [...slot.waiters]) waiter.resolve(ready);
      slot.waiters.clear();
      return;
    }
    if (slot.state === "failed") {
      // A refusal (an unapproved device, a changed identity) is said as itself;
      // anything that may pass is the path to the host going, which the
      // engine meets with a pause and Resume rather than a failure per file.
      const refused = slot.error?.retryable === false;
      const error = new HostTransferError(
        refused ? (slot.error?.code ?? "host_unreachable") : "host_unreachable",
        slot.error?.message ?? "The host could not be reached.",
      );
      for (const waiter of [...slot.waiters]) waiter.reject(error);
      slot.waiters.clear();
    }
  };

  return {
    pool: {
      acquire(host: TransferHost, signal: AbortSignal): Promise<HostTransport> {
        return new Promise<HostTransport>((resolve, reject) => {
          if (signal.aborted) {
            reject(new HostTransferError("cancelled", "Transfer cancelled."));
            return;
          }
          const slot = slotFor(host.id);
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = () => {
            if (timer !== undefined) clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            slot.waiters.delete(waiter);
          };
          const waiter: Waiter = {
            resolve(transport) {
              finish();
              resolve(transport);
            },
            reject(error) {
              finish();
              reject(error);
            },
          };
          const onAbort = () =>
            waiter.reject(new HostTransferError("cancelled", "Transfer cancelled."));
          signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(
            () =>
              waiter.reject(
                new HostTransferError("host_unreachable", "The host could not be reached."),
              ),
            timeoutMs,
          );
          slot.waiters.add(waiter);
          settle(host.id);
        });
      },
    },
    attach(hostId, transport) {
      const slot = slotFor(hostId);
      slot.transport = transport;
      slot.state = transport.state;
      slot.error = null;
      settle(hostId);
    },
    setState(hostId, state) {
      const slot = slotFor(hostId);
      slot.state = state;
      settle(hostId);
    },
    setError(hostId, error) {
      slotFor(hostId).error = error;
    },
    detach(hostId) {
      const slot = slots.get(hostId);
      if (!slot) return;
      slot.transport = null;
      slot.state = "idle";
      slot.error = null;
    },
  };
}
