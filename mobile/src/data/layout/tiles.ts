import type {
  GridLayoutV3,
  LayoutError,
  LayoutValidation,
  LegacySplitNode,
  PaneId,
  Tile,
  TilePlacement,
} from "@/data/types/layout";

export const GRID_SIZE = 24;
export const MIN_TILE_SIZE = 4;
export const MAX_TILES_PER_TAB = 16;

interface Rect extends TilePlacement {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function intersectionArea(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return width * height;
}

function sortTiles(tiles: readonly Tile[]): Tile[] {
  return [...tiles]
    .map((tile) => ({ ...tile }))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.session_id.localeCompare(b.session_id));
}

/** Geometry reading order; pane ID is a deterministic tie-break for malformed legacy input. */
export function orderedTiles(tiles: readonly Tile[]): Tile[] {
  return sortTiles(tiles);
}

export function readingOrderIds(tiles: readonly Tile[]): PaneId[] {
  return orderedTiles(tiles).map((tile) => tile.session_id);
}

export function validateGridLayout(layout: unknown): LayoutValidation {
  if (!isRecord(layout) || !Array.isArray(layout["tiles"])) {
    return { ok: false, errors: [{ code: "shape" }] };
  }

  const errors: LayoutError[] = [];
  if (layout["version"] !== 3) errors.push({ code: "version" });
  if (layout["tiles"].length > MAX_TILES_PER_TAB) errors.push({ code: "count" });

  const inspectable: Array<{ index: number; tile: Record<string, unknown> }> = [];
  for (const [index, candidate] of layout["tiles"].entries()) {
    const tile = isRecord(candidate) ? candidate : {};
    if (typeof tile["session_id"] !== "string" || tile["session_id"].length === 0) {
      errors.push({ code: "session_id", index });
    }

    const geometry = [tile["x"], tile["y"], tile["w"], tile["h"]];
    if (!geometry.every(Number.isInteger)) {
      errors.push({ code: "integer", index });
      continue;
    }

    const x = tile["x"] as number;
    const y = tile["y"] as number;
    const w = tile["w"] as number;
    const h = tile["h"] as number;
    if (x < 0 || y < 0 || x + w > GRID_SIZE || y + h > GRID_SIZE) {
      errors.push({ code: "bounds", index });
    }
    if (w < MIN_TILE_SIZE || h < MIN_TILE_SIZE) errors.push({ code: "size", index });
    if (x >= 0 && y >= 0 && x + w <= GRID_SIZE && y + h <= GRID_SIZE) {
      inspectable.push({ index, tile });
    }
  }

  const firstById = new Map<string, number>();
  for (const [index, candidate] of layout["tiles"].entries()) {
    if (!isRecord(candidate) || typeof candidate["session_id"] !== "string") continue;
    const first = firstById.get(candidate["session_id"]);
    if (first === undefined) firstById.set(candidate["session_id"], index);
    else errors.push({ code: "duplicate", index, other_index: first });
  }

  for (let left = 0; left < inspectable.length; left += 1) {
    const a = inspectable[left];
    if (!a) continue;
    for (let right = left + 1; right < inspectable.length; right += 1) {
      const b = inspectable[right];
      if (!b) continue;
      if (overlaps(a.tile as unknown as Rect, b.tile as unknown as Rect)) {
        errors.push({ code: "overlap", index: a.index, other_index: b.index });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function placementFree(rect: Rect, tiles: readonly Tile[], excludeId?: PaneId): boolean {
  return tiles.every((tile) => tile.session_id === excludeId || !overlaps(rect, tile));
}

export interface AutoPlaceResult {
  tile: TilePlacement | null;
  tiles: Tile[];
}

export function autoPlace(tiles: readonly Tile[]): AutoPlaceResult {
  const sorted = orderedTiles(tiles);
  if (sorted.length >= MAX_TILES_PER_TAB) return { tile: null, tiles: sorted };

  for (let y = 0; y <= GRID_SIZE - MIN_TILE_SIZE; y += 1) {
    for (let x = 0; x <= GRID_SIZE - MIN_TILE_SIZE; x += 1) {
      const seed = { x, y, w: MIN_TILE_SIZE, h: MIN_TILE_SIZE };
      if (!placementFree(seed, sorted)) continue;

      let width = MIN_TILE_SIZE;
      while (
        x + width < GRID_SIZE &&
        placementFree({ x, y, w: width + 1, h: MIN_TILE_SIZE }, sorted)
      ) {
        width += 1;
      }
      let height = MIN_TILE_SIZE;
      while (y + height < GRID_SIZE && placementFree({ x, y, w: width, h: height + 1 }, sorted)) {
        height += 1;
      }
      return { tile: { x, y, w: width, h: height }, tiles: sorted };
    }
  }

  const candidates = sorted.filter((tile) => Math.max(tile.w, tile.h) >= MIN_TILE_SIZE * 2);
  candidates.sort((a, b) => b.w * b.h - a.w * a.h || a.y - b.y || a.x - b.x);
  const victim = candidates[0];
  if (!victim) return { tile: null, tiles: sorted };

  let placement: TilePlacement;
  let resized: Tile;
  if (victim.w >= victim.h) {
    const existingWidth = Math.ceil(victim.w / 2);
    resized = { ...victim, w: existingWidth };
    placement = {
      x: victim.x + existingWidth,
      y: victim.y,
      w: Math.floor(victim.w / 2),
      h: victim.h,
    };
  } else {
    const existingHeight = Math.ceil(victim.h / 2);
    resized = { ...victim, h: existingHeight };
    placement = {
      x: victim.x,
      y: victim.y + existingHeight,
      w: victim.w,
      h: Math.floor(victim.h / 2),
    };
  }

  return {
    tile: placement,
    tiles: orderedTiles(
      sorted.map((tile) => (tile.session_id === victim.session_id ? resized : tile)),
    ),
  };
}

export function canAddTile(layout: GridLayoutV3): boolean {
  return autoPlace(layout.tiles).tile !== null;
}

export function addTile(
  layout: GridLayoutV3,
  tile: Pick<Tile, "session_id" | "widget"> & Record<string, unknown>,
): GridLayoutV3 | null {
  const placed = autoPlace(layout.tiles);
  if (!placed.tile) return null;
  return { ...layout, tiles: orderedTiles([...placed.tiles, { ...tile, ...placed.tile } as Tile]) };
}

export function moveTile(tiles: readonly Tile[], id: PaneId, x: number, y: number): Tile[] {
  const sorted = orderedTiles(tiles);
  const dragged = sorted.find((tile) => tile.session_id === id);
  if (!dragged) return sorted;
  const target = {
    x: Math.min(Math.max(0, x), GRID_SIZE - dragged.w),
    y: Math.min(Math.max(0, y), GRID_SIZE - dragged.h),
    w: dragged.w,
    h: dragged.h,
  };
  const victims = sorted
    .filter((tile) => tile.session_id !== id && overlaps(target, tile))
    .map((tile) => ({ tile, area: intersectionArea(target, tile) }))
    .sort((a, b) => b.area - a.area || a.tile.y - b.tile.y || a.tile.x - b.tile.x);
  const victim = victims[0]?.tile;

  if (!victim) {
    return orderedTiles(
      sorted.map((tile) => (tile.session_id === id ? { ...tile, x: target.x, y: target.y } : tile)),
    );
  }

  const original = { x: dragged.x, y: dragged.y, w: dragged.w, h: dragged.h };
  return orderedTiles(
    sorted.map((tile) => {
      if (tile.session_id === id) {
        return { ...tile, x: victim.x, y: victim.y, w: victim.w, h: victim.h };
      }
      if (tile.session_id === victim.session_id) return { ...tile, ...original };
      return tile;
    }),
  );
}

export function resizeTile(tiles: readonly Tile[], id: PaneId, w: number, h: number): Tile[] {
  const sorted = orderedTiles(tiles);
  const tile = sorted.find((candidate) => candidate.session_id === id);
  if (!tile) return sorted;
  const resized = {
    ...tile,
    w: Math.min(Math.max(MIN_TILE_SIZE, w), GRID_SIZE - tile.x),
    h: Math.min(Math.max(MIN_TILE_SIZE, h), GRID_SIZE - tile.y),
  };
  if (!placementFree(resized, sorted, id)) return sorted;
  return orderedTiles(
    sorted.map((candidate) => (candidate.session_id === id ? resized : candidate)),
  );
}

export function compactTiles(tiles: readonly Tile[]): Tile[] {
  const result = orderedTiles(tiles);
  for (const tile of result) {
    while (tile.y > 0 && placementFree({ ...tile, y: tile.y - 1 }, result, tile.session_id)) {
      tile.y -= 1;
    }
    while (tile.x > 0 && placementFree({ ...tile, x: tile.x - 1 }, result, tile.session_id)) {
      tile.x -= 1;
    }
  }
  return orderedTiles(result);
}

function inside(rect: Rect, boundary: Rect): boolean {
  return (
    rect.x >= boundary.x &&
    rect.y >= boundary.y &&
    rect.x + rect.w <= boundary.x + boundary.w &&
    rect.y + rect.h <= boundary.y + boundary.h
  );
}

function growOne(tile: Tile, direction: "right" | "down" | "left" | "up"): Tile {
  if (direction === "right") return { ...tile, w: tile.w + 1 };
  if (direction === "down") return { ...tile, h: tile.h + 1 };
  if (direction === "left") return { ...tile, x: tile.x - 1, w: tile.w + 1 };
  return { ...tile, y: tile.y - 1, h: tile.h + 1 };
}

function gainedStrip(tile: Tile, direction: "right" | "down" | "left" | "up"): Rect {
  if (direction === "right") return { x: tile.x + tile.w, y: tile.y, w: 1, h: tile.h };
  if (direction === "down") return { x: tile.x, y: tile.y + tile.h, w: tile.w, h: 1 };
  if (direction === "left") return { x: tile.x - 1, y: tile.y, w: 1, h: tile.h };
  return { x: tile.x, y: tile.y - 1, w: tile.w, h: 1 };
}

export function removeTile(tiles: readonly Tile[], id: PaneId): Tile[] {
  const sorted = orderedTiles(tiles);
  const removed = sorted.find((tile) => tile.session_id === id);
  if (!removed) return sorted;
  const result = sorted.filter((tile) => tile.session_id !== id);
  const directions = ["right", "down", "left", "up"] as const;

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < result.length; index += 1) {
      const tile = result[index];
      if (!tile) continue;
      for (const direction of directions) {
        const strip = gainedStrip(tile, direction);
        const grown = growOne(tile, direction);
        if (inside(strip, removed) && placementFree(grown, result, tile.session_id)) {
          result[index] = grown;
          changed = true;
          break;
        }
      }
    }
  }
  return orderedTiles(result);
}

interface FloatRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function splitLeaves(
  node: LegacySplitNode,
  rect: FloatRect,
  leaves: Array<{ id: string; rect: FloatRect }>,
): void {
  if (leaves.length >= MAX_TILES_PER_TAB) return;
  if (node.type === "pane") {
    leaves.push({ id: node.agent_id, rect });
    return;
  }
  const ratio = Math.min(1, Math.max(0, node.ratio));
  if (node.direction === "row") {
    const split = rect.x0 + ratio * (rect.x1 - rect.x0);
    splitLeaves(node.a, { ...rect, x1: split }, leaves);
    splitLeaves(node.b, { ...rect, x0: split }, leaves);
  } else {
    const split = rect.y0 + ratio * (rect.y1 - rect.y0);
    splitLeaves(node.a, { ...rect, y1: split }, leaves);
    splitLeaves(node.b, { ...rect, y0: split }, leaves);
  }
}

function fallbackPlacement(ids: readonly string[]): Tile[] {
  let tiles: Tile[] = [];
  for (const session_id of ids) {
    const placed = autoPlace(tiles);
    if (!placed.tile) break;
    tiles = orderedTiles([...placed.tiles, { session_id, ...placed.tile }]);
  }
  return tiles;
}

export function tilesFromSplitTree(root: LegacySplitNode | null): Tile[] {
  if (!root) return [];
  const leaves: Array<{ id: string; rect: FloatRect }> = [];
  splitLeaves(root, { x0: 0, y0: 0, x1: GRID_SIZE, y1: GRID_SIZE }, leaves);
  const round = (value: number) => Math.floor(value + 0.5);
  const tiles = leaves.map(({ id, rect }) => {
    const x = round(rect.x0);
    const y = round(rect.y0);
    return {
      session_id: id,
      x,
      y,
      w: round(rect.x1) - x,
      h: round(rect.y1) - y,
    };
  });
  return validateGridLayout({ version: 3, tiles }).ok
    ? orderedTiles(tiles)
    : fallbackPlacement(leaves.map((leaf) => leaf.id));
}
