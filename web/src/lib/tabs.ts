import { autoPlace, type GridLayout, readingOrder, remove, type Tile } from "@/lib/grid";

/**
 * Layout schema v3 — the tab envelope (docs/OVERHAUL.md §4.4-tabs).
 *
 * A workspace holds an ordered list of named tabs, each wrapping one tile
 * grid; the v2 algebra in `lib/grid.ts` (and its conformance fixtures) is
 * untouched. Everything here is pure: no ambient state, inputs never mutated,
 * unknown tab ids answered with the input unchanged (or null where the caller
 * must know the operation failed). The server twin of the envelope rules
 * lives in `spawn_server/routes/workspaces.py`.
 */

export interface WorkspaceTab {
  id: string;
  name: string;
  /**
   * The tab's own home — the host and folder a window added to this tab opens
   * in. Always a pair, and absent (or null) on both means "inherit the
   * workspace's home", so a tab that has never been re-pointed follows the
   * workspace as it moves. Optional here because that is how a tab is born:
   * the server reads a missing key as inheriting.
   */
  host_id?: string | null;
  cwd?: string | null;
  layout: GridLayout;
}

/** A host/folder pair to open something in. */
export interface Home {
  host_id: string;
  cwd: string;
}

export interface LayoutV3 {
  version: 3;
  /** The tab the workspace last had open; null falls back to the first. */
  active_tab: string | null;
  tabs: WorkspaceTab[];
}

export const MAX_TABS = 8;

/** The envelope's active tab, falling back to the first. */
export function activeTab(layout: LayoutV3): WorkspaceTab {
  return (
    layout.tabs.find((tab) => tab.id === layout.active_tab) ?? (layout.tabs[0] as WorkspaceTab)
  );
}

export function tabById(layout: LayoutV3, tabId: string): WorkspaceTab | null {
  return layout.tabs.find((tab) => tab.id === tabId) ?? null;
}

/** The tiles of one tab; unknown ids read as empty. */
export function tabTiles(layout: LayoutV3, tabId: string): Tile[] {
  return tabById(layout, tabId)?.layout.tiles ?? [];
}

/** Every tile across the envelope, tabs in order. */
export function allTiles(layout: LayoutV3): Tile[] {
  return layout.tabs.flatMap((tab) => tab.layout.tiles);
}

/** Session ids across the envelope: tabs in order, reading order within. */
export function allSessionIds(layout: LayoutV3): string[] {
  return layout.tabs.flatMap((tab) => readingOrder(tab.layout.tiles));
}

/** The tab holding `sessionId`'s tile, or null. */
export function tabOfSession(layout: LayoutV3, sessionId: string): WorkspaceTab | null {
  return (
    layout.tabs.find((tab) => tab.layout.tiles.some((tile) => tile.session_id === sessionId)) ??
    null
  );
}

/** The envelope with one tab's tiles replaced. */
export function withTabTiles(layout: LayoutV3, tabId: string, tiles: Tile[]): LayoutV3 {
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, layout: { version: 3, tiles } } : tab,
    ),
  };
}

/**
 * Where a window added to `tabId` opens: the tab's own home when it has one,
 * else the workspace's, else nothing (and the caller has to ask).
 */
export function tabHome(
  layout: LayoutV3,
  tabId: string,
  workspace: { host_id: string | null; cwd: string | null },
): Home | null {
  const tab = tabById(layout, tabId);
  if (tab?.host_id && tab.cwd) return { host_id: tab.host_id, cwd: tab.cwd };
  if (workspace.host_id && workspace.cwd) return { host_id: workspace.host_id, cwd: workspace.cwd };
  return null;
}

/** The envelope with one tab re-pointed; null clears it back to inheriting. */
export function withTabHome(layout: LayoutV3, tabId: string, home: Home | null): LayoutV3 {
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, host_id: home?.host_id ?? null, cwd: home?.cwd ?? null } : tab,
    ),
  };
}

export function withActiveTab(layout: LayoutV3, tabId: string): LayoutV3 {
  return tabById(layout, tabId) ? { ...layout, active_tab: tabId } : layout;
}

/** Next unused "Tab N" default name. */
export function nextTabName(layout: LayoutV3): string {
  const names = new Set(layout.tabs.map((tab) => tab.name));
  let n = layout.tabs.length + 1;
  while (names.has(`Tab ${n}`)) n += 1;
  return `Tab ${n}`;
}

/** Append an empty tab and make it active; null when the envelope is full. */
export function addTab(layout: LayoutV3, id: string, name: string): LayoutV3 | null {
  if (layout.tabs.length >= MAX_TABS || tabById(layout, id)) return null;
  return {
    version: 3,
    active_tab: id,
    tabs: [...layout.tabs, { id, name, layout: { version: 3, tiles: [] } }],
  };
}

/**
 * A free name for a copy of `name`: "Build copy", then "Build copy 2" and on
 * up, so duplicating the same tab twice never collides.
 */
export function copyTabName(layout: LayoutV3, name: string): string {
  const taken = new Set(layout.tabs.map((tab) => tab.name));
  const base = `${name} copy`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

/**
 * Insert a copy of `tabId` into the strip and make it active. The copy keeps
 * the original's geometry exactly; `sessionIds` maps each source tile's
 * `session_id` to the id its copy should carry — a freshly created session for
 * a pane, a fresh uuid for a widget. Tiles missing from the map are dropped,
 * which is how a caller refuses to copy a pane whose session it could not
 * recreate.
 *
 * `atIndex` is the slot the copy takes, counted in the strip as it stands and
 * clamped to it; left out, the copy goes on the end. The source keeps its own
 * slot either way — a copy never displaces the tab it came from.
 *
 * Null when the envelope is full or the tab is unknown.
 */
export function duplicateTab(
  layout: LayoutV3,
  tabId: string,
  id: string,
  name: string,
  sessionIds: Map<string, string>,
  atIndex?: number,
): LayoutV3 | null {
  if (layout.tabs.length >= MAX_TABS || tabById(layout, id)) return null;
  const source = tabById(layout, tabId);
  if (!source) return null;
  const tiles = source.layout.tiles.flatMap((tile) => {
    const copyId = sessionIds.get(tile.session_id);
    return copyId ? [{ ...tile, session_id: copyId }] : [];
  });
  const tabs = [...layout.tabs];
  const at = atIndex === undefined ? tabs.length : Math.min(Math.max(atIndex, 0), tabs.length);
  tabs.splice(at, 0, {
    id,
    name,
    // A copy opens its windows where the original did.
    host_id: source.host_id ?? null,
    cwd: source.cwd ?? null,
    layout: { version: 3, tiles },
  });
  return { version: 3, active_tab: id, tabs };
}

/**
 * Drop a tab. The last tab cannot be removed — a workspace always has one.
 * When the active tab is removed, its nearest surviving neighbour (preferring
 * the one before it) becomes active.
 */
export function removeTab(layout: LayoutV3, tabId: string): LayoutV3 | null {
  const index = layout.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || layout.tabs.length <= 1) return null;
  const tabs = layout.tabs.filter((tab) => tab.id !== tabId);
  const active =
    layout.active_tab === tabId ? (tabs[Math.max(0, index - 1)]?.id ?? null) : layout.active_tab;
  return { version: 3, active_tab: active, tabs };
}

export function renameTab(layout: LayoutV3, tabId: string, name: string): LayoutV3 {
  return {
    ...layout,
    tabs: layout.tabs.map((tab) => (tab.id === tabId ? { ...tab, name } : tab)),
  };
}

/**
 * Move a tab to another slot in the strip, the index clamped to it. Null when
 * the id is unknown or the order would not change — callers treat null as
 * "nothing to persist".
 */
export function reorderTab(layout: LayoutV3, tabId: string, toIndex: number): LayoutV3 | null {
  const from = layout.tabs.findIndex((tab) => tab.id === tabId);
  if (from === -1) return null;
  const to = Math.min(Math.max(toIndex, 0), layout.tabs.length - 1);
  if (to === from) return null;
  const tabs = [...layout.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved as WorkspaceTab);
  return { ...layout, tabs };
}

/**
 * Move a session's tile into another tab, auto-placed. Null when the session
 * has no tile, the target does not exist, is its current tab, or is full —
 * callers treat null as "nothing to persist".
 */
export function moveSessionToTab(
  layout: LayoutV3,
  sessionId: string,
  targetTabId: string,
): LayoutV3 | null {
  const source = tabOfSession(layout, sessionId);
  const target = tabById(layout, targetTabId);
  if (!source || !target || source.id === target.id) return null;
  const tile = source.layout.tiles.find((item) => item.session_id === sessionId);
  if (!tile) return null;
  const placed = autoPlace(target.layout.tiles);
  if (placed.tile === null) return null;
  const moved: Tile = { ...tile, ...placed.tile };
  const without = remove(source.layout.tiles, sessionId);
  return withTabTiles(withTabTiles(layout, source.id, without), target.id, [
    ...placed.tiles,
    moved,
  ]);
}

/**
 * Fold one tab's windows into another and drop the emptied tab — the drop at
 * the end of dragging a tab down onto the canvas.
 *
 * The target keeps its own arrangement; the newcomers arrive in reading order
 * and are auto-placed around it, which is the same algebra a window added to
 * the target would use. All or nothing: if the target runs out of room part
 * way through, the whole merge is refused rather than leaving half a tab's
 * windows behind in a tab that is about to be closed.
 *
 * Null when either tab is unknown, they are the same tab, or the target
 * cannot hold everything the source is carrying — callers treat null as
 * "nothing to persist".
 */
export function mergeTabs(
  layout: LayoutV3,
  sourceTabId: string,
  targetTabId: string,
): LayoutV3 | null {
  const source = tabById(layout, sourceTabId);
  const target = tabById(layout, targetTabId);
  if (!source || !target || source.id === target.id) return null;
  let tiles = target.layout.tiles;
  for (const sessionId of readingOrder(source.layout.tiles)) {
    const tile = source.layout.tiles.find((item) => item.session_id === sessionId);
    if (!tile) continue;
    const placed = autoPlace(tiles);
    if (placed.tile === null) return null;
    tiles = [...placed.tiles, { ...tile, ...placed.tile }];
  }
  return foldTabInto(layout, sourceTabId, targetTabId, tiles);
}

/**
 * The envelope with `targetTabId` holding `tiles` and `sourceTabId` gone — the
 * last step of every merge, however the tiles were worked out. The target is
 * made active, since it is the tab that survives and the one being looked at.
 *
 * Split out because where the windows land is a canvas question (see
 * `workspace/tab-merge.ts`, which aims them) while dropping the emptied tab is
 * an envelope one, and only this file may answer that. Null when the source is
 * unknown or is the workspace's last tab.
 */
export function foldTabInto(
  layout: LayoutV3,
  sourceTabId: string,
  targetTabId: string,
  tiles: Tile[],
): LayoutV3 | null {
  if (!tabById(layout, targetTabId)) return null;
  // Remove second, so the source's tiles are never in two tabs at once in the
  // envelope handed to the caller.
  const next = removeTab(withTabTiles(layout, targetTabId, tiles), sourceTabId);
  return next ? withActiveTab(next, targetTabId) : null;
}
