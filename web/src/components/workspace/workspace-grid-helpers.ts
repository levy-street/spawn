import {
  autoPlace,
  GRID_SIZE,
  MAX_TILES,
  MIN_TILE_SIZE,
  type Rect,
  remove,
  type Tile,
  validate,
} from "@/lib/grid";

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Convert 12×12 units into the edge-to-edge pixel geometry of a tile slot. */
export function tilePixelRect(
  tile: Pick<Tile, "x" | "y" | "w" | "h">,
  width: number,
  height: number,
): PixelRect {
  return {
    left: (tile.x / GRID_SIZE) * width,
    top: (tile.y / GRID_SIZE) * height,
    width: (tile.w / GRID_SIZE) * width,
    height: (tile.h / GRID_SIZE) * height,
  };
}

export type DividerAxis = "vertical" | "horizontal";

/**
 * A seam two or more panes share: the whole grid line at `line`, plus the one
 * contiguous run of it (`start`..`end`) where panes actually meet. `before`
 * holds the ids whose trailing edge sits on the line, `after` the ids whose
 * leading edge does; dragging moves all of them at once, the way a tiling
 * window manager resizes a column. `min`/`max` are the bounds inside which
 * every one of those panes stays at least MIN_TILE_SIZE.
 */
export interface GridDivider {
  id: string;
  axis: DividerAxis;
  line: number;
  start: number;
  end: number;
  before: string[];
  after: string[];
  min: number;
  max: number;
}

interface Run {
  start: number;
  end: number;
}

/** Sort, then fuse overlapping or touching runs into maximal ones. */
function mergeRuns(runs: Run[]): Run[] {
  const sorted = [...runs].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Run[] = [];
  for (const run of sorted) {
    const last = merged[merged.length - 1];
    if (last && run.start <= last.end) last.end = Math.max(last.end, run.end);
    else merged.push({ ...run });
  }
  return merged;
}

function dividersOnAxis(tiles: Tile[], axis: DividerAxis): GridDivider[] {
  const vertical = axis === "vertical";
  const lead = (tile: Tile) => (vertical ? tile.x : tile.y);
  const size = (tile: Tile) => (vertical ? tile.w : tile.h);
  const crossLead = (tile: Tile) => (vertical ? tile.y : tile.x);
  const crossSize = (tile: Tile) => (vertical ? tile.h : tile.w);

  const dividers: GridDivider[] = [];
  for (let line = 1; line < GRID_SIZE; line++) {
    const before = tiles.filter((tile) => lead(tile) + size(tile) === line);
    const after = tiles.filter((tile) => lead(tile) === line);
    if (before.length === 0 || after.length === 0) continue;
    const min = Math.max(1, ...before.map((tile) => lead(tile) + MIN_TILE_SIZE));
    const max = Math.min(
      GRID_SIZE - 1,
      ...after.map((tile) => lead(tile) + size(tile) - MIN_TILE_SIZE),
    );
    if (min > max) continue; // pinned: every drag would break the 3-cell minimum
    const runs = mergeRuns(
      before.flatMap((left) =>
        after
          .map((right) => ({
            start: Math.max(crossLead(left), crossLead(right)),
            end: Math.min(crossLead(left) + crossSize(left), crossLead(right) + crossSize(right)),
          }))
          .filter((run) => run.end > run.start),
      ),
    );
    for (const [index, run] of runs.entries()) {
      dividers.push({
        id: `${axis}-${line}-${index}`,
        axis,
        line,
        start: run.start,
        end: run.end,
        before: before.map((tile) => tile.session_id),
        after: after.map((tile) => tile.session_id),
        min,
        max,
      });
    }
  }
  return dividers;
}

/** Every draggable seam in a layout, both axes. */
export function gridDividers(tiles: Tile[]): GridDivider[] {
  return [...dividersOnAxis(tiles, "vertical"), ...dividersOnAxis(tiles, "horizontal")];
}

export function clampDividerLine(divider: GridDivider, line: number): number {
  return Math.min(divider.max, Math.max(divider.min, Math.round(line)));
}

/**
 * Slide a seam to `line`: the panes behind it grow (or shrink) by exactly what
 * the panes in front give up, so the covered area never gains a hole. Layouts
 * the move would invalidate are rejected, returning the input unchanged.
 */
export function moveDivider(tiles: Tile[], divider: GridDivider, line: number): Tile[] {
  const target = clampDividerLine(divider, line);
  if (target === divider.line) return tiles;
  const before = new Set(divider.before);
  const after = new Set(divider.after);
  const vertical = divider.axis === "vertical";
  const next = tiles.map((tile) => {
    if (before.has(tile.session_id)) {
      return vertical ? { ...tile, w: target - tile.x } : { ...tile, h: target - tile.y };
    }
    if (after.has(tile.session_id)) {
      return vertical
        ? { ...tile, x: target, w: tile.x + tile.w - target }
        : { ...tile, y: target, h: tile.y + tile.h - target };
    }
    return { ...tile };
  });
  if (!validate({ version: 3, tiles: next }).ok) return tiles;
  return next.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Where a resize drag grabbed a tile, per axis: lead edge, trail edge, or
 *  not this axis. Corners set both. */
export interface ResizeEdges {
  /** -1 = left edge, 1 = right edge, 0 = neither. */
  h: -1 | 0 | 1;
  /** -1 = top edge, 1 = bottom edge, 0 = neither. */
  v: -1 | 0 | 1;
}

/** The grid lines a resize drag is asking each grabbed edge to move to. */
export interface EdgeTargets {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Move one edge of a tile to the grid line `target`. The edge behaves like a
 * splitter: neighbours flush against it (within the tile's cross-range)
 * follow — shrinking to make room when the tile grows, growing to keep the
 * seam closed when it shrinks, but only where the swept cells are actually
 * empty. Gapped neighbours and the canvas border clamp the drag; every tile
 * keeps its 3-cell minimum. Unknown ids and clamped-to-nothing drags return
 * the input unchanged.
 */
function moveEdge(
  tiles: Tile[],
  id: string,
  edge: "left" | "right" | "top" | "bottom",
  target: number,
): Tile[] {
  const tile = tiles.find((item) => item.session_id === id);
  if (!tile) return tiles;
  const horizontal = edge === "left" || edge === "right";
  const lead = edge === "left" || edge === "top";
  const pos = (item: Tile) => (horizontal ? item.x : item.y);
  const size = (item: Tile) => (horizontal ? item.w : item.h);
  const crossOverlaps = (item: Tile) =>
    horizontal
      ? item.y < tile.y + tile.h && tile.y < item.y + item.h
      : item.x < tile.x + tile.w && tile.x < item.x + item.w;
  const line = lead ? pos(tile) : pos(tile) + size(tile);

  const others = tiles.filter((item) => item.session_id !== id);
  const alongside = others.filter(crossOverlaps);
  const followers = alongside.filter((item) =>
    lead ? pos(item) + size(item) === line : pos(item) === line,
  );
  let lo = lead ? 0 : pos(tile) + MIN_TILE_SIZE;
  let hi = lead ? pos(tile) + size(tile) - MIN_TILE_SIZE : GRID_SIZE;
  for (const follower of followers) {
    if (lead) lo = Math.max(lo, pos(follower) + MIN_TILE_SIZE);
    else hi = Math.min(hi, pos(follower) + size(follower) - MIN_TILE_SIZE);
  }
  for (const item of alongside) {
    if (followers.includes(item)) continue;
    if (lead && pos(item) + size(item) <= line) lo = Math.max(lo, pos(item) + size(item));
    if (!lead && pos(item) >= line) hi = Math.min(hi, pos(item));
  }
  const next = Math.min(hi, Math.max(lo, Math.round(target)));
  if (next === line || lo > hi) return tiles;

  const withEdgeAt = (item: Tile, at: number): Tile =>
    lead
      ? horizontal
        ? { ...item, x: at, w: item.x + item.w - at }
        : { ...item, y: at, h: item.y + item.h - at }
      : horizontal
        ? { ...item, w: at - item.x }
        : { ...item, h: at - item.y };
  const withOppositeEdgeAt = (item: Tile, at: number): Tile =>
    lead
      ? horizontal
        ? { ...item, w: at - item.x }
        : { ...item, h: at - item.y }
      : horizontal
        ? { ...item, x: at, w: item.x + item.w - at }
        : { ...item, y: at, h: item.y + item.h - at };

  const moved = withEdgeAt(tile, next);
  const kept = others.filter((item) => !followers.includes(item));
  const followed = followers.map((follower) => {
    const grown = withOppositeEdgeAt(follower, next);
    // Following a retreating edge grows the follower; take the growth only
    // when nothing stationary occupies the swept cells (its own cross-range
    // can be wider than the dragged tile's).
    const grows = size(grown) > size(follower);
    if (grows && kept.some((item) => rectsOverlap(grown, item))) return { ...follower };
    return grown;
  });
  const result = [moved, ...followed, ...kept.map((item) => ({ ...item }))];
  if (!validate({ version: 3, tiles: result }).ok) return tiles;
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Apply a resize drag: each grabbed edge (one per axis; a corner grabs two)
 * moves to its target line via `moveEdge`, horizontal first. Axes are
 * independent, so a corner drag blocked on one axis still resizes the other.
 */
export function resizeEdges(tiles: Tile[], id: string, targets: EdgeTargets): Tile[] {
  let result = tiles;
  if (targets.left !== undefined) result = moveEdge(result, id, "left", targets.left);
  if (targets.right !== undefined) result = moveEdge(result, id, "right", targets.right);
  if (targets.top !== undefined) result = moveEdge(result, id, "top", targets.top);
  if (targets.bottom !== undefined) result = moveEdge(result, id, "bottom", targets.bottom);
  return result;
}

/**
 * Grow one tile into the empty canvas around it without changing any other
 * tile. Windows stay rectangular, so "all available space" means the largest
 * empty rectangle that contains the tile's current bounds. Equal-area choices
 * prefer keeping its top-left corner in place, which makes the common
 * right/down expansion feel anchored rather than jumpy.
 */
export function expandTileIntoEmptySpace(tiles: Tile[], id: string): Tile[] {
  const target = tiles.find((tile) => tile.session_id === id);
  if (!target) return tiles;
  const others = tiles.filter((tile) => tile.session_id !== id);
  let best: Rect = { x: target.x, y: target.y, w: target.w, h: target.h };
  let bestArea = best.w * best.h;
  let bestOriginShift = 0;

  const targetRight = target.x + target.w;
  const targetBottom = target.y + target.h;
  for (let x = target.x; x >= 0; x--) {
    for (let right = targetRight; right <= GRID_SIZE; right++) {
      for (let y = target.y; y >= 0; y--) {
        for (let bottom = targetBottom; bottom <= GRID_SIZE; bottom++) {
          const candidate: Rect = { x, y, w: right - x, h: bottom - y };
          if (others.some((tile) => rectsOverlap(candidate, tile))) continue;
          const area = candidate.w * candidate.h;
          const originShift = target.x - candidate.x + (target.y - candidate.y);
          if (area > bestArea || (area === bestArea && originShift < bestOriginShift)) {
            best = candidate;
            bestArea = area;
            bestOriginShift = originShift;
          }
        }
      }
    }
  }

  return tiles
    .map((tile) => (tile.session_id === id ? { ...tile, ...best } : { ...tile }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Which side of a hovered pane a drag would dock against. */
export type DockZone = "left" | "right" | "top" | "bottom";

/**
 * The dock zone for a pointer inside a pane, from its relative coordinates
 * (0..1): the nearest edge wins, ties resolving left, right, top, bottom.
 */
export function dockZoneAt(u: number, v: number): DockZone {
  const distances: Array<[DockZone, number]> = [
    ["left", u],
    ["right", 1 - u],
    ["top", v],
    ["bottom", 1 - v],
  ];
  let best = distances[0] as [DockZone, number];
  for (const candidate of distances) {
    if (candidate[1] < best[1]) best = candidate;
  }
  return best[0];
}

/**
 * Halve a rect along a dock zone's axis: the incoming pane takes the half on
 * the zone's side (`moved`), the occupant keeps the rest (`kept`, which gets
 * the odd cell). Null when the rect is under 6 cells on that axis — both
 * halves must keep the 3-cell minimum.
 */
export function dockSplitRect(target: Rect, zone: DockZone): { moved: Rect; kept: Rect } | null {
  const horizontal = zone === "left" || zone === "right";
  const size = horizontal ? target.w : target.h;
  if (size < MIN_TILE_SIZE * 2) return null;
  const movedSize = Math.floor(size / 2);
  const keptSize = size - movedSize;
  if (zone === "left") {
    return {
      moved: { x: target.x, y: target.y, w: movedSize, h: target.h },
      kept: { x: target.x + movedSize, y: target.y, w: keptSize, h: target.h },
    };
  }
  if (zone === "right") {
    return {
      moved: { x: target.x + keptSize, y: target.y, w: movedSize, h: target.h },
      kept: { x: target.x, y: target.y, w: keptSize, h: target.h },
    };
  }
  if (zone === "top") {
    return {
      moved: { x: target.x, y: target.y, w: target.w, h: movedSize },
      kept: { x: target.x, y: target.y + movedSize, w: target.w, h: keptSize },
    };
  }
  return {
    moved: { x: target.x, y: target.y + keptSize, w: target.w, h: movedSize },
    kept: { x: target.x, y: target.y, w: target.w, h: keptSize },
  };
}

/**
 * Held during a drag, either of these duplicates instead of moving — ⌘ is the
 * Finder reflex, ⌥ the one people bring from tiling window managers and from
 * dragging in design tools. Both, rather than picking a side.
 */
export function wantsDuplicate(event: { metaKey: boolean; altKey: boolean }): boolean {
  return event.metaKey || event.altKey;
}

/**
 * The id a caller hands `dockInsert` for the pane that does not exist yet —
 * a ⌘-drag copy, or a pane being dragged out of the launcher. Never persisted:
 * the caller lifts this tile's rect out of the result and drops the rest into
 * the layout.
 */
export const PENDING_TILE_ID = "__pending__";

type BandAxis = "x" | "y";

function bandAxis(zone: DockZone): BandAxis {
  return zone === "left" || zone === "right" ? "x" : "y";
}

/**
 * The canvas read as a single band along `axis` — full-height columns side by
 * side (axis "x"), or full-width rows stacked (axis "y") — in order, or null
 * when the layout is anything less regular. A band is the one shape where
 * "add a pane here" has an obviously right answer: keep every pane, share the
 * canvas out evenly again.
 */
function canvasBand(tiles: Tile[], axis: BandAxis): Tile[] | null {
  if (tiles.length === 0) return null;
  const across = axis === "x" ? "y" : "x";
  const thickness = axis === "x" ? "h" : "w";
  if (tiles.some((tile) => tile[across] !== 0 || tile[thickness] !== GRID_SIZE)) return null;
  const ordered = [...tiles].sort((a, b) => a[axis] - b[axis]);
  let edge = 0;
  for (const tile of ordered) {
    if (tile[axis] !== edge) return null;
    edge += axis === "x" ? tile.w : tile.h;
  }
  return edge === GRID_SIZE ? ordered : null;
}

/**
 * GRID_SIZE shared between `count` slices as evenly as it divides, the
 * remainder going to the leftmost/topmost slices (12 into 5 is 3,3,2,2,2).
 * Null when the slices would fall under the minimum pane size.
 */
function evenSlices(count: number): number[] | null {
  if (count < 1) return null;
  const base = Math.floor(GRID_SIZE / count);
  if (base < MIN_TILE_SIZE) return null;
  const remainder = GRID_SIZE - base * count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

/** Lay an ordered band back across the whole canvas at even sizes. */
function layOutBand(order: Tile[], axis: BandAxis): Tile[] | null {
  const sizes = evenSlices(order.length);
  if (!sizes) return null;
  let edge = 0;
  const result = order.map((tile, index) => {
    const size = sizes[index] as number;
    const placed =
      axis === "x"
        ? { ...tile, x: edge, y: 0, w: size, h: GRID_SIZE }
        : { ...tile, x: 0, y: edge, w: GRID_SIZE, h: size };
    edge += size;
    return placed;
  });
  if (!validate({ version: 3, tiles: result }).ok) return null;
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Rebuild a band with `id` sitting on `zone`'s side of `targetId`. `incoming`
 * is the tile taking that slot — the same object when a band member is being
 * reordered, a fresh placeholder when a pane is being added. Null when the
 * canvas is not a band on that axis, or cannot be shared out that many ways.
 */
function rebalanceBand(
  tiles: Tile[],
  incoming: Tile,
  targetId: string,
  zone: DockZone,
): Tile[] | null {
  const axis = bandAxis(zone);
  const band = canvasBand(tiles, axis);
  if (!band) return null;
  // A band member being reordered leaves its slot first; a newcomer takes an
  // extra one. Either way the target has to still be in the band.
  const rest = band.filter((tile) => tile.session_id !== incoming.session_id);
  const index = rest.findIndex((tile) => tile.session_id === targetId);
  if (index === -1) return null;
  const order = [...rest];
  order.splice(zone === "left" || zone === "top" ? index : index + 1, 0, incoming);
  return layOutBand(order, axis);
}

/**
 * iTerm-style dock: drop `movedId` against one side of `targetId`.
 *
 * When the canvas is a plain band on the zone's axis — equal-ish columns side
 * by side, or rows stacked — the pane simply changes places within it and the
 * band is shared out evenly again. That is the whole layout, so halving one
 * occupant would leave a canvas of mismatched widths nobody asked for.
 *
 * Otherwise: the moved pane's old spot is absorbed by its neighbours first
 * (the same pass as `grid.remove`, so the canvas stays packed), then the
 * target's rect — which may just have grown — splits in half along the zone's
 * axis: the moved pane takes the half on the zone's side, the target keeps the
 * rest. Null when the ids are invalid or the target is too small to split
 * (under 6 cells on that axis), so callers can leave the layout untouched.
 */
export function dockPane(
  tiles: Tile[],
  movedId: string,
  targetId: string,
  zone: DockZone,
): Tile[] | null {
  const moved = tiles.find((tile) => tile.session_id === movedId);
  if (!moved || movedId === targetId) return null;
  const rebalanced = rebalanceBand(tiles, { ...moved }, targetId, zone);
  if (rebalanced) return rebalanced;
  const without = remove(tiles, movedId);
  const target = without.find((tile) => tile.session_id === targetId);
  if (!target) return null;
  const split = dockSplitRect(target, zone);
  if (!split) return null;

  const result = [
    { ...moved, ...split.moved },
    ...without.map((tile) =>
      tile.session_id === targetId ? { ...tile, ...split.kept } : { ...tile },
    ),
  ];
  if (!validate({ version: 3, tiles: result }).ok) return null;
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Move a tile to (x, y) — the drag gesture's algebra (`grid.move`'s swap
 * fallback is not used by the view). Landing on empty canvas just goes there;
 * a drag past the bottom or right edge keeps moving and gives up size instead
 * of pinning — the far side compresses against the canvas border (down to the
 * minimum) rather than snapping the pane back. Landing on another pane pushes
 * it out of the way: each overlapped pane slides by the smallest in-bounds
 * translation that clears whatever it overlaps, cascading into anything it
 * hits in turn. A push that cannot resolve inside the canvas refuses the
 * whole move and returns the input unchanged.
 */
export function movePane(tiles: Tile[], id: string, x: number, y: number): Tile[] {
  const target = tiles.find((tile) => tile.session_id === id);
  if (!target) return tiles;
  const movedX = Math.min(GRID_SIZE - MIN_TILE_SIZE, Math.max(0, x));
  const movedY = Math.min(GRID_SIZE - MIN_TILE_SIZE, Math.max(0, y));
  const moved: Tile = {
    ...target,
    x: movedX,
    y: movedY,
    w: Math.min(target.w, GRID_SIZE - movedX),
    h: Math.min(target.h, GRID_SIZE - movedY),
  };
  const work = [
    moved,
    ...tiles.filter((tile) => tile.session_id !== id).map((tile) => ({ ...tile })),
  ];

  for (let guard = 0; guard < 64; guard++) {
    let pushed = false;
    for (const pusher of work) {
      for (const other of work) {
        if (other === pusher || other === moved || !rectsOverlap(pusher, other)) continue;
        const candidates = [
          { dx: pusher.x + pusher.w - other.x, dy: 0 },
          { dx: 0, dy: pusher.y + pusher.h - other.y },
          { dx: -(other.x + other.w - pusher.x), dy: 0 },
          { dx: 0, dy: -(other.y + other.h - pusher.y) },
        ]
          .filter(
            ({ dx, dy }) =>
              other.x + dx >= 0 &&
              other.x + dx + other.w <= GRID_SIZE &&
              other.y + dy >= 0 &&
              other.y + dy + other.h <= GRID_SIZE,
          )
          .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));
        const best = candidates[0];
        if (!best) return tiles; // pinned against the canvas: refuse the move
        other.x += best.dx;
        other.y += best.dy;
        pushed = true;
        break;
      }
      if (pushed) break;
    }
    if (!pushed) {
      if (!validate({ version: 3, tiles: work }).ok) return tiles;
      return work.sort((a, b) => a.y - b.y || a.x - b.x);
    }
  }
  return tiles; // the cascade cycled: refuse rather than guess
}

/**
 * `dockPane` for a tile that does not exist yet — a duplicate, or a pane being
 * dragged out of the launcher. Same two outcomes: a band on the zone's axis
 * takes the newcomer as one more equal slice (three columns become four, all
 * the same width), and anything else halves the target, which keeps the rest.
 * Null when the canvas is full, the target is unknown, or it is too small to
 * split (under 6 cells on that axis).
 */
export function dockInsert(
  tiles: Tile[],
  id: string,
  targetId: string,
  zone: DockZone,
): Tile[] | null {
  if (tiles.length >= MAX_TILES) return null;
  const target = tiles.find((tile) => tile.session_id === targetId);
  if (!target) return null;
  const rebalanced = rebalanceBand(
    tiles,
    { session_id: id, x: 0, y: 0, w: MIN_TILE_SIZE, h: MIN_TILE_SIZE },
    targetId,
    zone,
  );
  if (rebalanced) return rebalanced;
  const split = dockSplitRect(target, zone);
  if (!split) return null;
  const result = [
    { session_id: id, ...split.moved },
    ...tiles.map((tile) =>
      tile.session_id === targetId ? { ...tile, ...split.kept } : { ...tile },
    ),
  ];
  if (!validate({ version: 3, tiles: result }).ok) return null;
  return result.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Where a pane goes when nobody aimed it — the "+" menu, a duplicate from the
 * pane menu, a tap on the launcher. A canvas that is already a plain band of
 * columns or rows takes one more equal slice (three columns become four, all
 * the same width) rather than having its widest member halved; anything else
 * falls back to `autoPlace`, which is the wire algebra the server would use.
 *
 * Returns the whole tile list including the newcomer — sibling geometry moves
 * in the band case, so the caller has to persist all of it — or null when the
 * canvas has no room.
 */
export function addPaneTiles(tiles: Tile[], id: string): Tile[] | null {
  if (tiles.length >= MAX_TILES) return null;
  if (tiles.length > 0) {
    for (const zone of ["right", "bottom"] as const) {
      const last = canvasBand(tiles, bandAxis(zone))?.at(-1);
      const rebalanced = last
        ? rebalanceBand(
            tiles,
            { session_id: id, x: 0, y: 0, w: MIN_TILE_SIZE, h: MIN_TILE_SIZE },
            last.session_id,
            zone,
          )
        : null;
      if (rebalanced) return rebalanced;
    }
  }
  const placed = autoPlace(tiles);
  if (!placed.tile) return null;
  return [...placed.tiles, { session_id: id, ...placed.tile }];
}

/**
 * `movePane` for a tile that does not exist yet — a ⌘-drag copy landing on
 * open canvas. The newcomer arrives at (x, y) carrying `size`, and neighbours
 * are pushed by the same cascade a move would use. Null when the canvas is
 * full or the push cannot resolve, so the caller can leave the layout alone.
 */
export function insertPane(
  tiles: Tile[],
  id: string,
  size: { w: number; h: number },
  x: number,
  y: number,
): Tile[] | null {
  if (tiles.length >= MAX_TILES) return null;
  if (tiles.some((tile) => tile.session_id === id)) return null;
  // movePane relocates the tile before resolving anything, so the seed rect's
  // position is irrelevant — only the size it carries in.
  const seeded = [...tiles.map((tile) => ({ ...tile })), { session_id: id, x: 0, y: 0, ...size }];
  const placed = movePane(seeded, id, x, y);
  return placed === seeded ? null : placed;
}

/**
 * Persist a mobile reorder. Up to GRID_SIZE / MIN_TILE_SIZE panes can be
 * represented as a valid full-width stack in the 12-row wire format. Above
 * that, a full-width stack is mathematically impossible, so preserve the
 * valid rect multiset and assign ids to those rects in the requested order.
 */
export function repackMobileTiles(tiles: Tile[], orderedIds: string[]): Tile[] {
  const ids = orderedIds.filter((id) => tiles.some((tile) => tile.session_id === id));
  if (ids.length === 0) return [];

  const widgetOf = (sessionId: string) =>
    tiles.find((tile) => tile.session_id === sessionId)?.widget;
  const withWidget = (tile: Tile): Tile => {
    const widget = widgetOf(tile.session_id);
    return widget ? { ...tile, widget } : tile;
  };

  if (ids.length <= Math.floor(GRID_SIZE / MIN_TILE_SIZE)) {
    const baseHeight = Math.floor(GRID_SIZE / ids.length);
    let remainder = GRID_SIZE % ids.length;
    let y = 0;
    return ids.map((sessionId) => {
      const h = baseHeight + (remainder > 0 ? 1 : 0);
      remainder = Math.max(0, remainder - 1);
      const tile = withWidget({ session_id: sessionId, x: 0, y, w: GRID_SIZE, h });
      y += h;
      return tile;
    });
  }

  const rects = [...tiles]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(({ x, y, w, h }) => ({ x, y, w, h }));
  return ids.map((sessionId, index) => withWidget({ session_id: sessionId, ...rects[index] }));
}

export function moveIdInOrder(ids: string[], id: string, delta: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= ids.length) return [...ids];
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/**
 * The empty canvas, carved into placeable rectangles: repeatedly take the
 * largest free rect that is at least MIN_TILE_SIZE on both sides, mark it
 * used, and go again. Deterministic (ties resolve to the first found in
 * reading order), and each rect is exactly what a pane dropped there gets.
 */
export function freeRects(tiles: Tile[]): Rect[] {
  // Prefix sums of occupancy, so "is this rect free" is O(1).
  const sums: number[][] = Array.from({ length: GRID_SIZE + 1 }, () =>
    new Array<number>(GRID_SIZE + 1).fill(0),
  );
  const occupied = Array.from({ length: GRID_SIZE }, () =>
    new Array<boolean>(GRID_SIZE).fill(false),
  );
  for (const tile of tiles) {
    for (let y = tile.y; y < tile.y + tile.h; y++) {
      for (let x = tile.x; x < tile.x + tile.w; x++) {
        const row = occupied[y];
        if (row) row[x] = true;
      }
    }
  }

  const rebuildSums = () => {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const cell = occupied[y]?.[x] ? 1 : 0;
        sums[y + 1]![x + 1] = cell + sums[y]![x + 1]! + sums[y + 1]![x]! - sums[y]![x]!;
      }
    }
  };
  const isFree = (x: number, y: number, w: number, h: number) =>
    sums[y + h]![x + w]! - sums[y]![x + w]! - sums[y + h]![x]! + sums[y]![x]! === 0;

  const rects: Rect[] = [];
  for (;;) {
    rebuildSums();
    let best: Rect | null = null;
    for (let y = 0; y + MIN_TILE_SIZE <= GRID_SIZE; y++) {
      for (let x = 0; x + MIN_TILE_SIZE <= GRID_SIZE; x++) {
        if (occupied[y]?.[x]) continue;
        for (let h = MIN_TILE_SIZE; y + h <= GRID_SIZE; h++) {
          if (!isFree(x, y, MIN_TILE_SIZE, h)) break;
          for (let w = MIN_TILE_SIZE; x + w <= GRID_SIZE; w++) {
            if (!isFree(x, y, w, h)) break;
            if (!best || w * h > best.w * best.h) best = { x, y, w, h };
          }
        }
      }
    }
    if (!best) return rects;
    rects.push(best);
    for (let y = best.y; y < best.y + best.h; y++) {
      for (let x = best.x; x < best.x + best.w; x++) {
        const row = occupied[y];
        if (row) row[x] = true;
      }
    }
  }
}
