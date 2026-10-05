import type { HostDirEntry } from "@/components/files/types";

/**
 * Selection mode's state is a set of paths. It lives in memory only and
 * belongs to the folder on screen, so it never outlives the entries it names.
 */
export type FileSelection = ReadonlySet<string>;

export const EMPTY_SELECTION: FileSelection = new Set<string>();

export function toggleSelected(selection: FileSelection, path: string): FileSelection {
  const next = new Set(selection);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}

/** Everything showing, which with a filter typed is only what matches it. */
export function selectAllShown(entries: readonly HostDirEntry[]): FileSelection {
  return new Set(entries.map((entry) => entry.path));
}

export function allShownSelected(
  selection: FileSelection,
  entries: readonly HostDirEntry[],
): boolean {
  return entries.length > 0 && entries.every((entry) => selection.has(entry.path));
}

/**
 * Drops whatever is no longer shown: deleted on the host, renamed, hidden by
 * the filter or the hidden toggle. A bulk action only ever touches rows the
 * person can see. Returns `selection` itself when nothing went.
 */
export function retainShown(
  selection: FileSelection,
  entries: readonly HostDirEntry[],
): FileSelection {
  if (selection.size === 0) return selection;
  const shown = new Set(entries.map((entry) => entry.path));
  let dropped = false;
  const next = new Set<string>();
  for (const path of selection) {
    if (shown.has(path)) next.add(path);
    else dropped = true;
  }
  return dropped ? next : selection;
}

/** The selected entries, in the order the folder shows them. */
export function selectedEntries(
  selection: FileSelection,
  entries: readonly HostDirEntry[],
): HostDirEntry[] {
  return entries.filter((entry) => selection.has(entry.path));
}
