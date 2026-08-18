import { describe, expect, test } from "bun:test";

import { type PromptState, PromptStateTracker } from "./prompt-state";

function tracked(): { tracker: PromptStateTracker; transitions: PromptState[] } {
  const tracker = new PromptStateTracker();
  const transitions: PromptState[] = [];
  tracker.onChange = (state) => transitions.push(state);
  return { tracker, transitions };
}

describe("PromptStateTracker", () => {
  test("printables count up; Enter resets; transitions fire once per edge", () => {
    const { tracker, transitions } = tracked();
    expect(tracker.state).toBe("empty");
    tracker.feed("l");
    tracker.feed("s");
    expect(tracker.state).toBe("typing");
    expect(tracker.pendingCount).toBe(2);
    tracker.feed("\r");
    expect(tracker.state).toBe("empty");
    expect(transitions).toEqual(["typing", "empty"]);
  });

  test("Backspace/DEL decrement with a floor of zero", () => {
    const { tracker } = tracked();
    tracker.feed("ab");
    tracker.feed("\x7f");
    expect(tracker.pendingCount).toBe(1);
    tracker.feed("\x7f\x7f\x08");
    expect(tracker.pendingCount).toBe(0);
    expect(tracker.state).toBe("empty");
  });

  test("Ctrl+C, Ctrl+U, Ctrl+D reset to zero", () => {
    for (const byte of ["\x03", "\x15", "\x04"]) {
      const { tracker } = tracked();
      tracker.feed("some command");
      tracker.feed(byte);
      expect(tracker.state).toBe("empty");
    }
  });

  test("bracketed paste counts its payload, including newlines", () => {
    const { tracker } = tracked();
    tracker.feed("\x1b[200~echo hi\n\x1b[201~");
    expect(tracker.state).toBe("typing");
    expect(tracker.pendingCount).toBe("echo hi\n".length);
  });

  test("a paste split across feeds still counts exactly once", () => {
    const { tracker } = tracked();
    tracker.feed("\x1b[200~abc");
    tracker.feed("def\x1b[2");
    tracker.feed("01~");
    expect(tracker.pendingCount).toBe(6);
    expect(tracker.state).toBe("typing");
  });

  test("navigation escapes leave the count untouched", () => {
    const { tracker } = tracked();
    tracker.feed("\x1b[A\x1b[B\x1b[1;5C\x1bOP\x1bb");
    expect(tracker.state).toBe("empty");
    tracker.feed("x");
    tracker.feed("\x1b[D");
    expect(tracker.pendingCount).toBe(1);
  });

  test("ESC+CR (Shift+Enter newline insert) counts as one insert", () => {
    const { tracker } = tracked();
    tracker.feed("\x1b\r");
    expect(tracker.state).toBe("typing");
    expect(tracker.pendingCount).toBe(1);
  });

  test("an escape split across feeds is reassembled, not miscounted", () => {
    const { tracker } = tracked();
    tracker.feed("\x1b");
    tracker.feed("[A");
    expect(tracker.pendingCount).toBe(0);
    tracker.feed("\x1b[1;");
    tracker.feed("5D");
    expect(tracker.pendingCount).toBe(0);
  });

  test("external reset clears typing and notifies", () => {
    const { tracker, transitions } = tracked();
    tracker.feed("claude");
    expect(tracker.state).toBe("typing");
    tracker.reset();
    expect(tracker.state).toBe("empty");
    expect(transitions).toEqual(["typing", "empty"]);
    // Reset while already empty must not re-notify.
    tracker.reset();
    expect(transitions).toEqual(["typing", "empty"]);
  });

  test("one chunk that types and submits nets to empty with no spurious transition", () => {
    const { tracker, transitions } = tracked();
    tracker.feed("claude\n");
    expect(tracker.state).toBe("empty");
    expect(transitions).toEqual([]);
  });

  test("multi-code-point characters count once each", () => {
    const { tracker } = tracked();
    tracker.feed("😀");
    expect(tracker.pendingCount).toBe(1);
    tracker.feed("\x7f");
    expect(tracker.pendingCount).toBe(0);
  });
});
