import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  chunkPtyInput,
  decodeSpctFrame,
  encodeSpctFrame,
  makeSessionCtlRequest,
  makeUploadStart,
  PTY_INPUT_CHUNK_BYTES,
  PTY_INPUT_MAX_BYTES,
  parseSessionCtlText,
  ReplayAssembler,
  SESSION_CTL_CHUNK_PAYLOAD_BYTES,
  slicePtyChunkAfterAnchor,
} from "@/terminal/transport/ctl-codec";

const REQUEST_ID = "00112233-4455-6677-8899-aabbccddeeff";

describe("SPCT codec", () => {
  test.each(["replay", "upload"] as const)(
    "encodes and decodes a %s frame field by field",
    (kind) => {
      const frame = encodeSpctFrame({
        kind,
        requestId: REQUEST_ID,
        sequence: 0x7856_3412,
        last: true,
        payload: new Uint8Array([0xde, 0xad]),
      });
      expect(frame).not.toBeNull();
      expect(Array.from(frame?.slice(0, 8) ?? [])).toEqual([
        0x53,
        0x50,
        0x43,
        0x54,
        1,
        kind === "replay" ? 1 : 2,
        1,
        0,
      ]);
      expect(Array.from(frame?.slice(8, 24) ?? [])).toEqual([
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee,
        0xff,
      ]);
      expect(Array.from(frame?.slice(24, 28) ?? [])).toEqual([0x12, 0x34, 0x56, 0x78]);
      expect(frame ? decodeSpctFrame(frame) : null).toEqual({
        kind,
        requestId: REQUEST_ID,
        sequence: 0x7856_3412,
        last: true,
        payload: new Uint8Array([0xde, 0xad]),
      });
    },
  );

  test("rejects malformed and out-of-bounds frames", () => {
    const valid = encodeSpctFrame({
      kind: "replay",
      requestId: REQUEST_ID,
      sequence: 0,
      last: false,
      payload: new Uint8Array([1]),
    });
    expect(valid).not.toBeNull();
    for (const [offset, value] of [
      [0, 0],
      [4, 2],
      [5, 3],
      [6, 2],
    ] as const) {
      const malformed = valid?.slice() ?? new Uint8Array();
      malformed[offset] = value;
      expect(decodeSpctFrame(malformed)).toBeNull();
    }
    expect(decodeSpctFrame(new Uint8Array(27))).toBeNull();
    expect(
      encodeSpctFrame({
        kind: "upload",
        requestId: REQUEST_ID,
        sequence: 0,
        last: false,
        payload: new Uint8Array(SESSION_CTL_CHUNK_PAYLOAD_BYTES + 1),
      }),
    ).toBeNull();
  });
});

describe("spawn.ctl JSON", () => {
  test("validates requests and their 16 KiB bound", () => {
    const request = makeSessionCtlRequest(REQUEST_ID, "history", { lines: 400, plain: false });
    expect(request ? JSON.parse(request) : null).toEqual({
      version: 1,
      kind: "request",
      request_id: REQUEST_ID,
      operation: "history",
      lines: 400,
      plain: false,
    });
    expect(makeSessionCtlRequest("invalid", "history")).toBeNull();
    expect(makeSessionCtlRequest(REQUEST_ID, "history", { value: "x".repeat(20_000) })).toBeNull();
  });

  test("validates ready, display, history and response messages", () => {
    expect(
      parseSessionCtlText(
        JSON.stringify({
          version: 1,
          kind: "event",
          event: "ready",
          upload_capability: REQUEST_ID,
          agent_generation: 7,
          upload_max_bytes: 20 * 1024 * 1024,
          upload_chunk_bytes: 48 * 1024,
        }),
      ),
    ).not.toBeNull();
    expect(
      parseSessionCtlText(
        JSON.stringify({
          version: 1,
          kind: "event",
          event: "display_state",
          owner: true,
          cols: 80,
          rows: 24,
          viewers: 1,
        }),
      ),
    ).not.toBeNull();
    expect(
      parseSessionCtlText(
        JSON.stringify({
          version: 1,
          kind: "event",
          event: "history_delta",
          history_epoch: "18446744073709551615",
          history_offset: 0,
          data: "AA==",
        }),
      ),
    ).not.toBeNull();
    expect(
      parseSessionCtlText(JSON.stringify({ version: 2, kind: "response", ok: true })),
    ).toBeNull();
    expect(parseSessionCtlText("not-json")).toBeNull();
  });

  test("validates upload manifests", () => {
    const base = {
      capability: REQUEST_ID,
      uploadId: REQUEST_ID,
      sessionGeneration: 7,
      name: "notes.txt",
      mimeType: "text/plain",
      destination: "cwd" as const,
      totalBytes: 49_153,
      chunks: 2,
      sha256: "a".repeat(64),
    };
    expect(makeUploadStart(base)).not.toBeNull();
    expect(makeUploadStart({ ...base, name: "../notes.txt" })).toBeNull();
    expect(makeUploadStart({ ...base, mimeType: "text/plain; charset=utf-8" })).toBeNull();
    expect(makeUploadStart({ ...base, totalBytes: 0, chunks: 0 })).toBeNull();
    expect(makeUploadStart({ ...base, chunks: 1 })).toBeNull();
  });
});

describe("PTY chunking and replay merge", () => {
  test("splits every input frame at 16 KiB while retaining the 64 KiB pending cap", () => {
    const bytes = new Uint8Array(PTY_INPUT_MAX_BYTES * 2 + 1);
    const chunks = chunkPtyInput(bytes);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([
      ...Array(8).fill(PTY_INPUT_CHUNK_BYTES),
      1,
    ]);
  });

  test("merges live output by explicit pty_offset", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(slicePtyChunkAfterAnchor(bytes, 8, 8)).toEqual({ bytes: null, anchor: null });
    expect(slicePtyChunkAfterAnchor(bytes, 10, 8)).toEqual({
      bytes: new Uint8Array([3, 4]),
      anchor: null,
    });
    expect(slicePtyChunkAfterAnchor(bytes, 12, 8)).toEqual({ bytes, anchor: null });
    expect(slicePtyChunkAfterAnchor(bytes, 6, 8)).toEqual({ bytes: null, anchor: 8 });
  });

  test("assembles replay chunks by sequence even when arrival is out of order", () => {
    const total = SESSION_CTL_CHUNK_PAYLOAD_BYTES + 2;
    const response = {
      version: 1 as const,
      kind: "response" as const,
      request_id: REQUEST_ID,
      operation: "history" as const,
      ok: true,
      total_bytes: total,
      chunks: 2,
      pty_offset: 9,
      plain: false,
    };
    const assembler = new ReplayAssembler(response);
    expect(
      assembler.accept({
        kind: "replay",
        requestId: REQUEST_ID,
        sequence: 1,
        last: true,
        payload: new Uint8Array([2, 3]),
      }),
    ).toEqual({ kind: "pending" });
    const result = assembler.accept({
      kind: "replay",
      requestId: REQUEST_ID,
      sequence: 0,
      last: false,
      payload: new Uint8Array(SESSION_CTL_CHUNK_PAYLOAD_BYTES).fill(1),
    });
    expect(result.kind).toBe("complete");
    if (result.kind === "complete") {
      expect(result.bytes.byteLength).toBe(total);
      expect(Array.from(result.bytes.slice(-2))).toEqual([2, 3]);
    }
  });
});

describe("replay framing vector", () => {
  const vectors = JSON.parse(
    readFileSync(
      resolve(__dirname, "../../../../../proto/session-ctl-replay-framing-v1-vectors.json"),
      "utf8",
    ),
  ) as {
    daemon_chunk_payload_bytes: number;
    cases: Array<{ name: string; total_bytes: number; chunks: number; last_chunk_bytes: number }>;
    rejected_headers: Array<{ name: string; total_bytes: number; chunks: number }>;
    rejected_on_first_chunk: Array<{
      name: string;
      total_bytes: number;
      chunks: number;
      first_chunk_bytes: number;
    }>;
  };
  const header = (totalBytes: number, chunks: number) => ({
    version: 1 as const,
    kind: "response" as const,
    request_id: REQUEST_ID,
    operation: "history" as const,
    ok: true,
    total_bytes: totalBytes,
    chunks,
    pty_offset: 0,
    plain: false,
  });

  test("assembles every case framed the daemon's way", () => {
    const payloadBytes = vectors.daemon_chunk_payload_bytes;
    expect(payloadBytes).toBe(16 * 1024 - 28);
    for (const c of vectors.cases) {
      if (c.chunks === 0) continue;
      const assembler = new ReplayAssembler(header(c.total_bytes, c.chunks));
      let result: ReturnType<ReplayAssembler["accept"]> = { kind: "pending" };
      for (let sequence = 0; sequence < c.chunks; sequence += 1) {
        const last = sequence + 1 === c.chunks;
        result = assembler.accept({
          kind: "replay",
          requestId: REQUEST_ID,
          sequence,
          last,
          payload: new Uint8Array(last ? c.last_chunk_bytes : payloadBytes).fill(sequence & 0xff),
        });
        if (!last) expect(result).toEqual({ kind: "pending" });
      }
      expect(result.kind).toBe("complete");
      if (result.kind === "complete") expect(result.bytes.byteLength).toBe(c.total_bytes);
    }
  });

  test("rejects headers and first chunks no daemon framing can explain", () => {
    for (const r of vectors.rejected_headers) {
      if (r.chunks === 0) continue;
      const assembler = new ReplayAssembler(header(r.total_bytes, r.chunks));
      const result = assembler.accept({
        kind: "replay",
        requestId: REQUEST_ID,
        sequence: 0,
        last: r.chunks === 1,
        payload: new Uint8Array(1),
      });
      expect(result.kind).toBe("invalid");
    }
    for (const r of vectors.rejected_on_first_chunk) {
      const assembler = new ReplayAssembler(header(r.total_bytes, r.chunks));
      const result = assembler.accept({
        kind: "replay",
        requestId: REQUEST_ID,
        sequence: 0,
        last: r.chunks === 1,
        payload: new Uint8Array(r.first_chunk_bytes),
      });
      expect(result.kind).toBe("invalid");
    }
  });
});
