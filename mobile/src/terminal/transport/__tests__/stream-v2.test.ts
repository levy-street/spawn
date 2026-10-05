import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeBridgeBytes } from "@/terminal/transport/bridge";
import { type HostStreamFrame, parseHostStreamFrame } from "@/terminal/transport/host-ctl-codec";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-error";
import { type StreamV2Port, StreamV2Runtime } from "@/terminal/transport/stream-v2";

type Frame = Record<string, unknown>;
interface Transcript {
  name: string;
  length: number;
  sha256: string;
  frames: Array<[string, Frame | string]>;
}

const vectors = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../../proto/stream-v2-vectors.json"), "utf8"),
) as {
  window: Array<{ window: number; acked: number; next_to_send: number; may_send: boolean }>;
  transcripts: Transcript[];
};

function port(timeoutMs = 60_000) {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const fatal: HostControlTransportError[] = [];
  let pending: Array<() => void> | null = null;
  const value: StreamV2Port & {
    sent: typeof sent;
    fatal: (error: HostControlTransportError) => void;
    errors: typeof fatal;
    hold(): void;
    release(): void;
  } = {
    sent,
    errors: fatal,
    timeoutMs,
    send: (type, payload) => {
      sent.push({ type, payload: { ...payload } });
      if (pending) return new Promise<void>((done) => pending?.push(done));
      return Promise.resolve();
    },
    fatal: (error) => {
      fatal.push(error);
    },
    hold() {
      pending = [];
    },
    release() {
      const waiting = pending ?? [];
      pending = null;
      for (const done of waiting) done();
    },
  };
  return value;
}

function frame(value: Frame): HostStreamFrame {
  return parseHostStreamFrame({ version: 1, ...value });
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe("stream v2 reads (conv.export)", () => {
  const transcript = vectors.transcripts.find((item) => item.name.includes("conv.export"));
  if (!transcript) throw new Error("The read transcript is missing from the vectors.");
  const daemonFrames = transcript.frames
    .filter(
      (entry): entry is [string, Frame] => entry[0] === "daemon" && typeof entry[1] !== "string",
    )
    .map(([, value]) => value);
  const chunks = daemonFrames.filter((value) => value["type"] === "stream.chunk");
  const end = daemonFrames.find((value) => value["type"] === "stream.end");

  it("hands chunks on in order, acknowledges what was handed on, and ends with the digest", async () => {
    const link = port();
    const runtime = new StreamV2Runtime(link);
    const reader = runtime.beginRead("rs-1", {
      length: transcript.length,
      nextSequence: 0,
      window: 16,
    });
    for (const chunk of chunks.filter((item) => item["stream_id"] === "rs-1")) {
      expect(runtime.handle(frame(chunk))).toBe(true);
    }
    const first = await reader.next();
    expect(first).toMatchObject({ kind: "chunk", sequence: 0 });
    reader.acknowledge(1);
    const second = await reader.next();
    expect(second).toMatchObject({ kind: "chunk", sequence: 1 });
    reader.acknowledge(2);
    await flush();
    // The device's own frames in the transcript, as it sent them.
    expect(link.sent).toEqual([
      { type: "ack", payload: { stream_id: "rs-1", sequence: 1 } },
      { type: "ack", payload: { stream_id: "rs-1", sequence: 2 } },
    ]);
    expect(runtime.active).toBe(1);
    reader.cancel();
    expect(runtime.active).toBe(0);
  });

  it("resumes from next_sequence with the same numbers and the whole stream's digest", async () => {
    const link = port();
    const runtime = new StreamV2Runtime(link);
    const reader = runtime.beginRead("rs-2", {
      length: transcript.length,
      nextSequence: 2,
      window: 16,
    });
    for (const value of daemonFrames.filter((item) => item["stream_id"] === "rs-2")) {
      runtime.handle(frame(value));
    }
    const chunk = await reader.next();
    expect(chunk.kind === "chunk" && chunk.sequence).toBe(2);
    reader.acknowledge(3);
    const ending = await reader.next();
    expect(ending).toEqual({ kind: "end", length: transcript.length, sha256: end?.["sha256"] });
    expect(runtime.active).toBe(0);
    expect(link.errors).toEqual([]);
  });

  it("a resume at the chunk count is answered by the end alone", async () => {
    const runtime = new StreamV2Runtime(port());
    const reader = runtime.beginRead("rs-3", {
      length: transcript.length,
      nextSequence: 3,
      window: 16,
    });
    runtime.handle(frame({ ...end, stream_id: "rs-3" }));
    await expect(reader.next()).resolves.toMatchObject({ kind: "end" });
  });

  it("refuses a chunk out of order, one past the window, or one of the wrong size", () => {
    const first = chunks[0] as Frame;
    for (const [declaration, value] of [
      [{ nextSequence: 1, window: 16 }, first],
      [
        { nextSequence: 0, window: 16 },
        { ...first, sequence: 1 },
      ],
      [
        { nextSequence: 0, window: 16 },
        { ...first, bytes_b64: "AQ==" },
      ],
    ] as const) {
      const link = port();
      const runtime = new StreamV2Runtime(link);
      runtime.beginRead("s", { length: transcript.length, ...declaration });
      runtime.handle(frame({ ...value, stream_id: "s" }));
      expect(link.errors.map((error) => error.code)).toEqual(["invalid_chunk"]);
    }
    const link = port();
    const runtime = new StreamV2Runtime(link);
    runtime.beginRead("w", { length: transcript.length, nextSequence: 0, window: 1 });
    runtime.handle(frame({ ...first, stream_id: "w" }));
    runtime.handle(frame({ ...(chunks[1] as Frame), stream_id: "w" }));
    expect(link.errors.map((error) => error.code)).toEqual(["invalid_chunk"]);
  });

  it("a host error ends the read with its code; a cancelled read drops late frames", async () => {
    const link = port();
    const runtime = new StreamV2Runtime(link);
    const reader = runtime.beginRead("e", {
      length: transcript.length,
      nextSequence: 0,
      window: 16,
    });
    const waiting = reader.next();
    runtime.handle(
      frame({ type: "stream.error", stream_id: "e", error: { code: "superseded", detail: "x" } }),
    );
    await expect(waiting).rejects.toMatchObject({ code: "superseded" });

    const cancelled = runtime.beginRead("c", {
      length: transcript.length,
      nextSequence: 0,
      window: 16,
    });
    cancelled.cancel();
    expect(runtime.handle(frame({ ...(chunks[0] as Frame), stream_id: "c" }))).toBe(true);
    expect(link.errors).toEqual([]);
    expect(link.sent.at(-1)).toEqual({ type: "cancel", payload: { stream_id: "c" } });
  });

  it("times out only while it waits on the host", async () => {
    jest.useFakeTimers();
    try {
      const link = port(1_000);
      const runtime = new StreamV2Runtime(link);
      const reader = runtime.beginRead("t", {
        length: transcript.length,
        nextSequence: 0,
        window: 16,
      });
      runtime.handle(frame({ ...(chunks[0] as Frame), stream_id: "t" }));
      // Holding a chunk back for a slow target is not a stall.
      jest.advanceTimersByTime(5_000);
      await expect(reader.next()).resolves.toMatchObject({ kind: "chunk" });
      const waiting = reader.next();
      jest.advanceTimersByTime(1_000);
      await expect(waiting).rejects.toMatchObject({ code: "stream_timeout" });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("stream v2 writes (conv.import.begin)", () => {
  const transcript = vectors.transcripts.find((item) => item.name.includes("conv.import.begin"));
  if (!transcript) throw new Error("The write transcript is missing from the vectors.");
  const deviceChunks = transcript.frames
    .filter(
      (entry): entry is [string, Frame] =>
        entry[0] === "device" &&
        typeof entry[1] !== "string" &&
        entry[1]["type"] === "stream.chunk",
    )
    .map(([, value]) => value);

  function bytesOf(sequence: number): Uint8Array {
    const chunk = deviceChunks.find((item) => item["sequence"] === sequence);
    return decodeBridgeBytes(String(chunk?.["bytes_b64"]));
  }

  it("never sends past the window the target granted", async () => {
    for (const row of vectors.window) {
      const link = port();
      const runtime = new StreamV2Runtime(link);
      const writer = runtime.beginWrite("w", { window: row.window, nextSequence: row.acked });
      for (let sequence = row.acked; sequence < row.next_to_send; sequence += 1) {
        await writer.write(sequence, Uint8Array.of(1));
      }
      const next = writer.write(row.next_to_send, Uint8Array.of(1));
      await flush();
      const sent = link.sent.some(
        (item) => item.type === "chunk" && item.payload["sequence"] === row.next_to_send,
      );
      expect({ ...row, sent }).toEqual({ ...row, sent: row.may_send });
      writer.cancel();
      await next.catch(() => undefined);
    }
  });

  it("writes, hears the target's acknowledgements, resumes from next_sequence and commits", async () => {
    const link = port();
    const runtime = new StreamV2Runtime(link);
    const first = runtime.beginWrite("ws-1", { window: 16, nextSequence: 0 });
    await first.write(0, bytesOf(0));
    await first.write(1, bytesOf(1));
    runtime.handle(frame({ type: "stream.ack", stream_id: "ws-1", sequence: 2 }));
    expect(first.acknowledged).toBe(2);
    // The channel goes; the status says 2; a resumed begin carries on.
    first.cancel();
    const resumed = runtime.beginWrite("ws-2", { window: 16, nextSequence: 2 });
    await resumed.write(2, bytesOf(2));
    runtime.handle(frame({ type: "stream.ack", stream_id: "ws-2", sequence: 3 }));
    const committing = resumed.end(transcript.length, transcript.sha256);
    await flush();
    runtime.handle(
      frame({
        type: "stream.committed",
        stream_id: "ws-2",
        length: transcript.length,
        sha256: transcript.sha256,
        result: { transfer_id: "9b2f5c1e-7a40-4d3b-8e61-0c4f2a7d9e15" },
      }),
    );
    await expect(committing).resolves.toEqual({
      length: transcript.length,
      sha256: transcript.sha256,
      result: { transfer_id: "9b2f5c1e-7a40-4d3b-8e61-0c4f2a7d9e15" },
    });
    expect(link.sent.filter((item) => item.type !== "cancel").map((item) => item.payload)).toEqual(
      transcript.frames
        .filter(
          (entry): entry is [string, Frame] =>
            entry[0] === "device" &&
            typeof entry[1] !== "string" &&
            (entry[1]["type"] === "stream.chunk" || entry[1]["type"] === "stream.end"),
        )
        .map(([, value]) => {
          const { version: _v, type: _t, ...payload } = value;
          return payload;
        }),
    );
    expect(link.errors).toEqual([]);
  });

  it("refuses an acknowledgement below an earlier one or above what was sent", async () => {
    const link = port();
    const runtime = new StreamV2Runtime(link);
    const writer = runtime.beginWrite("w", { window: 16, nextSequence: 0 });
    await writer.write(0, Uint8Array.of(1));
    runtime.handle(frame({ type: "stream.ack", stream_id: "w", sequence: 2 }));
    expect(link.errors.map((error) => error.code)).toEqual(["invalid_ack"]);
    writer.cancel();
  });

  it("a refused commit carries the target's code; one that never answers is outcome_unknown", async () => {
    jest.useFakeTimers();
    try {
      const link = port(1_000);
      const runtime = new StreamV2Runtime(link);
      const refused = runtime.beginWrite("r", { window: 16, nextSequence: 0 });
      await refused.write(0, Uint8Array.of(1));
      const ending = refused.end(1, "a".repeat(64));
      await flush();
      runtime.handle(
        frame({
          type: "stream.error",
          stream_id: "r",
          error: { code: "conversation_live_here", detail: "a Claude holds it" },
        }),
      );
      await expect(ending).rejects.toMatchObject({ code: "conversation_live_here" });

      const silent = runtime.beginWrite("s", { window: 16, nextSequence: 0 });
      await silent.write(0, Uint8Array.of(1));
      const waiting = silent.end(1, "a".repeat(64));
      await flush();
      jest.advanceTimersByTime(1_000);
      await expect(waiting).rejects.toMatchObject({ code: "outcome_unknown" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("a channel that closes after the end leaves the outcome unknown", async () => {
    const runtime = new StreamV2Runtime(port());
    const writer = runtime.beginWrite("x", { window: 16, nextSequence: 0 });
    await writer.write(0, Uint8Array.of(1));
    const ending = writer.end(1, "b".repeat(64));
    await flush();
    runtime.close(new HostControlTransportError("connection_lost"));
    await expect(ending).rejects.toMatchObject({ code: "outcome_unknown" });
  });
});
