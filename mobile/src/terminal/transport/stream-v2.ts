import { encodeBridgeBytes } from "@/terminal/transport/bridge";
import type { HostStreamFrame } from "@/terminal/transport/host-ctl-codec";
import { HostControlTransportError } from "@/terminal/transport/host-ctl-error";

/**
 * Stream v2 on a host-control channel (proto/README.md, "Stream v2"): what a
 * device moves a conversation with, reading the bundle out of one host
 * (`conv.export`) and writing it into another (`conv.import.begin`).
 *
 * Chunks are numbered from the transfer's first byte, so a stream resumed on
 * a fresh channel carries on from `next_sequence` with the same numbers. The
 * window bounds what a receiver holds unacknowledged, and acknowledgements
 * run both ways: the device acknowledges a read as it hands chunks on, and
 * the daemon acknowledges a write once it has staged the chunks. The device
 * never sends a write chunk past the window the target granted. Bulk pacing —
 * one gate per connection over the bulk channels' buffered bytes — is the
 * worker's (`worker-host-consumers.js`).
 */

const CHUNK_BYTES = 8 * 1024;
const TOMBSTONE_TTL_MS = 120_000;
const MAX_TOMBSTONES = 64;

export interface StreamV2Port {
  send(
    type: "ack" | "cancel" | "chunk" | "end",
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void>;
  fatal(error: HostControlTransportError): void;
  settled?(): void;
  readonly timeoutMs: number;
}

export interface StreamV2ReadDeclaration {
  readonly length: number;
  /** The first chunk this stream carries (`from_sequence` on a resume). */
  readonly nextSequence: number;
  readonly window: number;
}

export type StreamV2ReadItem =
  | { readonly kind: "chunk"; readonly sequence: number; readonly bytes: Uint8Array }
  | { readonly kind: "end"; readonly length: number; readonly sha256: string };

export interface StreamV2Reader {
  readonly streamId: string;
  /** The next chunk, or the end with the stream's digest. */
  next(): Promise<StreamV2ReadItem>;
  /** Every chunk below `sequence` has been handed on (cumulative). */
  acknowledge(sequence: number): void;
  /** Ends the stream, not its transfer: a resumed export carries on. */
  cancel(): void;
}

export interface StreamV2WriteDeclaration {
  readonly window: number;
  readonly nextSequence: number;
}

export interface StreamV2Committed {
  readonly length: number | null;
  readonly sha256: string | null;
  readonly result: unknown;
}

export interface StreamV2Writer {
  readonly streamId: string;
  /** The next chunk the receiver expects: it holds every one below. */
  readonly acknowledged: number;
  /** Sends chunk `sequence` once the window allows it; in order only. */
  write(sequence: number, bytes: Uint8Array): Promise<void>;
  /** Sends the end with the digest the source declared, and waits for the
   *  commit. A commit that does not answer is `outcome_unknown`: the
   *  transfer's status says what happened. */
  end(length: number, sha256: string): Promise<StreamV2Committed>;
  /** Ends the stream, not its transfer: the staged bytes stay. */
  cancel(): void;
}

interface Waiter<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

interface ReadState {
  readonly length: number;
  readonly window: number;
  readonly chunkCount: number;
  expected: number;
  acknowledged: number;
  readonly queue: StreamV2ReadItem[];
  waiter: Waiter<StreamV2ReadItem> | null;
  failure: Error | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface WriteState {
  readonly window: number;
  acknowledged: number;
  sent: number;
  readonly ackWaiters: Set<() => void>;
  endDispatched: boolean;
  committed: Waiter<StreamV2Committed> | null;
  failure: Error | null;
  timer: ReturnType<typeof setTimeout> | null;
}

function chunkCount(length: number): number {
  return Math.ceil(length / CHUNK_BYTES);
}

function streamError(frame: Extract<HostStreamFrame, { type: "stream.error" }>): Error {
  return new HostControlTransportError(frame.code, frame.detail);
}

export class StreamV2Runtime {
  readonly #reads = new Map<string, ReadState>();
  readonly #writes = new Map<string, WriteState>();
  /** Streams this device ended whose late frames are still on their way. */
  readonly #tombstones = new Map<string, number>();
  /** Requests that open a v2 stream and have not registered it yet. */
  #opening = 0;
  /** Frames that reached this runtime before their stream's declaration
   *  was processed — the daemon sends the first chunk right behind it. */
  readonly #early: HostStreamFrame[] = [];

  constructor(private readonly port: StreamV2Port) {}

  get active(): number {
    return this.#reads.size + this.#writes.size;
  }

  /** A request that opens a v2 stream is on its way; its frames may come
   *  before its answer is processed. Pair with `openingSettled`. */
  opening(): void {
    this.#opening += 1;
  }

  openingSettled(): void {
    this.#opening = Math.max(0, this.#opening - 1);
    if (this.#opening === 0) this.#early.length = 0;
  }

  #replayEarly(streamId: string): void {
    const frames = this.#early.filter((frame) => frame.streamId === streamId);
    if (frames.length === 0) return;
    for (let index = this.#early.length - 1; index >= 0; index -= 1) {
      if (this.#early[index]?.streamId === streamId) this.#early.splice(index, 1);
    }
    for (const frame of frames) this.handle(frame);
  }

  beginRead(streamId: string, declaration: StreamV2ReadDeclaration): StreamV2Reader {
    this.#refuseReuse(streamId);
    const count = chunkCount(declaration.length);
    if (declaration.nextSequence > count || declaration.window < 1) {
      throw new HostControlTransportError("invalid_response", "Host declared an invalid stream.");
    }
    const state: ReadState = {
      length: declaration.length,
      window: declaration.window,
      chunkCount: count,
      expected: declaration.nextSequence,
      acknowledged: declaration.nextSequence,
      queue: [],
      waiter: null,
      failure: null,
      timer: null,
    };
    this.#reads.set(streamId, state);
    queueMicrotask(() => this.#replayEarly(streamId));
    return {
      streamId,
      next: () => this.#next(streamId, state),
      acknowledge: (sequence) => this.#acknowledge(streamId, state, sequence),
      cancel: () => this.#cancelRead(streamId, state),
    };
  }

  beginWrite(streamId: string, declaration: StreamV2WriteDeclaration): StreamV2Writer {
    this.#refuseReuse(streamId);
    if (declaration.window < 1) {
      throw new HostControlTransportError("invalid_response", "Host granted an invalid window.");
    }
    const state: WriteState = {
      window: declaration.window,
      acknowledged: declaration.nextSequence,
      sent: declaration.nextSequence,
      ackWaiters: new Set(),
      endDispatched: false,
      committed: null,
      failure: null,
      timer: null,
    };
    this.#writes.set(streamId, state);
    queueMicrotask(() => this.#replayEarly(streamId));
    return {
      streamId,
      get acknowledged() {
        return state.acknowledged;
      },
      write: (sequence, bytes) => this.#write(streamId, state, sequence, bytes),
      end: (length, sha256) => this.#end(streamId, state, length, sha256),
      cancel: () => this.#cancelWrite(streamId, state),
    };
  }

  /** True when the frame belongs to a v2 stream (handled or knowingly dropped). */
  handle(frame: HostStreamFrame): boolean {
    const read = this.#reads.get(frame.streamId);
    if (read) {
      this.#handleRead(frame.streamId, read, frame);
      return true;
    }
    const write = this.#writes.get(frame.streamId);
    if (write) {
      this.#handleWrite(frame.streamId, write, frame);
      return true;
    }
    this.#prune();
    if (this.#tombstones.has(frame.streamId)) {
      if (frame.type === "stream.error" || frame.type === "stream.end") {
        this.#tombstones.delete(frame.streamId);
      }
      return true;
    }
    // At most a window and an end ahead of the answer that declares them.
    if (this.#opening > 0 && this.#early.length < 2 * 16 + 2) {
      this.#early.push(frame);
      return true;
    }
    return false;
  }

  close(error: Error): void {
    for (const [streamId, read] of [...this.#reads]) this.#failRead(streamId, read, error);
    for (const [streamId, write] of [...this.#writes]) {
      this.#failWrite(
        streamId,
        write,
        write.endDispatched
          ? new HostControlTransportError(
              "outcome_unknown",
              "The import may have committed; ask the target before going on.",
            )
          : error,
      );
    }
    this.#tombstones.clear();
  }

  #refuseReuse(streamId: string): void {
    this.#prune();
    if (this.#reads.has(streamId) || this.#writes.has(streamId) || this.#tombstones.has(streamId)) {
      throw new HostControlTransportError("invalid_response", "Host reused a live stream ID.");
    }
  }

  // ---- reads -------------------------------------------------------------

  #handleRead(streamId: string, read: ReadState, frame: HostStreamFrame): void {
    if (frame.type === "stream.error") {
      this.#failRead(streamId, read, streamError(frame));
      return;
    }
    if (frame.type === "stream.chunk") {
      const offset = frame.sequence * CHUNK_BYTES;
      const size = Math.min(CHUNK_BYTES, read.length - offset);
      if (
        frame.sequence !== read.expected ||
        size <= 0 ||
        frame.bytes.byteLength !== size ||
        // The host may have no more than the window unacknowledged.
        frame.sequence >= read.acknowledged + read.window
      ) {
        this.port.fatal(
          new HostControlTransportError("invalid_chunk", "Host sent an invalid stream chunk."),
        );
        return;
      }
      read.expected += 1;
      this.#deliver(read, { kind: "chunk", sequence: frame.sequence, bytes: frame.bytes });
      return;
    }
    if (frame.type === "stream.end") {
      if (frame.length !== read.length || read.expected !== read.chunkCount) {
        this.port.fatal(
          new HostControlTransportError("invalid_stream_end", "Host ended a stream early."),
        );
        return;
      }
      this.#deliver(read, { kind: "end", length: frame.length, sha256: frame.sha256 });
      return;
    }
    this.port.fatal(
      new HostControlTransportError("invalid_stream", "Host sent an invalid frame for a read."),
    );
  }

  #deliver(read: ReadState, item: StreamV2ReadItem): void {
    const waiter = read.waiter;
    if (waiter) {
      read.waiter = null;
      this.#clearReadTimer(read);
      waiter.resolve(item);
      return;
    }
    read.queue.push(item);
  }

  #next(streamId: string, read: ReadState): Promise<StreamV2ReadItem> {
    const queued = read.queue.shift();
    if (queued) {
      if (queued.kind === "end") this.#finishRead(streamId, read);
      return Promise.resolve(queued);
    }
    if (read.failure) return Promise.reject(read.failure);
    if (read.waiter) {
      return Promise.reject(
        new HostControlTransportError("invalid_state", "A read is already waiting."),
      );
    }
    return new Promise<StreamV2ReadItem>((resolve, reject) => {
      read.waiter = {
        resolve: (item) => {
          if (item.kind === "end") this.#finishRead(streamId, read);
          resolve(item);
        },
        reject,
      };
      // Only a reader waiting on the host times out: one that holds chunks
      // back while the target catches up is not stalled.
      read.timer = setTimeout(() => {
        read.timer = null;
        if (this.#reads.get(streamId) !== read) return;
        this.#failRead(
          streamId,
          read,
          new HostControlTransportError("stream_timeout", "The host stopped sending."),
        );
        this.#tombstone(streamId);
        void this.port.send("cancel", { stream_id: streamId }).catch(() => undefined);
      }, this.port.timeoutMs);
    });
  }

  #acknowledge(streamId: string, read: ReadState, sequence: number): void {
    if (this.#reads.get(streamId) !== read) return;
    if (sequence <= read.acknowledged || sequence > read.expected) return;
    read.acknowledged = sequence;
    void this.port.send("ack", { stream_id: streamId, sequence }).catch(() => undefined);
  }

  #cancelRead(streamId: string, read: ReadState): void {
    if (this.#reads.get(streamId) !== read) return;
    this.#failRead(
      streamId,
      read,
      new HostControlTransportError("cancelled", "The conversation read was cancelled."),
    );
    this.#tombstone(streamId);
    void this.port.send("cancel", { stream_id: streamId }).catch(() => undefined);
  }

  #failRead(streamId: string, read: ReadState, error: Error): void {
    read.failure = error;
    read.queue.length = 0;
    const waiter = read.waiter;
    read.waiter = null;
    this.#finishRead(streamId, read);
    waiter?.reject(error);
  }

  #finishRead(streamId: string, read: ReadState): void {
    this.#clearReadTimer(read);
    if (this.#reads.get(streamId) !== read) return;
    this.#reads.delete(streamId);
    this.port.settled?.();
  }

  #clearReadTimer(read: ReadState): void {
    if (read.timer === null) return;
    clearTimeout(read.timer);
    read.timer = null;
  }

  // ---- writes ------------------------------------------------------------

  #handleWrite(streamId: string, write: WriteState, frame: HostStreamFrame): void {
    if (frame.type === "stream.ack") {
      if (frame.sequence < write.acknowledged || frame.sequence > write.sent) {
        this.port.fatal(
          new HostControlTransportError("invalid_ack", "Host acknowledged chunks it never got."),
        );
        return;
      }
      write.acknowledged = frame.sequence;
      this.#armWriteTimer(streamId, write);
      for (const wake of [...write.ackWaiters]) wake();
      return;
    }
    if (frame.type === "stream.committed") {
      if (!write.endDispatched || !write.committed) {
        this.port.fatal(
          new HostControlTransportError("invalid_commit", "Host committed before the end."),
        );
        return;
      }
      const committed = write.committed;
      write.committed = null;
      this.#finishWrite(streamId, write);
      committed.resolve({
        length: frame.length ?? null,
        sha256: frame.sha256 ?? null,
        result: frame.result ?? null,
      });
      return;
    }
    if (frame.type === "stream.error") {
      this.#failWrite(streamId, write, streamError(frame));
      return;
    }
    this.port.fatal(
      new HostControlTransportError("invalid_stream", "Host sent an invalid frame for a write."),
    );
  }

  async #write(
    streamId: string,
    write: WriteState,
    sequence: number,
    bytes: Uint8Array,
  ): Promise<void> {
    if (write.failure) throw write.failure;
    if (this.#writes.get(streamId) !== write || write.endDispatched) {
      throw new HostControlTransportError("invalid_state", "This import stream has ended.");
    }
    if (sequence !== write.sent || bytes.byteLength === 0 || bytes.byteLength > CHUNK_BYTES) {
      throw new HostControlTransportError("invalid_chunk", "Chunks go out in order, 1–8 KiB.");
    }
    while (write.sent >= write.acknowledged + write.window) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          write.ackWaiters.delete(wake);
          write.ackWaiters.delete(fail);
          resolve();
        };
        const fail = () => {
          write.ackWaiters.delete(wake);
          write.ackWaiters.delete(fail);
          reject(write.failure ?? new HostControlTransportError("cancelled", "Import ended."));
        };
        write.ackWaiters.add(wake);
        // A failure wakes every waiter too; it rethrows below.
        if (write.failure) fail();
      });
      if (write.failure) throw write.failure;
    }
    write.sent += 1;
    this.#armWriteTimer(streamId, write);
    try {
      await this.port.send("chunk", {
        stream_id: streamId,
        sequence,
        bytes_b64: encodeBridgeBytes(bytes),
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new HostControlTransportError("send_failed");
      this.#failWrite(streamId, write, failure);
      throw failure;
    }
    if (write.failure) throw write.failure;
  }

  async #end(
    streamId: string,
    write: WriteState,
    length: number,
    sha256: string,
  ): Promise<StreamV2Committed> {
    if (write.failure) throw write.failure;
    if (this.#writes.get(streamId) !== write || write.endDispatched) {
      throw new HostControlTransportError("invalid_state", "This import stream has ended.");
    }
    if (write.sent !== chunkCount(length)) {
      throw new HostControlTransportError("length_mismatch", "Not every chunk was sent.");
    }
    const committed = new Promise<StreamV2Committed>((resolve, reject) => {
      write.committed = { resolve, reject };
    });
    write.endDispatched = true;
    this.#armWriteTimer(streamId, write);
    try {
      await this.port.send("end", { stream_id: streamId, length, sha256 });
    } catch {
      this.#failWrite(
        streamId,
        write,
        new HostControlTransportError(
          "outcome_unknown",
          "The import may have committed; ask the target before going on.",
        ),
      );
    }
    return committed;
  }

  #cancelWrite(streamId: string, write: WriteState): void {
    if (this.#writes.get(streamId) !== write) return;
    this.#failWrite(
      streamId,
      write,
      new HostControlTransportError("cancelled", "The conversation write was cancelled."),
    );
    this.#tombstone(streamId);
    void this.port.send("cancel", { stream_id: streamId }).catch(() => undefined);
  }

  /** A write waiting on the host — for room in the window or for its
   *  commit — that hears nothing for the stream timeout gives up. */
  #armWriteTimer(streamId: string, write: WriteState): void {
    if (write.timer !== null) clearTimeout(write.timer);
    write.timer = null;
    // Caught up and not ending: nothing is owed by the host.
    if (!write.endDispatched && write.sent <= write.acknowledged) return;
    write.timer = setTimeout(() => {
      write.timer = null;
      if (this.#writes.get(streamId) !== write) return;
      this.#failWrite(
        streamId,
        write,
        write.endDispatched
          ? new HostControlTransportError(
              "outcome_unknown",
              "The import may have committed; ask the target before going on.",
            )
          : new HostControlTransportError("stream_timeout", "The host stopped acknowledging."),
      );
      this.#tombstone(streamId);
      void this.port.send("cancel", { stream_id: streamId }).catch(() => undefined);
    }, this.port.timeoutMs);
  }

  #failWrite(streamId: string, write: WriteState, error: Error): void {
    write.failure ??= error;
    if (write.timer !== null) clearTimeout(write.timer);
    write.timer = null;
    if (this.#writes.get(streamId) === write) {
      this.#writes.delete(streamId);
      this.port.settled?.();
    }
    for (const wake of [...write.ackWaiters]) wake();
    const committed = write.committed;
    write.committed = null;
    committed?.reject(write.failure);
  }

  #finishWrite(streamId: string, write: WriteState): void {
    if (write.timer !== null) clearTimeout(write.timer);
    write.timer = null;
    if (this.#writes.get(streamId) !== write) return;
    this.#writes.delete(streamId);
    this.port.settled?.();
  }

  // ---- tombstones --------------------------------------------------------

  #tombstone(streamId: string): void {
    this.#prune();
    if (this.#tombstones.size >= MAX_TOMBSTONES) {
      const oldest = this.#tombstones.keys().next().value;
      if (oldest !== undefined) this.#tombstones.delete(oldest);
    }
    this.#tombstones.set(streamId, Date.now() + TOMBSTONE_TTL_MS);
  }

  #prune(): void {
    const now = Date.now();
    for (const [streamId, expiresAt] of this.#tombstones) {
      if (expiresAt <= now) this.#tombstones.delete(streamId);
    }
  }
}
