/**
 * Placing a move's note after the relaunch line is typed, by reading the
 * screen (`screen.ts`) and never by pressing a key into one of Claude's
 * dialogs.
 *
 * - `positional`: the note rode the line as Claude's first prompt. The
 *   device only watches, for a dialog or an error to surface as a banner.
 * - `typed`: once Claude's ready prompt shows, the note is pasted and Enter
 *   follows — the only Enter a move ever sends into Claude.
 * - `typed_no_enter`: once ready, the note is pasted and left for the
 *   person's next message.
 *
 * A screen SPAWN D does not recognise gets nothing; after its wait the pane
 * offers the note to copy and leaves the terminal alone.
 */

import type { NoteDelivery } from "@/lib/agent-relaunch";
import { type ClaudeScreenState, claudeScreenAsksPerson } from "./screen";

/** How long a typed note waits for Claude's ready prompt. */
export const NOTE_READY_WAIT_MS = 45_000;
/** A question the person is answering extends the wait, up to this in all. */
export const NOTE_DIALOG_MAX_MS = 5 * 60_000;
/** How long a positional note's line is watched for a dialog or an error. */
export const NOTE_WATCH_MS = 60_000;
/** How long after the note's text its Enter goes, for a `typed` note. */
export const NOTE_ENTER_GAP_MS = 150;

/**
 * The wait's end, in ms after the line was typed, once Claude was seen
 * asking the person something at `elapsedMs`: the full wait again from
 * then, never past `NOTE_DIALOG_MAX_MS` in all (the phone's
 * `ARRIVAL_MAX_MS`, the same rule).
 */
export function extendNoteWait(deadlineMs: number, elapsedMs: number): number {
  return Math.min(NOTE_DIALOG_MAX_MS, Math.max(deadlineMs, elapsedMs + NOTE_READY_WAIT_MS));
}

export interface QueuedNote {
  hostId: string;
  text: string;
  delivery: NoteDelivery;
  /** The relaunch line, typed again by "Try again". */
  line: string;
  /** Names for the banners. */
  target: string;
  cwd: string;
  expiresAt: number;
}

/** Notes waiting for a window's terminal on its new host, by session id. */
const queued = new Map<string, QueuedNote>();

/** As long as a queued launch waits (`PENDING_LAUNCH_TTL_MS`). */
const NOTE_TTL_MS = 15 * 60 * 1_000;

export const pendingNote = {
  set(sessionId: string, note: Omit<QueuedNote, "expiresAt">, now: number = Date.now()): void {
    queued.set(sessionId, { ...note, expiresAt: now + NOTE_TTL_MS });
  },
  /** The note for the window as it runs on `hostId`, without claiming it. */
  peek(sessionId: string, hostId: string, now: number = Date.now()): QueuedNote | null {
    const note = queued.get(sessionId);
    if (!note) return null;
    if (note.expiresAt <= now) {
      queued.delete(sessionId);
      return null;
    }
    return note.hostId === hostId ? note : null;
  },
  clear(sessionId: string): void {
    queued.delete(sessionId);
  },
};

export type NoteStep =
  /** Keep watching. */
  | { kind: "wait" }
  /** Paste the note now; Enter after it only when `enter`. */
  | { kind: "type"; enter: boolean }
  /** Claude asks the person something: say so in the pane, press nothing. */
  | { kind: "banner"; state: ClaudeScreenState }
  /** Claude exited: a banner, and nothing more to wait for. */
  | { kind: "stop"; state: ClaudeScreenState }
  /** Waited long enough without the ready prompt: offer the note to copy. */
  | { kind: "give_up" }
  /** Nothing more to do. */
  | { kind: "done" };

/**
 * The next step for a note, from what the screen shows `elapsedMs` after the
 * line was typed. `placed` says the note has been typed already; a typed
 * note gives up at `deadlineMs` (`extendNoteWait` pushes it out while
 * Claude asks the person something).
 */
export function nextNoteStep(
  delivery: NoteDelivery | null,
  screen: ClaudeScreenState,
  elapsedMs: number,
  placed: boolean,
  deadlineMs: number = NOTE_READY_WAIT_MS,
): NoteStep {
  if (screen === "conversation_not_found" || screen === "agent_missing")
    return { kind: "stop", state: screen };
  if (claudeScreenAsksPerson(screen)) return { kind: "banner", state: screen };
  if (delivery === null || delivery === "positional" || placed) {
    if (screen === "busy" || screen === "agent_ready") return { kind: "done" };
    return elapsedMs > NOTE_WATCH_MS ? { kind: "done" } : { kind: "wait" };
  }
  if (screen === "agent_ready") return { kind: "type", enter: delivery === "typed" };
  return elapsedMs > deadlineMs ? { kind: "give_up" } : { kind: "wait" };
}

/** How long after Try again the screen it was pressed on may still be up. */
export const RETRY_SETTLE_MS = 5_000;

/** Try again was pressed on `on` at `at` (ms). */
export interface RetryMark {
  on: ClaudeScreenState;
  at: number;
}

/**
 * The screen a note acts on after Try again. Until the echo of the line typed
 * again reaches the terminal, the screen still shows the error Try again was
 * pressed on, so that state is stale — read as `unknown` — until the terminal
 * reads any other or `RETRY_SETTLE_MS` passes; a failure of the new line is
 * then said again. The result carries the mark to keep for the next reading.
 */
export function screenSinceRetry(
  screen: ClaudeScreenState,
  retry: RetryMark | null,
  now: number,
): { screen: ClaudeScreenState; retry: RetryMark | null } {
  if (retry === null) return { screen, retry };
  if (screen !== retry.on || now - retry.at >= RETRY_SETTLE_MS) return { screen, retry: null };
  return { screen: "unknown", retry };
}
