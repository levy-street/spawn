"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  type CSSProperties,
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

export type CascadeMenuHandle = { open: () => void; close: () => void };

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
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [coords, setCoords] = useState<CSSProperties | null>(null);
  const [smallViewport, setSmallViewport] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const setOpenState = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        setPath([]);
        setDirection("forward");
      }
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(() => setOpenState(false), [setOpenState]);

  useImperativeHandle(ref, () => ({ open: () => setOpenState(true), close }), [
    setOpenState,
    close,
  ]);

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
  // trigger rect, flipping above when there is no room below — the same
  // approach as ui/dropdown-menu.
  useLayoutEffect(() => {
    if (!open || asSheet) {
      setCoords(null);
      return;
    }
    const place = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const menu = menuRef.current?.getBoundingClientRect();
      const menuH = menu?.height ?? 0;
      const menuW = menu?.width ?? 256;
      const style: CSSProperties = { position: "fixed" };
      const opensUp =
        anchor.bottom + menuH + 4 > window.innerHeight - 8 && anchor.top - menuH - 4 > 8;
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
  }, [open, asSheet, align]);

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
        direction === "forward" ? "slide-in-from-right-4" : "slide-in-from-left-4",
      )}
    >
      {depth > 0 ? (
        <button
          type="button"
          onClick={goBack}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
                index > 0 && "mt-1 border-t border-border",
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
                "flex w-full cursor-default select-none items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors",
                "hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50",
                // Taller touch targets in the sheet presentation.
                asSheet ? "min-h-11 py-2" : "py-1.5",
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
              "z-[100] w-64 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/40",
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
