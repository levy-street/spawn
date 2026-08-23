import { useCallback, useEffect, useRef, useState } from "react";

/**
 * How long after the agent command is written the keyboard is asked for.
 *
 * Long enough that the command has left the wire and the shell has begun
 * spawning the agent, short enough that the keyboard is already up by the time
 * the agent paints its first prompt. Asking earlier makes the keyboard
 * animation race the connection-ready frame.
 */
export const LAUNCH_FOCUS_DELAY_MS = 400;

export interface LaunchAutoFocusOptions {
  /** True while this terminal is the screen on top. */
  focused: boolean;
  /** True while a drawer the keyboard would cover is open over the terminal. */
  held: boolean;
  /** Puts focus on the terminal surface, which raises the keyboard. */
  onFocus: () => void;
  delayMs?: number;
}

/**
 * Raises the keyboard once, when a freshly launched agent starts booting.
 *
 * Creating a session on an agent is an act of typing something to it, so the
 * window that opens should already be ready to type into. Only a launch does
 * this: reopening a session that has been running for an hour must not shove a
 * keyboard over the output the operator came back to read.
 *
 * The request is armed by the delivery, not spent by it. If the launch lands
 * while a drawer is up or while another route sits on top, the keyboard waits
 * for the terminal to be the thing on screen rather than rising behind it.
 */
export function useLaunchAutoFocus({
  focused,
  held,
  onFocus,
  delayMs = LAUNCH_FOCUS_DELAY_MS,
}: LaunchAutoFocusOptions): () => void {
  const [armed, setArmed] = useState(false);
  const callback = useRef(onFocus);
  callback.current = onFocus;

  useEffect(() => {
    if (!armed || !focused || held) return undefined;
    const timer = setTimeout(() => {
      setArmed(false);
      callback.current();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [armed, delayMs, focused, held]);

  return useCallback(() => setArmed(true), []);
}
