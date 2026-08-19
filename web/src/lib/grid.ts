/**
 * Pure 12×12 packed-grid algebra for workspace layout schema v2.
 *
 * Contract: docs/OVERHAUL.md §4.4. The cross-language conformance suite in
 * proto/layout-v2-fixtures.json is the authority on every behavior here and is
 * shared with the Python twin (server/spawn_server/grid.py); both
 * implementations must pass every fixture case. Behavior the §4.4 prose leaves
 * open is pinned by the fixture file's `_rules` list.
 *
 * The canvas is free-form: `move` and `resize` never repack, so gaps between
 * tiles are a normal, persistable state (`remove` is the one operation that
 * closes a gap, and only the one it just made).
 *
 * Except for `validate`, every function assumes a valid tile list (as defined
 * by `validate`): integer geometry, in bounds, at least 2×2, no overlaps, at
 * most 8 tiles, unique session ids. All functions are deterministic (no
 * randomness, no ambient state), total on valid input, and never mutate their
 * arguments. Returned tile arrays are always sorted in reading order (y, then
 * x); on valid input that order is unambiguous because two tiles can never
 * share an origin cell.
 */

export const GRID_SIZE = 12;
export const MIN_TILE_SIZE = 2;
export const MAX_TILES = 8;

/**
 * Non-session pane content. A widget tile's `session_id` is its own id — the
 * algebra only requires a unique non-empty string, and the server keeps
 * widget tiles instead of pruning them against the session table.
 */
export interface TileWidget {
  kind: "files";
  host_id: string;
  path: string;
}

export interface Tile {
  session_id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Absent for session tiles; the algebra carries it through untouched. */
  widget?: TileWidget;
}

export interface LayoutV2 {
  version: 2;
  tiles: Tile[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** v1 split-tree layout (pre-overhaul screens), consumed by `fromSplitTree`. */
export type SplitTreePane = { type: "pane"; agent_id: string };
export type SplitTreeSplit = {
  type: "split";
  direction: "row" | "column";
  ratio: number;
  a: SplitTreeNode;
  b: SplitTreeNode;
};
export type SplitTreeNode = SplitTreePane | SplitTreeSplit;

export type LayoutErrorCode =
  | "shape" // layout is not an object, or `tiles` is not an array
  | "version" // `version` is not exactly 2
  | "count" // more than MAX_TILES tiles
  | "session_id" // tile session_id is missing or not a non-empty string
  | "integer" // x/y/w/h are not all integers
  | "bounds" // tile extends outside the 12×12 canvas
  | "size" // w or h below MIN_TILE_SIZE (one error per tile)
  | "duplicate" // session_id already used by an earlier tile
  | "overlap"; // two tiles overlap

export interface LayoutError {
  code: LayoutErrorCode;
  /** Index of the offending tile in `tiles`, when one is identifiable. */
  index?: number;
  /** duplicate: index of the first occurrence. overlap: index of the second tile. */
  other_index?: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: LayoutError[];
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Copies tiles into reading order — (y, x) ascending. */
function sortTiles(tiles: Tile[]): Tile[] {
  return [...tiles].sort((a, b) => a.y - b.y || a.x - b.x).map((t) => ({ ...t }));
}

/** True when `rect` overlaps no tile in `tiles` (excluding index `skip`). */
function fitsAt(tiles: Tile[], rect: Rect, skip = -1): boolean {
  for (let i = 0; i < tiles.length; i++) {
    if (i === skip) continue;
    if (overlaps(tiles[i], rect)) return false;
  }
  return true;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Checks the §4.4 invariants on an arbitrary value. Errors are reported in a
 * fixed order: shape (alone, when the value has no tiles array to inspect),
 * version, count, then per-tile errors in tile order (session_id, integer,
 * bounds, size — an `integer` failure suppresses bounds/size for that tile),
 * then duplicates in tile order, then overlaps for index pairs i<j in
 * lexicographic order. Tiles that failed integer or bounds checks are excluded
 * from overlap checking.
 */
export function validate(layout: unknown): ValidationResult {
  if (typeof layout !== "object" || layout === null || Array.isArray(layout)) {
    return { ok: false, errors: [{ code: "shape" }] };
  }
  const candidate = layout as { version?: unknown; tiles?: unknown };
  if (!Array.isArray(candidate.tiles)) {
    return { ok: false, errors: [{ code: "shape" }] };
  }
  const tiles: unknown[] = candidate.tiles;
  const errors: LayoutError[] = [];
  if (candidate.version !== 2) errors.push({ code: "version" });
  if (tiles.length > MAX_TILES) errors.push({ code: "count" });

  const ids: (string | null)[] = [];
  const rects: (Rect | null)[] = []; // integer + in-bounds tiles, used for overlap checks
  for (let i = 0; i < tiles.length; i++) {
    const raw = tiles[i];
    const record =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const sid = record?.session_id;
    if (typeof sid === "string" && sid.length > 0) {
      ids.push(sid);
    } else {
      ids.push(null);
      errors.push({ code: "session_id", index: i });
    }
    const nums = [record?.x, record?.y, record?.w, record?.h];
    if (!nums.every((v) => typeof v === "number" && Number.isInteger(v))) {
      errors.push({ code: "integer", index: i });
      rects.push(null);
      continue;
    }
    const [x, y, w, h] = nums as [number, number, number, number];
    const rect = { x, y, w, h };
    let inBounds = true;
    if (x < 0 || y < 0 || x + w > GRID_SIZE || y + h > GRID_SIZE) {
      errors.push({ code: "bounds", index: i });
      inBounds = false;
    }
    if (w < MIN_TILE_SIZE || h < MIN_TILE_SIZE) errors.push({ code: "size", index: i });
    rects.push(inBounds ? rect : null);
  }

  const seen = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    const sid = ids[i];
    if (sid === null) continue;
    const first = seen.get(sid);
    if (first === undefined) seen.set(sid, i);
    else errors.push({ code: "duplicate", index: i, other_index: first });
  }

  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    if (!a) continue;
    for (let j = i + 1; j < rects.length; j++) {
      const b = rects[j];
      if (b && overlaps(a, b)) errors.push({ code: "overlap", index: i, other_index: j });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Finds a spot for a new tile. Scans for the first free 2×2 position (y, then
 * x), then greedily expands it rightward (at the minimum height) and downward. When no
 * 2×2 is free, splits the largest-area tile whose longer side is at least 4
 * (ties on area broken by reading order) along its longer axis — a vertical
 * cut when w ≥ h — keeping ceil(side/2) for the existing tile and returning
 * the remaining half as the new tile's spot.
 *
 * Returns the new tile's geometry plus the (possibly shrunk) tile list; the
 * caller appends `{session_id, ...tile}` itself. `tile` is null when the grid
 * is already at MAX_TILES, or when no 2×2 is free and no tile is large enough
 * to split (unreachable through this module's own operations, but valid
 * layouts exist that trigger it).
 */
export function autoPlace(tiles: Tile[]): { tile: Rect | null; tiles: Tile[] } {
  if (tiles.length >= MAX_TILES) return { tile: null, tiles: sortTiles(tiles) };

  for (let y = 0; y + MIN_TILE_SIZE <= GRID_SIZE; y++) {
    for (let x = 0; x + MIN_TILE_SIZE <= GRID_SIZE; x++) {
      if (!fitsAt(tiles, { x, y, w: MIN_TILE_SIZE, h: MIN_TILE_SIZE })) continue;
      let w = MIN_TILE_SIZE;
      while (x + w < GRID_SIZE && fitsAt(tiles, { x: x + w, y, w: 1, h: MIN_TILE_SIZE })) w++;
      let h = MIN_TILE_SIZE;
      while (y + h < GRID_SIZE && fitsAt(tiles, { x, y: y + h, w, h: 1 })) h++;
      return { tile: { x, y, w, h }, tiles: sortTiles(tiles) };
    }
  }

  let victim: Tile | null = null;
  for (const t of sortTiles(tiles)) {
    if (Math.max(t.w, t.h) < 2 * MIN_TILE_SIZE) continue;
    if (!victim || t.w * t.h > victim.w * victim.h) victim = t;
  }
  if (!victim) return { tile: null, tiles: sortTiles(tiles) };

  const next = sortTiles(tiles);
  const kept = next.find((t) => t.session_id === victim.session_id);
  if (!kept) return { tile: null, tiles: next }; // unreachable on valid input
  let tile: Rect;
  if (kept.w >= kept.h) {
    const keep = Math.ceil(kept.w / 2);
    tile = { x: kept.x + keep, y: kept.y, w: kept.w - keep, h: kept.h };
    kept.w = keep;
  } else {
    const keep = Math.ceil(kept.h / 2);
    tile = { x: kept.x, y: kept.y + keep, w: kept.w, h: kept.h - keep };
    kept.h = keep;
  }
  return { tile, tiles: sortTiles(next) };
}

/**
 * Gravity compaction: tiles are processed in reading order; each slides up as
 * far as it can, then left. A slide is a continuous motion checked against
 * every other tile at its current position (already-processed tiles at their
 * settled spots, later tiles at their original spots) — tiles never pass
 * through occupied cells, so a valid layout stays valid at every step.
 */
export function compact(tiles: Tile[]): Tile[] {
  const work = sortTiles(tiles);
  for (let i = 0; i < work.length; i++) {
    const t = work[i];
    while (t.y > 0 && fitsAt(work, { x: t.x, y: t.y - 1, w: t.w, h: t.h }, i)) t.y--;
    while (t.x > 0 && fitsAt(work, { x: t.x - 1, y: t.y, w: t.w, h: t.h }, i)) t.x--;
  }
  return sortTiles(work);
}

function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** True when `inner` lies wholly inside `outer`. */
function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
}

/**
 * Moves a tile to (x, y), clamped into the canvas. The canvas is free-form:
 * when the target rect is empty the tile simply goes there and whatever gap it
 * left behind stays a gap. When the target rect is occupied the move is a
 * SWAP: T = the tile with the greatest intersection area with the clamped
 * target rect (ties broken by reading order); the dragged tile adopts T's rect
 * wholesale — position AND size — and T adopts the dragged tile's original
 * rect. A swap exchanges sizes between the two tiles, so move preserves the
 * multiset of sizes, not per-tile sizes. Unknown ids return the input
 * unchanged.
 */
export function move(tiles: Tile[], id: string, x: number, y: number): Tile[] {
  const original = sortTiles(tiles);
  const target = original.find((t) => t.session_id === id);
  if (!target) return original;
  const moved = {
    ...target,
    x: clamp(x, 0, GRID_SIZE - target.w),
    y: clamp(y, 0, GRID_SIZE - target.h),
  };
  const others = original.filter((t) => t.session_id !== id);
  if (fitsAt(others, moved)) return sortTiles([moved, ...others]);

  let victim: Tile | null = null;
  let bestArea = 0;
  for (const t of others) {
    // others is in reading order; strictly-greater keeps the first of any tie
    const area = intersectionArea(moved, t);
    if (area > bestArea) {
      bestArea = area;
      victim = t;
    }
  }
  if (!victim) return original; // unreachable: an occupied rect intersects something
  const swappedWith = victim;
  const swapped = original.map((t) => {
    if (t.session_id === id) {
      return { ...t, x: swappedWith.x, y: swappedWith.y, w: swappedWith.w, h: swappedWith.h };
    }
    if (t.session_id === swappedWith.session_id) {
      return { ...t, x: target.x, y: target.y, w: target.w, h: target.h };
    }
    return { ...t };
  });
  return sortTiles(swapped);
}

/**
 * Resizes a tile to (w, h) about its own origin, clamped to the invariants (at
 * least 2×2, within the canvas from the tile's position). Nothing else moves:
 * shrinking leaves empty canvas behind, and growing succeeds only into space
 * that is already empty — a growth that would overlap another tile returns the
 * input unchanged. Unknown ids return the input unchanged.
 */
export function resize(tiles: Tile[], id: string, w: number, h: number): Tile[] {
  const original = sortTiles(tiles);
  const target = original.find((t) => t.session_id === id);
  if (!target) return original;
  const resized = {
    ...target,
    w: clamp(w, MIN_TILE_SIZE, GRID_SIZE - target.x),
    h: clamp(h, MIN_TILE_SIZE, GRID_SIZE - target.y),
  };
  const others = original.filter((t) => t.session_id !== id);
  if (!fitsAt(others, resized)) return original;
  return sortTiles([resized, ...others]);
}

/**
 * Drops a tile, then lets the survivors absorb the rectangle it freed —
 * nothing else on the canvas moves. Survivors grow one cell at a time in
 * reading order, trying right, down, left, then up; a step is taken only when
 * every cell it gains lies inside the freed rectangle and is still empty, and
 * passes repeat until no tile can grow. Unknown ids return the input
 * unchanged.
 */
export function remove(tiles: Tile[], id: string): Tile[] {
  const original = sortTiles(tiles);
  const dropped = original.find((t) => t.session_id === id);
  if (!dropped) return original;
  const kept = original.filter((t) => t.session_id !== id);
  const freed: Rect = { x: dropped.x, y: dropped.y, w: dropped.w, h: dropped.h };

  for (let growing = true; growing; ) {
    growing = false;
    for (let i = 0; i < kept.length; i++) {
      const t = kept[i];
      const steps: Array<{ gained: Rect; grown: Rect }> = [
        { gained: { x: t.x + t.w, y: t.y, w: 1, h: t.h }, grown: { ...t, w: t.w + 1 } },
        { gained: { x: t.x, y: t.y + t.h, w: t.w, h: 1 }, grown: { ...t, h: t.h + 1 } },
        { gained: { x: t.x - 1, y: t.y, w: 1, h: t.h }, grown: { ...t, x: t.x - 1, w: t.w + 1 } },
        { gained: { x: t.x, y: t.y - 1, w: t.w, h: 1 }, grown: { ...t, y: t.y - 1, h: t.h + 1 } },
      ];
      for (const step of steps) {
        if (!contains(freed, step.gained)) continue;
        if (!fitsAt(kept, step.grown, i)) continue;
        kept[i] = { ...t, ...step.grown };
        growing = true;
        break;
      }
    }
  }
  return sortTiles(kept);
}

/** Session ids in reading order — (y, x) ascending. */
export function readingOrder(tiles: Tile[]): string[] {
  return sortTiles(tiles).map((t) => t.session_id);
}

function collectPaneIds(node: SplitTreeNode, out: string[]): void {
  if (node.type === "pane") {
    out.push(node.agent_id);
    return;
  }
  collectPaneIds(node.a, out);
  collectPaneIds(node.b, out);
}

/** Round half away from zero — NOT the default `round()` in Python (banker's). */
function roundHalfUp(v: number): number {
  return Math.floor(v + 0.5);
}

function assignRects(
  node: SplitTreeNode,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: Tile[],
): void {
  if (node.type === "pane") {
    const x = roundHalfUp(x0);
    const y = roundHalfUp(y0);
    out.push({ session_id: node.agent_id, x, y, w: roundHalfUp(x1) - x, h: roundHalfUp(y1) - y });
    return;
  }
  const ratio = clamp(node.ratio, 0, 1);
  if (node.direction === "row") {
    const s = x0 + ratio * (x1 - x0);
    assignRects(node.a, x0, y0, s, y1, out);
    assignRects(node.b, s, y0, x1, y1, out);
  } else {
    const s = y0 + ratio * (y1 - y0);
    assignRects(node.a, x0, y0, x1, s, out);
    assignRects(node.b, x0, s, x1, y1, out);
  }
}

/** Repeated autoPlace over the pane ids, starting from an empty canvas. */
function fallbackPlace(ids: string[]): Tile[] {
  let tiles: Tile[] = [];
  for (const id of ids) {
    const placed = autoPlace(tiles);
    if (!placed.tile) break; // unreachable for ≤ MAX_TILES ids from an empty canvas
    tiles = [...placed.tiles, { session_id: id, ...placed.tile }];
  }
  return sortTiles(tiles);
}

/**
 * Converts a v1 split tree to grid tiles (migration 0031). Float rects are
 * assigned from (0, 0, 12, 12) — a `row` split gives `a` the left ratio·width,
 * a `column` split gives `a` the top ratio·height (ratio clamped to [0, 1]) —
 * then each pane's EDGES are rounded half-up (floor(v + 0.5); shared split
 * positions are computed once, so rounding cannot create overlaps or gaps).
 * If any rounded tile violates the invariants, the panes fall back to
 * repeated `autoPlace` in v1 DFS order (a then b). Trees with more than 8
 * panes keep the first 8 in DFS order and drop the rest. A null root yields
 * an empty tile list. Pane `agent_id`s become tile `session_id`s verbatim.
 */
export function fromSplitTree(root: SplitTreeNode | null): Tile[] {
  if (!root) return [];
  const ids: string[] = [];
  collectPaneIds(root, ids);
  if (ids.length > MAX_TILES) return fallbackPlace(ids.slice(0, MAX_TILES));

  const rounded: Tile[] = [];
  assignRects(root, 0, 0, GRID_SIZE, GRID_SIZE, rounded);
  for (let i = 0; i < rounded.length; i++) {
    const t = rounded[i];
    if (t.w < MIN_TILE_SIZE || t.h < MIN_TILE_SIZE) return fallbackPlace(ids);
    if (t.x < 0 || t.y < 0 || t.x + t.w > GRID_SIZE || t.y + t.h > GRID_SIZE) {
      return fallbackPlace(ids);
    }
    for (let j = i + 1; j < rounded.length; j++) {
      if (overlaps(t, rounded[j])) return fallbackPlace(ids);
    }
  }
  return sortTiles(rounded);
}
