"use client";

import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils";
import { useVirtualRows } from "./use-virtual-rows";

export type FileListHandle = {
  element: HTMLDivElement | null;
  /** Scroll just enough that row `index` is wholly in view. */
  reveal: (index: number) => void;
  /** Rows a Page Up/Down moves. */
  pageSize: () => number;
};

/**
 * The scroller both views share: a focusable grid or tree that renders only
 * the rows near the viewport. Focus stays on the scroller itself and the
 * focused row is named by `aria-activedescendant`, so a row scrolling out of
 * the DOM never takes the keyboard focus with it.
 *
 * `pinned` rows are rendered wherever the list is scrolled: the focused row
 * (so `aria-activedescendant` always names an element) and a row holding a
 * name field (New folder, New file, Rename), which must not vanish with what
 * was typed in it while the browser waits on it.
 */
export const FileList = forwardRef<
  FileListHandle,
  {
    role: "grid" | "tree";
    label: string;
    count: number;
    rowHeight: number;
    /** A sticky header inside the scroller (the Details columns). */
    header?: ReactNode;
    headerHeight?: number;
    /** Below this the rows scroll sideways rather than squeeze. */
    minWidth?: number;
    activeId?: string;
    /** Rows to render even when scrolled out of view. */
    pinned?: readonly number[];
    /** A new value scrolls back to the top: the folder on screen changed. */
    scrollKey?: string;
    renderRow: (index: number, top: number) => ReactNode;
    /** Which rows are on screen, as they change. */
    onRangeChange?: (start: number, end: number) => void;
    /**
     * The width rows have — the scroller's, less any scrollbar — when it
     * mounts and whenever it changes: what decides the Details columns.
     */
    onWidthChange?: (width: number) => void;
    /** Shown over an empty list: a skeleton, an empty state, an error. */
    children?: ReactNode;
  } & Omit<HTMLAttributes<HTMLDivElement>, "role" | "children">
>(function FileList(
  {
    role,
    label,
    count,
    rowHeight,
    header,
    headerHeight = 0,
    minWidth,
    activeId,
    pinned,
    scrollKey,
    renderRow,
    onRangeChange,
    onWidthChange,
    children,
    className,
    ...rest
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useVirtualRows({ scrollRef, count, rowHeight, headerHeight, scrollKey });

  // Measured before paint, so a narrow panel never shows a frame of columns
  // it has no room for.
  const onWidthChangeRef = useRef(onWidthChange);
  onWidthChangeRef.current = onWidthChange;
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const report = () => onWidthChangeRef.current?.(element.clientWidth);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      get element() {
        return scrollRef.current;
      },
      reveal: rows.reveal,
      pageSize: () => rows.pageSize,
    }),
    [rows.reveal, rows.pageSize],
  );

  const { start, end } = rows;
  useEffect(() => {
    onRangeChange?.(start, end);
  }, [onRangeChange, start, end]);

  const rendered: ReactNode[] = [];
  for (let index = start; index < end; index += 1) {
    rendered.push(renderRow(index, index * rowHeight));
  }
  for (const index of new Set(pinned ?? [])) {
    if (index < 0 || index >= count || (index >= start && index < end)) continue;
    rendered.push(renderRow(index, index * rowHeight));
  }

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is a grid or a tree, both of which take a label
    <div
      ref={scrollRef}
      role={role}
      aria-label={label}
      aria-multiselectable
      aria-rowcount={role === "grid" ? count + 1 : undefined}
      aria-activedescendant={activeId}
      tabIndex={0}
      className={cn(
        "relative min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
      {...rest}
    >
      {header && (
        <div className="sticky top-0 z-20" style={{ minWidth, height: headerHeight }}>
          {header}
        </div>
      )}
      <div
        role={role === "grid" ? "rowgroup" : "presentation"}
        className="relative"
        style={{ height: rows.total, minWidth }}
      >
        {rendered}
      </div>
      {count === 0 && children}
    </div>
  );
});
