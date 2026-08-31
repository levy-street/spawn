"use client";

import type { JSX } from "react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/** How far the bar may fill on its own. Only real completion passes this. */
const CEILING = 92;
/** Fraction of the remaining distance closed per tick. */
const EASING = 0.055;
const TICK_MS = 200;

/**
 * A progress bar for work whose duration nobody can know.
 *
 * A spinner says "something is happening" and nothing else, which is thin
 * comfort during the seconds a machine takes to appear. This says the same
 * thing with a sense of motion — but it is deliberately not a lie about
 * completion: each tick closes a fixed fraction of the distance to a ceiling
 * it never reaches, so it visibly decelerates and can never claim to be nearly
 * done. Only `done` takes it to the end.
 *
 * That matters more than it sounds. A bar that marches confidently to 100% and
 * then sits there is worse than no bar at all — it tells the reader the wait is
 * over when it is not, and the next thing they do is reload.
 */
export function PaceBar({
  done = false,
  failed = false,
  label,
  className,
}: {
  /** The real work finished: fill to the end. */
  done?: boolean;
  /** The real work failed: hold where it is, in the destructive tone. */
  failed?: boolean;
  /** Announced to screen readers, which get no value from the animation. */
  label: string;
  className?: string;
}): JSX.Element {
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (done) {
      setValue(100);
      return;
    }
    if (failed) return;
    const timer = window.setInterval(() => {
      setValue((current) => current + (CEILING - current) * EASING);
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [done, failed]);

  return (
    <div className={cn("space-y-2", className)}>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        // Indeterminate until it is genuinely finished: announcing a percentage
        // invented by a timer would read as fact.
        aria-valuenow={done ? 100 : undefined}
        data-testid="pace-bar"
        data-state={failed ? "failed" : done ? "done" : "running"}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200 ease-out motion-reduce:transition-none",
            failed ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${Math.min(100, Math.max(2, value))}%` }}
        />
      </div>
      <p className="text-center text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
