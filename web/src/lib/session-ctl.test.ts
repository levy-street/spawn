import assert from "node:assert/strict";
import {
  combineSessionCtlChunks,
  decodeSessionCtlChunk,
  encodeSessionCtlUploadChunk,
  isSessionCtlRequestId,
  makeSessionCtlRequest,
  makeSessionCtlUploadCancel,
  makeSessionCtlUploadStart,
  OrderedAsyncQueue,
  parseSessionCtlText,
  parseSessionCtlUploadResponse,
  SESSION_CTL_CHUNK_PAYLOAD_BYTES,
  SESSION_CTL_MAX_OUTSTANDING_REQUESTS,
  SESSION_CTL_MAX_REPLAY_BYTES,
  SESSION_CTL_MAX_UPLOAD_BYTES,
  SESSION_CTL_UPLOAD_CHUNK_BYTES,
  SESSION_PTY_INPUT_CHUNK_BYTES,
  SessionCtlRequestTracker,
  SessionGenerationInputQueue,
  sessionPtyInputChunks,
  sha256Blob,
  slicePtyChunkAfterAnchor,
  writeSessionPtyInput,
} from "./session-ctl";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void | Promise<void>): void;

function requestId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

describe("spawn.ctl browser protocol", () => {
  test("builds versioned requests and rejects oversized metadata", () => {
    const id = "00112233-4455-4677-8899-aabbccddeeff";
    assert.match(makeSessionCtlRequest(id, "resize", { cols: 120, rows: 32 }) ?? "", /"version":1/);
    assert.deepEqual(
      JSON.parse(
        makeSessionCtlRequest(id, "redraw", {
          version: 99,
          kind: "event",
          request_id: requestId(999),
          operation: "snapshot",
        }) ?? "null",
      ),
      { version: 1, kind: "request", request_id: id, operation: "redraw" },
    );
    assert.equal(makeSessionCtlRequest(id, "redraw", { padding: "x".repeat(20_000) }), null);
    assert.equal(makeSessionCtlRequest("not-a-request-id", "redraw"), null);
    assert.equal(isSessionCtlRequestId(id), true);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(makeSessionCtlRequest(id, "redraw", circular), null);
  });

  test("parses readiness and display events and rejects other protocol versions", () => {
    const capability = "00112233-4455-4677-8899-aabbccddeeff";
    assert.equal(parseSessionCtlText('{"version":1,"kind":"event","event":"ready"}'), null);
    assert.deepEqual(
      parseSessionCtlText(
        JSON.stringify({
          version: 1,
          kind: "event",
          event: "ready",
          upload_capability: capability,
          agent_generation: 7,
          upload_max_bytes: SESSION_CTL_MAX_UPLOAD_BYTES,
          upload_chunk_bytes: SESSION_CTL_UPLOAD_CHUNK_BYTES,
        }),
      ),
      {
        version: 1,
        kind: "event",
        event: "ready",
        upload_capability: capability,
        agent_generation: 7,
        upload_max_bytes: SESSION_CTL_MAX_UPLOAD_BYTES,
        upload_chunk_bytes: SESSION_CTL_UPLOAD_CHUNK_BYTES,
      },
    );
    assert.deepEqual(
      parseSessionCtlText(
        '{"version":1,"kind":"event","event":"display_state","owner":true,"cols":120,"rows":32,"viewers":2}',
      ),
      {
        version: 1,
        kind: "event",
        event: "display_state",
        owner: true,
        cols: 120,
        rows: 32,
        viewers: 2,
      },
    );
    assert.equal(parseSessionCtlText('{"version":2,"kind":"response","ok":true}'), null);
  });

  test("frames bounded uploads and validates resumable direct responses", async () => {
    const capability = requestId(1);
    const uploadId = requestId(2);
    const bytes = new TextEncoder().encode("hello upload");
    const sha256 = await sha256Blob(new Blob([bytes]));
    assert.equal(sha256, "2d119f1cd272958a492a144af600b9dc36531f73027b34073967345b027021b1");
    const start = {
      capability,
      sessionGeneration: 9,
      uploadId,
      name: "note.txt",
      mimeType: "text/plain",
      destination: "cwd" as const,
      totalBytes: bytes.length,
      chunks: 1,
      sha256: sha256 ?? "",
    };
    assert.deepEqual(JSON.parse(makeSessionCtlUploadStart(start) ?? "null"), {
      version: 1,
      kind: "request",
      request_id: uploadId,
      operation: "upload_start",
      capability,
      agent_generation: 9,
      name: "note.txt",
      mime_type: "text/plain",
      destination: "cwd",
      total_bytes: bytes.length,
      chunks: 1,
      sha256,
    });
    assert.equal(makeSessionCtlUploadStart({ ...start, name: "../escape" }), null);
    assert.equal(
      makeSessionCtlUploadStart({ ...start, totalBytes: SESSION_CTL_MAX_UPLOAD_BYTES + 1 }),
      null,
    );
    assert.equal(makeSessionCtlUploadCancel(requestId(3), uploadId, capability, 0), null);

    const frame = encodeSessionCtlUploadChunk(uploadId, 0, true, bytes);
    assert.ok(frame);
    assert.deepEqual(Array.from(frame.subarray(0, 8)), [0x53, 0x50, 0x43, 0x54, 1, 2, 1, 0]);
    assert.equal(new DataView(frame.buffer).getUint32(24, true), 0);
    assert.deepEqual(frame.subarray(28), bytes);

    assert.deepEqual(
      parseSessionCtlUploadResponse(
        {
          version: 1,
          kind: "response",
          request_id: uploadId,
          operation: "upload_start",
          ok: true,
          state: "ready",
          next_sequence: 1,
          received_bytes: bytes.length,
        },
        start,
      ),
      { kind: "ready", nextSequence: 1, receivedBytes: bytes.length },
    );
    assert.equal(
      parseSessionCtlUploadResponse(
        {
          version: 1,
          kind: "response",
          request_id: uploadId,
          operation: "upload_complete",
          ok: true,
          state: "complete",
          path: "/repo/note.txt",
          total_bytes: bytes.length + 1,
          sha256: sha256 ?? "",
        },
        start,
      ),
      null,
    );
    assert.deepEqual(
      parseSessionCtlUploadResponse(
        {
          version: 1,
          kind: "response",
          request_id: uploadId,
          ok: false,
          error: {
            code: "outcome_unknown",
            detail: "reconcile before retrying",
          },
        },
        start,
      ),
      {
        kind: "error",
        code: "outcome_unknown",
        message: "reconcile before retrying",
      },
    );
  });

  test("decodes request-bound chunks and verifies complete response length", () => {
    const frame = new Uint8Array(28 + 3);
    frame.set([0x53, 0x50, 0x43, 0x54, 1, 1, 1, 0]);
    frame.set(
      [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x46, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff,
      ],
      8,
    );
    new DataView(frame.buffer).setUint32(24, 0, true);
    frame.set([7, 8, 9], 28);
    assert.deepEqual(decodeSessionCtlChunk(frame), {
      requestId: "00112233-4455-4677-8899-aabbccddeeff",
      sequence: 0,
      last: true,
      payload: new Uint8Array([7, 8, 9]),
    });
    assert.equal(
      decodeSessionCtlChunk(new Uint8Array(28 + SESSION_CTL_CHUNK_PAYLOAD_BYTES + 1)),
      null,
    );
    const unknownFlags = frame.slice();
    new DataView(unknownFlags.buffer).setUint16(6, 2, true);
    assert.equal(decodeSessionCtlChunk(unknownFlags), null);

    assert.deepEqual(
      combineSessionCtlChunks(
        new Map([
          [0, new Uint8Array([1, 2])],
          [1, new Uint8Array([3])],
        ]),
        2,
        3,
      ),
      new Uint8Array([1, 2, 3]),
    );
    assert.equal(combineSessionCtlChunks(new Map(), 0, SESSION_CTL_MAX_REPLAY_BYTES + 1), null);
  });

  test("holds an ahead-of-arrival PTY anchor and slices a straddling chunk", () => {
    let anchor: number | null = 10;
    let result = slicePtyChunkAfterAnchor(new Uint8Array([1, 2, 3, 4]), 4, anchor);
    assert.equal(result.bytes, null);
    anchor = result.anchor;

    result = slicePtyChunkAfterAnchor(new Uint8Array([5, 6, 7, 8]), 8, anchor);
    assert.equal(result.bytes, null);
    anchor = result.anchor;

    result = slicePtyChunkAfterAnchor(new Uint8Array([9, 10, 11, 12]), 12, anchor);
    assert.deepEqual(result.bytes, new Uint8Array([11, 12]));
    assert.equal(result.anchor, null);
  });

  test("only assembles bounded replies for outstanding request IDs", () => {
    const tracker = new SessionCtlRequestTracker();
    const snapshotId = requestId(1);
    assert.equal(tracker.register(snapshotId, "snapshot"), true);
    assert.equal(tracker.register(snapshotId, "snapshot"), false);

    // An unsolicited response and a cross-operation response cannot allocate
    // chunks or consume the legitimate request.
    assert.equal(
      tracker.acceptResponse({
        version: 1,
        kind: "response",
        request_id: requestId(999),
        operation: "snapshot",
        ok: true,
        total_bytes: SESSION_CTL_MAX_REPLAY_BYTES,
        chunks: 256,
      }),
      null,
    );
    assert.equal(
      tracker.acceptResponse({
        version: 1,
        kind: "response",
        request_id: snapshotId,
        operation: "history",
        ok: true,
        total_bytes: 3,
        chunks: 1,
      }),
      null,
    );
    assert.equal(tracker.size, 1);

    assert.equal(
      tracker.acceptResponse({
        version: 1,
        kind: "response",
        request_id: snapshotId,
        operation: "snapshot",
        ok: true,
        plain: false,
        total_bytes: 3,
        chunks: 1,
      }),
      null,
    );
    // A non-final flag on the final chunk is rejected without completing.
    assert.equal(
      tracker.acceptChunk({
        requestId: snapshotId,
        sequence: 0,
        last: false,
        payload: new Uint8Array([1, 2, 3]),
      }),
      null,
    );
    assert.deepEqual(
      tracker.acceptChunk({
        requestId: snapshotId,
        sequence: 0,
        last: true,
        payload: new Uint8Array([1, 2, 3]),
      }),
      {
        kind: "replay",
        response: {
          version: 1,
          kind: "response",
          request_id: snapshotId,
          operation: "snapshot",
          ok: true,
          plain: false,
          total_bytes: 3,
          chunks: 1,
        },
        bytes: new Uint8Array([1, 2, 3]),
      },
    );
    assert.equal(tracker.size, 0);

    for (let index = 0; index < SESSION_CTL_MAX_OUTSTANDING_REQUESTS; index += 1) {
      assert.equal(tracker.register(requestId(index + 10), "redraw"), true);
    }
    assert.equal(tracker.register(requestId(10_000), "redraw"), false);
    assert.equal(tracker.size, SESSION_CTL_MAX_OUTSTANDING_REQUESTS);
  });

  test("preserves message order when an earlier asynchronous decode finishes late", async () => {
    const queue = new OrderedAsyncQueue();
    const delivered: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.enqueue(
      async () => {
        await firstReady;
        return "blob-first";
      },
      (value) => {
        delivered.push(value);
      },
    );
    const second = queue.enqueue(
      () => "array-buffer-second",
      (value) => {
        delivered.push(value);
      },
    );
    await Promise.resolve();
    assert.deepEqual(delivered, []);
    releaseFirst?.();
    await Promise.all([first, second]);
    assert.deepEqual(delivered, ["blob-first", "array-buffer-second"]);
  });

  test("never drains queued input into another session generation", () => {
    const queue = new SessionGenerationInputQueue(4);
    assert.equal(queue.enqueue(1, new Uint8Array([1, 2])), true);
    assert.equal(queue.enqueue(2, new Uint8Array([3, 4])), true);
    assert.equal(queue.enqueue(2, new Uint8Array([5])), false);
    assert.deepEqual(queue.drain(2), [new Uint8Array([3, 4])]);
    assert.deepEqual(queue.drain(1), []);
  });

  test("expires stale queued input and exposes a bounded queued count", () => {
    const queue = new SessionGenerationInputQueue(SESSION_PTY_INPUT_CHUNK_BYTES * 2);
    assert.equal(queue.enqueue(3, new Uint8Array([1]), 1_000), true);
    assert.equal(queue.enqueue(3, new Uint8Array([2, 3]), 25_000), true);
    assert.equal(queue.count(3), 2);
    assert.equal(queue.bytes(3), 3);
    queue.prune(3, 30_000, 32_000);
    assert.equal(queue.count(3), 1);
    assert.deepEqual(queue.drain(3, 30_000, 32_000), [new Uint8Array([2, 3])]);
  });

  test("chunks PTY input into ordered messages no larger than 16 KiB", () => {
    const bytes = new Uint8Array(SESSION_PTY_INPUT_CHUNK_BYTES * 2 + 7);
    bytes.forEach((_, index) => {
      bytes[index] = index % 251;
    });
    const chunks = sessionPtyInputChunks(bytes);
    assert.deepEqual(
      chunks.map((chunk) => chunk.byteLength),
      [SESSION_PTY_INPUT_CHUNK_BYTES, SESSION_PTY_INPUT_CHUNK_BYTES, 7],
    );
    assert.deepEqual(new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk))), bytes);
  });

  test("stops PTY sends at backpressure and returns the exact remainder after a throw", () => {
    const bytes = new Uint8Array(SESSION_PTY_INPUT_CHUNK_BYTES * 2 + 7);
    const sent: ArrayBuffer[] = [];
    const channel = {
      readyState: "open",
      bufferedAmount: 0,
      send(value: ArrayBuffer) {
        if (sent.length === 1) throw new TypeError("message rejected");
        sent.push(value);
      },
    } as unknown as RTCDataChannel;
    assert.equal(writeSessionPtyInput(channel, bytes), SESSION_PTY_INPUT_CHUNK_BYTES);
    assert.deepEqual(
      sent.map((value) => value.byteLength),
      [SESSION_PTY_INPUT_CHUNK_BYTES],
    );

    const blocked = {
      ...channel,
      bufferedAmount: 256 * 1024 + 1,
    } as RTCDataChannel;
    assert.equal(writeSessionPtyInput(blocked, bytes), 0);
  });

  test("accepts pty_gap only with a safe non-negative offset", () => {
    assert.deepEqual(
      parseSessionCtlText('{"version":1,"kind":"event","event":"pty_gap","offset":42}'),
      { version: 1, kind: "event", event: "pty_gap", offset: 42 },
    );
    assert.equal(
      parseSessionCtlText('{"version":1,"kind":"event","event":"pty_gap","offset":-1}'),
      null,
    );
  });
});
