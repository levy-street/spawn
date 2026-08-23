"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** Hover has to settle before a tooltip is worth showing; focus does not, as
 *  it is already a deliberate act. */
const HOVER_DELAY_MS = 500;
/** Space between the rail and the plate. */
const GAP_PX = 8;
/** How close to the top or bottom edge the plate may sit. */
const EDGE_PX = 16;

/**
 * The collapsed sidebar rail's hover tooltip: a label to the right of an icon
 * that has no room for one, after a short delay. Render with `disabled` when
 * the sidebar is expanded, where the label is already on screen.
 *
 * Portalled to the body and positioned on show, rather than absolutely inside
 * the row. It looks like the more complicated way to do it, and it is the only
 * way that works: the workspace list is a scroll container, and a scroll
 * container clips both axes — `overflow-y: auto` computes `overflow-x` to
 * `auto` too, whatever the stylesheet says — so an absolutely positioned plate
 * reaching out of the rail was cut off at its edge and never seen. Escaping to
 * the body also puts the plate's width beyond the reach of anything the rail
 * does to its children, which is what used to leave the label spilling off the
 * end of its own background.
 *
 * The coordinates are measured once, when the tooltip appears, so anything
 * that moves the row afterwards takes the tooltip away rather than leaving it
 * pointing at nothing.
 */
export function RailTooltip({
  label,
  disabled = false,
  className,
  children,
}: {
  label: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);

  /**
   * Whether an event came from the row itself rather than from something the
   * row opened. React propagates events through the React tree, not the DOM
   * one, so a menu portalled to the body is still a React descendant of this
   * wrapper: focusing or hovering an item in it arrives here as if it were the
   * row. The tooltip labels the row, not whatever the row spawned.
   */
  const inside = useCallback(
    (target: EventTarget | null) => anchorRef.current?.contains(target as Node) ?? false,
    [],
  );

  const hide = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setAt(null);
  }, []);

  const show = useCallback((delay: number) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAt({
        // Centred on the row, then held clear of the viewport's edges — the
        // first and last rows of a long list sit right against them.
        top: Math.min(Math.max(rect.top + rect.height / 2, EDGE_PX), window.innerHeight - EDGE_PX),
        left: rect.right + GAP_PX,
      });
    }, delay);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (at === null) return;
    // Capture: the scroll that matters is the workspace list's, not the page's.
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [at, hide]);

  if (disabled) return <>{children}</>;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: not an interactive element — it wraps one. These handlers only watch the pointer to place a decoration; every activation still belongs to the link or button inside.
    <div
      ref={anchorRef}
      className={cn("relative", className)}
      // A touch has no hover to wait out: it is a tap on its way to happening,
      // and a plate that appears under the finger is only in the way.
      onPointerEnter={(event) => {
        if (event.pointerType === "touch" || !inside(event.target)) return;
        show(HOVER_DELAY_MS);
      }}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={(event) => {
        if (!inside(event.target)) return;
        // Keyboard focus only. A click already says what was clicked, and a
        // plate appearing under the cursor after every press is in the way.
        if (!(event.target as HTMLElement).matches(":focus-visible")) return;
        show(0);
      }}
      onBlur={hide}
    >
      {children}
      {at !== null &&
        createPortal(
          <span
            role="tooltip"
            style={{ top: at.top, left: at.left }}
            className={cn(
              "pointer-events-none fixed z-[60] w-max max-w-64 -translate-y-1/2",
              "rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
              // Wraps rather than runs off the screen: a workspace can be
              // named anything, and an account row carries a whole email.
              "break-words",
              "animate-in fade-in-0 duration-100",
            )}
          >
            {label}
          </span>,
          document.body,
        )}
    </div>
  );
}
