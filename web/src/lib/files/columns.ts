import type { SortKey } from "./sort";

/**
 * The Details view's columns: which there are, how wide each starts, how
 * narrow a drag may make it, and reading widths back from device storage.
 * Name takes whatever room is left over its own width, so the table always
 * fills its panel; the others are exactly as wide as they were dragged.
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

/** The CSS grid track list shared by the header and every row. */
export function columnTemplate(widths: ColumnWidths): string {
  return COLUMNS.map((column) =>
    column.key === "name" ? `minmax(${widths.name}px, 1fr)` : `${widths[column.key]}px`,
  ).join(" ");
}

/** The narrowest the table can be before it scrolls sideways. */
export function minimumTableWidth(widths: ColumnWidths): number {
  return COLUMNS.reduce((sum, column) => sum + widths[column.key], 0);
}
