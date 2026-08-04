import { beforeEach, describe, expect, test } from "bun:test";
import type { Terminal as XTerm } from "@xterm/xterm";
import { CommittedHistoryOverlay, decodeHistoryDelta } from "./committed-history";

class FakeTerm {
  rows = 10;
  cols = 40;
  writes: string[] = [];
  resets = 0;
  buffer = {
    active: { baseY: 0, cursorY: 0, cursorX: 0, viewportY: 0 },
  };
  #pendingCallbacks: Array<() => void> = [];

  write(data: string | Uint8Array, done?: () => void) {
    this.writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    if (done) this.#pendingCallbacks.push(done);
  }

  reset() {
    this.resets += 1;
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }

  scrollToLine(_line: number) {}
  scrollToBottom() {}

  /** Run queued write completions (the controller pumps between them). */
  flush() {
    while (this.#pendingCallbacks.length > 0) {
      const callback = this.#pendingCallbacks.shift();
      callback?.();
    }
  }
}

const asTerm = (fake: FakeTerm) => fake as unknown as XTerm;

describe("CommittedHistoryOverlay", () => {
  let term: FakeTerm;
  let seedRequests: number;
  let rendered: number;
  let screen: string;
  let overlay: CommittedHistoryOverlay;

  const delta = (offset: number, text: string, epoch = "7") => {
    overlay.applyDelta(epoch, offset, new TextEncoder().encode(text));
    term.flush();
  };

  beforeEach(() => {
    term = new FakeTerm();
    seedRequests = 0;
    rendered = 0;
    screen = "SCREEN";
    overlay = new CommittedHistoryOverlay({
      term: () => asTerm(term),
      serializeLiveScreen: () => screen,
      requestSeed: () => {
        seedRequests += 1;
      },
      onRendered: () => {
        rendered += 1;
      },
    });
  });

  test("seed then contiguous deltas append in order", () => {
    overlay.seed("hist-", { epoch: "7", offset: 100 }, { cols: 40, rows: 10 });
    term.flush();
    delta(100, "aaa");
    delta(103, "bb");
    expect(term.resets).toBe(1);
    expect(term.writes).toEqual(["hist-", "aaa", "bb"]);
    expect(overlay.anchor).toEqual({ epoch: "7", offset: 105 });
  });

  test("covered deltas drop; a hole requests exactly one reseed", () => {
    overlay.seed("h", { epoch: "7", offset: 100 }, { cols: 40, rows: 10 });
    term.flush();
    delta(90, "old-fully-covered!!!!!"); // 90+21 > 100 would be a straddle; use covered
    expect(overlay.anchored).toBe(false); // straddle treated as gap
    expect(seedRequests).toBe(1);
    delta(200, "later");
    expect(seedRequests).toBe(1); // still just the one outstanding request
  });

  test("exactly-covered delta is ignored without losing the anchor", () => {
    overlay.seed("h", { epoch: "7", offset: 100 }, { cols: 40, rows: 10 });
    term.flush();
    delta(97, "abc"); // ends exactly at the anchor
    expect(overlay.anchor).toEqual({ epoch: "7", offset: 100 });
    expect(term.writes).toEqual(["h"]);
    expect(seedRequests).toBe(0);
  });

  test("deltas during a seed buffer and drain afterwards", () => {
    overlay.seed("base", { epoch: "7", offset: 10 }, { cols: 40, rows: 10 });
    overlay.applyDelta("7", 10, new TextEncoder().encode("x"));
    overlay.applyDelta("7", 11, new TextEncoder().encode("y"));
    term.flush();
    expect(term.writes).toEqual(["base", "x", "y"]);
    expect(overlay.anchor).toEqual({ epoch: "7", offset: 12 });
  });

  test("epoch change without a wipe re-anchors from a fresh seed", () => {
    overlay.seed("h", { epoch: "7", offset: 0 }, { cols: 40, rows: 10 });
    term.flush();
    delta(0, "restarted", "8");
    expect(overlay.anchored).toBe(false);
    expect(seedRequests).toBe(1);
  });

  test("wipe resets the terminal and re-anchors at zero", () => {
    overlay.seed("h", { epoch: "7", offset: 50 }, { cols: 40, rows: 10 });
    term.flush();
    overlay.applyWipe("8");
    term.flush();
    expect(term.resets).toBe(2);
    expect(overlay.anchor).toEqual({ epoch: "8", offset: 0 });
    delta(0, "fresh", "8");
    expect(term.writes.at(-1)).toBe("fresh");
  });

  test("reveal paints the live screen tail; conceal erases it", () => {
    overlay.seed("h\r\n", { epoch: "7", offset: 3 }, { cols: 40, rows: 10 });
    term.flush();
    term.buffer.active.cursorY = 1;
    expect(overlay.reveal()).toBe(true);
    term.flush();
    expect(term.writes.at(-1)).toBe("\x1b[0mSCREEN");
    overlay.conceal();
    term.flush();
    // Tail began at buffer line 1 (baseY 0 + cursorY 1), column 0.
    expect(term.writes.at(-1)).toBe("\x1b[2;1H\x1b[0J");
  });

  test("a delta while revealed erases, appends, and repaints the tail", () => {
    overlay.seed("h\r\n", { epoch: "7", offset: 3 }, { cols: 40, rows: 10 });
    term.flush();
    expect(overlay.reveal()).toBe(true);
    term.flush();
    const before = term.writes.length;
    delta(3, "new-line\r\n");
    const tailCycle = term.writes.slice(before);
    expect(tailCycle[0]).toBe("\x1b[1;1H\x1b[0J");
    expect(tailCycle[1]).toBe("new-line\r\n");
    expect(tailCycle[2]).toBe("\x1b[0mSCREEN");
  });

  test("reveal before any seed requests one and reports not-ready", () => {
    expect(overlay.reveal()).toBe(false);
    expect(seedRequests).toBe(1);
  });

  test("wrapped history end erases from the recorded column", () => {
    overlay.seed("wrapped-tail", { epoch: "7", offset: 12 }, { cols: 40, rows: 10 });
    term.flush();
    term.buffer.active.cursorX = 12;
    expect(overlay.reveal()).toBe(true);
    term.flush();
    overlay.conceal();
    term.flush();
    expect(term.writes.at(-1)).toBe("\x1b[1;13H\x1b[0J");
  });
});

describe("decodeHistoryDelta", () => {
  test("round-trips base64", () => {
    const bytes = decodeHistoryDelta(btoa("hello\x1b[0m"));
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe("hello\x1b[0m");
  });

  test("rejects malformed input", () => {
    expect(decodeHistoryDelta("not b64!!")).toBeNull();
  });
});
