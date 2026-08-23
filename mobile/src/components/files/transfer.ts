import { Sha256 } from "@/components/files/sha256";
import type {
  HostIncomingStreamFrame,
  HostReadDeclaration,
  HostUploadPhase,
  TransferProgress,
} from "@/components/files/types";

export const HOST_TRANSFER_CHUNK_BYTES = 8 * 1024;
export const HOST_TRANSFER_MAX_BYTES = 512 * 1024 * 1024;
export const HOST_TRANSFER_IN_FLIGHT_CHUNKS = 8;
export const HOST_TRANSFER_TIMEOUT_MS = 60_000;

export interface VerifiedFileSink {
  write(chunk: Uint8Array): Promise<void> | void;
  commit(): Promise<void> | void;
  remove(): Promise<void> | void;
}

export interface UploadSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface HostUploadPort {
  begin(input: {
    dir: string;
    name: string;
    length: number;
    sha256: string;
    overwrite: boolean;
  }): Promise<{ stream_id: string }>;
  sendChunk(streamId: string, sequence: number, bytes: Uint8Array): Promise<void>;
  /** Dispatches stream.end synchronously and resolves after definitive acknowledgement. */
  sendEnd(streamId: string, length: number, sha256: string): Promise<void>;
  cancel(streamId: string): void;
}

export class HostTransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HostTransferError";
  }
}

export function assertHostFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new HostTransferError("invalid_size", "File size is invalid.");
  }
  if (size > HOST_TRANSFER_MAX_BYTES) {
    throw new HostTransferError("file_too_large", "Host files cannot exceed 512 MiB.");
  }
}

function abortError(): HostTransferError {
  return new HostTransferError("cancelled", "Transfer cancelled.");
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal?.aborted) throw abortError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new HostTransferError("stream_timeout", "Transfer timed out.")),
      timeoutMs,
    );
  });
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    abortListener = () => reject(abortError());
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}

export async function receiveVerifiedHostFile(options: {
  declaration: HostReadDeclaration;
  frames: AsyncIterable<HostIncomingStreamFrame>;
  sink: VerifiedFileSink;
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (received: number, total: number) => void;
  onCancel?: (streamId: string) => void;
}): Promise<void> {
  const { declaration, frames, sink, signal, onProgress, onCancel } = options;
  assertHostFileSize(declaration.length);
  if (!/^[0-9a-f]{64}$/.test(declaration.sha256)) {
    throw new HostTransferError("invalid_response", "Host returned an invalid digest.");
  }
  const iterator = frames[Symbol.asyncIterator]();
  const hash = new Sha256();
  let received = 0;
  let sequence = 0;
  try {
    for (;;) {
      const result = await nextWithTimeout(
        iterator,
        options.timeoutMs ?? HOST_TRANSFER_TIMEOUT_MS,
        signal,
      );
      if (result.done) throw new HostTransferError("stream_ended", "Transfer ended early.");
      const frame = result.value;
      if (frame.stream_id !== declaration.stream_id) {
        throw new HostTransferError("invalid_stream", "Host sent bytes for the wrong stream.");
      }
      if (frame.type === "stream.error") {
        throw new HostTransferError(frame.code, frame.detail ?? "Host transfer failed.");
      }
      if (frame.type === "stream.chunk") {
        if (
          frame.sequence !== sequence ||
          frame.bytes.byteLength === 0 ||
          frame.bytes.byteLength > HOST_TRANSFER_CHUNK_BYTES
        ) {
          throw new HostTransferError("invalid_chunk", "Host sent an invalid transfer chunk.");
        }
        received += frame.bytes.byteLength;
        if (received > declaration.length) {
          throw new HostTransferError("length_mismatch", "Host sent more bytes than declared.");
        }
        hash.update(frame.bytes);
        await sink.write(frame.bytes);
        sequence += 1;
        onProgress?.(received, declaration.length);
        continue;
      }
      if (
        frame.length !== declaration.length ||
        frame.length !== received ||
        frame.sha256 !== declaration.sha256
      ) {
        throw new HostTransferError("length_mismatch", "Transfer length or digest changed.");
      }
      if (hash.digestHex() !== declaration.sha256) {
        throw new HostTransferError(
          "hash_mismatch",
          "Downloaded file failed integrity verification.",
        );
      }
      await sink.commit();
      return;
    }
  } catch (error) {
    // Stream cancellation must not wait on a producer that is itself stalled.
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
    await sink.remove();
    if (error instanceof HostTransferError && error.code === "cancelled") {
      onCancel?.(declaration.stream_id);
    }
    throw error;
  }
}

export async function hashUploadSource(
  source: UploadSource,
  signal?: AbortSignal,
  onProgress?: (read: number, total: number) => void,
): Promise<string> {
  assertHostFileSize(source.size);
  const hash = new Sha256();
  for (let offset = 0; offset < source.size; offset += HOST_TRANSFER_CHUNK_BYTES) {
    if (signal?.aborted) throw abortError();
    const expected = Math.min(HOST_TRANSFER_CHUNK_BYTES, source.size - offset);
    const chunk = await source.read(offset, expected);
    if (chunk.byteLength !== expected) {
      throw new HostTransferError("local_file_changed", "The selected file changed while reading.");
    }
    hash.update(chunk);
    onProgress?.(offset + chunk.byteLength, source.size);
  }
  return hash.digestHex();
}

export async function uploadHostFile(options: {
  port: HostUploadPort;
  source: UploadSource;
  dir: string;
  name: string;
  overwrite?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}): Promise<{ sha256: string }> {
  const { port, source, signal, onProgress } = options;
  const emit = (phase: HostUploadPhase, transferred: number) =>
    onProgress?.({ phase, transferred, total: source.size });
  emit("hashing", 0);
  const digest = await hashUploadSource(source, signal, (read) => emit("hashing", read));
  if (signal?.aborted) throw abortError();
  emit("declaring", 0);
  const declaration = await port.begin({
    dir: options.dir,
    name: options.name,
    length: source.size,
    sha256: digest,
    overwrite: options.overwrite ?? false,
  });
  let finalDispatched = false;
  try {
    let sequence = 0;
    for (let offset = 0; offset < source.size; offset += HOST_TRANSFER_CHUNK_BYTES) {
      if (signal?.aborted) throw abortError();
      const expected = Math.min(HOST_TRANSFER_CHUNK_BYTES, source.size - offset);
      const chunk = await source.read(offset, expected);
      if (chunk.byteLength !== expected) {
        throw new HostTransferError(
          "local_file_changed",
          "The selected file changed while reading.",
        );
      }
      await port.sendChunk(declaration.stream_id, sequence, chunk);
      sequence += 1;
      emit("streaming", offset + chunk.byteLength);
    }
    emit("finalizing", source.size);
    const acknowledgement = port.sendEnd(declaration.stream_id, source.size, digest);
    finalDispatched = true;
    emit("outcome_unknown", source.size);
    await acknowledgement;
    emit("complete", source.size);
    return { sha256: digest };
  } catch (error) {
    if (!finalDispatched) port.cancel(declaration.stream_id);
    emit(
      finalDispatched
        ? "outcome_unknown"
        : error instanceof HostTransferError && error.code === "cancelled"
          ? "cancelled"
          : "failed",
      0,
    );
    throw error;
  }
}
