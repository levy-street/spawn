import {
  type Columns,
  columnCapacity,
  drawnColumns,
  drawnShares,
  insertColumn,
  MAX_MEMBERS,
  moveColumn,
  replaceColumn,
} from "@/lib/split-group";

/**
 * The geometry behind the sidebar's workspace drag.
 *
 * The gesture has two halves that are easy to get wrong and hard to see: the
 * point at which dragging a row stops meaning "reorder the rail" and starts
 * meaning "put this workspace on the canvas", and what a drop on a given half
 * of the window should actually do to the split. Both are decided here, from
 * numbers alone, so they can be exercised without a browser — the gesture
 * itself stays in `Sidebar` with the pointer plumbing.
 *
 * What a drop does to the group once it lands — adding, moving or replacing a
 * column — is `split-group`'s arithmetic; this decides which of those a
 * pointer position is asking for.
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

/** A column of the window as it currently stands: which workspace, and where. */
export interface PaneTarget {
  workspaceId: string;
  rect: Rect;
}

/**
 * What the window is drawing, as a drop sees it.
 *
 * Read off the canvas, not off the URL. Those two part company as soon as a
 * split is parked or the address bar is about a column other than the first:
 * the group keeps its own order, and a drop lands where the user aimed
 * regardless of which column the route names.
 */
export interface ShownWindow {
  /** The arrangement on screen: the group when one is, or the one workspace the window shows. */
  members: readonly string[];
  /** Each member's share of the canvas, left to right. */
  sizes: readonly number[];
  /**
   * The members actually drawn, left to right: all of them, unless the window
   * is too narrow to hold the whole group (see `drawnColumns`).
   */
  drawn: readonly string[];
  /** The workspace the address bar is on, or null off a workspace page. */
  routed: string | null;
}

/** A workspace in the window a drop would make, and where it would be drawn. */
export interface PreviewColumn {
  workspaceId: string;
  rect: Rect;
}

/**
 * A lit rectangle a carried workspace can be released into, the window that
 * release makes, and the picture of that window the preview draws.
 *
 * One value rather than a plan plus a preview of it: a preview that can
 * disagree with its own drop is worse than no preview at all, because it is
 * believed. The overlay draws `columns`, and the release applies `next`.
 */
export interface DropZone {
  rect: Rect;
  /** The arrangement a release here leaves behind, or null when it changes nothing. */
  next: Columns | null;
  /**
   * Where the address bar is once a release here has landed: where it was,
   * when that workspace is still drawn alongside the one just placed, or the
   * one just placed when it would otherwise be drawn off the window.
   */
  route: string | null;
  /** That arrangement as it would be drawn, column by column. */
  columns: PreviewColumn[];
}

/** The box the drawn columns span between them. */
function boundsOf(rects: readonly Rect[]): Rect {
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

/**
 * Some columns laid across a canvas the way the window lays them: the run
 * `drawnColumns` chose, at the widths `drawnShares` holds them to on a canvas
 * this wide. The seams between columns take no width of their own, so these
 * are the boxes the panes will actually occupy, to the pixel.
 */
export function layoutColumns(
  canvas: Rect,
  columns: Columns,
  run: { start: number; ids: readonly string[] },
): PreviewColumn[] {
  const width = canvas.right - canvas.left;
  const shares = drawnShares(columns.sizes, run.start, run.ids.length, width);
  const laid: PreviewColumn[] = [];
  let left = canvas.left;
  for (const [offset, share] of shares.entries()) {
    const workspaceId = run.ids[offset];
    if (workspaceId === undefined) continue;
    // Each edge named, never `{...canvas, left, right}`: a canvas is very
    // often built from live `DOMRect`s, whose edges are prototype getters
    // rather than own properties — see `dropZones` below.
    const right = offset === shares.length - 1 ? canvas.right : left + share * width;
    laid.push({ workspaceId, rect: { left, top: canvas.top, right, bottom: canvas.bottom } });
    left = right;
  }
  return laid;
}

/**
 * Where the address bar is after `placedId` lands in `members`. It stays put
 * whenever it can: the workspace it is on is still in the split, and the
 * window that keeps it drawn draws the one just placed too. Otherwise it
 * follows the workspace just placed — on a window too narrow for the whole
 * group, the URL's column and the new one may not both fit, and a drop whose
 * workspace never appeared would be a drop that did nothing.
 */
export function routeAfterDrop(
  members: readonly string[],
  capacity: number,
  previousStart: number,
  placedId: string,
  routedId: string | null,
): string {
  if (!routedId || !members.includes(routedId)) return placedId;
  const kept = drawnColumns(members, capacity, previousStart, placedId, routedId);
  return kept.ids.includes(placedId) ? routedId : placedId;
}

/**
 * The zones a carried workspace can be dropped into, given the window as it
 * stands.
 *
 * While the window has room for another column — fewer than four, and wide
 * enough that every column would keep `MIN_COLUMN_PX` — a workspace from
 * outside it is *added*: there is one zone per place it could go, cut at the
 * middle of each column, so aiming at the left half of a column puts it before
 * that column and the right half after. One workspace on screen is the same
 * rule with a single column: the left half and it takes the front, the right
 * half and it opens beside.
 *
 * A window that is full — four columns, or as many as its width holds — has
 * nowhere to put another, so each column is a zone and a release displaces its
 * occupant: the arrangement keeps its shape and swaps one workspace for
 * another. A workspace that is already one of the columns is never added
 * twice; dropping it on a column moves it there, the others shuffling over,
 * which with two columns is the pair trading sides.
 *
 * The cuts are where the columns' middles are on screen now, so the boundary
 * the pointer flips at is always one the user can see; the preview then draws
 * the window that release would make — the one the window really does draw
 * afterwards, address bar and all (see `routeAfterDrop`).
 */
export function dropZones(
  draggedId: string,
  shown: ShownWindow,
  panes: readonly PaneTarget[],
): DropZone[] {
  const drawn = shown.drawn
    .map((workspaceId) => panes.find((pane) => pane.workspaceId === workspaceId))
    .filter((pane): pane is PaneTarget => Boolean(pane));
  if (!draggedId || drawn.length === 0) return [];
  // Each edge named, never `{...rect, right: seam}`. A `Rect` here is very
  // often a live `DOMRect`, whose edges are prototype getters rather than own
  // properties, so spreading one yields an object with no edges at all — and
  // it typechecks, because DOMRect structurally satisfies `Rect`. Every
  // comparison against the result is then `x >= undefined`, so every point
  // lands outside every zone and no drop is ever offered.
  const canvas = boundsOf(drawn.map(({ rect }) => rect));
  const capacity = columnCapacity(canvas.right - canvas.left);
  const current: Columns = { members: shown.members, sizes: shown.sizes };
  const runStart = Math.max(0, shown.members.indexOf(drawn[0]?.workspaceId ?? ""));
  const asDrawn: PreviewColumn[] = drawn.map(({ workspaceId, rect }) => ({
    workspaceId,
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
  }));
  // A release here, as the window will then draw it: the drop makes the
  // workspace just placed the active column and takes the route where
  // `routeAfterDrop` says, and the window asks `drawnColumns` — the rule it
  // always draws by — from the run it is showing now.
  const landing = (next: Columns | null): Pick<DropZone, "next" | "route" | "columns"> => {
    if (!next) return { next, route: shown.routed, columns: asDrawn };
    const route = routeAfterDrop(next.members, capacity, runStart, draggedId, shown.routed);
    const run = drawnColumns(next.members, capacity, runStart, draggedId, route);
    return { next, route, columns: layoutColumns(canvas, next, run) };
  };

  const member = shown.members.includes(draggedId);
  const room = shown.members.length < MAX_MEMBERS && shown.members.length < capacity;
  if (!member && room) {
    const middles = drawn.map(({ rect }) => (rect.left + rect.right) / 2);
    return Array.from(
      { length: drawn.length + 1 },
      (_, slot): DropZone => ({
        rect: {
          left: middles[slot - 1] ?? canvas.left,
          top: canvas.top,
          right: middles[slot] ?? canvas.right,
          bottom: canvas.bottom,
        },
        ...landing(insertColumn(current, draggedId, slot)),
      }),
    );
  }
  return drawn.map(({ workspaceId, rect }): DropZone => {
    const at = shown.members.indexOf(workspaceId);
    const next = member
      ? moveColumn(current, draggedId, at)
      : replaceColumn(current, at, draggedId);
    return {
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      ...landing(next),
    };
  });
}

/** The zone under a point, or null when the point is outside every zone. */
export function zoneAt(x: number, y: number, zones: readonly DropZone[]): DropZone | null {
  return zones.find((zone) => pointInRect(x, y, zone.rect)) ?? null;
}

/**
 * The workspaces each sidebar row holds, in the order the rows are drawn.
 *
 * A split renders its workspaces as one grouped row rather than one each, and
 * that row sits at whichever member comes first in the existing order — so
 * opening a split collapses its rows into one where the uppermost of them
 * was, and never reshuffles the list. The group is always listed in its own
 * left-to-right order regardless of which member anchored the row, because the
 * row is drawn to match the columns on screen.
 */
export function groupRows(
  orderedIds: readonly string[],
  members: readonly string[] | null,
): string[][] {
  const positions = (members ?? []).map((id) => orderedIds.indexOf(id));
  // Any member missing — filtered out by a search, archived, not loaded yet —
  // and the row would be a picture of some other window; every one of them
  // falls back to a row of its own.
  if (!members || members.length < 2 || positions.some((position) => position < 0)) {
    return orderedIds.map((id) => [id]);
  }
  const anchor = Math.min(...positions);
  const absorbed = new Set(members);
  return orderedIds.flatMap((id, index) => {
    if (index === anchor) return [[...members]];
    return absorbed.has(id) ? [] : [[id]];
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
 * A row can hold a whole split, so the index counted over rows is not the
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
    // The first of the group goes where the row was dropped; the rest follow
    // immediately behind it, which is what keeps a carried split together.
    const position =
      order === 0 || previous === undefined
        ? indexAfterSettled(without, settledAbove, moving)
        : without.indexOf(previous) + 1;
    writes.push({ id, position });
    simulated = [...without.slice(0, position), id, ...without.slice(position)];
  }
  return writes;
}
