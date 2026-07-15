"use client";

import { cn } from "@/lib/utils";

/**
 * A screen's sidebar/tab avatar: same rounded-tile footprint as
 * AgentKindIcon so screens and agents read as one family, but the glyph is
 * the pane count — the most useful thing to know about a screen at a glance.
 */
export function ScreenIcon({ paneCount, className }: { paneCount: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground shadow-sm ring-1 ring-inset ring-white/10",
        className,
      )}
      role="img"
      aria-label={`Screen with ${paneCount} ${paneCount === 1 ? "pane" : "panes"}`}
      title={`${paneCount} ${paneCount === 1 ? "pane" : "panes"}`}
    >
      {paneCount}
    </span>
  );
}
