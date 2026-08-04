import type { Terminal as XTerm } from "@xterm/xterm";

/** Position in the worker's committed-history stream. `epoch` is a decimal
 *  string (u64 nonce; exceeds JS safe integers), `offset` counts committed
 *  plaintext bytes within the epoch. */
export type HistoryAnchor = { epoch: string; offset: number };

type QueuedOp = {
  reset?: boolean;
  resize?: { cols: number; rows: number };
  data: string | Uint8Array | ((term: XTerm) => string);
  done?: () => void;
};

type PendingDelta = { epoch: string; offset: number; bytes: Uint8Array };

const PENDING_MAX_BYTES = 4 * 1024 * 1024;
const PENDING_MAX_COUNT = 4096;

export type CommittedHistoryHooks = {
  /** The hidden overlay terminal. The controller owns its contents. */
  term(): XTerm | null;
  /** Relative styled paint of the LIVE terminal's current screen ("" if
   *  unavailable). Written below the history as the reveal tail. */
  serializeLiveScreen(): string;
  /** Fetch a fresh anchored snapshot; the caller routes its response back via
   *  `seed()`. Called at most once per un-anchoring. */
  requestSeed(): void;
  /** The buffer changed and the write queue drained; update reveal state. */
  onRendered(): void;
};

/**
 * Keeps the hidden scrollback terminal a pure view of the worker's
 * committed-history log. Content comes exclusively from `seed()` (a replay's
 * history text) plus in-order `applyDelta()` appends — raw PTY bytes never
 * touch this buffer, so it cannot diverge from what the daemon would replay.
 *
 * The live screen is painted below the history only while the overlay is
 * revealed (the "tail"), sourced from the local live terminal. Every write
 * that appends history first erases the tail, appends at the true history
 * end, and repaints the tail, so the seam cannot interleave.
 */
export class CommittedHistoryOverlay {
  #anchor: HistoryAnchor | null = null;
  #pending: PendingDelta[] = [];
  #pendingBytes = 0;
  #pendingOverflow = false;
  #tail: { line: number; col: number } | null = null;
  #visible = false;
  #seedInFlight = false;
  #seedRequested = false;
  #ops: QueuedOp[] = [];
  #pumping = false;
  #tailRepaintQueued = false;
  #restoreViewportLine: number | null = null;

  constructor(private readonly hooks: CommittedHistoryHooks) {}

  get anchored(): boolean {
    return this.#anchor !== null;
  }

  get anchor(): HistoryAnchor | null {
    return this.#anchor ? { ...this.#anchor } : null;
  }

  /** One committed batch fragment from the delta stream. */
  applyDelta(epoch: string, offset: number, bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    if (this.#seedInFlight || !this.#anchor) {
      this.#bufferPending({ epoch, offset, bytes });
      if (!this.#seedInFlight) this.#requestSeed();
      return;
    }
    if (!this.#applyDeltaAnchored({ epoch, offset, bytes })) {
      this.#bufferPending({ epoch, offset, bytes });
      this.#unanchorAndReseed();
    }
  }

  /** The app erased its scrollback (`ED 3`). */
  applyWipe(epoch: string): void {
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#pendingOverflow = false;
    this.#anchor = { epoch, offset: 0 };
    this.#tail = null;
    this.#seedRequested = false;
    this.#enqueue({ reset: true, data: "" });
    if (this.#visible) this.#enqueue({ data: this.#paintTailOp() });
  }

  /** The daemon lost deltas for this viewer; re-anchor from a snapshot. */
  applyGap(): void {
    this.#unanchorAndReseed();
  }

  /**
   * Rebuild from a replay's history text. `anchorAt` is the stream position
   * at the end of `history` (batch-aligned). Called for the connect seed, the
   * one deep post-connect refresh, and gap heals.
   */
  seed(history: string, anchorAt: HistoryAnchor, size: { cols: number; rows: number }): void {
    this.#seedInFlight = true;
    this.#seedRequested = false;
    this.#tail = null;
    const term = this.hooks.term();
    this.#restoreViewportLine = this.#visible && term ? term.buffer.active.viewportY : null;
    this.#enqueue({
      reset: true,
      resize: size,
      data: history,
      done: () => {
        this.#anchor = { ...anchorAt };
        this.#seedInFlight = false;
        this.#drainPending();
        if (this.#visible) this.#enqueue({ data: this.#paintTailOp() });
        const restore = this.#restoreViewportLine;
        this.#restoreViewportLine = null;
        if (restore !== null) {
          this.#enqueue({
            data: (t) => {
              t.scrollToLine(Math.min(restore, t.buffer.active.baseY));
              return "";
            },
          });
        }
      },
    });
  }

  /** The overlay is being opened. Returns false when no seed has anchored
   *  yet — the caller requests one and re-reveals when it lands. */
  reveal(): boolean {
    this.#visible = true;
    if (!this.#anchor || this.#seedInFlight) {
      this.#requestSeed();
      return false;
    }
    if (!this.#tail) this.#enqueue({ data: this.#paintTailOp() });
    else this.hooks.onRendered();
    return true;
  }

  /** The overlay closed; drop the tail so history stays pure and appends
   *  while hidden are cheap. */
  conceal(): void {
    this.#visible = false;
    this.#tailRepaintQueued = false;
    if (this.#tail) this.#enqueue({ data: this.#eraseTailOp() });
  }

  /** Live terminal output arrived while the overlay is visible: refresh the
   *  painted tail (coalesced to one repaint per animation frame). */
  liveScreenChanged(): void {
    if (!this.#visible || !this.#anchor || !this.#tail || this.#tailRepaintQueued) return;
    this.#tailRepaintQueued = true;
    requestAnimationFrame(() => {
      if (!this.#tailRepaintQueued) return;
      this.#tailRepaintQueued = false;
      if (!this.#visible || !this.#tail) return;
      this.#enqueue({ data: this.#eraseTailOp() }, { data: this.#paintTailOp() });
    });
  }

  /** The overlay geometry changed. Flowing history reflows natively; only
   *  the tail needs erase + repaint around the resize. */
  resize(cols: number, rows: number): void {
    this.#enqueue({ data: this.#eraseTailOp() }, { resize: { cols, rows }, data: "" });
    if (this.#visible && this.#anchor) this.#enqueue({ data: this.#paintTailOp() });
  }

  dispose(): void {
    this.#ops = [];
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#anchor = null;
    this.#tail = null;
    this.#tailRepaintQueued = false;
  }

  #applyDeltaAnchored(delta: PendingDelta): boolean {
    const anchor = this.#anchor;
    if (!anchor || delta.epoch !== anchor.epoch) return false;
    if (delta.offset + delta.bytes.byteLength <= anchor.offset) return true; // already covered
    if (delta.offset !== anchor.offset) return false; // hole (or straddle: impossible by construction)
    anchor.offset += delta.bytes.byteLength;
    if (this.#visible && this.#tail) {
      this.#enqueue(
        { data: this.#eraseTailOp() },
        { data: delta.bytes },
        { data: this.#paintTailOp() },
      );
    } else if (this.#tail) {
      this.#enqueue({ data: this.#eraseTailOp() }, { data: delta.bytes });
    } else {
      this.#enqueue({ data: delta.bytes });
    }
    return true;
  }

  #bufferPending(delta: PendingDelta): void {
    if (this.#pendingOverflow) return;
    if (
      this.#pendingBytes + delta.bytes.byteLength > PENDING_MAX_BYTES ||
      this.#pending.length >= PENDING_MAX_COUNT
    ) {
      this.#pending = [];
      this.#pendingBytes = 0;
      this.#pendingOverflow = true;
      return;
    }
    this.#pending.push(delta);
    this.#pendingBytes += delta.bytes.byteLength;
  }

  #drainPending(): void {
    const pending = this.#pending;
    this.#pending = [];
    this.#pendingBytes = 0;
    if (this.#pendingOverflow) {
      this.#pendingOverflow = false;
      this.#unanchorAndReseed();
      return;
    }
    for (const delta of pending) {
      if (!this.#applyDeltaAnchored(delta)) {
        this.#unanchorAndReseed();
        return;
      }
    }
  }

  #unanchorAndReseed(): void {
    this.#anchor = null;
    this.#tail = null;
    this.#requestSeed();
  }

  #requestSeed(): void {
    if (this.#seedRequested || this.#seedInFlight) return;
    this.#seedRequested = true;
    this.hooks.requestSeed();
  }

  /** Erase from the recorded history end to the bottom of the screen and
   *  leave the cursor at the history end (including a soft-wrapped column),
   *  so the next append continues the stream exactly. */
  #eraseTailOp(): (term: XTerm) => string {
    return (term) => {
      const tail = this.#tail;
      this.#tail = null;
      if (!tail) return "";
      const buffer = term.buffer.active;
      const screenRow = tail.line - buffer.baseY + 1;
      if (screenRow < 1 || screenRow > term.rows) {
        // The tail start left the screen region — invariants broken (e.g. a
        // huge write raced the erase). Rebuild rather than corrupt.
        this.#unanchorAndReseed();
        return "";
      }
      return `\x1b[${screenRow};${tail.col + 1}H\x1b[0J`;
    };
  }

  /** Paint the live screen below the history and remember where it began. */
  #paintTailOp(): (term: XTerm) => string {
    return (term) => {
      if (this.#tail) return ""; // already painted (queued twice)
      const screen = this.hooks.serializeLiveScreen();
      if (!screen) return "";
      const buffer = term.buffer.active;
      this.#tail = { line: buffer.baseY + buffer.cursorY, col: buffer.cursorX };
      return `\x1b[0m${screen}`;
    };
  }

  #enqueue(...ops: QueuedOp[]): void {
    this.#ops.push(...ops);
    this.#pump();
  }

  #pump(): void {
    if (this.#pumping) return;
    const term = this.hooks.term();
    if (!term) {
      this.#ops = [];
      return;
    }
    const op = this.#ops.shift();
    if (!op) {
      this.hooks.onRendered();
      return;
    }
    this.#pumping = true;
    if (op.reset) term.reset();
    if (op.resize) {
      try {
        term.resize(op.resize.cols, op.resize.rows);
      } catch {
        // Mid-dispose during route changes; the write below is a no-op too.
      }
    }
    const data = typeof op.data === "function" ? op.data(term) : op.data;
    term.write(data, () => {
      this.#pumping = false;
      op.done?.();
      this.#pump();
    });
  }
}

/** Decode a base64 `history_delta` payload. Returns null on malformed input. */
export function decodeHistoryDelta(data: string): Uint8Array | null {
  try {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
