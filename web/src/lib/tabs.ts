import { autoPlace, type LayoutV2, readingOrder, remove, type Tile } from "@/lib/grid";

/**
 * Layout schema v3 — the tab envelope (docs/OVERHAUL.md §4.4-tabs).
 *
 * A workspace holds an ordered list of named tabs, each wrapping one v2 tile
 * grid; the v2 algebra in `lib/grid.ts` (and its conformance fixtures) is
 * untouched. Everything here is pure: no ambient state, inputs never mutated,
 * unknown tab ids answered with the input unchanged (or null where the caller
 * must know the operation failed). The server twin of the envelope rules
 * lives in `spawn_server/routes/workspaces.py`.
 */

export interface WorkspaceTab {
  id: string;
  name: string;
  layout: LayoutV2;
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
      tab.id === tabId ? { ...tab, layout: { version: 2, tiles } } : tab,
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
    tabs: [...layout.tabs, { id, name, layout: { version: 2, tiles: [] } }],
  };
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
