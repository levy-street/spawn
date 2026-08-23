"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A fast upload finishes in a couple of frames. Holding the bar this long
 * turns that into a sweep you can actually read instead of a flicker — the
 * complaint that retired the old thumbnail overlay.
 */
const MIN_VISIBLE_MS = 420;
const FADE_MS = 200;
/** Enough bar to read as "started" the moment the first byte moves. */
const MIN_WIDTH = 0.04;

/**
 * The upload indicator: a hairline that overlays the top edge of the terminal,
 * reading as a second border under the pane header. It is absolutely
 * positioned and `pointer-events-none` on purpose — the terminal underneath
 * keeps its full height, so nothing here disturbs scrollback or geometry.
 */
export function UploadProgressBar({ ratio }: { ratio: number | null }) {
  const active = ratio !== null;
  const [visible, setVisible] = useState(false);
  const [fading, setFading] = useState(false);
  const shownAtRef = useRef(0);

  useEffect(() => {
    if (active) {
      if (!visible) shownAtRef.current = Date.now();
      setVisible(true);
      setFading(false);
      return;
    }
    if (!visible) return;
    // Settled: the bar is already painted full below, so hold it long enough
    // to be seen, then fade. A new upload arriving mid-fade cancels both.
    const held = Math.max(0, MIN_VISIBLE_MS - (Date.now() - shownAtRef.current));
    const fade = setTimeout(() => setFading(true), held);
    const hide = setTimeout(() => setVisible(false), held + FADE_MS);
    return () => {
      clearTimeout(fade);
      clearTimeout(hide);
    };
  }, [active, visible]);

  if (!visible) return null;

  const width = active ? Math.max(MIN_WIDTH, ratio) : 1;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden"
      aria-hidden
    >
      <div
        className={cn(
          "h-full bg-white/20 transition-[width,opacity] ease-swift",
          fading ? "opacity-0 duration-200" : "opacity-100 duration-300",
        )}
        style={{ width: `${width * 100}%` }}
      >
        <div className="upload-sheen h-full w-full" />
      </div>
    </div>
  );
}
