"use client";

import {
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { announceModalOpen } from "@/lib/modal-layer";
import { cn } from "@/lib/utils";

// Drag the grab handle down past this many pixels to dismiss.
const CLOSE_DRAG_PX = 90;

/**
 * A bottom sheet: a portal-rendered panel that slides up from the bottom edge,
 * with a scrim, a drag-to-dismiss grab handle, Escape-to-close, and background
 * scroll lock. Height is capped to the visual viewport (`--vv-height`) so the
 * on-screen keyboard never pushes it off screen. Theme-aware via tokens.
 *
 * Radix-free, matching the repo's hand-rolled `ui/` primitives. Controlled:
 * mount it always and toggle `open`; it manages its own enter/exit animation.
 */
export function BottomSheet({
  open,
  onClose,
  title,
  children,
  className,
  contentClassName,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  ariaLabel?: string;
}) {
  // `mounted` keeps the node in the tree through the exit animation; `shown`
  // drives the slide (true = up/visible, false = down/off-screen).
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [dragY, setDragY] = useState(0);
  const dragStartRef = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // A sheet takes the window like any modal, so anything already floating
  // over it gives way (see `modal-layer`). Keyed on `open`, not on mount:
  // the node outlives the close by one animation.
  useEffect(() => {
    if (open) announceModalOpen();
  }, [open]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
  }, [open]);

  // Escape closes.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Lock background scroll and move focus into the sheet while it is mounted;
  // restore both on teardown.
  useEffect(() => {
    if (!mounted) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const focusId = requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      document.documentElement.style.overflow = prevOverflow;
      cancelAnimationFrame(focusId);
      restoreFocusRef.current?.focus?.();
    };
  }, [mounted]);

  const onTransitionEnd = useCallback(() => {
    if (!open && !shown) {
      setMounted(false);
      setDragY(0);
    }
  }, [open, shown]);

  const onHandleTouchStart = (event: ReactTouchEvent) => {
    dragStartRef.current = event.touches[0]?.clientY ?? null;
  };
  const onHandleTouchMove = (event: ReactTouchEvent) => {
    if (dragStartRef.current === null) return;
    const dy = (event.touches[0]?.clientY ?? dragStartRef.current) - dragStartRef.current;
    setDragY(Math.max(0, dy));
  };
  const onHandleTouchEnd = () => {
    const dismissed = dragY > CLOSE_DRAG_PX;
    dragStartRef.current = null;
    if (dismissed) onClose();
    else setDragY(0);
  };

  if (!mounted) return null;

  const dragging = dragStartRef.current !== null;
  const transform = shown ? `translateY(${dragY}px)` : "translateY(100%)";

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <div
        aria-hidden
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/50 transition-opacity duration-200",
          shown ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        onTransitionEnd={onTransitionEnd}
        style={{ transform, transition: dragging ? "none" : "transform 220ms ease-out" }}
        className={cn(
          "pad-safe-bottom absolute inset-x-0 bottom-0 flex max-h-[calc(var(--vv-height)-2.5rem)] flex-col rounded-t-2xl border-t border-border bg-popover text-popover-foreground shadow-2xl outline-none",
          className,
        )}
      >
        <div
          className="flex shrink-0 cursor-grab touch-none flex-col items-center gap-2 pt-2.5"
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onTouchEnd={onHandleTouchEnd}
        >
          <span className="h-1 w-9 rounded-full bg-border" aria-hidden />
          {title != null && (
            <div className="w-full px-4 pb-1 text-sm font-medium text-foreground">{title}</div>
          )}
        </div>
        <div className={cn("min-h-0 flex-1 overflow-y-auto", contentClassName)}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
