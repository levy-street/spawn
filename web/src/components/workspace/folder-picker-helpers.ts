import { type MenuAnchor, type MenuPlacement, placeMenu } from "@/components/ui/menu-position";
import type { HostDirEntry, HostDirList } from "@/lib/hostControl";
import { normalizeAbsolutePath, parentDir, trimTrailingSlash } from "@/lib/paths";

/** Gutter the centred panel keeps from the viewport edge — `placeMenu`'s own. */
const PANEL_MARGIN = 8;

/**
 * Where the picker panel goes.
 *
 * Anchored like a menu when it has a control to hang off; centred in the
 * viewport when it has none. The third case is the one that earns this
 * function: an anchor that is an *area* rather than a control — the grid's
 * "Add a window" opening can be most of the canvas — leaves `placeMenu` no
 * side worth having, and its cap squashed the panel into the sliver above the
 * opening: a breadcrumb row with the whole browser crushed out of it. A panel
 * that cannot get at least half its preferred height beside its anchor is
 * better off centred over it.
 */
export function placePickerPanel({
  anchor,
  width,
  height,
  preferredHeight,
  viewportWidth,
  viewportHeight,
}: {
  /** The control the panel hangs off, or null to centre. */
  anchor: MenuAnchor | null;
  /** The panel's current rendered size. */
  width: number;
  height: number;
  /** What the panel wants to be — the yardstick squashing is measured by. */
  preferredHeight: number;
  viewportWidth: number;
  viewportHeight: number;
}): MenuPlacement {
  if (anchor) {
    const placed = placeMenu({
      anchor,
      menuWidth: width,
      menuHeight: height,
      align: "start",
      viewportWidth,
      viewportHeight,
    });
    if (placed.maxHeight >= preferredHeight / 2) return placed;
  }
  return {
    position: "fixed",
    left: Math.max(PANEL_MARGIN, (viewportWidth - width) / 2),
    top: Math.max(PANEL_MARGIN, (viewportHeight - height) / 2),
    maxHeight: viewportHeight - PANEL_MARGIN * 2,
    maxWidth: viewportWidth - PANEL_MARGIN * 2,
    // Nothing usable to grow out of, so it grows from its own middle.
    transformOrigin: "center",
  };
}

export function joinDirectory(parent: string, child: string): string {
  return normalizeAbsolutePath(`${trimTrailingSlash(parent)}/${child}`);
}

/**
 * The directories a picker list shows: subdirectories only, dot-folders
 * hidden unless asked for, narrowed by the filter box, sorted by name.
 */
export function visibleDirectories<T extends { name: string; is_dir: boolean }>(
  entries: readonly T[] | undefined,
  { filter = "", showHidden = false }: { filter?: string; showHidden?: boolean } = {},
): T[] {
  const needle = filter.trim().toLocaleLowerCase();
  return (entries ?? [])
    .filter((entry) => entry.is_dir)
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .filter((entry) => !needle || entry.name.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * The host only ever serves paths under the account's home directory — the
 * daemon's file service is rooted there and answers anything above it with
 * `outside_root`. Every navigation affordance in the picker is therefore
 * measured against home, not `/`, so the UI can never offer a step the host
 * would refuse.
 */
export function homeRoot(homeDir: string): string {
  return trimTrailingSlash(normalizeAbsolutePath(homeDir || "/")) || "/";
}

/** True when `path` is the home root itself or sits beneath it. */
export function isWithinHome(path: string, homeDir: string): boolean {
  const home = homeRoot(homeDir);
  const target = trimTrailingSlash(normalizeAbsolutePath(path || "/"));
  if (home === "/") return true;
  return target === home || target.startsWith(`${home}/`);
}

/**
 * The folder to step up into, or `null` when there is nowhere left to go:
 * home is the ceiling, so the ".." row disappears there rather than walking
 * the user into an error.
 */
export function parentWithinHome(path: string, homeDir: string): string | null {
  if (!isWithinHome(path, homeDir)) return null;
  const home = homeRoot(homeDir);
  const target = trimTrailingSlash(normalizeAbsolutePath(path || "/"));
  if (target === home) return null;
  return parentDir(target);
}

/**
 * Crumbs from the home root down to `path`. Ancestors of home are omitted
 * entirely — they are not browsable, and a crumb that only ever errors is
 * worse than no crumb.
 */
export function breadcrumbParts(
  path: string,
  homeDir: string,
): Array<{ label: string; path: string }> {
  const home = homeRoot(homeDir);
  const breadcrumbs = [{ label: home === "/" ? "/" : "Home", path: home }];
  if (!isWithinHome(path, home)) return breadcrumbs;
  const relative = trimTrailingSlash(normalizeAbsolutePath(path || "/")).slice(
    home === "/" ? 0 : home.length,
  );
  let current = home === "/" ? "" : home;
  for (const part of relative.split("/").filter(Boolean)) {
    current += `/${part}`;
    breadcrumbs.push({ label: part, path: current });
  }
  return breadcrumbs;
}

/** One column of the picker's Finder-style trail. */
export type FolderColumn = {
  /** The folder this column lists. */
  path: string;
  /** The child of `path` the trail continues through, highlighted here. */
  selectedChild: string | null;
};

/**
 * The column trail for `path`: one column per ancestor from the home root
 * down, each highlighting the child the trail continues through, then a final
 * column listing `path`'s own subfolders with nothing selected yet.
 *
 * The trail is derived from the path rather than accumulated as you click, so
 * every way of moving — a crumb, the drill menu, an arrow key, a stale saved
 * cwd — rebuilds the same columns. There is no history to fall out of sync.
 */
export function folderColumns(path: string, homeDir: string): FolderColumn[] {
  const trail = breadcrumbParts(path, homeDir);
  return trail.map((crumb, index) => ({
    path: crumb.path,
    selectedChild: trail[index + 1]?.path ?? null,
  }));
}

/**
 * Pages to ask for before giving up on a directory. The daemon serves 96
 * entries a page and refuses to inventory more than 1024 of them, so twelve
 * rounds reaches the end of anything it will ever return.
 */
export const FOLDER_PAGE_BUDGET = 12;

/**
 * Every entry in a directory, not just the first page.
 *
 * The daemon returns entries in raw readdir order, unsorted — so a single page
 * is an arbitrary 96 of them, not the first 96 alphabetically. In a home
 * directory (where dotfiles and loose files easily fill a page on their own)
 * that left the picker showing a scattered handful of real folders and hiding
 * the rest. Anything that lists folders has to drain the cursor.
 */
export async function listAllEntries(
  fetchPage: (cursor: number) => Promise<HostDirList>,
  budget = FOLDER_PAGE_BUDGET,
): Promise<{ entries: HostDirEntry[]; truncated: boolean }> {
  const entries: HostDirEntry[] = [];
  let cursor = 0;
  for (let page = 0; page < budget; page += 1) {
    const result = await fetchPage(cursor);
    entries.push(...result.entries);
    // The daemon's own ceiling: it stopped reading the directory, so there is
    // nothing further to ask for even though more exists on disk.
    if (result.truncated === true) return { entries, truncated: true };
    if (typeof result.next_cursor !== "number") return { entries, truncated: false };
    cursor = result.next_cursor;
  }
  return { entries, truncated: true };
}
