export type LiveWriteGeometry = { cols: number; rows: number };

type BufferedLiveWrite = {
  bytes: Uint8Array;
  offsetAfter: number | null;
  geometry: LiveWriteGeometry;
};

export type LiveWriteDrain =
  | { kind: "writes"; chunks: Uint8Array[]; coveredOffset: number | null }
  | { kind: "refresh" };

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
