/**
 * Hover intent: opening something because the pointer *stopped*, not because it
 * passed through.
 *
 * The open delay is input disambiguation, not decoration — sweeping down a file
 * tree crosses dozens of rows, and every one of them would otherwise start a
 * fetch. Nothing else depends on a timer: click, Space and the context menu act
 * immediately, and closing is geometric rather than timed.
 *
 * The factory takes its clock so `bun test` can drive it with no DOM.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Opening waits for the pointer to settle — sweeping a list crosses dozens of
 * rows, and every one of them would otherwise start a fetch.
 *
 * There is deliberately no closing delay. Closing is decided by *where the
 * pointer is*, not by a countdown: a deadline runs while the pointer is still
 * travelling toward the card, which is exactly what makes a hover card
 * impossible to reach. The caller owns that region and calls `cancel`.
 */
export const HOVER_OPEN_DELAY_MS = 260;

export type HoverIntentTimers = {
  setTimer: (fn: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
};

export type HoverIntent<T> = {
  /** Pointer entered a target. Opens after the delay unless it leaves first. */
  enter: (value: T) => void;
  /** Open now and stay open — the keyboard path. Hover cannot dismiss it. */
  pin: (value: T) => void;
  unpin: () => void;
  /**
   * The pointer has reached what is open: abandon a pending swap to another
   * target, picked up on the way there, and keep what is showing.
   */
  hold: () => void;
  /** Close immediately, cancelling any pending open. */
  cancel: () => void;
  dispose: () => void;
};

export function createHoverIntent<T>(
  io: HoverIntentTimers & {
    onChange: (value: T | null, pinned: boolean) => void;
    openDelayMs?: number;
    /**
     * Something else has the pointer's attention — a menu, a dialog — and a
     * card must not open over it. Asked again when the delay runs out, not
     * only when it starts: the pointer can settle on a row in the instant a
     * dialog takes the window, and the card would otherwise land on top of
     * that dialog a quarter-second later.
     */
    blocked?: () => boolean;
  },
): HoverIntent<T> {
  const openDelay = io.openDelayMs ?? HOVER_OPEN_DELAY_MS;
  const blocked = () => io.blocked?.() === true;

  let timer: number | null = null;
  let current: T | null = null;
  let pinned = false;

  const clear = () => {
    if (timer !== null) {
      io.clearTimer(timer);
      timer = null;
    }
  };

  const set = (value: T | null, nextPinned: boolean) => {
    current = value;
    pinned = nextPinned;
    io.onChange(value, nextPinned);
  };

  /** Blocked: nothing opens, and whatever is up goes. */
  const close = () => {
    clear();
    if (current !== null || pinned) set(null, false);
  };

  return {
    enter(value) {
      if (pinned) return;
      clear();
      if (blocked()) {
        close();
        return;
      }
      // Already showing this one: a pending close is simply abandoned, and
      // nothing refetches.
      if (current !== null && sameTarget(current, value)) return;
      timer = io.setTimer(() => {
        timer = null;
        if (blocked()) close();
        else set(value, false);
      }, openDelay);
    },
    pin(value) {
      if (blocked()) {
        close();
        return;
      }
      clear();
      set(value, true);
    },
    unpin() {
      clear();
      set(null, false);
    },
    hold() {
      if (current !== null) clear();
    },
    cancel: close,
    dispose() {
      clear();
    },
  };
}

/** Structural comparison so callers can pass fresh objects each move. */
function sameTarget<T>(a: T, b: T): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => left[key] === right[key]);
}

export function useHoverIntent<T>(options: { enabled?: boolean; blocked?: () => boolean } = {}) {
  const enabled = options.enabled !== false;
  // The latest answer, read through a ref: the intent is made once.
  const blockedRef = useRef(options.blocked);
  blockedRef.current = options.blocked;
  const [state, setState] = useState<{ value: T | null; pinned: boolean }>({
    value: null,
    pinned: false,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  const intent = useMemo(
    () =>
      createHoverIntent<T>({
        setTimer: (fn, ms) => window.setTimeout(fn, ms),
        clearTimer: (id) => window.clearTimeout(id),
        onChange: (value, pinned) => setState({ value, pinned }),
        blocked: () => blockedRef.current?.() === true,
      }),
    [],
  );

  useEffect(() => intent.dispose, [intent]);

  const enter = useCallback(
    (value: T) => {
      if (enabled) intent.enter(value);
    },
    [enabled, intent],
  );
  const pin = useCallback(
    (value: T) => {
      // Pinning is the keyboard path and must work even where hover does not.
      if (stateRef.current.pinned && stateRef.current.value !== null) intent.unpin();
      else intent.pin(value);
    },
    [intent],
  );
  const hold = useCallback(() => intent.hold(), [intent]);
  const cancel = useCallback(() => intent.cancel(), [intent]);

  return { value: state.value, pinned: state.pinned, enter, pin, hold, cancel };
}
