import type { HostDirEntry } from "@/components/files/types";

/**
 * Hidden means a leading dot, on every host. The daemon does not report the
 * Windows hidden attribute or macOS's UF_HIDDEN yet, so `AppData` and
 * `~/Library` still show; the toggle is the same one on web and phone.
 */
export function isHiddenEntry(entry: Pick<HostDirEntry, "name">): boolean {
  return entry.name.startsWith(".");
}

export interface FileFilter {
  /** What has been typed into "Filter this folder"; matched anywhere in the name. */
  query: string;
  showHidden: boolean;
}

export function normalizedFilterQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function matchesFilter(entry: Pick<HostDirEntry, "name">, query: string): boolean {
  const needle = normalizedFilterQuery(query);
  return needle.length === 0 || entry.name.toLocaleLowerCase().includes(needle);
}

/** The entries a folder shows: hidden ones only when asked for, then the filter. */
export function filterEntries(
  entries: readonly HostDirEntry[],
  { query, showHidden }: FileFilter,
): HostDirEntry[] {
  return entries.filter(
    (entry) => (showHidden || !isHiddenEntry(entry)) && matchesFilter(entry, query),
  );
}

/** How many entries the hidden toggle is keeping out of view, filter applied. */
export function countHiddenMatches(entries: readonly HostDirEntry[], query: string): number {
  let hidden = 0;
  for (const entry of entries) {
    if (isHiddenEntry(entry) && matchesFilter(entry, query)) hidden += 1;
  }
  return hidden;
}
