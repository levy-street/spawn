"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The single loading affordance. Inherits `currentColor`; size via the
 * `size` prop (px), color via text utilities on `className`. Replaces every
 * ad-hoc "Loading..." string.
 */
export function Spinner({
  size = 16,
  label = "Loading",
  className,
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <svg
      className={cn("animate-spin text-muted-foreground", className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A page that is not here yet: the spinner alone, centred in the viewport.
 *
 * It holds off for a beat before appearing, so a wait too short to notice
 * never flashes an indicator across the screen on its way to the page — and
 * a real wait gets the same mark the app shows everywhere else, rather than a
 * lone word of small text in the middle of nothing. The phone's account gate
 * does the same, under the same label.
 */
export function PageSpinner({
  label = "Loading",
  delayMs = 150,
  size = 20,
}: {
  label?: string;
  delayMs?: number;
  size?: number;
}) {
  const [shown, setShown] = useState(delayMs === 0);
  useEffect(() => {
    if (delayMs === 0) return;
    const id = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs]);
  return (
    <div className="flex min-h-vv items-center justify-center" aria-busy>
      {shown && <Spinner size={size} label={label} />}
    </div>
  );
}
