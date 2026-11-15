/**
 * Which columns the split container keeps mounted, and how wide each is drawn.
 *
 * The group says which workspaces are on screen; this decides how the window
 * gets from the columns it has to the ones it is asked for. A column that
 * arrives sweeps open from its seam, one that goes folds into it, and the
 * ones that stay slide to their new widths on the same clock — so adding a
 * third workspace reads as the window making room, not as a cut. Kept apart
 * from the component so the rules can be exercised without a browser.
 */

/**
 * A column as mounted: settled at its share, flat at the seam waiting for the
 * frame that sweeps it open, or on its way out and held mounted until its
 * collapse has finished.
 */
export type ColumnState = "in" | "entering" | "leaving";

export interface MountedColumn {
  id: string;
  state: ColumnState;
}

/** Everything mounted and settled, as a window draws on its first frame. */
export function settledColumns(ids: readonly string[]): MountedColumn[] {
  return ids.map((id) => ({ id, state: "in" }));
}

/**
 * The columns to mount for `next`, given those mounted now.
 *
 * A window that shares no workspace with the one before it is a different
 * window, not a rearranged one — opening another workspace, or arriving at a
 * parked split from outside it — and is drawn as it is, at once: sweeping
 * every column in and out would turn each navigation into an animation.
 *
 * Otherwise the columns that stay keep their place in the new order, a
 * newcomer arrives flat at its seam, and one that is no longer wanted stays
 * mounted at the seam it is folding into, just after the column that was to
 * its left, until it has finished going.
 */
export function mountColumns(
  previous: readonly MountedColumn[],
  next: readonly string[],
): MountedColumn[] {
  const showing = previous.filter((column) => column.state !== "leaving").map(({ id }) => id);
  if (!next.some((id) => showing.includes(id))) return settledColumns(next);

  const result: MountedColumn[] = next.map((id) => {
    const was = previous.find((column) => column.id === id);
    // One brought back while it was still folding away settles from where it
    // is, and one that has not had its opening frame yet keeps waiting for it.
    return { id, state: !was ? "entering" : was.state === "entering" ? "entering" : "in" };
  });
  for (const [index, column] of previous.entries()) {
    if (next.includes(column.id)) continue;
    let at = 0;
    for (let left = index - 1; left >= 0; left -= 1) {
      const neighbour = previous[left];
      const found = neighbour ? result.findIndex(({ id }) => id === neighbour.id) : -1;
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    result.splice(at, 0, { id: column.id, state: "leaving" });
  }
  return result;
}

/** The opening frame has passed: every arriving column sweeps out to its share. */
export function settleEntering(columns: readonly MountedColumn[]): MountedColumn[] {
  return columns.some(({ state }) => state === "entering")
    ? columns.map((column) => (column.state === "entering" ? { ...column, state: "in" } : column))
    : [...columns];
}

/** The collapse has finished: the columns that were going are gone. */
export function dropLeaving(columns: readonly MountedColumn[]): MountedColumn[] {
  return columns.filter(({ state }) => state !== "leaving");
}

/**
 * Each settled column's share of the canvas, from the group's widths, scaled
 * so the settled ones fill it between them. Columns arriving or going have no
 * share: they are drawn flat at their seam, and the others keep the canvas
 * full around them — so for one frame an arriving column takes nothing and the
 * window looks exactly as it did, which is what lets the next frame sweep.
 */
export function settledShares(
  columns: readonly MountedColumn[],
  members: readonly string[],
  sizes: readonly number[],
): Map<string, number> {
  const settled = columns.filter(({ state }) => state === "in").map(({ id }) => id);
  const weights = settled.map((id) => sizes[members.indexOf(id)] ?? 0);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return new Map(
    settled.map((id, index) => [
      id,
      total > 0 ? (weights[index] ?? 0) / total : 1 / settled.length,
    ]),
  );
}
