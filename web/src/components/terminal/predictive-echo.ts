/**
 * Mosh-style predictive local echo.
 *
 * The felt keystroke latency of a remote terminal is round-trip + one render
 * frame no matter how fast the pipeline gets. Prediction removes the round
 * trip from perception: a printable keystroke paints immediately in an
 * overlay at the cursor, and the authoritative echo confirms (or refutes) it
 * a round-trip later.
 *
 * The terminal buffer is never touched — predictions live in a DOM overlay
 * owned by the caller, so the worst cost of a misprediction is a one-frame
 * flicker, never buffer corruption. Confirmation compares the authoritative
 * cursor advance and the glyphs it left behind against the outstanding
 * predictions; anything surprising clears the overlay, and repeated hard
 * mispredictions disable prediction for a cool-off (apps like vim's normal
 * mode echo nothing that matches, exactly as in mosh's adaptive mode).
 */

const PRINTABLE_ASCII = /^[\x20-\x7e]$/;
/** Give the echo ample time before quietly dropping stale predictions. */
const CONFIRM_TIMEOUT_MS = 2_000;
/** Hard mispredictions inside this window trip the breaker. */
const BACKOFF_WINDOW_MS = 10_000;
const BACKOFF_TRIP_COUNT = 2;
const BACKOFF_DISABLE_MS = 30_000;
/** Never accumulate more outstanding predictions than this. */
const MAX_PENDING = 64;

export type PredictionCursor = {
  /** Absolute buffer row (base + viewport-relative cursor row). */
  row: number;
  col: number;
};

export type ReconcileOutcome = {
  /** Unconfirmed predicted text remaining after this reconcile. */
  pending: string;
  /** True when the echo contradicted a prediction (hard mispredict). */
  mispredicted: boolean;
};

export class PredictiveEcho {
  #pending = "";
  #anchor: PredictionCursor | null = null;
  #predictedAt = 0;
  #hardMisses: number[] = [];
  #disabledUntil = 0;

  get pendingText(): string {
    return this.#pending;
  }

  enabled(now: number): boolean {
    return now >= this.#disabledUntil;
  }

  /**
   * Consider predicting one unit of user input. Returns true when the caller
   * should paint `data` as a prediction; false passes it through unpredicted.
   * Non-printable input (Enter, arrows, control chords) clears outstanding
   * predictions — their effects are unguessable.
   */
  predict(data: string, cursor: PredictionCursor | null, cols: number, now: number): boolean {
    if (!PRINTABLE_ASCII.test(data)) {
      this.clear();
      return false;
    }
    if (!this.enabled(now) || cursor === null) return false;
    // Never predict across the wrap boundary: the app decides how to wrap.
    if (cursor.col + this.#pending.length + 1 >= cols) return false;
    if (this.#pending.length >= MAX_PENDING) {
      this.clear();
      return false;
    }
    if (this.#pending.length === 0) {
      this.#anchor = cursor;
    }
    this.#pending += data;
    this.#predictedAt = now;
    return true;
  }

  /**
   * Reconcile after authoritative output rendered. `cursor` is the new
   * cursor; `textBeforeCursor` holds up to `pendingText.length` glyphs
   * immediately left of it on the cursor row.
   */
  reconcile(cursor: PredictionCursor, textBeforeCursor: string, now: number): ReconcileOutcome {
    if (this.#pending.length === 0) {
      return { pending: "", mispredicted: false };
    }
    const anchor = this.#anchor;
    if (anchor === null) {
      this.clear();
      return { pending: "", mispredicted: false };
    }
    // A row change is a repaint, scroll, or wrap — ambiguous, drop softly.
    if (cursor.row !== anchor.row) {
      this.clear();
      return { pending: "", mispredicted: false };
    }
    const advance = cursor.col - anchor.col;
    if (advance <= 0) {
      // No forward motion yet (spinner frames, status repaints). Wait, but
      // not forever: an app that echoes nothing gets its overlay dropped.
      if (now - this.#predictedAt > CONFIRM_TIMEOUT_MS) {
        this.clear();
      }
      return { pending: this.#pending, mispredicted: false };
    }
    if (advance > this.#pending.length) {
      // The app produced more text than was predicted (completion popups,
      // rewrites) — ambiguous, drop softly.
      this.clear();
      return { pending: "", mispredicted: false };
    }
    const expected = this.#pending.slice(0, advance);
    const echoed = textBeforeCursor.slice(-advance);
    if (echoed !== expected) {
      this.clear();
      this.#recordHardMiss(now);
      return { pending: "", mispredicted: true };
    }
    this.#pending = this.#pending.slice(advance);
    this.#anchor = { row: cursor.row, col: cursor.col };
    if (this.#pending.length === 0) this.#anchor = null;
    return { pending: this.#pending, mispredicted: false };
  }

  clear(): void {
    this.#pending = "";
    this.#anchor = null;
  }

  #recordHardMiss(now: number): void {
    this.#hardMisses = this.#hardMisses.filter((at) => now - at < BACKOFF_WINDOW_MS);
    this.#hardMisses.push(now);
    if (this.#hardMisses.length >= BACKOFF_TRIP_COUNT) {
      this.#disabledUntil = now + BACKOFF_DISABLE_MS;
      this.#hardMisses = [];
    }
  }
}
