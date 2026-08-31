import { clampRatio, type SplitSide } from "@/lib/split-store";

/**
 * The geometry behind the sidebar's workspace drag.
 *
 * The gesture has two halves that are easy to get wrong and hard to see: the
 * point at which dragging a row stops meaning "reorder the rail" and starts
 * meaning "put this workspace on the canvas", and what a drop on a given half
 * of the window should actually do to the split. Both are decided here, from
 * numbers alone, so they can be exercised without a browser — the gesture
 * itself stays in `Sidebar` with the pointer plumbing.
 */

/** A viewport-space box: the four edges `getBoundingClientRect` reports. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * What the gesture is doing at this instant. It swaps live as the pointer
 * moves — over the rail the row is being reordered, past its edge the row is
 * being carried onto the canvas — and either transition is reversible without
 * lifting.
 */
export type DragMode = "reorder" | "carry";

/** Edges count as inside: a pointer resting exactly on the rail is on it. */
export function pointInRect(x: number, y: number, rect: Rect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/**
 * Which mode a pointer position implies. No rail on screen keeps the gesture
 * in reorder: the drag started in the rail, and a sidebar that went away
 * underneath it is not the user asking for a split.
 */
export function dragModeAt(x: number, y: number, railRect: Rect | null): DragMode {
  if (!railRect) return "reorder";
  return pointInRect(x, y, railRect) ? "reorder" : "carry";
}

/**
 * Where a row released at `clientY` belongs: the number of other rows whose
 * midpoint the release point has passed. The rects are the resting ones —
 * rows slide under transforms while the drag is live, so live geometry would
 * chase the answer it just produced.
 */
export function reorderTargetIndex(
  clientY: number,
  restingRects: readonly (Rect | null | undefined)[],
  fromIndex: number,
): number {
  let target = 0;
  for (const [index, rect] of restingRects.entries()) {
    if (index === fromIndex || !rect) continue;
    if (clientY > rect.top + (rect.bottom - rect.top) / 2) target += 1;
  }
  return target;
}

/**
 * How far a neighbour slides to open the gap the dragged row would land in.
 * Everything between the row's own slot and its prospective one moves by one
 * stride, so the drop target is always a visible hole rather than a guess.
 */
export function reorderShift(
  index: number,
  fromIndex: number,
  targetIndex: number,
  stride: number,
): number {
  if (index === fromIndex) return 0;
  if (fromIndex < targetIndex && index > fromIndex && index <= targetIndex) return -stride;
  if (fromIndex > targetIndex && index < fromIndex && index >= targetIndex) return stride;
  return 0;
}

/** A half of the window as it currently stands: which side, and where. */
export interface PaneTarget {
  side: SplitSide;
  rect: Rect;
}

/** A lit rectangle a carried workspace can be released into. */
export interface DropZone {
  side: SplitSide;
  rect: Rect;
}

/**
 * The zones a carried row can be dropped into, given the halves on screen.
 *
 * One workspace has no halves yet, so its root is offered as two: release on
 * the left and the dragged workspace takes the front, release on the right
 * and it opens beside. Two workspaces already have their halves, and each is
 * a single zone — sub-dividing them would ask the user to aim at a quarter of
 * the window for a distinction the window is not making.
 *
 * The undivided root is cut at `ratio` rather than down the middle, because
 * these rectangles are also what the drop preview is drawn in: cutting the
 * hit region anywhere other than where the seam will actually land would put
 * the boundary the pointer flips at somewhere the user cannot see it.
 */
export function dropZones(panes: readonly PaneTarget[], ratio: number): DropZone[] {
  const only = panes.length === 1 ? panes[0] : null;
  if (!only) return panes.map((pane) => ({ side: pane.side, rect: pane.rect }));
  const { left, top, right, bottom } = only.rect;
  const seam = left + (right - left) * clampRatio(ratio);
  // Each edge named, never `{...rect, right: seam}`. A `Rect` here is very
  // often a live `DOMRect`, whose edges are prototype getters rather than own
  // properties, so spreading one yields an object with no edges at all — and
  // it typechecks, because DOMRect structurally satisfies `Rect`. Every
  // comparison against the result is then `x >= undefined`, so every point
  // lands outside every zone and no drop is ever offered.
  return [
    { side: "primary", rect: { left, top, right: seam, bottom } },
    { side: "secondary", rect: { left: seam, top, right, bottom } },
  ];
}

/** The zone under a point, or null when the point is outside every zone. */
export function zoneAt(x: number, y: number, zones: readonly DropZone[]): DropZone | null {
  return zones.find((zone) => pointInRect(x, y, zone.rect)) ?? null;
}

/** Which workspace sits in each half of the window. `secondary` null is one. */
export interface Arrangement {
  primary: string | null;
  secondary: string | null;
}

/**
 * The window a release on `side` would leave behind, or null when the drop
 * asks for the arrangement already on screen and the gesture should simply
 * end.
 *
 * `shown` is what is on the canvas right now, left and right — not what the
 * URL says. Those two part company as soon as a split is parked: the pair
 * keeps its own order, the address bar may be about either half of it, and a
 * drop lands where the user aimed regardless.
 *
 * The rule a drop obeys is "it goes where I dropped it", which for a half
 * that is already occupied means its occupant has to go somewhere: it moves
 * across rather than being closed, if there is room. Dropping a workspace
 * onto the half it is not already in therefore reads as the two swapping
 * sides — the alternative, refusing the arrangement where a workspace would
 * sit beside itself, would silently collapse the split and lose a workspace
 * nobody asked to close.
 *
 * One function rather than a plan plus a preview of it: a preview that can
 * disagree with its own drop is worse than no preview at all, because it is
 * believed. The overlay draws this, and the release applies it.
 */
export function splitDrop(
  side: SplitSide,
  draggedId: string,
  shown: Arrangement,
): Arrangement | null {
  const { primary, secondary } = shown;
  if (!draggedId || !primary) return null;
  if (side === "primary") {
    if (draggedId === primary) return null;
    // The left half's occupant moves across, unless a third workspace is
    // already holding the right — then it is the one displaced.
    if (secondary === null || draggedId === secondary) {
      return { primary: draggedId, secondary: primary };
    }
    return { primary: draggedId, secondary };
  }
  if (draggedId === secondary) return null;
  // The one workspace on screen, dropped onto its own right half: there is no
  // second workspace for it to trade places with, so nothing happens.
  if (draggedId === primary) {
    if (secondary === null) return null;
    return { primary: secondary, secondary: primary };
  }
  return { primary, secondary: draggedId };
}

/**
 * Which half a workspace occupies in an arrangement, or null when it is not
 * in it at all — which for the preview is what "displaced" means, and is why
 * this answers with null rather than defaulting to a side.
 */
export function sideOf(workspaceId: string, arrangement: Arrangement): SplitSide | null {
  if (workspaceId === arrangement.primary) return "primary";
  if (workspaceId === arrangement.secondary) return "secondary";
  return null;
}

/**
 * The workspaces each sidebar row holds, in the order the rows are drawn.
 *
 * A split renders its two workspaces as one paired row rather than two, and
 * that row sits at whichever of the pair comes first in the existing order —
 * so opening a split collapses two rows into one where the upper of them was,
 * and never reshuffles the list. The pair is always listed primary-then-
 * secondary regardless of which anchored the row, because those two
 * containers are drawn left-to-right to match the halves on screen.
 */
export function pairRows(
  orderedIds: readonly string[],
  primaryId: string | null,
  secondaryId: string | null,
): string[][] {
  const primaryAt = primaryId ? orderedIds.indexOf(primaryId) : -1;
  const secondaryAt = secondaryId ? orderedIds.indexOf(secondaryId) : -1;
  // Either one missing — filtered out by a search, archived, not loaded yet —
  // and there is no pair to draw; both fall back to rows of their own.
  if (!primaryId || !secondaryId || primaryAt < 0 || secondaryAt < 0) {
    return orderedIds.map((id) => [id]);
  }
  const anchor = Math.min(primaryAt, secondaryAt);
  const absorbed = Math.max(primaryAt, secondaryAt);
  return orderedIds.flatMap((id, index) => {
    if (index === absorbed) return [];
    return index === anchor ? [[primaryId, secondaryId]] : [[id]];
  });
}

/**
 * Where to insert so the item lands after exactly `count` of the workspaces
 * that are staying put. The ones being moved are skipped rather than counted:
 * they are leaving these positions, so they cannot be landmarks for them.
 */
function indexAfterSettled(
  list: readonly string[],
  count: number,
  moving: ReadonlySet<string>,
): number {
  let settled = 0;
  for (const [index, id] of list.entries()) {
    if (settled === count && !moving.has(id)) return index;
    if (!moving.has(id)) settled += 1;
  }
  return list.length;
}

/**
 * The position writes that move the row at `fromRowIndex` to `targetRowIndex`.
 *
 * A row can hold two workspaces, so the index counted over rows is not the
 * position the server stores and one row can need more than one write. The
 * server reorders by removing and reinserting, so each write is computed
 * against the list as the previous write leaves it rather than against the
 * finished order — targeting final indices directly does not converge, since
 * the first write moves the ground the second is measured from.
 *
 * A row of one workspace yields exactly the single write this always made.
 */
export function reorderWrites(
  rows: readonly (readonly string[])[],
  fromRowIndex: number,
  targetRowIndex: number,
): { id: string; position: number }[] {
  const dragged = rows[fromRowIndex];
  if (!dragged || dragged.length === 0) return [];
  const staying = rows.filter((_, index) => index !== fromRowIndex);
  const settledAbove = staying
    .slice(0, targetRowIndex)
    .reduce((total, row) => total + row.length, 0);
  const moving = new Set(dragged);
  const writes: { id: string; position: number }[] = [];
  let simulated = rows.flat();
  for (const [order, id] of dragged.entries()) {
    const without = simulated.filter((candidate) => candidate !== id);
    const previous = dragged[order - 1];
    // The first of the pair goes where the row was dropped; the rest follow
    // immediately behind it, which is what keeps a carried pair a pair.
    const position =
      order === 0 || previous === undefined
        ? indexAfterSettled(without, settledAbove, moving)
        : without.indexOf(previous) + 1;
    writes.push({ id, position });
    simulated = [...without.slice(0, position), id, ...without.slice(position)];
  }
  return writes;
}
