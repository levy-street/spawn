export type LiveWriteGeometry = { cols: number; rows: number };

type BufferedLiveWrite = {
  bytes: Uint8Array;
  offsetAfter: number | null;
  geometry: LiveWriteGeometry;
};

export type LiveWriteDrain =
  | { kind: "writes"; chunks: Uint8Array[]; coveredOffset: number | null }
  | { kind: "refresh" };

type BufferedTerminalWrite = {
  bytes: Uint8Array;
  onWritten?: () => void;
};

export type LiveTerminalWriteBatch = {
  bytes: Uint8Array;
  onWritten: Array<() => void>;
};

export type LiveTerminalWriteEnqueueResult = {
  synchronized: boolean;
  completedSynchronizedOutput: boolean;
};

const SYNCHRONIZED_OUTPUT_PREFIX = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36] as const;

/** Tracks DEC synchronized-output mode even when its CSI markers cross chunks. */
class SynchronizedOutputTracker {
  private prefixLength = 0;
  private active = false;

  get synchronized() {
    return this.active;
  }

  consume(bytes: Uint8Array): LiveTerminalWriteEnqueueResult {
    let completedSynchronizedOutput = false;
    for (const byte of bytes) {
      if (this.prefixLength === SYNCHRONIZED_OUTPUT_PREFIX.length) {
        if (byte === 0x68) {
          // CSI ? 2026 h (set synchronized-output mode).
          this.active = true;
        } else if (byte === 0x6c) {
          // CSI ? 2026 l (reset synchronized-output mode).
          completedSynchronizedOutput ||= this.active;
          this.active = false;
        }
        this.prefixLength = byte === SYNCHRONIZED_OUTPUT_PREFIX[0] ? 1 : 0;
        continue;
      }

      if (byte === SYNCHRONIZED_OUTPUT_PREFIX[this.prefixLength]) {
        this.prefixLength += 1;
      } else {
        // The prefix contains no other ESC byte, so only it can begin a new
        // overlapping candidate after a mismatch.
        this.prefixLength = byte === SYNCHRONIZED_OUTPUT_PREFIX[0] ? 1 : 0;
      }
    }
    return { synchronized: this.active, completedSynchronizedOutput };
  }

  release() {
    this.active = false;
    this.prefixLength = 0;
  }
}

/**
 * FIFO byte buffer used to present a short burst of live PTY chunks to xterm
 * as one write. Full-screen TUIs commonly redraw by moving the cursor to the
 * top of a region and returning it at the end; preserving transport chunk
 * boundaries lets WebGL paint those intermediate cursor positions.
 */
export class LiveTerminalWriteBuffer {
  private readonly writes: BufferedTerminalWrite[] = [];
  private readonly synchronizedOutput = new SynchronizedOutputTracker();
  private byteLength = 0;
  private atomicBatchPending = false;

  get size() {
    return this.byteLength;
  }

  get synchronized() {
    return this.synchronizedOutput.synchronized;
  }

  enqueue(bytes: Uint8Array, onWritten?: () => void): LiveTerminalWriteEnqueueResult {
    if (bytes.byteLength === 0) {
      return {
        synchronized: this.synchronizedOutput.synchronized,
        completedSynchronizedOutput: false,
      };
    }
    this.writes.push({ bytes, onWritten });
    this.byteLength += bytes.byteLength;
    const state = this.synchronizedOutput.consume(bytes);
    if (state.synchronized || state.completedSynchronizedOutput) {
      // A complete synchronized repaint must reach xterm in one write. Its
      // transport chunks may exceed the ordinary live-write batch target.
      this.atomicBatchPending = true;
    }
    return state;
  }

  take(maxBytes: number): LiveTerminalWriteBatch | null {
    if (this.writes.length === 0 || this.synchronizedOutput.synchronized) return null;
    const selected: BufferedTerminalWrite[] = [];
    let selectedBytes = 0;
    while (this.writes.length > 0) {
      const next = this.writes[0];
      if (
        !this.atomicBatchPending &&
        selectedBytes > 0 &&
        selectedBytes + next.bytes.byteLength > maxBytes
      ) {
        break;
      }
      selected.push(this.writes.shift() as BufferedTerminalWrite);
      selectedBytes += next.bytes.byteLength;
      if (!this.atomicBatchPending && selectedBytes >= maxBytes) break;
    }
    this.byteLength -= selectedBytes;
    this.atomicBatchPending = false;

    const bytes =
      selected.length === 1
        ? selected[0].bytes
        : (() => {
            const joined = new Uint8Array(selectedBytes);
            let offset = 0;
            for (const write of selected) {
              joined.set(write.bytes, offset);
              offset += write.bytes.byteLength;
            }
            return joined;
          })();
    return {
      bytes,
      onWritten: selected.flatMap((write) => (write.onWritten ? [write.onWritten] : [])),
    };
  }

  clear() {
    this.writes.length = 0;
    this.byteLength = 0;
    this.atomicBatchPending = false;
    this.synchronizedOutput.release();
  }

  releaseSynchronization() {
    if (!this.synchronizedOutput.synchronized) return;
    this.synchronizedOutput.release();
    this.atomicBatchPending = true;
  }
}

/**
 * Bounded holding area for PTY bytes that arrive while the scrollback xterm
 * is being reset and geometry-walked. The caller drains only after that
 * render completes, or asks the endpoint for a fresh checkpoint when bytes
 * cannot be appended safely at the final geometry.
 */
export class PostRenderLiveWriteBuffer {
  private readonly writes: BufferedLiveWrite[] = [];
  private byteLength = 0;
  private overflowed = false;

  constructor(private readonly maxBytes: number) {}

  enqueue(bytes: Uint8Array, offsetAfter: number | undefined, geometry: LiveWriteGeometry) {
    if (this.overflowed) return;
    if (bytes.byteLength > this.maxBytes - this.byteLength) {
      this.writes.length = 0;
      this.byteLength = 0;
      this.overflowed = true;
      return;
    }
    this.writes.push({
      bytes,
      offsetAfter: typeof offsetAfter === "number" ? offsetAfter : null,
      geometry,
    });
    this.byteLength += bytes.byteLength;
  }

  drain(coveredOffset: number | null, geometry: LiveWriteGeometry): LiveWriteDrain {
    if (this.overflowed) {
      this.clear();
      return { kind: "refresh" };
    }
    const writes = this.writes.splice(0);
    this.byteLength = 0;
    const uncovered = writes.filter(
      (write) =>
        coveredOffset === null || write.offsetAfter === null || write.offsetAfter > coveredOffset,
    );
    if (
      uncovered.some(
        (write) => write.geometry.cols !== geometry.cols || write.geometry.rows !== geometry.rows,
      )
    ) {
      return { kind: "refresh" };
    }
    let nextCoveredOffset = coveredOffset;
    for (const write of uncovered) {
      if (write.offsetAfter !== null) {
        nextCoveredOffset = Math.max(nextCoveredOffset ?? 0, write.offsetAfter);
      }
    }
    return {
      kind: "writes",
      chunks: uncovered.map((write) => write.bytes),
      coveredOffset: nextCoveredOffset,
    };
  }

  clear() {
    this.writes.length = 0;
    this.byteLength = 0;
    this.overflowed = false;
  }
}
