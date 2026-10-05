import type { SortKey } from "./sort";

/**
 * The Details view's columns: which there are, how wide each starts, how
 * narrow a drag may make it, which of them a panel of a given width shows,
 * and reading widths back from device storage. Name takes whatever room is
 * left over its own width, so the table always fills its panel; the others
 * are exactly as wide as they were dragged.
 *
 * Pure and DOM-free.
 */

export type ColumnKey = SortKey;

export interface ColumnSpec {
  key: ColumnKey;
  label: string;
  /** Numbers read right-aligned so their digits line up. */
  align: "start" | "end";
}

export const COLUMNS: readonly ColumnSpec[] = [
  { key: "name", label: "Name", align: "start" },
  { key: "modified", label: "Date modified", align: "start" },
  { key: "size", label: "Size", align: "end" },
  { key: "kind", label: "Kind", align: "start" },
];

export type ColumnWidths = Record<ColumnKey, number>;

export const DEFAULT_COLUMN_WIDTHS: ColumnWidths = {
  name: 280,
  modified: 180,
  size: 88,
  kind: 140,
};

export const MIN_COLUMN_WIDTHS: ColumnWidths = {
  name: 140,
  modified: 96,
  size: 64,
  kind: 72,
};

export const MAX_COLUMN_WIDTH = 960;

/** One keyboard step of a column's resize handle. */
export const COLUMN_RESIZE_STEP = 16;

export function clampColumnWidth(key: ColumnKey, width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_COLUMN_WIDTHS[key];
  return Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTHS[key], width)));
}

export function resizeColumn(widths: ColumnWidths, key: ColumnKey, width: number): ColumnWidths {
  const next = clampColumnWidth(key, width);
  return next === widths[key] ? widths : { ...widths, [key]: next };
}

/** Stored widths, read back tolerantly, one column at a time. */
export function parseColumnWidths(raw: unknown): ColumnWidths {
  const value = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const widths = { ...DEFAULT_COLUMN_WIDTHS };
  for (const column of COLUMNS) {
    const stored = value[column.key];
    if (typeof stored === "number") widths[column.key] = clampColumnWidth(column.key, stored);
  }
  return widths;
}

/**
 * What a Details view shows at the width it has: its columns, left to right,
 * or — `stacked` — Name alone, with each row folded into two lines.
 */
export interface DetailsLayout {
  columns: readonly ColumnSpec[];
  /**
   * Each row is the name over a line of its size and date, as the phone's
   * file row reads, rather than a row of cells.
   */
  stacked: boolean;
}

const ALL_COLUMNS: DetailsLayout = { columns: COLUMNS, stacked: false };
const WITHOUT_KIND: DetailsLayout = {
  columns: COLUMNS.filter((column) => column.key !== "kind"),
  stacked: false,
};
const STACKED: DetailsLayout = {
  columns: COLUMNS.filter((column) => column.key === "name"),
  stacked: true,
};

/**
 * The columns a panel `available` pixels wide shows, so the table never
 * scrolls sideways. Name is always there, at its own width at least; the
 * others follow it while they fit beside it at theirs, and the first to go
 * is Kind, which the icon already says. Narrower than Name, Date modified
 * and Size side by side, the rows fold: Name over the size and the date, the
 * phone's own file row. Until the panel has been measured, everything shows.
 *
 * `widths` are the widths the person settled on, not the ones a drag in
 * progress is trying: a column must not vanish from under the pointer.
 */
export function detailsLayout(
  widths: ColumnWidths,
  available: number | null | undefined,
): DetailsLayout {
  if (typeof available !== "number" || !Number.isFinite(available)) return ALL_COLUMNS;
  if (minimumTableWidth(widths, ALL_COLUMNS) <= available) return ALL_COLUMNS;
  if (minimumTableWidth(widths, WITHOUT_KIND) <= available) return WITHOUT_KIND;
  return STACKED;
}

/** The CSS grid track list shared by the header and every row. */
export function columnTemplate(widths: ColumnWidths, layout: DetailsLayout = ALL_COLUMNS): string {
  // Folded, the one column is the panel's width, however narrow that is.
  if (layout.stacked) return "minmax(0, 1fr)";
  return layout.columns
    .map((column) =>
      column.key === "name" ? `minmax(${widths.name}px, 1fr)` : `${widths[column.key]}px`,
    )
    .join(" ");
}

/** The narrowest the table can be before it scrolls sideways; folded, any width. */
export function minimumTableWidth(
  widths: ColumnWidths,
  layout: DetailsLayout = ALL_COLUMNS,
): number {
  if (layout.stacked) return 0;
  return layout.columns.reduce((sum, column) => sum + widths[column.key], 0);
}
