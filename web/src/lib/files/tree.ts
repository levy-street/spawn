import type { HostDirEntry } from "@/lib/hostControl";
import { filterEntries, nameMatches } from "./filter";
import type { DirectoryListing } from "./listing";
import { isFolder, type SortSpec, sortEntries } from "./sort";

/**
 * The tree view, flattened: one row per visible entry in display order, with
 * its depth, plus a status row wherever a folder is still loading, failed,
 * was cut short by the host's cap, or changed on the host in a way one page
 * cannot show (a folder bigger than a page whose first page moved). Flat rows are what the list virtualizes
 * and what keyboard selection walks, so a range is always rows a person sees.
 *
 * With a filter, a folder stays when its own name matches or when it is open
 * and something inside it matches — otherwise typing a file's name would hide
 * the very folder it sits in.
 *
 * Pure and DOM-free.
 */

export interface TreeFolderState {
  listing: DirectoryListing | undefined;
  loading: boolean;
  error: unknown;
}

export type TreeRow =
  | {
      kind: "entry";
      entry: HostDirEntry;
      depth: number;
      parentDir: string;
      expanded: boolean;
    }
  | {
      kind: "status";
      dir: string;
      depth: number;
      state: "loading" | "error" | "truncated" | "changed";
      error?: unknown;
    };

export interface FlattenOptions {
  root: string;
  folder: (path: string) => TreeFolderState | undefined;
  expanded: ReadonlySet<string>;
  sort: SortSpec;
  query: string;
  showHidden: boolean;
}

export interface FlatTree {
  rows: TreeRow[];
  /** The root folder's own rows on screen: the "N items" of the count line. */
  rootShown: number;
  /** The root's hidden entries the filter would show: the "· H hidden". */
  rootHidden: number;
}

export function flattenTree(options: FlattenOptions): FlatTree {
  const { root, folder, expanded, sort, query, showHidden } = options;
  const walk = (dir: string, depth: number, trail: ReadonlySet<string>): TreeRow[] => {
    const state = folder(dir);
    const listing = state?.listing;
    if (!listing) {
      if (state?.error) return [{ kind: "status", dir, depth, state: "error", error: state.error }];
      return [{ kind: "status", dir, depth, state: "loading" }];
    }
    const out: TreeRow[] = [];
    // First, so it is seen without scrolling past the folder's contents.
    if (listing.changedOnHost) out.push({ kind: "status", dir, depth, state: "changed" });
    const { visible } = filterEntries(listing.entries, { showHidden });
    for (const entry of sortEntries(visible, sort)) {
      const open = isFolder(entry) && expanded.has(entry.path) && !trail.has(entry.path);
      const children = open ? walk(entry.path, depth + 1, new Set([...trail, entry.path])) : [];
      const matches = nameMatches(entry.name, query);
      const childMatches = children.some((row) => row.kind === "entry");
      if (!matches && !childMatches) continue;
      out.push({ kind: "entry", entry, depth, parentDir: dir, expanded: open });
      // Children were filtered on the way up, so a folder kept for its
      // matches shows just those.
      out.push(...children);
    }
    if (state?.error) out.push({ kind: "status", dir, depth, state: "error", error: state.error });
    if (listing.truncated) out.push({ kind: "status", dir, depth, state: "truncated" });
    return out;
  };
  const rows = walk(root, 0, new Set([root]));
  const listing = folder(root)?.listing;
  const rootShown = rows.filter((row) => row.kind === "entry" && row.depth === 0).length;
  const rootHidden = listing
    ? filterEntries(listing.entries, { query, showHidden }).hiddenCount
    : 0;
  return { rows, rootShown, rootHidden };
}

/**
 * What a delete of `items` actually removes: an item inside a folder that is
 * itself in the list goes with that folder, so it is neither counted in the
 * confirm nor asked for again (and then reported missing). Order is kept.
 */
export function outermostItems<T extends { path: string; isDir: boolean }>(
  items: readonly T[],
  within: (path: string, folder: string) => boolean,
): T[] {
  const folders = items.filter((item) => item.isDir).map((item) => item.path);
  return items.filter(
    (item) => !folders.some((folder) => folder !== item.path && within(item.path, folder)),
  );
}

/** The entry rows alone, in order: what selection and type-ahead walk. */
export function entryRows(rows: readonly TreeRow[]): Array<Extract<TreeRow, { kind: "entry" }>> {
  return rows.filter((row): row is Extract<TreeRow, { kind: "entry" }> => row.kind === "entry");
}
