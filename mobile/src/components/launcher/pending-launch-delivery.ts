import type { PendingLaunchRead, PendingLaunchStore } from "@/components/launcher/pending-launch";
import { isShellCommand } from "@/data/selectors/agent";
import { chunkPtyInput } from "@/terminal/transport/ctl-codec";
import type { AgentNotice, TransportState } from "@/terminal/transport/types";

const COMMAND_TERMINATOR = "\r";

/**
 * How long a launch waits for the window's host to say whether its Codex
 * accepts `--no-daemon` (`conv.launch`), opening the channel and answering
 * together, before the plain command is typed. Plain `codex` is always safe:
 * every Codex starts with it, and all the window loses is that Codex keeps
 * its threads in its shared background server, so a later restart opens
 * Codex's own picker instead of naming the thread. Waiting longer would leave
 * the window blank while anything the person types lands in the command line.
 * The browser waits as long (`web/.../launch-delivery.ts`).
 */
export const CODEX_ANSWER_DEADLINE_MS = 1_500;

/** How long after `codex --no-daemon` is typed a refusal of the flag on
 *  screen is taken for this launch's. Codex refuses an unknown argument as
 *  it starts, well inside this. */
export const NO_DAEMON_REFUSAL_WINDOW_MS = 10_000;

/** `ask`'s answer, or null when it fails or takes longer than `ms`. */
export function answerWithin<T>(ask: () => Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    ask().then(
      (answer) => {
        clearTimeout(timer);
        resolve(answer);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

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
  /** Whether the window's Codex accepts `--no-daemon`, asked of its host
   *  before a launch with that form is claimed (`conv.launch`); null when the
   *  host cannot tell. */
  askCodexNoDaemon?(): Promise<boolean | null>;
  /** The window's foreground process as its host last reported it. */
  foreground?(): string | null | undefined;
  /** Whether an agent runs in the window now, asked of its host
   *  (`conv.inspect`); null when it cannot say. */
  agentRunning?(): Promise<boolean | null>;
  onResult?(result: PendingLaunchDeliveryResult): void;
}

/** The command to type for a launch, given the host's answer: its
 *  `--no-daemon` form only on an explicit yes. */
export function chooseLaunchCommand(
  launch: { command: string; codexNoDaemon?: string | null | undefined },
  accepts: boolean | null,
): string {
  return launch.codexNoDaemon && accepts === true ? launch.codexNoDaemon : launch.command;
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
 * A Codex launch is typed with `--no-daemon` only where the window's host
 * says, before the launch is claimed, that the window's Codex accepts it: a
 * view that stops being able to type while it waits leaves the launch queued
 * for its next chance rather than losing it, and the durable claim stays the
 * one step that decides who types. The host asks that Codex with the window's
 * own environment, but cannot see an alias or a shell hook; if the Codex that
 * runs refuses the flag anyway (`codex_no_daemon_refused` on screen within
 * {@link NO_DAEMON_REFUSAL_WINDOW_MS}), the plain command is typed, once, and
 * only while this view can still type and the window's shell is in the
 * foreground: its host reports a shell and says no agent runs there now.
 * Where either cannot be known nothing is typed, since a command typed into a
 * running Codex would be sent to it as a prompt.
 */
export function observePendingLaunchDelivery({
  transport,
  pending,
  initialSessionLife = "unknown",
  getSessionLife,
  askCodexNoDaemon,
  foreground,
  agentRunning,
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
      // Asked before the claim, which is durable: nothing is lost if this view
      // cannot type by the time the host answers.
      let accepts: boolean | null = null;
      if (askCodexNoDaemon) {
        const flagged = await (
          pending.hasNoDaemonForm?.(transport.sessionId, transport.hostId) ?? Promise.resolve(false)
        ).catch(() => false);
        if (flagged) {
          accepts = await answerWithin(askCodexNoDaemon, CODEX_ANSWER_DEADLINE_MS);
          if (disposed || !canType()) {
            // Unclaimed: the next ready or display claim asks again, and a
            // transport that closed meanwhile is checked as it would have
            // been.
            operation = null;
            if (!disposed) handleState(transport.state);
            return;
          }
        }
      }

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

      const command = chooseLaunchCommand(read.record, accepts);
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
    // Answered once at most, whatever the answer.
    const fallback = refusalFallback;
    refusalFallback = null;
    if (disposed || !fallback || Date.now() > fallback.until || !canType()) return;
    if (!isShellCommand(foreground?.())) return;
    void answerWithin(agentRunning ?? (async () => null), CODEX_ANSWER_DEADLINE_MS).then(
      (running) => {
        if (running !== false || disposed || !canType()) return;
        try {
          type(fallback.command);
        } catch {
          // The person sees Codex's refusal and can type it themselves.
        }
      },
    );
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
