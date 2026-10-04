import type { HostDirEntry } from "@/lib/hostControl";
import { classifyFile } from "@/lib/preview/file-kinds";

/**
 * How a folder's entries are ordered, the way a desktop file manager orders
 * them: names in natural order ("file2" before "file10"), folders on top
 * unless asked otherwise, and a missing value — a folder's size, a timestamp
 * the host could not read — always at the bottom, whichever way the column
 * runs. The daemon lists entries in raw directory order, which on ext4 looks
 * random, so every order a person sees is made here.
 *
 * Pure and DOM-free. Mobile mirrors these rules in its own module.
 */

export type SortKey = "name" | "modified" | "size" | "kind";
export type SortOrder = "asc" | "desc";

export interface SortSpec {
  key: SortKey;
  order: SortOrder;
  /** Folders above everything else, whichever way the column runs. */
  foldersFirst: boolean;
}

export const SORT_KEYS: readonly SortKey[] = ["name", "modified", "size", "kind"];

export const DEFAULT_SORT: SortSpec = { key: "name", order: "asc", foldersFirst: true };

/**
 * The order a column takes on its first click. Names and kinds read A to Z;
 * dates and sizes lead with the newest and the largest, which is what someone
 * clicking "Date modified" is looking for.
 */
export const FIRST_ORDER: Record<SortKey, SortOrder> = {
  name: "asc",
  kind: "asc",
  modified: "desc",
  size: "desc",
};

export type SortableEntry = Pick<HostDirEntry, "name" | "kind" | "is_dir" | "size" | "modified_at">;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Natural, case-insensitive order. Names the collator calls equal ("Readme"
 * and "README") still get a fixed order by code unit, or two rows would swap
 * places every time a poll rebuilt the list.
 */
export function naturalCompare(a: string, b: string): number {
  const primary = collator.compare(a, b);
  if (primary !== 0) return primary;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isFolder(entry: Pick<HostDirEntry, "is_dir">): boolean {
  return entry.is_dir === true;
}

/** The Kind column's words: "Folder", "Markdown", "PNG image", "File". */
export function kindLabel(entry: Pick<HostDirEntry, "name" | "kind" | "is_dir" | "size">): string {
  if (isFolder(entry)) return "Folder";
  return classifyFile(entry).label;
}

/** Clicking a column: the same column reverses, another starts at its first order. */
export function toggleSort(spec: SortSpec, key: SortKey): SortSpec {
  if (spec.key === key) return { ...spec, order: spec.order === "asc" ? "desc" : "asc" };
  return { ...spec, key, order: FIRST_ORDER[key] };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function sortEntries<T extends SortableEntry>(entries: readonly T[], spec: SortSpec): T[] {
  const direction = spec.order === "asc" ? 1 : -1;
  const rows = entries.map((entry) => ({
    entry,
    folder: isFolder(entry),
    kind: spec.key === "kind" ? kindLabel(entry) : "",
    value:
      spec.key === "size"
        ? finiteOrNull(entry.is_dir ? null : entry.size)
        : spec.key === "modified"
          ? finiteOrNull(entry.modified_at)
          : null,
  }));
  rows.sort((a, b) => {
    if (spec.foldersFirst && a.folder !== b.folder) return a.folder ? -1 : 1;
    if (spec.key === "size" || spec.key === "modified") {
      // Missing values sink in both directions: "no size" is not "smallest".
      if (a.value === null || b.value === null) {
        if (a.value !== b.value) return a.value === null ? 1 : -1;
      } else if (a.value !== b.value) {
        return (a.value - b.value) * direction;
      }
      return naturalCompare(a.entry.name, b.entry.name);
    }
    if (spec.key === "kind") {
      const byKind = naturalCompare(a.kind, b.kind);
      if (byKind !== 0) return byKind * direction;
      return naturalCompare(a.entry.name, b.entry.name);
    }
    return naturalCompare(a.entry.name, b.entry.name) * direction;
  });
  return rows.map((row) => row.entry);
}

/** A stored sort, read back tolerantly: anything unreadable is the default. */
export function parseSortSpec(raw: unknown): SortSpec {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SORT;
  const value = raw as Record<string, unknown>;
  const key = SORT_KEYS.includes(value.key as SortKey) ? (value.key as SortKey) : DEFAULT_SORT.key;
  const order = value.order === "asc" || value.order === "desc" ? value.order : FIRST_ORDER[key];
  const foldersFirst =
    typeof value.foldersFirst === "boolean" ? value.foldersFirst : DEFAULT_SORT.foldersFirst;
  return { key, order, foldersFirst };
}
