"use client";

import Link from "next/link";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

type Align = "start" | "end";
type Side = "top" | "bottom";

/**
 * Hand-rolled dropdown (matching the repo's radix-free shadcn ports).
 * `renderTrigger` receives the props to spread onto the trigger button so
 * nested-interactive markup never occurs.
 */
export function DropdownMenu({
  renderTrigger,
  children,
  align = "end",
  side = "bottom",
  className,
  menuClassName,
}: {
  renderTrigger: (props: {
    onClick: () => void;
    onKeyDown: (event: ReactKeyboardEvent) => void;
    "aria-expanded": boolean;
    "aria-haspopup": "menu";
    "aria-controls": string;
  }) => ReactNode;
  children: ReactNode;
  align?: Align;
  side?: Side;
  className?: string;
  menuClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<CSSProperties | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(() => setOpen(false), []);

  // The menu renders in a portal (position: fixed) so it can never be clipped
  // by an ancestor's overflow — e.g. the horizontally-scrolling screen tab
  // strip or the scrollable sidebar. Position it against the trigger's rect,
  // flipping side/edge when it would leave the viewport. Recomputed on open
  // and on scroll/resize so it tracks the trigger.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const place = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const menu = menuRef.current?.getBoundingClientRect();
      const menuH = menu?.height ?? 0;
      const menuW = menu?.width ?? 176;
      const style: CSSProperties = { position: "fixed" };
      const opensUp =
        side === "top"
          ? anchor.top - menuH - 4 > 8
          : anchor.bottom + menuH + 4 > window.innerHeight - 8 && anchor.top - menuH - 4 > 8;
      if (opensUp) style.bottom = window.innerHeight - anchor.top + 4;
      else style.top = anchor.bottom + 4;
      if (align === "end") style.right = Math.max(8, window.innerWidth - anchor.right);
      else style.left = Math.min(anchor.left, window.innerWidth - menuW - 8);
      setCoords(style);
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, side, align]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  const focusItem = (direction: 1 | -1) => {
    const items = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([aria-disabled])") ??
        [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = current === -1 ? 0 : (current + direction + items.length) % items.length;
    items[next]?.focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(-1);
    }
  };

  return (
    <div ref={rootRef} className={cn("relative inline-block", className)}>
      {renderTrigger({
        onClick: () => setOpen((v) => !v),
        onKeyDown: (event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        },
        "aria-expanded": open,
        "aria-haspopup": "menu",
        "aria-controls": menuId,
      })}
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            id={menuId}
            ref={menuRef}
            role="menu"
            onKeyDown={onMenuKeyDown}
            onClick={close}
            style={coords ?? { position: "fixed", visibility: "hidden" }}
            className={cn(
              "z-[100] min-w-44 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/40",
              "animate-in fade-in-0 zoom-in-95 duration-100",
              menuClassName,
            )}
          >
            {children}
          </div>,
          document.body,
        )}
    </div>
  );
}

const ITEM_CLASS =
  "flex w-full cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50";

export function DropdownMenuItem({
  onSelect,
  href,
  destructive = false,
  disabled = false,
  className,
  children,
}: {
  onSelect?: () => void;
  href?: string;
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn(
    ITEM_CLASS,
    destructive && "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10",
    className,
  );
  if (href) {
    return (
      <Link role="menuitem" href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={classes}
    >
      {children}
    </button>
  );
}

export function DropdownMenuSeparator() {
  return <hr className="mx-1 my-1 h-px border-0 bg-border" />;
}

export function DropdownMenuLabel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("px-2 py-1.5 text-[11px] font-medium text-muted-foreground", className)}>
      {children}
    </div>
  );
}
