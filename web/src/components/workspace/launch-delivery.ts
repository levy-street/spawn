/**
 * How a view types the launch queued for its window (`usePendingLaunchDrain`)
 * and, for a Codex launch typed with `--no-daemon`, how it answers Codex
 * refusing the flag. The phone keeps the same rules
 * (`mobile/src/components/launcher/pending-launch-delivery.ts`).
 */

import type { PendingLaunchCommand } from "@/components/workspace/pending-launch";
import { isShellCommand } from "@/lib/sessions";

/**
 * How long a launch waits for the window's host to say whether its Codex
 * accepts `--no-daemon` (`conv.launch`), opening the channel and answering
 * together, before the plain command is typed. Plain `codex` is always safe:
 * every Codex starts with it, and all the window loses is that Codex keeps
 * its threads in its shared background server, so a later restart opens
 * Codex's own picker instead of naming the thread. Waiting longer would leave
 * the window blank while anything the person types lands in the command line.
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

/** The command to type for a launch, given the host's answer: its
 *  `--no-daemon` form only on an explicit yes. */
export function chooseLaunchCommand(launch: PendingLaunchCommand, accepts: boolean | null): string {
  return launch.codexNoDaemon && accepts === true ? launch.codexNoDaemon : launch.command;
}

export interface QueuedLaunchDelivery {
  /** The launch waiting for the window, without claiming it. */
  peek(): PendingLaunchCommand | null;
  /** Claims it: once, for one view. */
  take(): PendingLaunchCommand | null;
  /** `conv.launch` on the window's host; null where it cannot be asked. */
  ask: (() => Promise<boolean | null>) | null;
  /** Whether this view can still type into the window. */
  canType(): boolean;
  type(command: string): void;
}

export interface DeliveredLaunch {
  /** What was typed. */
  typed: string;
  /** The launch's plain command. */
  plain: string;
}

/**
 * Type a queued launch. The host is asked before the launch is claimed, so a
 * view that stops being able to type while it waits leaves the launch queued
 * for the next one rather than losing it; the claim itself stays the only
 * step that decides who types, so two views never both type it.
 */
export async function deliverQueuedLaunch(
  delivery: QueuedLaunchDelivery,
): Promise<DeliveredLaunch | null> {
  const waiting = delivery.peek();
  if (!waiting) return null;
  const accepts =
    waiting.codexNoDaemon && delivery.ask
      ? await answerWithin(delivery.ask, CODEX_ANSWER_DEADLINE_MS)
      : null;
  if (!delivery.canType()) return null;
  const launch = delivery.take();
  if (!launch) return null;
  const typed = chooseLaunchCommand(launch, accepts);
  delivery.type(typed);
  return { typed, plain: launch.command };
}

/** A `--no-daemon` launch just typed: the plain command to type instead if
 *  Codex refuses the flag, for the window on which host, until when. */
export interface RefusalFallback {
  command: string;
  hostId: string;
  until: number;
}

export function armRefusalFallback(
  delivered: DeliveredLaunch | null,
  hostId: string,
  now: number = Date.now(),
): RefusalFallback | null {
  if (!delivered || delivered.typed === delivered.plain) return null;
  return { command: delivered.plain, hostId, until: now + NO_DAEMON_REFUSAL_WINDOW_MS };
}

export interface RefusalMoment {
  now: number;
  /** The host this view is attached to the window on, when that is where
   *  the window runs now (`attachedLaunchHost`). */
  attachedHost: string | null;
  /** Whether this view holds the window's display. */
  owner: boolean;
  /** The window's foreground process as its host last reported it. */
  foreground: string | null | undefined;
  /** Whether an agent runs in the window now, asked of its host
   *  (`conv.inspect`); null when it cannot say. */
  agentRunning: () => Promise<boolean | null>;
}

/**
 * The command to type after Codex refused `--no-daemon`, or null. Only for
 * the launch that typed the flag, inside its window, into a view that can
 * still type there, and only while the window's shell is in the foreground:
 * its host reports a shell, and says no agent runs in the window now. Where
 * either cannot be known, nothing is typed: a command typed into a running
 * Codex would be sent to it as a prompt.
 */
export async function retypeAfterRefusal(
  fallback: RefusalFallback | null,
  moment: RefusalMoment,
): Promise<string | null> {
  if (!fallback || moment.now > fallback.until) return null;
  if (!moment.owner || moment.attachedHost !== fallback.hostId) return null;
  if (!isShellCommand(moment.foreground)) return null;
  const running = await answerWithin(moment.agentRunning, CODEX_ANSWER_DEADLINE_MS);
  return running === false ? fallback.command : null;
}

/** The launch a view typed last, kept so Codex's refusal of `--no-daemon`
 *  is answered once at most. */
export function refusalWatch() {
  let fallback: RefusalFallback | null = null;
  return {
    arm(delivered: DeliveredLaunch | null, hostId: string, now: number = Date.now()): void {
      fallback = armRefusalFallback(delivered, hostId, now);
    },
    /** The command to type for a refusal on screen now; the launch is
     *  forgotten whatever the answer. */
    refused(moment: RefusalMoment): Promise<string | null> {
      const armed = fallback;
      fallback = null;
      return retypeAfterRefusal(armed, moment);
    },
  };
}
