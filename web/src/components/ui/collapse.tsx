"use client";

import type { ReactNode } from "react";
import { useArmedMotion } from "@/components/ui/armed-motion";
import { cn } from "@/lib/utils";

/**
 * A disclosure that opens and closes to its own height, with no measurement.
 *
 * `grid-template-rows: 0fr → 1fr` is the whole trick: a grid row sized in
 * fractions animates where `height: auto` cannot, so the drawer glides instead
 * of appearing, and it stays correct when its contents change size — a host
 * coming online adds a row, and the open drawer simply grows.
 *
 * The content stays mounted while closed so it has a height to animate *from*.
 * That would otherwise leave a clipped list in the tab order, so the clipping
 * wrapper is `inert` whenever the drawer is shut: nothing inside can be
 * focused, clicked, or read out until it is actually open.
 *
 * The transition is armed a frame after mount (`useArmedMotion`), never on the
 * first paint, so a drawer that mounts already open does not animate itself
 * open on every route change.
 *
 * Two things callers must respect. Spacing above the content belongs *inside*
 * (`pt-*`, not `mt-*`) — a margin escapes the clip and leaves a gap under a
 * closed drawer. And `prefers-reduced-motion` is handled globally in
 * `globals.css`, so there is nothing to opt out of here.
 */
export function Collapse({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: ReactNode;
}) {
  const armed = useArmedMotion();

  return (
    <div
      className={cn(
        "grid",
        armed && "transition-[grid-template-rows] duration-200 ease-swift",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div className="overflow-hidden" inert={!open}>
        {children}
      </div>
    </div>
  );
}
