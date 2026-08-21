"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
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
import { BottomSheet } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

/**
 * Multi-step dropdown for pick-one flows (the `+` new-session cascade:
 * host → location). Renders one panel at a time from a nested panel tree,
 * with a slide transition between steps, a back button, arrow/Enter/Escape
 * keyboard nav, and a per-panel loading state. On mobile it presents as a
 * bottom sheet (`ui/sheet.tsx`) instead of an anchored dropdown.
 *
 * Panels are plain data rebuilt on every render, so async content (e.g.
 * recent dirs from a query) flows in naturally: flip `loading` on the panel
 * and replace its `items` when the data lands — navigation state is a path
 * of panel ids and survives the re-render.
 */
export type CascadeItem = {
  /** List identity when labels can repeat; defaults to `label`. */
  key?: string;
  icon?: ReactNode;
  label: string;
  /** Secondary line, e.g. a full path under a folder name. */
  detail?: string;
  /** Render as a non-interactive section label instead of a menu item. */
  heading?: boolean;
  /** Draw the row in the danger ink, as DropdownMenuItem's `destructive` does. */
  destructive?: boolean;
  disabled?: boolean;
  /** Leaf action: runs and closes the menu. Ignored when `panel` is set. */
  onSelect?: () => void;
  /** Submenu: descend into this panel instead of selecting. */
  panel?: CascadePanel;
};

export type CascadePanel = {
  id: string;
  /** Shown in the back header (and as the sheet title on mobile). */
  title?: string;
  /** Replaces the items with a spinner while async content loads. */
  loading?: boolean;
  /** Muted row shown when `items` is empty and not loading. */
  emptyLabel?: string;
  items: CascadeItem[];
};

export type CascadeMenuHandle = {
  open: () => void;
  /** Open anchored to a viewport point (a click) rather than the trigger. */
  openAt: (x: number, y: number) => void;
  /**
   * Point-anchored toggle for triggers that open at the cursor: a second click
   * closes the menu instead of dragging it to the new cursor position.
   */
  toggleAt: (x: number, y: number) => void;
  close: () => void;
};

type TriggerProps = {
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent) => void;
  "aria-expanded": boolean;
  "aria-haspopup": "menu";
  "aria-controls": string;
};

/** Walk `root` along `path`; stops early if the tree changed under the path. */
function resolvePanel(root: CascadePanel, path: string[]): { panel: CascadePanel; depth: number } {
  let panel = root;
  let depth = 0;
  for (const id of path) {
    const next = panel.items.find((item) => item.panel?.id === id)?.panel;
    if (!next) break;
    panel = next;
    depth += 1;
  }
  return { panel, depth };
}

export const CascadeMenu = forwardRef<
  CascadeMenuHandle,
  {
    root: CascadePanel;
    renderTrigger: (props: TriggerProps) => ReactNode;
    onOpenChange?: (open: boolean) => void;
    align?: "start" | "end";
    /** "auto" (default) presents as a bottom sheet under the `md` viewport. */
    presentation?: "auto" | "menu" | "sheet";
    /** Sheet title fallback when the current panel has no `title`. */
    sheetTitle?: string;
    className?: string;
    menuClassName?: string;
  }
>(function CascadeMenu(
  {
    root,
    renderTrigger,
    onOpenChange,
    align = "start",
    presentation = "auto",
    sheetTitle,
    className,
    menuClassName,
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<string[]>([]);
  // null until a step is taken: the first panel of an open should not slide,
  // only the container's own zoom-from-the-trigger carries that motion. A
  // slide there read as the menu arriving from off to the right no matter
  // which corner it was actually hung from.
  const [direction, setDirection] = useState<"forward" | "back" | null>(null);
  const [coords, setCoords] = useState<MenuPlacement | null>(null);
  // Set when opened at a click: the menu hangs off that point instead of the
  // trigger, which matters when the trigger is a whole empty grid opening.
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [smallViewport, setSmallViewport] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const setOpenState = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        setPath([]);
        setDirection(null);
      } else {
        setPoint(null);
      }
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(() => setOpenState(false), [setOpenState]);

  useImperativeHandle(
    ref,
    () => ({
      open: () => {
        setPoint(null);
        setOpenState(true);
      },
      openAt: (x: number, y: number) => {
        setPoint({ x, y });
        setOpenState(true);
      },
      toggleAt: (x: number, y: number) => {
        if (open) {
          close();
          return;
        }
        setPoint({ x, y });
        setOpenState(true);
      },
      close,
    }),
    [open, setOpenState, close],
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setSmallViewport(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const asSheet = presentation === "sheet" || (presentation === "auto" && smallViewport);

  const { panel, depth } = resolvePanel(root, path);
  const pathKey = path.slice(0, depth).join("/");

  const descend = useCallback((target: CascadePanel) => {
    setDirection("forward");
    setPath((current) => [...current, target.id]);
  }, []);

  const goBack = useCallback(() => {
    setDirection("back");
    setPath((current) => current.slice(0, -1));
  }, []);

  const activate = useCallback(
    (item: CascadeItem) => {
      if (item.disabled) return;
      if (item.panel) {
        descend(item.panel);
        return;
      }
      item.onSelect?.();
      close();
    },
    [descend, close],
  );

  // Anchored positioning (menu mode): portal + fixed coords against the
  // trigger rect (or the click point), resolved by the shared `placeMenu` so
  // the menu is always fully on screen — flipped above when there is no room
  // below, slid in from either edge, height-capped when neither side fits.
  useLayoutEffect(() => {
    if (!open || asSheet) {
      setCoords(null);
      return;
    }
    const place = () => {
      const { width, height } = measureMenu(menuRef.current, 240);
      const anchor: MenuAnchor | null = point
        ? pointAnchor(point.x, point.y)
        : (rootRef.current?.getBoundingClientRect() ?? null);
      if (!anchor) return;
      setCoords(
        placeMenu({
          anchor,
          menuWidth: width,
          menuHeight: height,
          // Click-anchored: the menu drops from the cursor, so there is no
          // trigger box for `end` to hang off.
          align: point ? "start" : align,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
        }),
      );
    };
    place();
    // Panels differ in height and async content lands late, so re-place on any
    // size change: a deeper step must not spill off the bottom of the screen.
    const observer = new ResizeObserver(place);
    if (menuRef.current) observer.observe(menuRef.current);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, asSheet, align, point]);

  // Close on outside pointerdown / Escape (menu mode; the sheet handles its
  // own scrim and Escape).
  useEffect(() => {
    if (!open || asSheet) return;
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
  }, [open, asSheet, close]);

  // Focus the first enabled item whenever a panel appears.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathKey re-runs the focus on every panel change
  useEffect(() => {
    if (!open || asSheet) return;
    const id = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open, asSheet, pathKey]);

  const focusSibling = (container: HTMLElement | null, step: 1 | -1) => {
    const items = Array.from(
      container?.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)") ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = current === -1 ? 0 : (current + step + items.length) % items.length;
    items[next]?.focus();
  };

  const onListKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusSibling(event.currentTarget as HTMLElement, 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusSibling(event.currentTarget as HTMLElement, -1);
    } else if (event.key === "ArrowRight") {
      const index = Number((document.activeElement as HTMLElement)?.dataset.cascadeIndex);
      const item = panel.items[index];
      if (item?.panel && !item.disabled) {
        event.preventDefault();
        descend(item.panel);
      }
    } else if (event.key === "ArrowLeft" || event.key === "Backspace") {
      if (depth > 0) {
        event.preventDefault();
        goBack();
      }
    }
  };

  const panelView = (
    <div
      // Remount per step so tw-animate-css replays the slide.
      key={pathKey}
      className={cn(
        "animate-in fade-in-0 duration-150",
        direction === "forward" && "slide-in-from-right-4",
        direction === "back" && "slide-in-from-left-4",
      )}
    >
      {depth > 0 ? (
        <button
          type="button"
          onClick={goBack}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-popover-accent hover:text-foreground"
        >
          <ChevronLeft className="size-3.5 shrink-0" aria-hidden />
          {panel.title ?? "Back"}
        </button>
      ) : (
        panel.title != null && (
          <div className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
            {panel.title}
          </div>
        )
      )}
      {panel.loading ? (
        <div className="flex items-center justify-center py-6">
          <Spinner />
        </div>
      ) : panel.items.length === 0 ? (
        <div className="px-2 py-3 text-center text-sm text-muted-foreground">
          {panel.emptyLabel ?? "Nothing here"}
        </div>
      ) : (
        panel.items.map((item, index) =>
          item.heading ? (
            <div
              key={item.key ?? item.label}
              role="presentation"
              className={cn(
                "select-none px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground",
                index > 0 && "mt-1 border-t border-popover-border",
              )}
            >
              {item.label}
            </div>
          ) : (
            <button
              key={item.key ?? item.label}
              type="button"
              role="menuitem"
              data-cascade-index={index}
              disabled={item.disabled}
              aria-haspopup={item.panel ? "menu" : undefined}
              onClick={() => activate(item)}
              className={cn(
                "flex w-full select-none items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors",
                "hover:bg-popover-accent focus-visible:bg-popover-accent disabled:pointer-events-none disabled:opacity-50",
                // Taller touch targets in the sheet presentation.
                asSheet ? "min-h-11 py-2.5" : "py-2",
                item.destructive &&
                  "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10",
              )}
            >
              {item.icon != null && (
                <span
                  className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-4"
                  aria-hidden
                >
                  {item.icon}
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.label}</span>
                {item.detail != null && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.detail}
                  </span>
                )}
              </span>
              {item.panel != null && (
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
            </button>
          ),
        )
      )}
    </div>
  );

  return (
    <div ref={rootRef} className={cn("relative inline-block", className)}>
      {renderTrigger({
        onClick: () => setOpenState(!open),
        onKeyDown: (event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpenState(true);
          }
        },
        "aria-expanded": open,
        "aria-haspopup": "menu",
        "aria-controls": menuId,
      })}
      {asSheet ? (
        <BottomSheet
          open={open}
          onClose={close}
          title={depth === 0 ? (panel.title ?? sheetTitle) : undefined}
          ariaLabel={panel.title ?? sheetTitle}
        >
          <div
            id={menuId}
            role="menu"
            onKeyDown={onListKeyDown}
            className="overflow-x-hidden px-2 pb-2"
          >
            {panelView}
          </div>
        </BottomSheet>
      ) : (
        open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            id={menuId}
            ref={menuRef}
            role="menu"
            onKeyDown={onListKeyDown}
            style={coords ?? { position: "fixed", visibility: "hidden" }}
            className={cn(
              // pointer-events-auto: a modal Radix dialog sets `pointer-events:
              // none` on the body, and this menu is portaled to it — without
              // this, a menu opened from inside a dialog is dead to the mouse.
              // Lighter than the shell it opens over, so it reads as a
              // surface lifted off the chrome rather than a hole cut into it.
              "pointer-events-auto z-[100] w-60 overflow-y-auto overflow-x-hidden overscroll-contain rounded-lg border border-popover-border bg-popover p-1 text-popover-foreground shadow-xl shadow-black/50",
              "animate-in fade-in-0 zoom-in-95 duration-100",
              menuClassName,
            )}
          >
            {panelView}
          </div>,
          document.body,
        )
      )}
    </div>
  );
});
