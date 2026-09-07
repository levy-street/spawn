import { describe, expect, test } from "bun:test";

import { LiveTerminalWriteBuffer, PostRenderLiveWriteBuffer } from "./live-write-buffer";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const geometry = { cols: 100, rows: 30 };

describe("LiveTerminalWriteBuffer", () => {
  test("joins adjacent transport chunks and preserves completion order", () => {
    const buffer = new LiveTerminalWriteBuffer();
    const completed: string[] = [];
    buffer.enqueue(encoder.encode("cursor-up"), () => completed.push("up"));
    buffer.enqueue(encoder.encode("cursor-home"), () => completed.push("home"));

    const batch = buffer.take(32 * 1024);
    expect(decoder.decode(batch?.bytes)).toBe("cursor-upcursor-home");
    expect(buffer.size).toBe(0);
    expect(completed).toEqual([]);
    batch?.onWritten.forEach((callback) => {
      callback();
    });
    expect(completed).toEqual(["up", "home"]);
  });

  test("takes whole chunks without exceeding the target where possible", () => {
    const buffer = new LiveTerminalWriteBuffer();
    buffer.enqueue(encoder.encode("1234"));
    buffer.enqueue(encoder.encode("5678"));
    buffer.enqueue(encoder.encode("90"));

    expect(decoder.decode(buffer.take(8)?.bytes)).toBe("12345678");
    expect(buffer.size).toBe(2);
    expect(decoder.decode(buffer.take(8)?.bytes)).toBe("90");
  });

  test("allows one oversized transport chunk through and clears queued data", () => {
    const buffer = new LiveTerminalWriteBuffer();
    buffer.enqueue(encoder.encode("oversized"));
    expect(decoder.decode(buffer.take(4)?.bytes)).toBe("oversized");

    buffer.enqueue(encoder.encode("discarded"));
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.take(32)).toBeNull();
  });

  test("holds synchronized output until its closing marker and writes it atomically", () => {
    const buffer = new LiveTerminalWriteBuffer();
    const first = "\x1b[?2026h\x1b[2;1Hpartial";
    const last = " repaint\x1b[30;1H\x1b[?2026l";

    expect(buffer.enqueue(encoder.encode(first))).toEqual({
      synchronized: true,
      completedSynchronizedOutput: false,
    });
    expect(buffer.take(4)).toBeNull();
    expect(buffer.enqueue(encoder.encode(last))).toEqual({
      synchronized: false,
      completedSynchronizedOutput: true,
    });
    expect(decoder.decode(buffer.take(4)?.bytes)).toBe(first + last);
  });

  test("recognizes synchronized-output markers split across transport chunks", () => {
    const buffer = new LiveTerminalWriteBuffer();

    buffer.enqueue(encoder.encode("\x1b[?20"));
    expect(buffer.synchronized).toBe(false);
    buffer.enqueue(encoder.encode("26h\x1b[4;1H"));
    expect(buffer.synchronized).toBe(true);
    buffer.enqueue(encoder.encode("\x1b[?202"));
    expect(buffer.synchronized).toBe(true);
    const end = buffer.enqueue(encoder.encode("6l"));

    expect(end).toEqual({ synchronized: false, completedSynchronizedOutput: true });
    expect(decoder.decode(buffer.take(1)?.bytes)).toBe("\x1b[?2026h\x1b[4;1H\x1b[?2026l");
  });

  test("can release an unterminated synchronized frame for bounded recovery", () => {
    const buffer = new LiveTerminalWriteBuffer();
    buffer.enqueue(encoder.encode("\x1b[?2026hstalled"));
    expect(buffer.take(32)).toBeNull();

    buffer.releaseSynchronization();

    expect(buffer.synchronized).toBe(false);
    expect(decoder.decode(buffer.take(1)?.bytes)).toBe("\x1b[?2026hstalled");
  });
});

describe("PostRenderLiveWriteBuffer", () => {
  test("drains uncovered writes exactly once after replay", () => {
    const buffer = new PostRenderLiveWriteBuffer(64);
    buffer.enqueue(encoder.encode("covered"), 7, geometry);
    buffer.enqueue(encoder.encode("live-a"), 13, geometry);
    buffer.enqueue(encoder.encode("live-b"), 19, geometry);

    const first = buffer.drain(7, geometry);
    expect(first.kind).toBe("writes");
    if (first.kind !== "writes") return;
    expect(first.chunks.map((chunk) => decoder.decode(chunk))).toEqual(["live-a", "live-b"]);
    expect(first.coveredOffset).toBe(19);

    expect(buffer.drain(first.coveredOffset, geometry)).toEqual({
      kind: "writes",
      chunks: [],
      coveredOffset: 19,
    });
  });

  test("requires a fresh endpoint checkpoint after bounded overflow", () => {
    const buffer = new PostRenderLiveWriteBuffer(8);
    buffer.enqueue(encoder.encode("123456"), 6, geometry);
    buffer.enqueue(encoder.encode("789"), 9, geometry);

    expect(buffer.drain(0, geometry)).toEqual({ kind: "refresh" });
    expect(buffer.drain(0, geometry)).toEqual({
      kind: "writes",
      chunks: [],
      coveredOffset: 0,
    });
  });

  test("requires a fresh endpoint checkpoint across geometry changes", () => {
    const buffer = new PostRenderLiveWriteBuffer(64);
    buffer.enqueue(encoder.encode("old-width"), 9, { cols: 80, rows: 24 });

    expect(buffer.drain(0, geometry)).toEqual({ kind: "refresh" });
  });
});
