import type { MoveArrival } from "@/components/launcher/pending-agent-input";
import * as copy from "@/components/workspace-detail/move-copy";
import type { ClaudeScreenState } from "@/data/selectors/claude-screen";

/**
 * What a moved window still owes its agent once its resume line has gone
 * out, step by step against what the screen shows (`claude-screen.ts`): the
 * note typed at Claude Code's ready prompt — sent when it was mid-turn on a
 * shell that could not carry it on the line, left for the person's next
 * message when it was idle — or nothing to type when the note rode the line.
 * Every question Claude Code asks first is the person's to answer: a banner
 * says so and no key is pressed. Past the wait, the note is offered to copy
 * and the terminal is left alone. The browser follows the same steps
 * (web/src/lib/move/note-delivery.ts, driven by
 * web/src/components/workspace/use-move-note.ts).
 */

/** How long the note waits for Claude Code's prompt. */
export const ARRIVAL_WAIT_MS = 45_000;
/** How long a window whose note rode the line (or that owed none) is
 *  watched for a question to put a banner over. */
export const ARRIVAL_WATCH_MS = 60_000;
/** A dialog the person is answering extends the wait, up to this in all. */
export const ARRIVAL_MAX_MS = 5 * 60_000;
/** How often the screen is read while waiting. */
export const ARRIVAL_POLL_MS = 600;
/** How long after Try again the screen it was pressed on may still be up. */
export const RETRY_SETTLE_MS = 5_000;

export type ArrivalBanner =
  | { readonly kind: "dialog"; readonly message: string }
  | { readonly kind: "not_found"; readonly message: string }
  | { readonly kind: "missing"; readonly message: string }
  | { readonly kind: "note_failed"; readonly message: string };

export interface ArrivalState {
  readonly arrival: MoveArrival;
  readonly startedAt: number;
  readonly deadline: number;
  /** The note is where it belongs: typed, on the line, or there was none. */
  readonly placed: boolean;
  /** Nothing more is read or typed. */
  readonly done: boolean;
  /** "Resuming the conversation…": the person's keys would interleave. */
  readonly guard: boolean;
  readonly banner: ArrivalBanner | null;
  /** Try again was pressed on this screen at this time: until the echo of
   *  the line typed again is read, the screen still shows it. */
  readonly retry: { readonly on: ClaudeScreenState; readonly at: number } | null;
}

export type ArrivalEffect =
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "enter" }
  | { readonly kind: "focus" };

function typesNote(arrival: MoveArrival): boolean {
  return arrival.note !== null && arrival.note.delivery !== "positional";
}

export function startArrival(arrival: MoveArrival, now: number): ArrivalState {
  const typing = typesNote(arrival);
  return {
    arrival,
    startedAt: now,
    deadline: now + (typing ? ARRIVAL_WAIT_MS : ARRIVAL_WATCH_MS),
    placed: !typing,
    done: false,
    guard: typing,
    banner: null,
    retry: null,
  };
}

function dialogMessage(state: ClaudeScreenState, arrival: MoveArrival): string | null {
  switch (state) {
    case "trust_prompt":
      return copy.arrivalTrust(arrival.to, arrival.cwd);
    case "bypass_prompt":
      return copy.arrivalBypass(arrival.to);
    case "resume_summary_prompt":
      return copy.ARRIVAL_RESUME_SUMMARY;
    case "login_required":
      return copy.arrivalLogin(arrival.to);
    case "dialog":
      return copy.arrivalQuestion(arrival.to);
    default:
      return null;
  }
}

/**
 * The screen as read since Try again: the state it was pressed on is stale —
 * read as `unknown` — until the terminal reads any other or
 * `RETRY_SETTLE_MS` passes, so a failure of the new line is then said again.
 */
function sinceRetry(
  current: ArrivalState,
  read: ClaudeScreenState | null,
  now: number,
): { state: ArrivalState; screen: ClaudeScreenState | null } {
  const { retry } = current;
  if (retry === null || read === null) return { state: current, screen: read };
  if (read !== retry.on || now - retry.at >= RETRY_SETTLE_MS) {
    return { state: { ...current, retry: null }, screen: read };
  }
  return { state: current, screen: "unknown" };
}

/** One reading of the screen (null when the terminal did not answer). */
export function stepArrival(
  before: ArrivalState,
  read: ClaudeScreenState | null,
  now: number,
): { state: ArrivalState; effects: ArrivalEffect[] } {
  if (before.done) return { state: before, effects: [] };
  const { state: current, screen } = sinceRetry(before, read, now);
  const { arrival } = current;
  const dialog = screen ? dialogMessage(screen, arrival) : null;
  if (dialog) {
    // The person answers it in the terminal: the guard gives way to it.
    return {
      state: {
        ...current,
        guard: false,
        banner: { kind: "dialog", message: dialog },
        deadline: Math.min(
          current.startedAt + ARRIVAL_MAX_MS,
          Math.max(current.deadline, now + ARRIVAL_WAIT_MS),
        ),
      },
      effects: [],
    };
  }
  if (screen === "conversation_not_found") {
    // The resume line failed: nothing more is read or typed — not even into
    // a Claude the person then starts by hand — unless Try again is pressed.
    return {
      state: {
        ...current,
        done: true,
        guard: false,
        banner: { kind: "not_found", message: copy.arrivalNotFound(arrival.to) },
      },
      effects: [],
    };
  }
  if (screen === "agent_missing") {
    return {
      state: {
        ...current,
        done: true,
        guard: false,
        banner: { kind: "missing", message: copy.arrivalMissing(arrival.to) },
      },
      effects: [],
    };
  }
  if (screen === "agent_ready") {
    if (current.placed || !arrival.note) {
      return { state: { ...current, done: true, guard: false, banner: null }, effects: [] };
    }
    const effects: ArrivalEffect[] = [{ kind: "type", text: arrival.note.text }];
    // Sent only when it was mid-turn; an idle note waits for the person's words.
    if (arrival.note.delivery === "typed") effects.push({ kind: "enter" });
    else effects.push({ kind: "focus" });
    return {
      state: { ...current, placed: true, done: true, guard: false, banner: null },
      effects,
    };
  }
  if (now >= current.deadline) return { state: giveUp(current), effects: [] };
  // Working, starting, or a screen this table does not know: wait. A
  // question that went away takes its banner with it, and a note still to
  // type is guarded again.
  return {
    state:
      current.banner?.kind === "dialog"
        ? { ...current, banner: null, guard: typesNote(arrival) && !current.placed }
        : current,
    effects: [],
  };
}

/** Stop and leave the terminal to the person; an unplaced note is offered to copy. */
export function giveUp(current: ArrivalState): ArrivalState {
  return {
    ...current,
    done: true,
    guard: false,
    banner:
      current.placed || !current.arrival.note
        ? current.banner?.kind === "dialog"
          ? null
          : current.banner
        : { kind: "note_failed", message: copy.ARRIVAL_NOTE_FAILED },
  };
}

/** "Try again" after "No conversation found": the resume line again. */
export function retryResume(
  current: ArrivalState,
  now: number,
): { state: ArrivalState; effects: ArrivalEffect[] } {
  return {
    state: {
      ...current,
      done: false,
      guard: typesNote(current.arrival) && !current.placed,
      banner: null,
      startedAt: now,
      deadline: now + ARRIVAL_WAIT_MS,
      retry: { on: "conversation_not_found", at: now },
    },
    effects: [{ kind: "type", text: current.arrival.line }, { kind: "enter" }],
  };
}
