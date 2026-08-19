"use client";

import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Marks an agent that runs without stopping to ask.
 *
 * The point is that a gated agent and an ungated one must not be
 * indistinguishable once they exist — the create form's toggle is a decision
 * made once, and everything after it is a list of agents that all look alike.
 *
 * Amber rather than red: this is a deliberate, supported mode, not an error.
 */
export function YoloBadge({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="YOLO mode: runs without permission prompts"
      title="YOLO mode — this agent does not stop to ask before it acts"
      data-testid="yolo-badge"
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-md border px-1.5 py-0.5",
        "border-amber-500/40 bg-amber-500/10 text-[10px] font-semibold uppercase tracking-wide",
        "text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <Zap className="size-2.5" aria-hidden />
      YOLO
    </span>
  );
}
