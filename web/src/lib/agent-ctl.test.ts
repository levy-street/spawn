import assert from "node:assert/strict";
import {
  AGENT_CTL_CHUNK_PAYLOAD_BYTES,
  AGENT_CTL_MAX_REPLAY_BYTES,
  combineAgentCtlChunks,
  decodeAgentCtlChunk,
  makeAgentCtlRequest,
  parseAgentCtlText,
  slicePtyChunkAfterAnchor,
} from "./agent-ctl";

declare function describe(name: string, callback: () => void): void;
declare function test(name: string, callback: () => void): void;

describe("spawn.ctl browser protocol", () => {
  test("builds versioned requests and rejects oversized metadata", () => {
    const id = "00112233-4455-4677-8899-aabbccddeeff";
    assert.match(makeAgentCtlRequest(id, "resize", { cols: 120, rows: 32 }) ?? "", /"version":1/);
    assert.equal(makeAgentCtlRequest(id, "redraw", { padding: "x".repeat(20_000) }), null);
  });

  test("parses display events and rejects other protocol versions", () => {
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
});
