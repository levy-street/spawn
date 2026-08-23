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
  | { status: "lost"; reason: "invalid_record" | "storage_error" }
  | { status: "abandoned"; reason: "session_dead" | "delivery_unconfirmed" };

export interface PendingLaunchTransport {
  readonly sessionId: string;
  readonly state: TransportState;
  write(bytes: Uint8Array): void;
  on(ev: "state", listener: (state: TransportState) => void): () => void;
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

  const deliver = (): void => {
    if (settled || operation || transport.state !== "ready") return;
    operation = (async () => {
      let read: PendingLaunchRead;
      try {
        read = await pending.take(transport.sessionId);
      } catch {
        finish({ status: "lost", reason: "storage_error" });
        return;
      }

      if (read.status !== "ready") {
        finish(resultForRead(read));
        return;
      }
      if (disposed || transport.state !== "ready") {
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

  const handleState = (state: TransportState): void => {
    if (state === "ready") deliver();
    else if (state === "closed" || state === "failed") checkSessionLife();
  };

  const unsubscribe = transport.on("state", handleState);
  if (initialSessionLife === "dead") abandonDeadSession();
  else handleState(transport.state);

  return () => {
    disposed = true;
    unsubscribe();
  };
}
