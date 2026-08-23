import { autoPlace, canAddTile, orderedTiles, removeTile } from "@/data/layout/tiles";
import type {
  HostId,
  PaneId,
  TabId,
  Tile,
  WorkspaceLayoutV3,
  WorkspaceTab,
} from "@/data/types/layout";

export const MAX_TABS = 8;

export function getActiveTab(layout: WorkspaceLayoutV3): WorkspaceTab {
  return (
    layout.tabs.find((tab) => tab.id === layout.active_tab) ?? (layout.tabs[0] as WorkspaceTab)
  );
}

export function setActiveTab(layout: WorkspaceLayoutV3, tabId: TabId): WorkspaceLayoutV3 {
  if (!layout.tabs.some((tab) => tab.id === tabId) || layout.active_tab === tabId) return layout;
  return { ...layout, active_tab: tabId };
}

export function canAddTab(layout: WorkspaceLayoutV3): boolean {
  return layout.tabs.length < MAX_TABS;
}

export function nextTabName(tabs: readonly WorkspaceTab[]): string {
  const names = new Set(tabs.map((tab) => tab.name));
  let suffix = tabs.length + 1;
  while (names.has(`Tab ${suffix}`)) suffix += 1;
  return `Tab ${suffix}`;
}

export function addTab(
  layout: WorkspaceLayoutV3,
  id: TabId,
  name = nextTabName(layout.tabs),
): WorkspaceLayoutV3 | null {
  const normalizedName = name.trim().slice(0, 64);
  if (
    !canAddTab(layout) ||
    id.length === 0 ||
    layout.tabs.some((tab) => tab.id === id) ||
    !normalizedName
  ) {
    return null;
  }
  const tab: WorkspaceTab = {
    id,
    name: normalizedName,
    host_id: null,
    cwd: null,
    layout: { version: 3, tiles: [] },
  };
  return { ...layout, active_tab: id, tabs: [...layout.tabs, tab] };
}

export function renameTab(
  layout: WorkspaceLayoutV3,
  tabId: TabId,
  name: string,
): WorkspaceLayoutV3 {
  const normalized = name.trim().slice(0, 64);
  if (!normalized || !layout.tabs.some((tab) => tab.id === tabId)) return layout;
  return {
    ...layout,
    tabs: layout.tabs.map((tab) => (tab.id === tabId ? { ...tab, name: normalized } : tab)),
  };
}

export function reorderTab(
  layout: WorkspaceLayoutV3,
  tabId: TabId,
  toIndex: number,
): WorkspaceLayoutV3 {
  const fromIndex = layout.tabs.findIndex((tab) => tab.id === tabId);
  if (fromIndex < 0 || layout.tabs.length < 2) return layout;
  const target = Math.min(Math.max(0, Math.trunc(toIndex)), layout.tabs.length - 1);
  if (fromIndex === target) return layout;
  const tabs = [...layout.tabs];
  const [tab] = tabs.splice(fromIndex, 1);
  if (!tab) return layout;
  tabs.splice(target, 0, tab);
  return { ...layout, tabs };
}

export function canRemoveTab(layout: WorkspaceLayoutV3, tabId: TabId): boolean {
  return layout.tabs.length > 1 && layout.tabs.some((tab) => tab.id === tabId);
}

export function removeTab(layout: WorkspaceLayoutV3, tabId: TabId): WorkspaceLayoutV3 | null {
  const index = layout.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0 || !canRemoveTab(layout, tabId)) return null;
  const tabs = layout.tabs.filter((tab) => tab.id !== tabId);
  const active_tab =
    layout.active_tab === tabId
      ? (tabs[Math.max(0, index - 1)]?.id ?? tabs[0]?.id ?? null)
      : layout.active_tab;
  return { ...layout, active_tab, tabs };
}

export function setTabHome(
  layout: WorkspaceLayoutV3,
  tabId: TabId,
  home: { host_id: HostId; cwd: string } | null,
): WorkspaceLayoutV3 {
  if (!layout.tabs.some((tab) => tab.id === tabId)) return layout;
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.id === tabId ? { ...tab, host_id: home?.host_id ?? null, cwd: home?.cwd ?? null } : tab,
    ),
  };
}

export function allTiles(layout: WorkspaceLayoutV3): Tile[] {
  return layout.tabs.flatMap((tab) => orderedTiles(tab.layout.tiles));
}

export interface PaneLocation {
  tab: WorkspaceTab;
  tile: Tile;
}

export function findPane(layout: WorkspaceLayoutV3, paneId: PaneId): PaneLocation | null {
  for (const tab of layout.tabs) {
    const tile = tab.layout.tiles.find((candidate) => candidate.session_id === paneId);
    if (tile) return { tab, tile };
  }
  return null;
}

export function canMovePaneToTab(
  layout: WorkspaceLayoutV3,
  paneId: PaneId,
  targetTabId: TabId,
): boolean {
  const source = findPane(layout, paneId);
  const target = layout.tabs.find((tab) => tab.id === targetTabId);
  return Boolean(source && target && source.tab.id !== target.id && canAddTile(target.layout));
}

export function movePaneToTab(
  layout: WorkspaceLayoutV3,
  paneId: PaneId,
  targetTabId: TabId,
): WorkspaceLayoutV3 | null {
  const source = findPane(layout, paneId);
  const target = layout.tabs.find((tab) => tab.id === targetTabId);
  if (!source || !target || source.tab.id === target.id) return null;
  const placement = autoPlace(target.layout.tiles);
  if (!placement.tile) return null;

  const moved = { ...source.tile, ...placement.tile };
  return {
    ...layout,
    tabs: layout.tabs.map((tab) => {
      if (tab.id === source.tab.id) {
        return { ...tab, layout: { ...tab.layout, tiles: removeTile(tab.layout.tiles, paneId) } };
      }
      if (tab.id === target.id) {
        return {
          ...tab,
          layout: { ...tab.layout, tiles: orderedTiles([...placement.tiles, moved]) },
        };
      }
      return tab;
    }),
  };
}

export function removePane(layout: WorkspaceLayoutV3, paneId: PaneId): WorkspaceLayoutV3 {
  const source = findPane(layout, paneId);
  if (!source) return layout;
  return {
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.id === source.tab.id
        ? { ...tab, layout: { ...tab.layout, tiles: removeTile(tab.layout.tiles, paneId) } }
        : tab,
    ),
  };
}
