import { Sha256 } from "@/components/files/sha256";
import {
  HOST_TRANSFER_CHUNK_BYTES,
  HostTransferError,
  receiveVerifiedHostFile,
  type UploadSource,
  uploadHostFile,
  type VerifiedFileSink,
} from "@/components/files/transfer";
import type { HostIncomingStreamFrame, HostReadDeclaration } from "@/components/files/types";

const encoder = new TextEncoder();

function digest(bytes: Uint8Array): string {
  return new Sha256().update(bytes).digestHex();
}

function declaration(bytes: Uint8Array): HostReadDeclaration {
  return {
    stream_id: "stream",
    path: "/home/me/a",
    name: "a",
    length: bytes.length,
    sha256: digest(bytes),
  };
}

function sink(): VerifiedFileSink & { chunks: Uint8Array[]; committed: boolean; removed: boolean } {
  return {
    chunks: [],
    committed: false,
    removed: false,
    write(chunk) {
      this.chunks.push(chunk);
    },
    commit() {
      this.committed = true;
    },
    remove() {
      this.removed = true;
    },
  };
}

async function* frames(values: HostIncomingStreamFrame[]): AsyncGenerator<HostIncomingStreamFrame> {
  for (const value of values) yield value;
}

describe("host file transfers", () => {
  it("matches standard SHA-256 vectors across incremental boundaries", () => {
    expect(new Sha256().digestHex()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(new Sha256().update(encoder.encode("a")).update(encoder.encode("bc")).digestHex()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("verifies exact 8 KiB chunk sequencing, length, and SHA-256 before commit", async () => {
    const bytes = new Uint8Array(HOST_TRANSFER_CHUNK_BYTES + 3).fill(7);
    const meta = declaration(bytes);
    const output = sink();
    await receiveVerifiedHostFile({
      declaration: meta,
      frames: frames([
        {
          type: "stream.chunk",
          stream_id: "stream",
          sequence: 0,
          bytes: bytes.subarray(0, HOST_TRANSFER_CHUNK_BYTES),
        },
        {
          type: "stream.chunk",
          stream_id: "stream",
          sequence: 1,
          bytes: bytes.subarray(HOST_TRANSFER_CHUNK_BYTES),
        },
        { type: "stream.end", stream_id: "stream", length: bytes.length, sha256: meta.sha256 },
      ]),
      sink: output,
    });
    expect(output.chunks).toHaveLength(2);
    expect(output.committed).toBe(true);
    expect(output.removed).toBe(false);
  });

  it("deletes partial output on hash mismatch", async () => {
    const bytes = encoder.encode("hello");
    const meta = declaration(bytes);
    const output = sink();
    await expect(
      receiveVerifiedHostFile({
        declaration: meta,
        frames: frames([
          {
            type: "stream.chunk",
            stream_id: "stream",
            sequence: 0,
            bytes: encoder.encode("jello"),
          },
          { type: "stream.end", stream_id: "stream", length: bytes.length, sha256: meta.sha256 },
        ]),
        sink: output,
      }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
    expect(output.removed).toBe(true);
    expect(output.committed).toBe(false);
  });

  it("cancels the remote stream and removes partial output", async () => {
    const bytes = encoder.encode("hello");
    const controller = new AbortController();
    controller.abort();
    const output = sink();
    const cancel = jest.fn();
    await expect(
      receiveVerifiedHostFile({
        declaration: declaration(bytes),
        frames: frames([]),
        sink: output,
        signal: controller.signal,
        onCancel: cancel,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(cancel).toHaveBeenCalledWith("stream");
    expect(output.removed).toBe(true);
  });

  it("times out an inactive stream", async () => {
    const never = {
      async *[Symbol.asyncIterator](): AsyncGenerator<HostIncomingStreamFrame> {
        await new Promise(() => undefined);
      },
    };
    await expect(
      receiveVerifiedHostFile({
        declaration: declaration(new Uint8Array()),
        frames: never,
        sink: sink(),
        timeoutMs: 1,
      }),
    ).rejects.toMatchObject({ code: "stream_timeout" });
  });

  it("uploads in 8 KiB chunks and exposes the outcome-unknown boundary", async () => {
    const bytes = new Uint8Array(HOST_TRANSFER_CHUNK_BYTES + 1).fill(9);
    const source: UploadSource = {
      size: bytes.length,
      async read(offset, length) {
        return bytes.slice(offset, offset + length);
      },
    };
    const phases: string[] = [];
    const chunks: number[] = [];
    const port = {
      begin: jest.fn(async () => ({ stream_id: "upload" })),
      sendChunk: jest.fn(async (_id: string, _sequence: number, chunk: Uint8Array) => {
        chunks.push(chunk.length);
      }),
      sendEnd: jest.fn(async () => undefined),
      cancel: jest.fn(),
    };
    await uploadHostFile({
      port,
      source,
      dir: "/home/me",
      name: "a",
      onProgress: ({ phase }) => phases.push(phase),
    });
    expect(chunks).toEqual([HOST_TRANSFER_CHUNK_BYTES, 1]);
    expect(phases).toEqual(
      expect.arrayContaining([
        "hashing",
        "declaring",
        "streaming",
        "finalizing",
        "outcome_unknown",
        "complete",
      ]),
    );
    expect(port.cancel).not.toHaveBeenCalled();
  });

  it("does not retry after final dispatch loses acknowledgement", async () => {
    const source: UploadSource = {
      size: 1,
      async read() {
        return Uint8Array.of(1);
      },
    };
    const phases: string[] = [];
    const port = {
      begin: jest.fn(async () => ({ stream_id: "upload" })),
      sendChunk: jest.fn(async () => undefined),
      sendEnd: jest.fn(async () => {
        throw new HostTransferError("ack_lost", "lost");
      }),
      cancel: jest.fn(),
    };
    await expect(
      uploadHostFile({
        port,
        source,
        dir: "/home/me",
        name: "a",
        onProgress: ({ phase }) => phases.push(phase),
      }),
    ).rejects.toThrow("lost");
    expect(phases.at(-1)).toBe("outcome_unknown");
    expect(port.begin).toHaveBeenCalledTimes(1);
    expect(port.cancel).not.toHaveBeenCalled();
  });
});
