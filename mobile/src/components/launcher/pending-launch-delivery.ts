import type { PendingLaunchRead, PendingLaunchStore } from "@/components/launcher/pending-launch";
import { chunkPtyInput } from "@/terminal/transport/ctl-codec";
import type { AgentNotice, TransportState } from "@/terminal/transport/types";

const COMMAND_TERMINATOR = "\r";
/** How long after typing `codex --no-daemon` a refusal of the flag is taken
 *  for this launch's, and answered by typing it again without. */
const NO_DAEMON_REFUSAL_WINDOW_MS = 60_000;

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
  /** What the window's screen shows (`worker-session.js`). */
  on(ev: "agent-notice", listener: (notice: AgentNotice | null) => void): () => void;
}

export interface PendingLaunchDeliveryOptions {
  transport: PendingLaunchTransport;
  pending: PendingLaunchStore;
  initialSessionLife?: PendingSessionLife;
  getSessionLife?(): Promise<PendingSessionLife>;
  /** Whether the window's Codex accepts `--no-daemon`, asked of its host just
   *  before a launch with that form is typed (`conv.launch`); null when the
   *  host cannot tell. */
  askCodexNoDaemon?(): Promise<boolean | null>;
  onResult?(result: PendingLaunchDeliveryResult): void;
}

/**
 * The command to type for a queued launch: its `--no-daemon` form when it has
 * one and the window's host says, now, that the window's Codex accepts it;
 * the plain command otherwise — no host to ask, an older daemon, a Codex that
 * refuses the flag or one the host cannot tell about.
 */
export async function chooseLaunchCommand(
  launch: { command: string; codexNoDaemon?: string | null | undefined },
  ask: (() => Promise<boolean | null>) | undefined,
): Promise<string> {
  if (!launch.codexNoDaemon || !ask) return launch.command;
  const accepts = await ask().catch(() => null);
  return accepts === true ? launch.codexNoDaemon : launch.command;
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

/**
 * Type the command queued for a window into it once this view can: attached
 * to the host the window runs on and holding its display.
 *
 * A Codex launch is typed with `--no-daemon` only where the window's host says
 * the window's Codex accepts it (`chooseLaunchCommand`). The host asks that
 * Codex with the window's own environment, but cannot see an alias or a shell
 * hook; if the Codex that runs refuses the flag anyway
 * (`codex_no_daemon_refused` on screen soon after), the command is typed again
 * without it, once.
 */
export function observePendingLaunchDelivery({
  transport,
  pending,
  initialSessionLife = "unknown",
  getSessionLife,
  askCodexNoDaemon,
  onResult,
}: PendingLaunchDeliveryOptions): () => void {
  let disposed = false;
  let settled = false;
  let operation: Promise<void> | null = null;
  // A `--no-daemon` launch just typed: the plain command to type if Codex
  // refuses the flag, until when.
  let refusalFallback: { command: string; until: number } | null = null;

  const type = (command: string): void => {
    const bytes = new TextEncoder().encode(`${command}${COMMAND_TERMINATOR}`);
    for (const chunk of chunkPtyInput(bytes)) transport.write(chunk);
  };

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
      const command = await chooseLaunchCommand(read.record, askCodexNoDaemon);
      if (disposed || !canType()) {
        await completePending(pending, transport.sessionId).catch(() => undefined);
        finish({ status: "abandoned", reason: "delivery_unconfirmed" });
        return;
      }

      try {
        refusalFallback =
          command === read.record.command
            ? null
            : { command: read.record.command, until: Date.now() + NO_DAEMON_REFUSAL_WINDOW_MS };
        type(command);
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

  const handleNotice = (notice: AgentNotice | null): void => {
    if (notice !== "codex_no_daemon_refused") return;
    const fallback = refusalFallback;
    refusalFallback = null;
    if (disposed || !fallback || Date.now() > fallback.until || !canType()) return;
    try {
      type(fallback.command);
    } catch {
      // The person sees Codex's refusal and can type it themselves.
    }
  };

  const unsubscribe = transport.on("state", handleState);
  // The claim this view makes on its first ready lands after it.
  const unsubscribeDisplay = transport.on("display", () => deliver());
  const unsubscribeNotice = transport.on("agent-notice", handleNotice);
  if (initialSessionLife === "dead") abandonDeadSession();
  else handleState(transport.state);

  return () => {
    disposed = true;
    unsubscribe();
    unsubscribeDisplay();
    unsubscribeNotice();
  };
}
