"use client";

import { useEffect } from "react";

/**
 * Subscribe to `visualViewport` size changes so the layout can shrink when
 * the on-screen keyboard appears. We expose two CSS variables on `:root`:
 *
 *   --vv-height   the height the app should fill
 *   --vv-keyboard how much on-screen keyboard is covering the layout viewport
 *
 * Components that need to "stick above" the keyboard can use
 * `bottom: var(--vv-keyboard)`.
 */

/**
 * The on-screen keyboard is the only thing we want to shrink the layout for,
 * so a measured height is only ever an *override* — `height: null` means "no
 * keyboard, leave --vv-height alone" and the stylesheet's `100dvh` takes over.
 *
 * Pinch zoom is why this matters: it shrinks `visualViewport` without
 * shrinking the layout viewport (at 1.5x an 800px page reports 533px), so
 * pinning a px height to it pulls the app up and leaves the rest of the page
 * bare. Anything else that moves the viewport without firing an event we can
 * hear has the same effect, and `100dvh` is immune to all of it — it is
 * recomputed by the browser, never by us.
 */
export function viewportInset({
  visualHeight,
  offsetTop,
  scale,
  layoutHeight,
}: {
  visualHeight: number;
  offsetTop: number;
  scale: number;
  layoutHeight: number;
}): { height: number | null; keyboard: number } {
  // Zoomed: the visual viewport is a window onto the page, not a keyboard.
  if (scale > 1.01) return { height: null, keyboard: 0 };
  const height = Math.min(visualHeight, layoutHeight);
  const keyboard = Math.max(0, layoutHeight - height - offsetTop);
  // Sub-pixel slack: browsers report fractional viewport heights at rest, and
  // a 0.5px "keyboard" is not worth freezing the layout to a px value for.
  if (keyboard < 1) return { height: null, keyboard: 0 };
  return { height, keyboard };
}

export function useViewportInset() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const root = document.documentElement;
      const { height, keyboard } = viewportInset({
        visualHeight: vv.height,
        offsetTop: vv.offsetTop,
        scale: vv.scale,
        layoutHeight: window.innerHeight,
      });
      if (height === null) root.style.removeProperty("--vv-height");
      else root.style.setProperty("--vv-height", `${height}px`);
      root.style.setProperty("--vv-keyboard", `${keyboard}px`);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    // The keyboard inset is measured against the layout viewport, which browser
    // zoom and window resizes move without always touching the visual viewport.
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
}
