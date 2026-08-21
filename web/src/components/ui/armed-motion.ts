"use client";

import { useEffect, useState } from "react";

/**
 * False on the first paint, true a frame later — the switch that keeps a
 * transition from firing just because a component mounted.
 *
 * The app shell remounts on every route change, workspace switches included,
 * so anything that animates a state read from storage or props will replay
 * itself on each navigation: a drawer re-opens, a chevron re-spins, and motion
 * that should mean "you did something" comes to mean nothing at all. Withhold
 * the transition class until after the element has painted once and the first
 * frame simply *is* the correct state, with nothing to animate from.
 *
 * `prefers-reduced-motion` is handled globally in `globals.css`; this is about
 * when motion is meaningful, not whether it is wanted.
 */
export function useArmedMotion(): boolean {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return armed;
}
