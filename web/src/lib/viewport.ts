"use client";

import { useEffect } from "react";

/**
 * Subscribe to `visualViewport` size changes so the layout can shrink when
 * the on-screen keyboard appears. We expose two CSS variables on `:root`:
 *
 *   --vv-height   the current visualViewport height in px
 *   --vv-keyboard the difference vs window.innerHeight (i.e. how much keyboard)
 *
 * Components that need to "stick above" the keyboard can use
 * `bottom: var(--vv-keyboard)`.
 */
export function useViewportInset() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const root = document.documentElement;
      const h = vv.height;
      const kb = Math.max(0, window.innerHeight - h - vv.offsetTop);
      root.style.setProperty("--vv-height", `${h}px`);
      root.style.setProperty("--vv-keyboard", `${kb}px`);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("orientationchange", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);
}
