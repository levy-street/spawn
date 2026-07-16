import { describe, expect, test } from "bun:test";

import { PostRenderLiveWriteBuffer } from "./live-write-buffer";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const geometry = { cols: 100, rows: 30 };

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
