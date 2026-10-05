"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * One header cell of a sortable, resizable table or grid: the label is a
 * button that sorts (and says how, through `aria-sort`), and the cell's right
 * edge is a drag handle that resizes the column — a `separator` that also
 * takes ←/→ from the keyboard and a double-click to go back to its default.
 *
 * The caller owns the widths and the order; this draws them and reports
 * intent. `onResize` fires as the handle moves, `onResizeEnd` once at the end
 * (where a caller persists).
 */
export function ColumnHeader({
  label,
  sort,
  onSort,
  align = "start",
  width,
  minWidth,
  maxWidth,
  defaultWidth,
  step = 16,
  onResize,
  onResizeEnd,
  className,
}: {
  label: string;
  /** Omit for a column that does not sort. */
  sort?: "ascending" | "descending" | "none";
  onSort?: () => void;
  align?: "start" | "end";
  /** Omit, with the resize callbacks, for a column that does not resize. */
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
  step?: number;
  onResize?: (width: number) => void;
  onResizeEnd?: (width: number) => void;
  className?: string;
}) {
  const drag = useRef<{ startX: number; startWidth: number; last: number } | null>(null);
  const resizable = width !== undefined && onResize !== undefined;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { startX: event.clientX, startWidth: width, last: width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || !onResize) return;
    current.last = current.startWidth + event.clientX - current.startX;
    onResize(current.last);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (current) onResizeEnd?.(current.last);
  };
  const onHandleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!resizable) return;
    const delta = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    if (delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    onResize(width + delta);
    onResizeEnd?.(width + delta);
  };

  const Icon = sort === "descending" ? ChevronDown : ChevronUp;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a header cell of an ARIA grid laid out with CSS grid; <th> needs a <table>
    // biome-ignore lint/a11y/useFocusableInteractive: the sort button inside it takes the focus
    <div
      role="columnheader"
      aria-sort={sort}
      className={cn("relative flex min-w-0 items-center", className)}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className={cn(
            "flex h-full min-w-0 flex-1 items-center gap-1 px-2 text-left text-[11px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
            align === "end" && "flex-row-reverse text-right",
            sort && sort !== "none" && "text-foreground",
          )}
        >
          <span className="truncate">{label}</span>
          <Icon
            aria-hidden
            className={cn("size-3 shrink-0", (!sort || sort === "none") && "invisible")}
          />
        </button>
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate px-2 text-[11px] font-medium text-muted-foreground",
            align === "end" && "text-right",
          )}
        >
          {label}
        </span>
      )}
      {resizable && (
        // biome-ignore lint/a11y/useSemanticElements: an interactive splitter is a focusable separator with a value; <hr> cannot take focus or keys
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${label}`}
          aria-valuenow={Math.round(width)}
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onHandleKeyDown}
          onDoubleClick={() => {
            if (defaultWidth === undefined) return;
            onResize(defaultWidth);
            onResizeEnd?.(defaultWidth);
          }}
          className="group/resize absolute inset-y-0 -right-1.5 z-10 flex w-3 cursor-col-resize touch-none justify-center outline-none"
        >
          <span
            aria-hidden
            className="my-1.5 w-px bg-border transition-colors group-hover/resize:bg-foreground/40 group-focus-visible/resize:bg-ring"
          />
        </div>
      )}
    </div>
  );
}
