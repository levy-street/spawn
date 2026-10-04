"use client";

import { Folder } from "lucide-react";
import type { DragEvent, MouseEvent, ReactNode } from "react";
import { FileIcon } from "@/components/files/file-icon";
import { HighlightedName } from "@/components/files/file-name";
import { ColumnHeader } from "@/components/ui/column-header";
import {
  COLUMN_RESIZE_STEP,
  type ColumnKey,
  type ColumnWidths,
  DEFAULT_COLUMN_WIDTHS,
  type DetailsLayout,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTHS,
} from "@/lib/files/columns";
import {
  formatEntrySummary,
  formatModified,
  formatSize,
  formatTimestamp,
} from "@/lib/files/format";
import { kindLabel, type SortSpec } from "@/lib/files/sort";
import type { HostDirEntry } from "@/lib/hostControl";
import { cn } from "@/lib/utils";

export const DETAILS_HEADER_HEIGHT = 28;

/**
 * The Details view's sticky header: sortable, resizable columns — those the
 * panel has room for. Folded, Name alone, which sorts but has nothing to
 * resize: it is the panel's width.
 */
export function DetailsHeader({
  layout,
  template,
  sort,
  widths,
  onSort,
  onResize,
  onResizeEnd,
}: {
  layout: DetailsLayout;
  template: string;
  sort: SortSpec;
  widths: ColumnWidths;
  onSort: (key: ColumnKey) => void;
  onResize: (key: ColumnKey, width: number) => void;
  onResizeEnd: (key: ColumnKey, width: number) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: rows of an ARIA grid laid out with CSS grid; <tr>/<td> need a <table>
    <div role="rowgroup" className="h-full">
      {/* biome-ignore lint/a11y/useSemanticElements: the header row of an ARIA grid laid out with CSS grid */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: its column headers hold the focusable sort buttons */}
      <div
        role="row"
        aria-rowindex={1}
        // The last column's resize handle straddles the table's right edge;
        // clipped there, so it never gives the grid something to scroll to.
        className="grid h-full overflow-x-clip border-b border-border bg-background"
        style={{ gridTemplateColumns: template }}
      >
        {layout.columns.map((column) => (
          <ColumnHeader
            key={column.key}
            label={column.label}
            align={column.align}
            sort={
              sort.key === column.key ? (sort.order === "asc" ? "ascending" : "descending") : "none"
            }
            onSort={() => onSort(column.key)}
            {...(layout.stacked
              ? {}
              : {
                  width: widths[column.key],
                  minWidth: MIN_COLUMN_WIDTHS[column.key],
                  maxWidth: MAX_COLUMN_WIDTH,
                  defaultWidth: DEFAULT_COLUMN_WIDTHS[column.key],
                  step: COLUMN_RESIZE_STEP,
                  onResize: (width: number) => onResize(column.key, width),
                  onResizeEnd: (width: number) => onResizeEnd(column.key, width),
                })}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One row of the Details view: a cell for each column shown, or, folded, the
 * name over its size and date.
 */
export function DetailsRow({
  id,
  index,
  top,
  height,
  layout,
  template,
  entry,
  selected,
  focused,
  dropTarget,
  query,
  rename,
  menu,
  now,
  onClick,
  onDoubleClick,
  onContextMenu,
  onPointerEnter,
  dropProps,
}: {
  id: string;
  index: number;
  top: number;
  height: number;
  layout: DetailsLayout;
  template: string;
  entry: HostDirEntry;
  selected: boolean;
  focused: boolean;
  dropTarget: boolean;
  query: string;
  /** The inline rename field, while this row is being renamed. */
  rename: ReactNode | null;
  menu: ReactNode;
  now: Date;
  onClick: (event: MouseEvent) => void;
  onDoubleClick: (event: MouseEvent) => void;
  onContextMenu: (event: MouseEvent) => void;
  onPointerEnter: () => void;
  dropProps?: {
    onDragOver: (event: DragEvent) => void;
    onDragLeave: (event: DragEvent) => void;
    onDrop: (event: DragEvent) => void;
  };
}) {
  const isDir = entry.is_dir === true;
  const name = rename ?? <HighlightedName name={entry.name} query={query} className="min-w-0" />;
  const cells: Record<ColumnKey, () => ReactNode> = {
    name: () => (
      <GridCell
        key="name"
        className={cn(
          "relative flex min-w-0 items-center pl-2 pr-8",
          layout.stacked ? "gap-2" : "gap-1.5",
        )}
      >
        {isDir ? (
          <Folder className="size-4 shrink-0 text-info" aria-hidden />
        ) : (
          <FileIcon
            name={entry.name}
            kind={entry.kind}
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
        {layout.stacked ? (
          <div className="flex min-w-0 flex-1 flex-col">
            {name}
            <span
              className="truncate text-[11px] tabular-nums text-muted-foreground"
              title={formatTimestamp(entry.modified_at)}
            >
              {formatEntrySummary(entry, now)}
            </span>
          </div>
        ) : (
          name
        )}
        {menu}
      </GridCell>
    ),
    modified: () => (
      <GridCell
        key="modified"
        className="truncate px-2 text-xs text-muted-foreground"
        title={formatTimestamp(entry.modified_at)}
      >
        {formatModified(entry.modified_at, now)}
      </GridCell>
    ),
    size: () => (
      <GridCell
        key="size"
        className="truncate px-2 text-right text-xs tabular-nums text-muted-foreground"
      >
        {isDir ? "—" : formatSize(entry.size)}
      </GridCell>
    ),
    kind: () => (
      <GridCell key="kind" className="truncate px-2 text-xs text-muted-foreground">
        {kindLabel(entry)}
      </GridCell>
    ),
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: rows of an ARIA grid laid out with CSS grid; <tr>/<td> need a <table>
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid, which names the focused row with aria-activedescendant
    <div
      id={id}
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      data-path={entry.path}
      className={cn(
        "group/filerow absolute inset-x-0 grid cursor-default select-none items-center text-[13px]",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
        focused && "outline outline-1 -outline-offset-1 outline-ring/60",
        dropTarget && "bg-primary/10 outline outline-1 outline-primary",
      )}
      style={{ top, height, gridTemplateColumns: template }}
      onClick={(event) => {
        // A portalled menu's clicks bubble through the React tree; only a
        // click that physically landed in this row is a click on it.
        if (!event.currentTarget.contains(event.target as Node)) return;
        onClick(event);
      }}
      onDoubleClick={(event) => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        onDoubleClick(event);
      }}
      onContextMenu={onContextMenu}
      onPointerEnter={onPointerEnter}
      {...dropProps}
    >
      {layout.columns.map((column) => cells[column.key]())}
    </div>
  );
}

/** One cell of a Details row. */
function GridCell({
  className,
  title,
  children,
}: {
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: rows of an ARIA grid laid out with CSS grid; <tr>/<td> need a <table>
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the grid, which names the focused row with aria-activedescendant
    <div role="gridcell" className={className} title={title}>
      {children}
    </div>
  );
}
