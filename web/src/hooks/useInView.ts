"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Whether somebody can see an element right now: it intersects the viewport
 * (after every scrolling ancestor has clipped it) and its page is the tab in
 * front.
 *
 * For work that is only worth doing while its result is on screen — the Hosts
 * page's exact figures, a request every few seconds per host. A card scrolled
 * out of view or a tab left in the background stops asking, and asks again
 * the moment it is back.
 *
 * Pass the returned callback as the element's `ref`. Where there is no
 * IntersectionObserver the element counts as in view, so the feature degrades
 * to "on while the tab is visible" rather than to "never".
 */
export function useInView<T extends Element>(): [(node: T | null) => void, boolean] {
  const [node, setNode] = useState<T | null>(null);
  const [intersecting, setIntersecting] = useState(false);
  const pageVisible = usePageVisible();

  useEffect(() => {
    if (!node) {
      setIntersecting(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setIntersecting(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      // Several entries can arrive in one batch; the last is the current one.
      const latest = entries[entries.length - 1];
      if (latest) setIntersecting(latest.isIntersecting);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, intersecting && pageVisible];
}

function subscribeToVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** The tab is in front. False on the server, where nothing is on screen. */
function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeToVisibility,
    () => document.visibilityState === "visible",
    () => false,
  );
}
