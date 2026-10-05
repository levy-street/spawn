import { describe, expect, test } from "bun:test";
import { screenBanner } from "./copy";
import {
  extendNoteWait,
  NOTE_DIALOG_MAX_MS,
  NOTE_ENTER_GAP_MS,
  NOTE_READY_WAIT_MS,
  NOTE_WATCH_MS,
  nextNoteStep,
  pendingNote,
  RETRY_SETTLE_MS,
  screenSinceRetry,
} from "./note-delivery";
import { CLAUDE_SCREEN_TABLE } from "./screen";

describe("the note's timings, as the phone's", () => {
  test("45 s for the ready prompt, a question extends it to at most 5 min, Enter 150 ms after", () => {
    expect(NOTE_READY_WAIT_MS).toBe(45_000);
    expect(NOTE_DIALOG_MAX_MS).toBe(300_000);
    expect(NOTE_WATCH_MS).toBe(60_000);
    expect(NOTE_ENTER_GAP_MS).toBe(150);
  });

  test("a question seen pushes the wait out from then, never past five minutes in all", () => {
    expect(extendNoteWait(NOTE_READY_WAIT_MS, 10_000)).toBe(55_000);
    expect(extendNoteWait(55_000, 20_000)).toBe(65_000);
    expect(extendNoteWait(290_000, 280_000)).toBe(NOTE_DIALOG_MAX_MS);
    // Once answered, the note gives up at the extended deadline, not before.
    expect(nextNoteStep("typed", "busy", 50_000, false, 65_000)).toEqual({ kind: "wait" });
    expect(nextNoteStep("typed", "busy", 65_001, false, 65_000)).toEqual({ kind: "give_up" });
  });
});

describe("nextNoteStep", () => {
  test("a typed note waits for the ready prompt, then is pasted and sent", () => {
    expect(nextNoteStep("typed", "unknown", 100, false)).toEqual({ kind: "wait" });
    expect(nextNoteStep("typed", "busy", 100, false)).toEqual({ kind: "wait" });
    expect(nextNoteStep("typed", "agent_ready", 100, false)).toEqual({
      kind: "type",
      enter: true,
    });
  });

  test("an idle note is pasted and never sent", () => {
    expect(nextNoteStep("typed_no_enter", "agent_ready", 100, false)).toEqual({
      kind: "type",
      enter: false,
    });
  });

  test("every question is surfaced and never answered; the note waits behind it", () => {
    for (const state of [
      "trust_prompt",
      "bypass_prompt",
      "resume_summary_prompt",
      "login_required",
      "dialog",
    ] as const) {
      expect(nextNoteStep("typed_no_enter", state, 100, false)).toEqual({ kind: "banner", state });
      expect(nextNoteStep("typed", state, NOTE_READY_WAIT_MS + 1, false)).toEqual({
        kind: "banner",
        state,
      });
    }
  });

  test("every question and every stop has its words in the pane", () => {
    for (const state of CLAUDE_SCREEN_TABLE.asks_person)
      expect(screenBanner(state, "mac", "~/code/spawn")).toContain("in the terminal");
    for (const state of ["conversation_not_found", "agent_missing"] as const)
      expect(screenBanner(state, "mac", "~/code/spawn")).toContain("mac");
    for (const state of ["agent_ready", "busy", "unknown"] as const)
      expect(screenBanner(state, "mac", "~/code/spawn")).toBeNull();
  });

  test("Claude gone — no conversation, no Claude — stops with its banner", () => {
    expect(nextNoteStep("positional", "conversation_not_found", 100, false)).toEqual({
      kind: "stop",
      state: "conversation_not_found",
    });
    expect(nextNoteStep("typed", "agent_missing", 100, false)).toEqual({
      kind: "stop",
      state: "agent_missing",
    });
  });

  test("a positional note is only watched", () => {
    expect(nextNoteStep("positional", "unknown", 100, false)).toEqual({ kind: "wait" });
    expect(nextNoteStep("positional", "trust_prompt", 100, false)).toEqual({
      kind: "banner",
      state: "trust_prompt",
    });
    expect(nextNoteStep("positional", "busy", 100, false)).toEqual({ kind: "done" });
    expect(nextNoteStep("positional", "unknown", NOTE_WATCH_MS + 1, false)).toEqual({
      kind: "done",
    });
  });

  test("an unrecognised screen past the wait gives the note to copy", () => {
    expect(nextNoteStep("typed", "unknown", NOTE_READY_WAIT_MS + 1, false)).toEqual({
      kind: "give_up",
    });
  });

  test("once placed, nothing is typed again", () => {
    expect(nextNoteStep("typed_no_enter", "agent_ready", 100, true)).toEqual({ kind: "done" });
  });
});

describe("screenSinceRetry", () => {
  test("the error Try again was pressed on is stale until another screen is read", () => {
    const retry = { on: "conversation_not_found" as const, at: 1_000 };
    let seen = screenSinceRetry("conversation_not_found", retry, 1_100);
    expect(seen).toEqual({ screen: "unknown", retry });
    expect(nextNoteStep("typed", seen.screen, 100, false)).toEqual({ kind: "wait" });
    // The echo of the line typed again: the mark is spent.
    seen = screenSinceRetry("unknown", seen.retry, 1_500);
    expect(seen).toEqual({ screen: "unknown", retry: null });
    // The new line failed too: said again.
    seen = screenSinceRetry("conversation_not_found", seen.retry, 2_000);
    expect(seen).toEqual({ screen: "conversation_not_found", retry: null });
  });

  test("a failure that came before any other reading is said once the screen has had time", () => {
    const retry = { on: "conversation_not_found" as const, at: 1_000 };
    expect(screenSinceRetry("conversation_not_found", retry, 1_000 + RETRY_SETTLE_MS)).toEqual({
      screen: "conversation_not_found",
      retry: null,
    });
  });

  test("with no Try again pending, the screen is read as it is", () => {
    expect(screenSinceRetry("agent_ready", null, 0)).toEqual({
      screen: "agent_ready",
      retry: null,
    });
  });
});

describe("pendingNote", () => {
  test("a note belongs to the window as it runs on one host, and lapses", () => {
    pendingNote.set(
      "s",
      { hostId: "h", text: "n", delivery: "typed", line: "claude", target: "mac", cwd: "~" },
      1_000,
    );
    expect(pendingNote.peek("s", "other", 1_001)).toBeNull();
    expect(pendingNote.peek("s", "h", 1_001)?.text).toBe("n");
    expect(pendingNote.peek("s", "h", 1_000 + 16 * 60 * 1_000)).toBeNull();
    expect(pendingNote.peek("s", "h", 1_001)).toBeNull();
  });
});
