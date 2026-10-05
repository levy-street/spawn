"use client";

import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { pageRows, revealScrollTop, virtualWindow } from "@/lib/files/virtual-window";

/**
 * The rows of a fixed-height list worth rendering, for a scroller the caller
 * owns. `headerHeight` is a sticky header inside the scroller that rows pass
 * under; rows are positioned from the end of it. A new `scrollKey` (another
 * folder) starts the list from the top, rather than at the offset the last
 * one was scrolled to.
 */
export function useVirtualRows({
  scrollRef,
  count,
  rowHeight,
  headerHeight = 0,
  scrollKey,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  count: number;
  rowHeight: number;
  headerHeight?: number;
  scrollKey?: string;
}) {
  const [metrics, setMetrics] = useState({ scrollTop: 0, height: 0 });

  // Before paint, so a cached folder never shows a frame at the old offset.
  const lastKey = useRef(scrollKey);
  useLayoutEffect(() => {
    if (lastKey.current === scrollKey) return;
    lastKey.current = scrollKey;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = 0;
    setMetrics({ scrollTop: 0, height: element.clientHeight });
  }, [scrollKey, scrollRef]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const update = () =>
      setMetrics((current) =>
        current.scrollTop === element.scrollTop && current.height === element.clientHeight
          ? current
          : { scrollTop: element.scrollTop, height: element.clientHeight },
      );
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [scrollRef]);

  const viewportHeight = Math.max(0, metrics.height - headerHeight);
  const slice = virtualWindow({
    count,
    rowHeight,
    scrollTop: metrics.scrollTop,
    viewportHeight,
  });

  /** Scroll just enough that row `index` is wholly in view. */
  const reveal = useCallback(
    (index: number) => {
      const element = scrollRef.current;
      if (!element) return;
      const top = revealScrollTop({
        index,
        rowHeight,
        scrollTop: element.scrollTop,
        viewportHeight: Math.max(0, element.clientHeight - headerHeight),
      });
      if (top !== null) element.scrollTop = top;
    },
    [headerHeight, rowHeight, scrollRef],
  );

  return { ...slice, reveal, pageSize: pageRows(rowHeight, viewportHeight) };
}
