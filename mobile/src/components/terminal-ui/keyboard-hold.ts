import { useEffect, useRef } from "react";
import { Keyboard } from "react-native";
import { KeyboardController, useKeyboardState } from "react-native-keyboard-controller";

/** A drawer reports its dismissal as it starts animating out, not once it is gone. */
const RESTORE_DELAY_MS = 120;
const RESTORE_RETRY_MS = 180;
/** Roughly a second of trying before the keyboard is left where it is. */
const RESTORE_TICKS = 6;

export interface TerminalKeyboardHoldOptions {
  /** True while anything is presented over the terminal that the keyboard would cover. */
  held: boolean;
  /** Takes focus off the terminal surface, so the keyboard has nothing to serve. */
  onHold: () => void;
  /** Puts focus back on the terminal surface, which raises the keyboard again. */
  onRelease: () => void;
}

/**
 * Stands the keyboard down while a drawer is open over the terminal.
 *
 * A phone keyboard is taller than most of these drawers, so a sheet opening
 * underneath one is simply invisible. It is put back on close — but only if it
 * was up to begin with: raising a keyboard over a terminal the operator had
 * deliberately left quiet is worse than leaving it down.
 *
 * Restoring is retried rather than fired once. A drawer announces its dismissal
 * at the start of its close animation, and focus asked for while it is still on
 * screen is swallowed; the retry simply stops as soon as the keyboard is up.
 *
 * Only the transitions matter. Unmounting mid-drawer must not raise a keyboard
 * over whatever screen comes next, so nothing is restored from teardown.
 */
export function useTerminalKeyboardHold({
  held,
  onHold,
  onRelease,
}: TerminalKeyboardHoldOptions): void {
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const visible = useRef(keyboardVisible);
  visible.current = keyboardVisible;
  const callbacks = useRef({ onHold, onRelease });
  callbacks.current = { onHold, onRelease };
  const holding = useRef(false);
  const owed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const stop = (): void => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };

    if (held === holding.current) return undefined;
    holding.current = held;

    if (held) {
      stop();
      owed.current = visible.current;
      if (!owed.current) return undefined;
      callbacks.current.onHold();
      void KeyboardController.dismiss().catch(() => Keyboard.dismiss());
      return undefined;
    }

    if (!owed.current) return undefined;
    owed.current = false;
    let ticks = 0;
    let asked = false;
    const attempt = (): void => {
      timer.current = null;
      ticks += 1;
      if (visible.current) {
        // Already up. If that is because we asked, the job is done; if the
        // dismissal simply has not landed yet, wait and ask on a later tick.
        if (asked) return;
      } else {
        asked = true;
        callbacks.current.onRelease();
      }
      if (ticks >= RESTORE_TICKS) return;
      timer.current = setTimeout(attempt, RESTORE_RETRY_MS);
    };
    timer.current = setTimeout(attempt, RESTORE_DELAY_MS);
    // Another drawer opening mid-restore takes the branch above, which stops it.
    return stop;
  }, [held]);
}
