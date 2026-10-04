/**
 * Which rows of a long, fixed-height list are worth putting in the DOM.
 *
 * A folder can hold 1,024 entries and a tree several such folders, and a row
 * per entry made a big folder slow to scroll and slower to poll. Rows are a
 * fixed height in each density, so the visible slice is arithmetic: the rows
 * under the viewport plus a margin either side, so a fast wheel never shows
 * a gap before React catches up.
 *
 * Pure and DOM-free.
 */

export const DEFAULT_OVERSCAN = 8;

export interface VirtualWindow {
  /** First rendered row (inclusive). */
  start: number;
  /** Last rendered row (exclusive). */
  end: number;
  /** Height of every row together, for the scroll extent. */
  total: number;
}

export function virtualWindow({
  count,
  rowHeight,
  scrollTop,
  viewportHeight,
  overscan = DEFAULT_OVERSCAN,
}: {
  count: number;
  rowHeight: number;
  /** How far the rows themselves have scrolled (header excluded). */
  scrollTop: number;
  /** How much of the rows can be seen at once (header excluded). */
  viewportHeight: number;
  overscan?: number;
}): VirtualWindow {
  const total = Math.max(0, count) * rowHeight;
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, total };
  // Before the first layout there is no viewport yet: render a screenful.
  const height = viewportHeight > 0 ? viewportHeight : rowHeight * 40;
  const top = Math.max(0, scrollTop);
  const first = Math.floor(top / rowHeight);
  const last = Math.ceil((top + height) / rowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, last + overscan),
    total,
  };
}

/**
 * The scroll position that brings row `index` fully into view, or null when
 * it already is — so arrowing through a list scrolls only at its edges.
 */
export function revealScrollTop({
  index,
  rowHeight,
  scrollTop,
  viewportHeight,
}: {
  index: number;
  rowHeight: number;
  scrollTop: number;
  viewportHeight: number;
}): number | null {
  if (index < 0 || rowHeight <= 0 || viewportHeight <= 0) return null;
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return null;
}

/** Rows a Page Up/Down jumps: a screenful, less one so a row stays for context. */
export function pageRows(rowHeight: number, viewportHeight: number): number {
  if (rowHeight <= 0) return 1;
  return Math.max(1, Math.floor(viewportHeight / rowHeight) - 1);
}
