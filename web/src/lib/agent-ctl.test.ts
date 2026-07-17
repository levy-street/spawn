import assert from "node:assert/strict";
import {
  AGENT_CTL_CHUNK_PAYLOAD_BYTES,
  AGENT_CTL_MAX_OUTSTANDING_REQUESTS,
  AGENT_CTL_MAX_REPLAY_BYTES,
  AGENT_CTL_MAX_UPLOAD_BYTES,
  AGENT_CTL_UPLOAD_CHUNK_BYTES,
  AgentCtlRequestTracker,
  AgentGenerationInputQueue,
  combineAgentCtlChunks,
  decodeAgentCtlChunk,
  encodeAgentCtlUploadChunk,
  isAgentCtlRequestId,
  makeAgentCtlRequest,
  makeAgentCtlUploadCancel,
  makeAgentCtlUploadStart,
  OrderedAsyncQueue,
  parseAgentCtlText,
  parseAgentCtlUploadResponse,
  sha256Blob,
  slicePtyChunkAfterAnchor,
} from "./agent-ctl";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void | Promise<void>): void;

function requestId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

describe("spawn.ctl browser protocol", () => {
  test("builds versioned requests and rejects oversized metadata", () => {
    const id = "00112233-4455-4677-8899-aabbccddeeff";
    assert.match(makeAgentCtlRequest(id, "resize", { cols: 120, rows: 32 }) ?? "", /"version":1/);
    assert.deepEqual(
      JSON.parse(
        makeAgentCtlRequest(id, "redraw", {
          version: 99,
          kind: "event",
          request_id: requestId(999),
          operation: "snapshot",
        }) ?? "null",
      ),
      { version: 1, kind: "request", request_id: id, operation: "redraw" },
    );
    assert.equal(makeAgentCtlRequest(id, "redraw", { padding: "x".repeat(20_000) }), null);
    assert.equal(makeAgentCtlRequest("not-a-request-id", "redraw"), null);
    assert.equal(isAgentCtlRequestId(id), true);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.equal(makeAgentCtlRequest(id, "redraw", circular), null);
  });

  test("parses readiness and display events and rejects other protocol versions", () => {
    const capability = "00112233-4455-4677-8899-aabbccddeeff";
    assert.equal(parseAgentCtlText('{"version":1,"kind":"event","event":"ready"}'), null);
    assert.deepEqual(
      parseAgentCtlText(
        JSON.stringify({
          version: 1,
          kind: "event",
          event: "ready",
          upload_capability: capability,
          agent_generation: 7,
          upload_max_bytes: AGENT_CTL_MAX_UPLOAD_BYTES,
          upload_chunk_bytes: AGENT_CTL_UPLOAD_CHUNK_BYTES,
        }),
      ),
      {
        version: 1,
        kind: "event",
        event: "ready",
        upload_capability: capability,
        agent_generation: 7,
        upload_max_bytes: AGENT_CTL_MAX_UPLOAD_BYTES,
        upload_chunk_bytes: AGENT_CTL_UPLOAD_CHUNK_BYTES,
      },
    );
    assert.deepEqual(
      parseAgentCtlText(
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
    assert.equal(parseAgentCtlText('{"version":2,"kind":"response","ok":true}'), null);
  });

  test("frames bounded uploads and validates resumable direct responses", async () => {
    const capability = requestId(1);
    const uploadId = requestId(2);
    const bytes = new TextEncoder().encode("hello upload");
    const sha256 = await sha256Blob(new Blob([bytes]));
    assert.equal(sha256, "2d119f1cd272958a492a144af600b9dc36531f73027b34073967345b027021b1");
    const start = {
      capability,
      agentGeneration: 9,
      uploadId,
      name: "note.txt",
      mimeType: "text/plain",
      destination: "cwd" as const,
      totalBytes: bytes.length,
      chunks: 1,
      sha256: sha256 ?? "",
    };
    assert.deepEqual(JSON.parse(makeAgentCtlUploadStart(start) ?? "null"), {
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
    assert.equal(makeAgentCtlUploadStart({ ...start, name: "../escape" }), null);
    assert.equal(
      makeAgentCtlUploadStart({ ...start, totalBytes: AGENT_CTL_MAX_UPLOAD_BYTES + 1 }),
      null,
    );
    assert.equal(makeAgentCtlUploadCancel(requestId(3), uploadId, capability, 0), null);

    const frame = encodeAgentCtlUploadChunk(uploadId, 0, true, bytes);
    assert.ok(frame);
    assert.deepEqual(Array.from(frame.subarray(0, 8)), [0x53, 0x50, 0x43, 0x54, 1, 2, 1, 0]);
    assert.equal(new DataView(frame.buffer).getUint32(24, true), 0);
    assert.deepEqual(frame.subarray(28), bytes);

    assert.deepEqual(
      parseAgentCtlUploadResponse(
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
      parseAgentCtlUploadResponse(
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
      parseAgentCtlUploadResponse(
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
    assert.deepEqual(decodeAgentCtlChunk(frame), {
      requestId: "00112233-4455-4677-8899-aabbccddeeff",
      sequence: 0,
      last: true,
      payload: new Uint8Array([7, 8, 9]),
    });
    assert.equal(decodeAgentCtlChunk(new Uint8Array(28 + AGENT_CTL_CHUNK_PAYLOAD_BYTES + 1)), null);
    const unknownFlags = frame.slice();
    new DataView(unknownFlags.buffer).setUint16(6, 2, true);
    assert.equal(decodeAgentCtlChunk(unknownFlags), null);

    assert.deepEqual(
      combineAgentCtlChunks(
        new Map([
          [0, new Uint8Array([1, 2])],
          [1, new Uint8Array([3])],
        ]),
        2,
        3,
      ),
      new Uint8Array([1, 2, 3]),
    );
    assert.equal(combineAgentCtlChunks(new Map(), 0, AGENT_CTL_MAX_REPLAY_BYTES + 1), null);
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
    const tracker = new AgentCtlRequestTracker();
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
        total_bytes: AGENT_CTL_MAX_REPLAY_BYTES,
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

    for (let index = 0; index < AGENT_CTL_MAX_OUTSTANDING_REQUESTS; index += 1) {
      assert.equal(tracker.register(requestId(index + 10), "redraw"), true);
    }
    assert.equal(tracker.register(requestId(10_000), "redraw"), false);
    assert.equal(tracker.size, AGENT_CTL_MAX_OUTSTANDING_REQUESTS);
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

  test("never drains queued input into another agent generation", () => {
    const queue = new AgentGenerationInputQueue(4);
    assert.equal(queue.enqueue(1, new Uint8Array([1, 2])), true);
    assert.equal(queue.enqueue(2, new Uint8Array([3, 4])), true);
    assert.equal(queue.enqueue(2, new Uint8Array([5])), false);
    assert.deepEqual(queue.drain(2), [new Uint8Array([3, 4])]);
    assert.deepEqual(queue.drain(1), []);
  });
});
