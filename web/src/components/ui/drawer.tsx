"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

// Drag the panel left past this many pixels to dismiss.
const CLOSE_DRAG_PX = 70;

const FOCUSABLE =
  "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Left slide-in drawer — the mobile sidebar container. Portal-rendered panel
 * with a scrim, horizontal drag-to-dismiss, a focus trap, Escape-to-close,
 * and background scroll lock. Height follows the visual viewport
 * (`--vv-height`) so the on-screen keyboard never pushes it off screen.
 *
 * Hand-rolled like `ui/sheet.tsx` (its vertical sibling). Controlled: mount
 * it always and toggle `open`; it manages its own enter/exit animation.
 */
export function Drawer({
  open,
  onClose,
  children,
  className,
  contentClassName,
  ariaLabel,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  ariaLabel?: string;
}) {
  // `mounted` keeps the node in the tree through the exit animation; `shown`
  // drives the slide (true = in/visible, false = off-screen left).
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [dragX, setDragX] = useState(0);
  // null = not tracking; `axis` locks once a direction dominates, so vertical
  // scrolling inside the drawer never starts a dismiss drag.
  const dragRef = useRef<{ x: number; y: number; axis: "h" | "v" | null } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

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

  // Lock background scroll and move focus into the drawer while mounted;
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
      setDragX(0);
    }
  }, [open, shown]);

  // Focus trap: Tab and Shift+Tab wrap within the panel.
  const onPanelKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
    ).filter((el) => el.offsetParent !== null);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onTouchStart = (event: ReactTouchEvent) => {
    const touch = event.touches[0];
    if (touch) dragRef.current = { x: touch.clientX, y: touch.clientY, axis: null };
  };
  const onTouchMove = (event: ReactTouchEvent) => {
    const start = dragRef.current;
    const touch = event.touches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (start.axis === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      start.axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
    }
    if (start.axis === "h") setDragX(Math.min(0, dx));
  };
  const onTouchEnd = () => {
    const dismissed = dragX < -CLOSE_DRAG_PX;
    dragRef.current = null;
    if (dismissed) onClose();
    else setDragX(0);
  };

  if (!mounted) return null;

  const dragging = dragRef.current?.axis === "h";
  const transform = shown ? `translateX(${dragX}px)` : "translateX(-100%)";

  return createPortal(
    <div className="fixed inset-0 z-50">
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
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        onTransitionEnd={onTransitionEnd}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{ transform, transition: dragging ? "none" : "transform 220ms" }}
        className={cn(
          "ease-swift pad-safe-top pad-safe-bottom absolute left-0 top-0 flex h-(--vv-height) w-[min(85vw,var(--sidebar-width))] flex-col border-r border-border bg-background text-foreground shadow-2xl outline-none",
          className,
        )}
      >
        <div className={cn("min-h-0 flex-1 overflow-y-auto", contentClassName)}>{children}</div>
      </div>
    </div>,
    document.body,
  );
}
