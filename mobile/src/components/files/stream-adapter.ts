import type { HostReadDeclaration } from "@/components/files/types";
import type { HostTransport } from "@/terminal/transport/types";

export interface HostReadableFile {
  streamId: string;
  path: string;
  name: string;
  length: number;
  sha256: string;
  stream: ReadableStream<Uint8Array>;
}

export interface HostReadHead {
  bytes: Uint8Array;
  total: number;
  truncated: boolean;
}

export interface HostPreviewFile extends HostReadableFile {
  mime: string;
  width: number;
  height: number;
}

export interface HostFileStreamTransport extends HostTransport {
  readFile(path: string, options?: { signal?: AbortSignal }): Promise<HostReadableFile>;
  readHead(
    path: string,
    limit: number,
    options?: { signal?: AbortSignal; size?: number | null },
  ): Promise<HostReadHead>;
  previewImage(
    path: string,
    maxPixels: 128 | 256 | 512 | 1024,
    options?: { signal?: AbortSignal },
  ): Promise<HostPreviewFile>;
}

export function hasHostFileStreams(
  transport: HostTransport | null,
): transport is HostFileStreamTransport {
  if (!transport) return false;
  const candidate = transport as Partial<HostFileStreamTransport>;
  return (
    typeof candidate.readFile === "function" &&
    typeof candidate.readHead === "function" &&
    typeof candidate.previewImage === "function"
  );
}

export function readDeclaration(read: HostReadableFile): HostReadDeclaration {
  return {
    stream_id: read.streamId,
    path: read.path,
    name: read.name,
    length: read.length,
    sha256: read.sha256,
  };
}

type ReadableFrame =
  | { type: "stream.chunk"; stream_id: string; sequence: number; bytes: Uint8Array }
  | { type: "stream.end"; stream_id: string; length: number; sha256: string };

export function readableStreamFrames(read: HostReadableFile): AsyncIterable<ReadableFrame> {
  const reader = read.stream.getReader();
  let sequence = 0;
  let ended = false;
  let released = false;
  const release = () => {
    if (released) return;
    reader.releaseLock();
    released = true;
  };
  return {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<ReadableFrame>> {
          if (ended) return { done: true, value: undefined };
          const result = await reader.read();
          if (!result.done) {
            const frame: ReadableFrame = {
              type: "stream.chunk",
              stream_id: read.streamId,
              sequence,
              bytes: result.value,
            };
            sequence += 1;
            return { done: false, value: frame };
          }
          ended = true;
          release();
          return {
            done: false,
            value: {
              type: "stream.end",
              stream_id: read.streamId,
              length: read.length,
              sha256: read.sha256,
            },
          };
        },
        async return(): Promise<IteratorResult<ReadableFrame>> {
          ended = true;
          if (!released) await reader.cancel("Host file transfer cancelled.");
          release();
          return { done: true, value: undefined };
        },
      };
    },
  };
}
