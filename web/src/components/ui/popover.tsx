"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  type MenuAlign,
  type MenuAnchor,
  type MenuPlacement,
  type MenuSide,
  measureMenu,
  placeMenu,
} from "@/components/ui/menu-position";
import { cn } from "@/lib/utils";

/**
 * A floating surface anchored to a caller-supplied rect.
 *
 * Distinct from `DropdownMenu` because the anchor is not the trigger. A file
 * preview tracks a row *vertically* while staying pinned to the edge of the
 * panel *horizontally*, so it does not slide sideways as the pointer runs down
 * a list. Only the caller knows both rects, so only the caller can supply them.
 *
 * Non-interactive by default: the card is a `role="tooltip"` with pointer
 * events off, so it cannot steal the hover that opened it, cannot cover the
 * row's kebab, and cannot trap a click. Content that needs to be scrolled or
 * selected belongs in the viewer dialog instead.
 */
export function Popover({
  open,
  anchor,
  side = "right",
  align = "start",
  flip = true,
  interactive = false,
  id,
  ariaLabel,
  className,
  onPointerEnter,
  onPointerLeave,
  children,
}: {
  open: boolean;
  anchor: MenuAnchor | null;
  side?: MenuSide;
  align?: MenuAlign;
  /** False pins the box to `side`, narrowing it rather than crossing over. */
  flip?: boolean;
  interactive?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<MenuPlacement | null>(null);
  const [mounted, setMounted] = useState(false);

  useLayoutEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchor) {
      setCoords(null);
      return;
    }
    const place = () => {
      // Fallback only matters for the first frame, before the panel has
      // measured; keep it near the real width so nothing shifts after paint.
      const { width, height } = measureMenu(panelRef.current, 544);
      setCoords(
        placeMenu({
          anchor,
          menuWidth: width,
          menuHeight: height,
          align,
          side,
          flip,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    place();
    // Content arrives asynchronously — a thumbnail decodes, a text head lands —
    // so the panel's height changes after it first opens and it may no longer
    // fit where it was put.
    const observer = new ResizeObserver(place);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchor, side, align, flip]);

  if (!mounted || !open || !anchor) return null;

  return createPortal(
    <div
      id={id}
      ref={panelRef}
      // A tooltip may not contain interactive content, and `dialog` would make
      // every "find the open dialog" query match a hover card. `group` is the
      // honest description of a labelled box holding a few controls.
      role={interactive ? "group" : "tooltip"}
      {...(interactive && ariaLabel ? { "aria-label": ariaLabel } : {})}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      // Hidden until measured, so it never paints at the wrong place first.
      style={coords ?? { position: "fixed", visibility: "hidden" }}
      className={cn(
        // Below DropdownMenu's z-[100] so a context menu opened over a preview
        // still wins, and above Dialog's z-50.
        "z-[90] overflow-hidden rounded-lg border border-popover-border bg-popover text-popover-foreground shadow-xl shadow-black/50",
        "animate-in fade-in-0 zoom-in-95 duration-100",
        // pointer-events-auto also un-inherits the `pointer-events: none` a
        // modal Radix dialog puts on <body>, which this portal would take on.
        interactive ? "pointer-events-auto" : "pointer-events-none",
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
