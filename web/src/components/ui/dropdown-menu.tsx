"use client";

import { Check } from "lucide-react";
import Link from "next/link";
import {
  forwardRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type MenuAnchor,
  type MenuPlacement,
  measureMenu,
  placeMenu,
  pointAnchor,
} from "@/components/ui/menu-position";
import { useDismissOnModalOpen } from "@/components/ui/modal-layer";
import { cn } from "@/lib/utils";

/** Imperative handle: open the menu at a viewport point (e.g. a right-click),
 *  bypassing the trigger anchor. */
export type DropdownMenuHandle = { openAt: (x: number, y: number) => void };

type Align = "start" | "end";
type Side = "top" | "bottom";

/**
 * Hand-rolled dropdown (matching the repo's radix-free shadcn ports).
 * `renderTrigger` receives the props to spread onto the trigger button so
 * nested-interactive markup never occurs.
 */
export const DropdownMenu = forwardRef<
  DropdownMenuHandle,
  {
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
  }
>(function DropdownMenu(
  { renderTrigger, children, align = "end", side = "bottom", className, menuClassName },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<MenuPlacement | null>(null);
  // When opened via openAt (right-click), position at this viewport point
  // instead of anchoring to the trigger.
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setPoint(null);
  }, []);

  // A menu opened before a modal is a leftover once the modal has the window;
  // one opened from inside a modal never hears this (see `modal-layer`).
  useDismissOnModalOpen(open, close);

  useImperativeHandle(
    ref,
    () => ({
      openAt: (x: number, y: number) => {
        setPoint({ x, y });
        setOpen(true);
      },
    }),
    [],
  );

  // The menu renders in a portal (position: fixed) so it can never be clipped
  // by an ancestor's overflow — e.g. the horizontally-scrolling screen tab
  // strip or the scrollable sidebar. `placeMenu` anchors it to the trigger's
  // rect (or the right-click point) and guarantees it lands fully on screen,
  // flipping side and capping height when it would not otherwise fit.
  // Recomputed on open, on scroll/resize, and whenever the menu's own size
  // changes so it tracks the trigger.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const place = () => {
      const { width, height } = measureMenu(menuRef.current, 176);
      const anchor: MenuAnchor | null = point
        ? pointAnchor(point.x, point.y)
        : (rootRef.current?.getBoundingClientRect() ?? null);
      if (!anchor) return;
      setCoords(
        placeMenu({
          anchor,
          menuWidth: width,
          menuHeight: height,
          // A cursor-anchored menu drops from the point; there is no trigger
          // box for `end` to hang off.
          align: point ? "start" : align,
          side: point ? "bottom" : side,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    place();
    // Item counts change while open (a checkbox list, an async label), and a
    // taller menu may no longer fit on the side it opened to.
    const observer = new ResizeObserver(place);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, side, align, point]);

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
      rootRef.current?.querySelectorAll<HTMLElement>(
        "[role='menuitem']:not([aria-disabled]),[role='menuitemcheckbox']:not([aria-disabled]),[role='menuitemradio']:not([aria-disabled])",
      ) ?? [],
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
              // pointer-events-auto: a modal Radix dialog sets `pointer-events:
              // none` on <body>, which this portal would otherwise inherit.
              // A menu is a surface that rises off the shell, so it is drawn
              // lighter than the ground it opens over (see --popover) and
              // leans on the shadow rather than a hard edge for separation.
              "pointer-events-auto z-[100] min-w-44 overflow-y-auto overscroll-contain rounded-lg border border-popover-border bg-popover p-1 text-popover-foreground shadow-xl shadow-black/50",
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
});

/** The row shape, exported for the rare item a menu has to hand-roll — a
 *  download row that owns its own link attributes and progress. */
export const DROPDOWN_ITEM_CLASS =
  "flex w-full select-none items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none transition-colors hover:bg-popover-accent focus-visible:bg-popover-accent disabled:pointer-events-none disabled:opacity-50";

export function DropdownMenuItem({
  onSelect,
  href,
  external = false,
  newTab = false,
  checked,
  destructive = false,
  disabled = false,
  className,
  children,
}: {
  onSelect?: () => void;
  href?: string;
  /**
   * Render `href` as a plain anchor instead of a route `Link`: for a file the
   * browser should download (a .dmg is not a route) or another site entirely.
   */
  external?: boolean;
  /** With `external`: open in a new tab (a store listing, not a download). */
  newTab?: boolean;
  /** Pass to make the item a toggle: renders a checkbox showing its state. */
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn(
    DROPDOWN_ITEM_CLASS,
    destructive && "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10",
    className,
  );
  if (href && external) {
    return (
      <a
        role="menuitem"
        href={href}
        className={classes}
        {...(newTab ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {children}
      </a>
    );
  }
  if (href) {
    return (
      <Link role="menuitem" href={href} className={classes}>
        {children}
      </Link>
    );
  }
  if (checked !== undefined) {
    return (
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={onSelect}
        className={classes}
      >
        <span
          aria-hidden
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded border",
            checked ? "border-foreground bg-foreground text-background" : "border-border",
          )}
        >
          {checked && <Check className="size-3" strokeWidth={3} />}
        </span>
        {children}
      </button>
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
  return <hr className="mx-1 my-1 h-px border-0 bg-popover-border" />;
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
