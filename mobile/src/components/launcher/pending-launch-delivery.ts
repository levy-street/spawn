import type { PendingLaunchRead, PendingLaunchStore } from "@/components/launcher/pending-launch";
import { chunkPtyInput } from "@/terminal/transport/ctl-codec";
import type { TransportState } from "@/terminal/transport/types";

const COMMAND_TERMINATOR = "\r";

export type PendingSessionLife = "alive" | "dead" | "unknown";

export function pendingSessionLifeFromStatus(status: string): PendingSessionLife {
  if (status === "starting" || status === "running") return "alive";
  if (status === "exited" || status === "killed") return "dead";
  return "unknown";
}

export type PendingLaunchDeliveryResult =
  | { status: "sent" }
  | { status: "missing" }
  | { status: "stale" }
  /** Queued for the window as it ran on another host, and dropped. */
  | { status: "elsewhere" }
  | { status: "lost"; reason: "invalid_record" | "storage_error" }
  | { status: "abandoned"; reason: "session_dead" | "delivery_unconfirmed" };

export interface PendingLaunchTransport {
  readonly sessionId: string;
  /** The host this view is attached to the window on: the incarnation a
   *  command must have been queued for to be typed here. */
  readonly hostId: string;
  readonly state: TransportState;
  /**
   * Whether this view holds the session's display — the only view whose input
   * the host accepts. Another device's view can hold it: one that followed a
   * moved window to its new host may attach there first. A command written
   * before this view's claim lands is dropped, so delivery waits for it. A
   * transport that does not report ownership is taken at its word.
   */
  readonly displayOwner?: boolean;
  write(bytes: Uint8Array): void;
  on(ev: "state", listener: (state: TransportState) => void): () => void;
  on(ev: "display", listener: (display: { owner: boolean }) => void): () => void;
}

export interface PendingLaunchDeliveryOptions {
  transport: PendingLaunchTransport;
  pending: PendingLaunchStore;
  initialSessionLife?: PendingSessionLife;
  getSessionLife?(): Promise<PendingSessionLife>;
  onResult?(result: PendingLaunchDeliveryResult): void;
}

function resultForRead(
  read: Exclude<PendingLaunchRead, { status: "ready" }>,
): PendingLaunchDeliveryResult {
  if (read.status === "missing") return { status: "missing" };
  if (read.status === "stale") return { status: "stale" };
  if (read.status === "elsewhere") return { status: "elsewhere" };
  if (read.status === "already_delivered") {
    return { status: "abandoned", reason: "delivery_unconfirmed" };
  }
  return { status: "lost", reason: "invalid_record" };
}

function completePending(pending: PendingLaunchStore, sessionId: string): Promise<void> {
  return pending.complete ? pending.complete(sessionId) : pending.clear(sessionId);
}

function abandonPending(pending: PendingLaunchStore, sessionId: string): Promise<void> {
  return pending.abandon ? pending.abandon(sessionId) : pending.clear(sessionId);
}

export function observePendingLaunchDelivery({
  transport,
  pending,
  initialSessionLife = "unknown",
  getSessionLife,
  onResult,
}: PendingLaunchDeliveryOptions): () => void {
  let disposed = false;
  let settled = false;
  let operation: Promise<void> | null = null;

  const finish = (result: PendingLaunchDeliveryResult): void => {
    settled = true;
    if (!disposed) onResult?.(result);
  };

  const abandonDeadSession = (): void => {
    if (settled || operation) return;
    operation = abandonPending(pending, transport.sessionId)
      .then(() => finish({ status: "abandoned", reason: "session_dead" }))
      .catch(() => finish({ status: "lost", reason: "storage_error" }));
  };

  const checkSessionLife = (): void => {
    if (settled || operation || !getSessionLife) return;
    operation = getSessionLife()
      .then((life) => {
        operation = null;
        if (life === "dead") abandonDeadSession();
        else deliver();
      })
      .catch(() => {
        operation = null;
        deliver();
      });
  };

  const canType = (): boolean => transport.state === "ready" && transport.displayOwner !== false;

  const deliver = (): void => {
    if (settled || operation || !canType()) return;
    operation = (async () => {
      let read: PendingLaunchRead;
      try {
        read = await pending.take(transport.sessionId, transport.hostId);
      } catch {
        finish({ status: "lost", reason: "storage_error" });
        return;
      }

      if (read.status !== "ready") {
        finish(resultForRead(read));
        return;
      }
      if (disposed || !canType()) {
        await completePending(pending, transport.sessionId).catch(() => undefined);
        finish({ status: "abandoned", reason: "delivery_unconfirmed" });
        return;
      }

      try {
        const bytes = new TextEncoder().encode(`${read.record.command}${COMMAND_TERMINATOR}`);
        for (const chunk of chunkPtyInput(bytes)) transport.write(chunk);
      } catch {
        await completePending(pending, transport.sessionId).catch(() => undefined);
        finish({ status: "abandoned", reason: "delivery_unconfirmed" });
        return;
      }

      // If cleanup fails, the durable delivered flag remains and blocks replay after a restart.
      await completePending(pending, transport.sessionId).catch(() => undefined);
      finish({ status: "sent" });
    })();
  };

  // Attached: the window runs on this view's host, so a command queued for it
  // as it ran elsewhere is dropped even while this view waits for the display
  // — or never gets it, and a later move back to that host finds nothing of
  // the old shell's to type into the new one. Queued in the store ahead of
  // any claim, so the claim sees the drop.
  const noteAttached = (): void => {
    if (settled) return;
    void pending.observe?.(transport.sessionId, transport.hostId).catch(() => undefined);
  };

  const handleState = (state: TransportState): void => {
    if (state === "ready") {
      noteAttached();
      deliver();
    } else if (state === "closed" || state === "failed") checkSessionLife();
  };

  const unsubscribe = transport.on("state", handleState);
  // The claim this view makes on its first ready lands after it.
  const unsubscribeDisplay = transport.on("display", () => deliver());
  if (initialSessionLife === "dead") abandonDeadSession();
  else handleState(transport.state);

  return () => {
    disposed = true;
    unsubscribe();
    unsubscribeDisplay();
  };
}
