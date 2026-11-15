/**
 * The arithmetic of a split: which workspaces stand side by side, in what
 * order, and how wide each column is.
 *
 * A split is an ordered group of two to four workspaces drawn as columns,
 * left to right, with a seam between each pair of neighbours. Everything here
 * is numbers and ids — no storage, no React, no DOM — so that the rules the
 * window, the sidebar and the drop preview all have to agree on are decided in
 * one place and exercised without a browser. `split-store` holds the group;
 * this is what it, and everything drawing it, does to one.
 *
 * Widths are kept per column, not per workspace. A column is a slot of the
 * window, and the window's shape is the user's: swapping or moving workspaces
 * between slots changes what is in them and leaves every seam where it was.
 * Only adding or removing a column changes the shape, and then by as little
 * as it can.
 */

/** Fewer than this is one workspace, not a split. */
export const MIN_MEMBERS = 2;
/** The most workspaces a window draws side by side. */
export const MAX_MEMBERS = 4;

/**
 * The narrowest a column may be when the window is asked to hold another one.
 * A terminal of about thirty-five columns with its tab strip still legible;
 * narrower than that and a workspace is a name and a scrollbar.
 *
 * It decides how many columns a canvas holds (`columnCapacity`), which in turn
 * decides whether a drop may add a column and how many of a group are drawn on
 * a window that has since narrowed. It never applies to two: a split of two is
 * drawn at whatever width the window has, as it always was.
 */
export const MIN_COLUMN_PX = 280;

/** How far one arrow press moves a seam, as a share of the canvas. */
export const SEAM_STEP = 0.02;

/** Some columns: which workspace is in each, and each one's share. */
export interface Columns {
  /** Left to right, all different. */
  members: readonly string[];
  /** Each column's share of the canvas, left to right: positive, summing to 1. */
  sizes: readonly number[];
}

/**
 * The narrowest share a column may be dragged to: half of an even share. Two
 * columns therefore stop at a quarter and three quarters, exactly where the
 * single seam always stopped, and four stop at an eighth — still a column, and
 * still a seam you can drag back.
 */
export function minShare(count: number): number {
  return count > 0 ? 0.5 / count : 0;
}

export function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Hold every column at or above its minimum share, taking what that costs
 * from the others in proportion to their width, so the total stays one.
 *
 * Water-filling rather than one pass: lifting a column to the floor can push a
 * neighbour under it, so a pinned column stays pinned and the rest are scaled
 * again. It always ends — the floor is half an even share, so the columns left
 * free can always share what is left above it.
 */
export function clampSizes(sizes: readonly number[]): number[] {
  const count = sizes.length;
  if (count === 0) return [];
  if (!(sum(sizes) > 0)) return evenSizes(count);
  const floor = minShare(count);
  const pinned = new Set<number>();
  let result = [...sizes];
  for (let pass = 0; pass <= count; pass += 1) {
    const free = result.map((_, index) => index).filter((index) => !pinned.has(index));
    const budget = 1 - pinned.size * floor;
    const freeTotal = sum(free.map((index) => sizes[index] ?? 0));
    result = result.map((_, index) =>
      pinned.has(index) ? floor : ((sizes[index] ?? 0) * budget) / (freeTotal || 1),
    );
    const under = free.filter((index) => (result[index] ?? 0) < floor);
    if (under.length === 0) return result;
    for (const index of under) pinned.add(index);
  }
  return result;
}

/**
 * Coerce anything into `count` usable shares: the given ones if they are all
 * positive numbers, scaled to sum to one and held off the floor; an even split
 * for anything else, which is the answer that cannot surprise anyone.
 */
export function normalizeSizes(raw: unknown, count: number): number[] {
  if (count <= 0) return [];
  if (!Array.isArray(raw) || raw.length !== count) return evenSizes(count);
  if (!raw.every((value) => typeof value === "number" && Number.isFinite(value) && value > 0)) {
    return evenSizes(count);
  }
  const total = sum(raw as number[]);
  return clampSizes((raw as number[]).map((value) => value / total));
}

/**
 * A group of two to four real, different workspaces, or null for anything
 * else. All or nothing: a list with a hole in it, a repeat, or too many
 * entries names no arrangement anyone built, and guessing which part of it was
 * meant would put workspaces on screen nobody asked for.
 */
export function toGroup(members: unknown, sizes: unknown): Columns | null {
  if (!Array.isArray(members)) return null;
  if (members.length < MIN_MEMBERS || members.length > MAX_MEMBERS) return null;
  if (!members.every((id) => typeof id === "string" && id.length > 0)) return null;
  if (new Set(members).size !== members.length) return null;
  const ids = members as string[];
  return { members: ids, sizes: normalizeSizes(sizes, ids.length) };
}

/**
 * A column added at `at`, or null when it cannot be: the workspace is already
 * one of them, or the window is full.
 *
 * The newcomer takes an even share of the window it joins, and the columns
 * already there give it up in proportion — so a seam the user moved stays
 * where it is relative to its neighbours, and nothing is reset to make room.
 */
export function insertColumn(columns: Columns, workspaceId: string, at: number): Columns | null {
  const { members, sizes } = columns;
  if (!workspaceId || members.includes(workspaceId)) return null;
  if (members.length >= MAX_MEMBERS) return null;
  const count = members.length + 1;
  const index = Math.min(Math.max(0, at), members.length);
  const scaled = sizes.map((size) => (size * (count - 1)) / count);
  return {
    members: [...members.slice(0, index), workspaceId, ...members.slice(index)],
    sizes: clampSizes([...scaled.slice(0, index), 1 / count, ...scaled.slice(index)]),
  };
}

/**
 * The columns without `workspaceId`, its width shared back among the rest in
 * proportion. Unchanged when it was not one of them. May leave a single
 * column — whether that is still a split is the caller's question.
 */
export function removeColumn(columns: Columns, workspaceId: string): Columns {
  const index = columns.members.indexOf(workspaceId);
  if (index < 0) return columns;
  const members = columns.members.filter((_, at) => at !== index);
  const kept = columns.sizes.filter((_, at) => at !== index);
  const total = sum(kept);
  return {
    members,
    sizes: total > 0 ? clampSizes(kept.map((size) => size / total)) : evenSizes(members.length),
  };
}

/**
 * `workspaceId` into the column at `at`, or null when it is already there.
 *
 * A workspace that is already elsewhere in the window trades places with the
 * one it displaces, rather than the window ending up with it twice or losing a
 * column nobody asked to close. One from outside displaces the occupant, which
 * leaves the split. The columns keep their widths either way.
 */
export function replaceColumn(columns: Columns, at: number, workspaceId: string): Columns | null {
  const { members, sizes } = columns;
  const occupant = members[at];
  if (occupant === undefined || !workspaceId || occupant === workspaceId) return null;
  const from = members.indexOf(workspaceId);
  const next = [...members];
  next[at] = workspaceId;
  if (from >= 0) next[from] = occupant;
  return { members: next, sizes: [...sizes] };
}

/**
 * A member moved to column `to`, the ones between shuffling over to close the
 * gap it leaves, or null when it is already there. The columns keep their
 * widths: it is the workspaces that move, not the seams. With two columns this
 * is the two trading places.
 */
export function moveColumn(columns: Columns, workspaceId: string, to: number): Columns | null {
  const { members, sizes } = columns;
  const from = members.indexOf(workspaceId);
  const target = Math.min(Math.max(0, to), members.length - 1);
  if (from < 0 || from === target) return null;
  const without = members.filter((id) => id !== workspaceId);
  return {
    members: [...without.slice(0, target), workspaceId, ...without.slice(target)],
    sizes: [...sizes],
  };
}

/** Where seam `seam` — the one after column `seam` — sits, as a share of the canvas. */
export function seamPosition(sizes: readonly number[], seam: number): number {
  return sum(sizes.slice(0, seam + 1));
}

/**
 * Move one seam to `boundary`, a share of the canvas measured from its left
 * edge. Only the two columns either side of it change, and between them they
 * keep the width they had: every other seam stays exactly where it was. Held
 * so neither neighbour drops under its floor, so a caller may hand it raw
 * pointer arithmetic. A boundary that is not a number moves nothing.
 */
export function moveSeam(sizes: readonly number[], seam: number, boundary: number): number[] {
  const left = sizes[seam];
  const right = sizes[seam + 1];
  if (left === undefined || right === undefined || !Number.isFinite(boundary)) return [...sizes];
  const floor = minShare(sizes.length);
  const start = seamPosition(sizes, seam - 1);
  const pair = left + right;
  const nextLeft = Math.min(pair - floor, Math.max(floor, boundary - start));
  const next = [...sizes];
  next[seam] = nextLeft;
  next[seam + 1] = pair - nextLeft;
  return next;
}

/**
 * How many columns a canvas this wide holds: as many as leave each one at
 * least `MIN_COLUMN_PX`, never more than the most a split may have, and never
 * fewer than two — a split of two is drawn at any width. A width nobody has
 * measured yet holds them all, so a group is not folded before the window has
 * said anything about how wide it is.
 */
export function columnCapacity(widthPx: number): number {
  if (!Number.isFinite(widthPx) || widthPx <= 0) return MAX_MEMBERS;
  return Math.min(MAX_MEMBERS, Math.max(MIN_MEMBERS, Math.floor(widthPx / MIN_COLUMN_PX)));
}

/**
 * The first of the columns a window too narrow for the whole group draws.
 *
 * A group of three or four on a window that has since narrowed is not
 * dismantled and not crushed into slivers: the window draws as many
 * neighbouring columns as fit, and the rest stay in the group, listed in the
 * sidebar, back the moment there is room. Which run is drawn scrolls like a
 * viewport — as little as it has to, to keep `focusIndex` (the column being
 * worked in) on screen — so clicking into a column already drawn never slides
 * the window out from under the pointer.
 */
export function visibleRun(
  count: number,
  capacity: number,
  previousStart: number,
  focusIndex: number,
): number {
  if (count <= capacity) return 0;
  const lastStart = count - capacity;
  let start = Math.min(Math.max(0, previousStart), lastStart);
  if (focusIndex >= 0 && focusIndex < count) {
    if (focusIndex < start) start = focusIndex;
    else if (focusIndex >= start + capacity) start = focusIndex - capacity + 1;
  }
  return start;
}

/** The shares of `length` columns from `start`, scaled to fill the canvas between them. */
export function runShares(sizes: readonly number[], start: number, length: number): number[] {
  const run = sizes.slice(start, start + length);
  const total = sum(run);
  return total > 0 ? run.map((size) => size / total) : evenSizes(run.length);
}

/**
 * Shares for the drawn run written back into the whole group's sizes: the run
 * keeps the total it had, so the columns that are not drawn keep theirs.
 */
export function withRunShares(
  sizes: readonly number[],
  start: number,
  shares: readonly number[],
): number[] {
  const total = sum(sizes.slice(start, start + shares.length));
  const next = [...sizes];
  for (const [offset, share] of shares.entries()) next[start + offset] = share * total;
  return next;
}
