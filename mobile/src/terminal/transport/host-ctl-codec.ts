import { sha256 } from "@noble/hashes/sha2.js";
import { encodeHex } from "@/lib/crypto/bytes";
import { decodeBridgeBytes, encodeBridgeBytes } from "@/terminal/transport/bridge";
import type {
  HostCapabilities,
  HostControlLimits,
  HostFileSource,
  HostRequestOptions,
  HostWriteDeclaration,
  HostWriteOptions,
  HostWritePhase,
  HostWriteResult,
} from "@/terminal/transport/types";

export const HOST_CONTROL_PROTOCOL = "spawn.host.ctl" as const;
export const HOST_CONTROL_VERSION = 1 as const;
export const HOST_CONTROL_FRAME_BYTES = 16 * 1024;
export const HOST_STREAM_CHUNK_BYTES = 8 * 1024;
export const HOST_STREAM_WINDOW_CHUNKS = 8;
export const HOST_STREAM_HIGH_WATER_CHUNKS = 4;
export const HOST_STREAM_BUFFERED_HIGH_WATER = 256 * 1024;
export const HOST_STREAM_TIMEOUT_MS = 60_000;
export const HOST_FILE_MAX_BYTES = 512 * 1024 * 1024;
export const HOST_RANGE_MAX_BYTES = 16 * 1024 * 1024;
export const HOST_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
export const HOST_PREVIEW_PIXELS = [128, 256, 512, 1024] as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class HostControlTransportError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ?? code);
    this.name = "HostControlTransportError";
  }
}

interface HostRecord extends Record<string, unknown> {
  version?: unknown;
  type?: unknown;
  protocol?: unknown;
  stream_id?: unknown;
  sequence?: unknown;
  bytes_b64?: unknown;
  length?: unknown;
  sha256?: unknown;
  path?: unknown;
  name?: unknown;
  error?: unknown;
  capabilities?: unknown;
  limits?: unknown;
}

export interface HostReadDeclarationWire {
  readonly streamId: string;
  readonly path: string;
  readonly name: string;
  readonly length: number;
  readonly sha256: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export type HostStreamFrame =
  | {
      readonly type: "stream.chunk";
      readonly streamId: string;
      readonly sequence: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: "stream.end";
      readonly streamId: string;
      readonly length: number;
      readonly sha256: string;
    }
  | {
      readonly type: "stream.error";
      readonly streamId: string;
      readonly code: string;
      readonly detail?: string;
    }
  | { readonly type: "stream.committed"; readonly streamId: string; readonly path: string };

function record(value: unknown): HostRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as HostRecord)
    : null;
}

function boundedPositiveInt(value: unknown, fallback: number, ceiling: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? Math.min(value as number, ceiling)
    : fallback;
}

function optionalPositiveInt(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : null;
}

function parseLimits(value: unknown): HostControlLimits {
  const limits = record(value);
  const advertisedPixels = limits?.["preview_pixels"];
  const pixels = Array.isArray(advertisedPixels)
    ? HOST_PREVIEW_PIXELS.filter((pixel) => advertisedPixels.includes(pixel))
    : [...HOST_PREVIEW_PIXELS];
  return Object.freeze({
    frameBytes: boundedPositiveInt(
      limits?.["frame_bytes"],
      HOST_CONTROL_FRAME_BYTES,
      HOST_CONTROL_FRAME_BYTES,
    ),
    chunkBytes: boundedPositiveInt(
      limits?.["chunk_bytes"],
      HOST_STREAM_CHUNK_BYTES,
      HOST_STREAM_CHUNK_BYTES,
    ),
    fileBytes: boundedPositiveInt(limits?.["file_bytes"], HOST_FILE_MAX_BYTES, HOST_FILE_MAX_BYTES),
    rangeBytes: boundedPositiveInt(
      limits?.["range_bytes"],
      HOST_RANGE_MAX_BYTES,
      HOST_RANGE_MAX_BYTES,
    ),
    previewBytes: boundedPositiveInt(
      limits?.["preview_bytes"],
      HOST_PREVIEW_MAX_BYTES,
      HOST_PREVIEW_MAX_BYTES,
    ),
    previewPixels: Object.freeze(pixels),
    normalQueue: optionalPositiveInt(limits?.["normal_queue"]),
    fastQueue: optionalPositiveInt(limits?.["fast_queue"]),
  });
}

export function parseHostHello(value: unknown): HostCapabilities {
  const hello = record(value);
  if (
    !hello ||
    hello.version !== HOST_CONTROL_VERSION ||
    hello.type !== "hello" ||
    hello.protocol !== HOST_CONTROL_PROTOCOL
  ) {
    throw new HostControlTransportError("invalid_hello", "Host returned an invalid hello frame.");
  }
  const operations = Array.isArray(hello.capabilities)
    ? [...new Set(hello.capabilities.filter((item): item is string => typeof item === "string"))]
    : [];
  return Object.freeze({
    protocol: HOST_CONTROL_PROTOCOL,
    version: HOST_CONTROL_VERSION,
    operations: Object.freeze(operations),
    limits: parseLimits(hello.limits),
  });
}

export function assertHostFileSize(size: number, limit = HOST_FILE_MAX_BYTES): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new HostControlTransportError("invalid_size", "Host file size is invalid.");
  }
  if (size > Math.min(limit, HOST_FILE_MAX_BYTES)) {
    throw new HostControlTransportError("file_too_large", "Host files cannot exceed 512 MiB.");
  }
}

export function parseHostReadDeclaration(
  value: unknown,
  limit = HOST_FILE_MAX_BYTES,
): HostReadDeclarationWire {
  const declaration = record(value);
  if (
    !declaration ||
    typeof declaration.stream_id !== "string" ||
    declaration.stream_id.length === 0 ||
    typeof declaration.path !== "string" ||
    typeof declaration.name !== "string" ||
    !Number.isSafeInteger(declaration.length) ||
    (declaration.length as number) < 0 ||
    typeof declaration.sha256 !== "string" ||
    !SHA256_PATTERN.test(declaration.sha256)
  ) {
    throw new HostControlTransportError(
      "invalid_response",
      "Host returned an invalid stream declaration.",
    );
  }
  assertHostFileSize(declaration.length as number, limit);
  return {
    streamId: declaration.stream_id,
    path: declaration.path,
    name: declaration.name,
    length: declaration.length as number,
    sha256: declaration.sha256,
    raw: declaration,
  };
}

export function parseHostWriteStreamId(value: unknown): string {
  const declaration = record(value);
  if (!declaration || typeof declaration.stream_id !== "string" || !declaration.stream_id) {
    throw new HostControlTransportError(
      "invalid_response",
      "Host returned an invalid write stream.",
    );
  }
  return declaration.stream_id;
}

export function parseHostStreamFrame(value: unknown): HostStreamFrame {
  const frame = record(value);
  if (!frame || frame.version !== HOST_CONTROL_VERSION || typeof frame.stream_id !== "string") {
    throw new HostControlTransportError("invalid_stream", "Host returned an invalid stream frame.");
  }
  if (frame.type === "stream.chunk") {
    if (!Number.isSafeInteger(frame.sequence) || (frame.sequence as number) < 0) {
      throw new HostControlTransportError("invalid_chunk", "Host returned an invalid sequence.");
    }
    if (typeof frame.bytes_b64 !== "string") {
      throw new HostControlTransportError("invalid_chunk", "Host returned invalid chunk bytes.");
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBridgeBytes(frame.bytes_b64);
    } catch {
      throw new HostControlTransportError("invalid_chunk", "Host returned invalid chunk bytes.");
    }
    if (bytes.byteLength === 0 || bytes.byteLength > HOST_STREAM_CHUNK_BYTES) {
      throw new HostControlTransportError("invalid_chunk", "Host returned an invalid chunk size.");
    }
    return {
      type: frame.type,
      streamId: frame.stream_id,
      sequence: frame.sequence as number,
      bytes,
    };
  }
  if (frame.type === "stream.end") {
    if (
      !Number.isSafeInteger(frame.length) ||
      (frame.length as number) < 0 ||
      typeof frame.sha256 !== "string" ||
      !SHA256_PATTERN.test(frame.sha256)
    ) {
      throw new HostControlTransportError(
        "invalid_stream_end",
        "Host returned an invalid end frame.",
      );
    }
    return {
      type: frame.type,
      streamId: frame.stream_id,
      length: frame.length as number,
      sha256: frame.sha256,
    };
  }
  if (frame.type === "stream.committed") {
    if (typeof frame.path !== "string") {
      throw new HostControlTransportError(
        "invalid_commit",
        "Host returned an invalid commit frame.",
      );
    }
    return { type: frame.type, streamId: frame.stream_id, path: frame.path };
  }
  if (frame.type === "stream.error") {
    const error = record(frame.error);
    return {
      type: frame.type,
      streamId: frame.stream_id,
      code: typeof error?.["code"] === "string" ? error["code"] : "stream_failed",
      ...(typeof error?.["detail"] === "string" ? { detail: error["detail"] } : {}),
    };
  }
  throw new HostControlTransportError("invalid_stream", "Host returned an unknown stream frame.");
}

export function encodeHostChunk(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > HOST_STREAM_CHUNK_BYTES) {
    throw new HostControlTransportError("invalid_chunk", "Host stream chunks must be 1–8 KiB.");
  }
  return encodeBridgeBytes(bytes);
}

export function createHostHasher() {
  return sha256.create();
}

export async function hashHostFileSource(
  source: HostFileSource,
  signal?: AbortSignal,
  onProgress?: (read: number, total: number) => void,
): Promise<string> {
  assertHostFileSize(source.size);
  const hash = createHostHasher();
  for (let offset = 0; offset < source.size; offset += HOST_STREAM_CHUNK_BYTES) {
    if (signal?.aborted) {
      throw new HostControlTransportError("cancelled", "Host file transfer was cancelled.");
    }
    const expected = Math.min(HOST_STREAM_CHUNK_BYTES, source.size - offset);
    const chunk = await source.read(offset, expected);
    if (chunk.byteLength !== expected) {
      throw new HostControlTransportError(
        "local_file_changed",
        "The selected file changed while it was being read.",
      );
    }
    hash.update(chunk);
    onProgress?.(offset + chunk.byteLength, source.size);
  }
  return encodeHex(hash.digest());
}

interface IncomingStreamState {
  controller: ReadableStreamDefaultController<Uint8Array>;
  declaration: HostReadDeclarationWire;
  hash: ReturnType<typeof createHostHasher>;
  nextSequence: number;
  acknowledged: number;
  received: number;
  timer?: ReturnType<typeof setTimeout>;
  removeAbort?: () => void;
}

interface IncomingTombstone {
  declaration: HostReadDeclarationWire;
  hash: ReturnType<typeof createHostHasher>;
  nextSequence: number;
  maxSequenceExclusive: number;
  received: number;
  expiresAt: number;
}

interface OutgoingStreamState {
  resolve(path: string): void;
  reject(error: Error): void;
  failure: Promise<never>;
  commitDispatched: boolean;
  definitiveFailure: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export interface HostStreamPort {
  send(
    type: "ack" | "cancel" | "chunk" | "end",
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  fatal(error: HostControlTransportError): void;
  readonly timeoutMs: number;
}

const STREAM_TOMBSTONE_TTL_MS = 120_000;
const MAX_STREAM_TOMBSTONES = 256;

export class HostStreamRuntime {
  readonly #incoming = new Map<string, IncomingStreamState>();
  readonly #tombstones = new Map<string, IncomingTombstone>();
  readonly #outgoing = new Map<string, OutgoingStreamState>();

  constructor(private readonly port: HostStreamPort) {}

  beginIncoming(
    declaration: HostReadDeclarationWire,
    options: HostRequestOptions = {},
  ): ReadableStream<Uint8Array> {
    if (this.#incoming.has(declaration.streamId) || this.#tombstones.has(declaration.streamId)) {
      throw new HostControlTransportError("invalid_response", "Host reused a live stream ID.");
    }
    let incoming: IncomingStreamState | null = null;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          incoming = {
            controller,
            declaration,
            hash: createHostHasher(),
            nextSequence: 0,
            acknowledged: 0,
            received: 0,
          };
          this.#incoming.set(declaration.streamId, incoming);
          this.#resetIncomingTimeout(declaration.streamId, incoming);
        },
        pull: async () => {
          const current = this.#incoming.get(declaration.streamId);
          if (!current || current.acknowledged >= current.nextSequence) return;
          current.acknowledged += 1;
          await this.port.send("ack", {
            stream_id: declaration.streamId,
            sequence: current.acknowledged,
          });
        },
        cancel: () => this.#cancelIncoming(declaration.streamId),
      },
      { highWaterMark: HOST_STREAM_HIGH_WATER_CHUNKS },
    );
    const active = this.#incoming.get(declaration.streamId);
    if (!active) {
      throw new HostControlTransportError("stream_failed", "Could not initialize host stream.");
    }
    if (options.signal) {
      const onAbort = () => {
        const current = this.#incoming.get(declaration.streamId);
        if (!current) return;
        current.controller.error(
          new HostControlTransportError("cancelled", "Host file transfer was cancelled."),
        );
        this.#cancelIncoming(declaration.streamId);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      active.removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      if (options.signal.aborted) onAbort();
    }
    return stream;
  }

  async write(
    streamId: string,
    stream: ReadableStream<Uint8Array>,
    declaration: HostWriteDeclaration,
    options: HostWriteOptions = {},
  ): Promise<HostWriteResult> {
    if (this.#outgoing.has(streamId)) {
      throw new HostControlTransportError("invalid_response", "Host reused a live stream ID.");
    }
    const { outgoing, committed } = this.#createOutgoing(streamId);
    const reader = stream.getReader();
    const hash = createHostHasher();
    let sent = 0;
    let sequence = 0;
    const emit = (phase: HostWritePhase) =>
      options.onProgress?.({ phase, transferred: sent, total: declaration.length });
    const onAbort = () =>
      outgoing.reject(
        new HostControlTransportError("cancelled", "Host file transfer was cancelled."),
      );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const result = await Promise.race([reader.read(), outgoing.failure]);
        if (result.done) break;
        for (let offset = 0; offset < result.value.byteLength; offset += HOST_STREAM_CHUNK_BYTES) {
          const chunk = result.value.subarray(offset, offset + HOST_STREAM_CHUNK_BYTES);
          sent += chunk.byteLength;
          if (sent > declaration.length) {
            throw new HostControlTransportError(
              "length_mismatch",
              "Input exceeds declared length.",
            );
          }
          hash.update(chunk);
          await Promise.race([
            this.port.send("chunk", {
              stream_id: streamId,
              sequence,
              bytes_b64: encodeHostChunk(chunk),
            }),
            outgoing.failure,
          ]);
          sequence += 1;
          this.#resetOutgoingTimeout(streamId, outgoing);
          emit("streaming");
        }
      }
      if (sent !== declaration.length || encodeHex(hash.digest()) !== declaration.sha256) {
        throw new HostControlTransportError(
          "hash_mismatch",
          "Upload bytes do not match the declared length and digest.",
        );
      }
      emit("finalizing");
      const endAcknowledgement = this.port.send("end", {
        stream_id: streamId,
        length: declaration.length,
        sha256: declaration.sha256,
      });
      outgoing.commitDispatched = true;
      emit("outcome_unknown");
      await Promise.race([endAcknowledgement, outgoing.failure]);
      const path = await committed;
      emit("complete");
      return { path, length: declaration.length, sha256: declaration.sha256 };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Host write failed.");
      if (this.#outgoing.get(streamId) === outgoing) {
        this.#outgoing.delete(streamId);
        if (outgoing.timer) clearTimeout(outgoing.timer);
        void this.port.send("cancel", { stream_id: streamId }).catch(() => undefined);
      }
      void reader.cancel(failure).catch(() => undefined);
      const finalFailure =
        outgoing.commitDispatched && !outgoing.definitiveFailure
          ? new HostControlTransportError(
              "outcome_unknown",
              "The host write may have committed; reconcile before retrying.",
            )
          : failure;
      options.onProgress?.({
        phase:
          finalFailure instanceof HostControlTransportError && finalFailure.code === "cancelled"
            ? "cancelled"
            : outgoing.commitDispatched
              ? "outcome_unknown"
              : "failed",
        transferred: sent,
        total: declaration.length,
      });
      throw finalFailure;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
  }

  handle(value: unknown): void {
    let frame: HostStreamFrame;
    try {
      frame = parseHostStreamFrame(value);
    } catch (error) {
      this.port.fatal(
        error instanceof HostControlTransportError
          ? error
          : new HostControlTransportError("invalid_stream", "Host stream frame is invalid."),
      );
      return;
    }
    const outgoing = this.#outgoing.get(frame.streamId);
    if (outgoing && (frame.type === "stream.committed" || frame.type === "stream.error")) {
      this.#outgoing.delete(frame.streamId);
      if (outgoing.timer) clearTimeout(outgoing.timer);
      if (frame.type === "stream.committed") {
        if (!outgoing.commitDispatched) {
          this.port.fatal(
            new HostControlTransportError(
              "invalid_commit",
              "Host committed before final dispatch.",
            ),
          );
          return;
        }
        outgoing.resolve(frame.path);
      } else {
        outgoing.definitiveFailure = true;
        outgoing.reject(new HostControlTransportError(frame.code, frame.detail));
      }
      return;
    }
    const incoming = this.#incoming.get(frame.streamId);
    if (!incoming) {
      if (this.#acceptTombstone(frame)) return;
      this.port.fatal(
        new HostControlTransportError("invalid_stream", "Host sent a frame for an unknown stream."),
      );
      return;
    }
    if (frame.type === "stream.error") {
      this.#finishIncoming(frame.streamId, incoming);
      incoming.controller.error(new HostControlTransportError(frame.code, frame.detail));
      return;
    }
    if (frame.type !== "stream.chunk" && frame.type !== "stream.end") {
      this.port.fatal(
        new HostControlTransportError("invalid_stream", "Host sent an invalid incoming frame."),
      );
      return;
    }
    if (frame.type === "stream.chunk") {
      if (
        frame.sequence !== incoming.nextSequence ||
        incoming.received + frame.bytes.byteLength > incoming.declaration.length
      ) {
        this.port.fatal(
          new HostControlTransportError("invalid_chunk", "Host sent an invalid stream chunk."),
        );
        return;
      }
      incoming.nextSequence += 1;
      incoming.received += frame.bytes.byteLength;
      incoming.hash.update(frame.bytes);
      incoming.controller.enqueue(frame.bytes);
      this.#resetIncomingTimeout(frame.streamId, incoming);
      return;
    }
    this.#finishIncoming(frame.streamId, incoming);
    if (
      frame.length !== incoming.declaration.length ||
      incoming.received !== incoming.declaration.length ||
      frame.sha256 !== incoming.declaration.sha256 ||
      encodeHex(incoming.hash.digest()) !== incoming.declaration.sha256
    ) {
      incoming.controller.error(
        new HostControlTransportError(
          "hash_mismatch",
          "Downloaded file failed integrity verification.",
        ),
      );
    } else {
      incoming.controller.close();
    }
  }

  close(error: Error): void {
    for (const [streamId, incoming] of this.#incoming) {
      this.#finishIncoming(streamId, incoming);
      incoming.controller.error(error);
    }
    this.#tombstones.clear();
    for (const [streamId, outgoing] of this.#outgoing) {
      this.#outgoing.delete(streamId);
      if (outgoing.timer) clearTimeout(outgoing.timer);
      outgoing.reject(
        outgoing.commitDispatched
          ? new HostControlTransportError(
              "outcome_unknown",
              "The host write may have committed; reconcile before retrying.",
            )
          : error,
      );
    }
  }

  #createOutgoing(streamId: string): {
    outgoing: OutgoingStreamState;
    committed: Promise<string>;
  } {
    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => {
      rejectFailure = reject;
    });
    void failure.catch(() => undefined);
    let outgoing!: OutgoingStreamState;
    const committed = new Promise<string>((resolve, reject) => {
      outgoing = {
        resolve,
        reject: (error) => {
          rejectFailure(error);
          reject(error);
        },
        failure,
        commitDispatched: false,
        definitiveFailure: false,
      };
    });
    void committed.catch(() => undefined);
    this.#outgoing.set(streamId, outgoing);
    this.#resetOutgoingTimeout(streamId, outgoing);
    return { outgoing, committed };
  }

  #cancelIncoming(streamId: string): void {
    const incoming = this.#incoming.get(streamId);
    if (!incoming) return;
    this.#pruneTombstones();
    if (!this.#tombstones.has(streamId) && this.#tombstones.size >= MAX_STREAM_TOMBSTONES) {
      this.port.fatal(
        new HostControlTransportError("stream_limit", "Too many cancelled host streams."),
      );
      return;
    }
    this.#tombstones.set(streamId, {
      declaration: incoming.declaration,
      hash: incoming.hash,
      nextSequence: incoming.nextSequence,
      maxSequenceExclusive: incoming.acknowledged + HOST_STREAM_WINDOW_CHUNKS,
      received: incoming.received,
      expiresAt: Date.now() + STREAM_TOMBSTONE_TTL_MS,
    });
    this.#finishIncoming(streamId, incoming);
    void this.port.send("cancel", { stream_id: streamId }).catch(() => undefined);
  }

  #acceptTombstone(frame: HostStreamFrame): boolean {
    this.#pruneTombstones();
    const tombstone = this.#tombstones.get(frame.streamId);
    if (!tombstone) return false;
    if (frame.type === "stream.error") {
      this.#tombstones.delete(frame.streamId);
      return true;
    }
    if (frame.type === "stream.chunk") {
      if (
        frame.sequence !== tombstone.nextSequence ||
        frame.sequence >= tombstone.maxSequenceExclusive ||
        tombstone.received + frame.bytes.byteLength > tombstone.declaration.length
      ) {
        return false;
      }
      tombstone.nextSequence += 1;
      tombstone.received += frame.bytes.byteLength;
      tombstone.hash.update(frame.bytes);
      return true;
    }
    if (frame.type === "stream.end") {
      this.#tombstones.delete(frame.streamId);
      return (
        frame.length === tombstone.declaration.length &&
        tombstone.received === tombstone.declaration.length &&
        frame.sha256 === tombstone.declaration.sha256 &&
        encodeHex(tombstone.hash.digest()) === tombstone.declaration.sha256
      );
    }
    return false;
  }

  #finishIncoming(streamId: string, incoming: IncomingStreamState): void {
    this.#incoming.delete(streamId);
    if (incoming.timer) clearTimeout(incoming.timer);
    incoming.removeAbort?.();
  }

  #resetIncomingTimeout(streamId: string, incoming: IncomingStreamState): void {
    if (incoming.timer) clearTimeout(incoming.timer);
    incoming.timer = setTimeout(() => {
      if (this.#incoming.get(streamId) !== incoming) return;
      incoming.controller.error(
        new HostControlTransportError("stream_timeout", "Host file read timed out."),
      );
      this.#cancelIncoming(streamId);
    }, this.port.timeoutMs);
  }

  #resetOutgoingTimeout(streamId: string, outgoing: OutgoingStreamState): void {
    if (outgoing.timer) clearTimeout(outgoing.timer);
    outgoing.timer = setTimeout(() => {
      if (this.#outgoing.get(streamId) !== outgoing) return;
      this.#outgoing.delete(streamId);
      void this.port.send("cancel", { stream_id: streamId }).catch(() => undefined);
      outgoing.reject(
        outgoing.commitDispatched
          ? new HostControlTransportError(
              "outcome_unknown",
              "The host write may have committed; reconcile before retrying.",
            )
          : new HostControlTransportError("stream_timeout", "Host file write timed out."),
      );
    }, this.port.timeoutMs);
  }

  #pruneTombstones(): void {
    const now = Date.now();
    for (const [streamId, tombstone] of this.#tombstones) {
      if (tombstone.expiresAt <= now) this.#tombstones.delete(streamId);
    }
  }
}

export async function collectHostStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
