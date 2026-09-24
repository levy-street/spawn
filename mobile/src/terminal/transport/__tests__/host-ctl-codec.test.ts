import {
  assertHostFileSize,
  encodeHostChunk,
  HOST_CONTROL_FRAME_BYTES,
  HOST_FILE_MAX_BYTES,
  HOST_STREAM_CHUNK_BYTES,
  hashHostFileSource,
  parseAgentTranscriptReport,
  parseHostHello,
  parseHostReadDeclaration,
  parseHostStreamFrame,
} from "@/terminal/transport/host-ctl-codec";

describe("host control codec", () => {
  test("decodes advertised operations and clamps limits to protocol ceilings", () => {
    const capabilities = parseHostHello({
      version: 1,
      type: "hello",
      protocol: "spawn.host.ctl",
      capabilities: ["fs.read", "fs.read", "fs.write.begin", 7],
      limits: {
        frame_bytes: HOST_CONTROL_FRAME_BYTES * 2,
        chunk_bytes: HOST_STREAM_CHUNK_BYTES * 2,
        file_bytes: HOST_FILE_MAX_BYTES * 2,
        range_bytes: 4_096,
        preview_pixels: [128, 512, 16_384],
        normal_queue: 64,
      },
    });
    expect(capabilities.operations).toEqual(["fs.read", "fs.write.begin"]);
    expect(capabilities.limits).toMatchObject({
      frameBytes: HOST_CONTROL_FRAME_BYTES,
      chunkBytes: HOST_STREAM_CHUNK_BYTES,
      fileBytes: HOST_FILE_MAX_BYTES,
      rangeBytes: 4_096,
      previewPixels: [128, 512],
      normalQueue: 64,
      fastQueue: null,
    });
  });

  test("uses safe protocol defaults when optional hello fields are absent", () => {
    const capabilities = parseHostHello({
      version: 1,
      type: "hello",
      protocol: "spawn.host.ctl",
    });
    expect(capabilities.operations).toEqual([]);
    expect(capabilities.limits.chunkBytes).toBe(HOST_STREAM_CHUNK_BYTES);
    expect(capabilities.limits.fileBytes).toBe(HOST_FILE_MAX_BYTES);
  });

  test("validates declaration sizes and exact stream chunk boundaries", () => {
    expect(() => assertHostFileSize(HOST_FILE_MAX_BYTES)).not.toThrow();
    expect(() => assertHostFileSize(HOST_FILE_MAX_BYTES + 1)).toThrow("512 MiB");
    expect(encodeHostChunk(new Uint8Array(HOST_STREAM_CHUNK_BYTES))).toHaveLength(10_924);
    expect(() => encodeHostChunk(new Uint8Array(HOST_STREAM_CHUNK_BYTES + 1))).toThrow("1–8 KiB");
    expect(() =>
      parseHostReadDeclaration({
        stream_id: "stream",
        path: "/tmp/file",
        name: "file",
        length: HOST_FILE_MAX_BYTES + 1,
        sha256: "0".repeat(64),
      }),
    ).toThrow("512 MiB");
  });

  test("rejects malformed and oversized incoming chunks", () => {
    expect(() =>
      parseHostStreamFrame({
        version: 1,
        type: "stream.chunk",
        stream_id: "stream",
        sequence: 0,
        bytes_b64: "not base64",
      }),
    ).toThrow("invalid chunk bytes");
    expect(() =>
      parseHostStreamFrame({
        version: 1,
        type: "stream.chunk",
        stream_id: "stream",
        sequence: 0,
        bytes_b64: encodeHostChunk(new Uint8Array(HOST_STREAM_CHUNK_BYTES)).concat("AA=="),
      }),
    ).toThrow();
  });

  test("hashes a repeatable source incrementally across the 8 KiB boundary", async () => {
    const bytes = Uint8Array.from({ length: HOST_STREAM_CHUNK_BYTES + 3 }, (_, index) => index);
    const reads: number[] = [];
    const digest = await hashHostFileSource(
      {
        size: bytes.length,
        read: async (offset, length) => bytes.slice(offset, offset + length),
      },
      undefined,
      (read) => reads.push(read),
    );
    expect(digest).toBe("aeb5000e5f0d5144ec958b073a61c0a829f85d1dc7f614f386920710fa48b447");
    expect(reads).toEqual([HOST_STREAM_CHUNK_BYTES, HOST_STREAM_CHUNK_BYTES + 3]);
  });
});

describe("agent transcript reports", () => {
  test("normalises a report and keeps only what the daemon vouched for", () => {
    const report = parseAgentTranscriptReport({
      agent_kind: "claude-code",
      supported: true,
      transcripts: [
        {
          path: "/home/me/.claude/projects/-home-me-proj/abc.jsonl",
          name: "abc.jsonl",
          size: 4096,
          modified_at: 1_700_000_000,
          role: "conversation",
          conversation_id: "abc",
        },
        { path: "/home/me/x/agent-1.jsonl", name: "agent-1.jsonl", size: 12, role: "subagent" },
      ],
      searched: ["/home/me/.claude/projects", 7],
      truncated: "yes",
    });
    expect(report.transcripts).toEqual([
      {
        path: "/home/me/.claude/projects/-home-me-proj/abc.jsonl",
        name: "abc.jsonl",
        size: 4096,
        modified_at: 1_700_000_000,
        role: "conversation",
        conversation_id: "abc",
      },
      {
        path: "/home/me/x/agent-1.jsonl",
        name: "agent-1.jsonl",
        size: 12,
        modified_at: null,
        role: "subagent",
        conversation_id: null,
      },
    ]);
    expect(report.searched).toEqual(["/home/me/.claude/projects"]);
    expect(report.truncated).toBe(false);
  });

  test("refuses a file with a role it does not know", () => {
    expect(() =>
      parseAgentTranscriptReport({
        agent_kind: "claude-code",
        supported: true,
        transcripts: [{ path: "/x", name: "x", size: 1, role: "whatever" }],
        searched: [],
        truncated: false,
      }),
    ).toThrow(/invalid transcript report/);
  });

  test("refuses a report missing its verdict", () => {
    expect(() => parseAgentTranscriptReport({ agent_kind: "codex", transcripts: [] })).toThrow(
      /invalid transcript report/,
    );
  });
});
