/**
 * "Filter this folder": narrowing what is already listed as someone types.
 *
 * Client-side over the entries the host returned (a v1 host returns at most
 * 1,024 per folder). Hidden means a dot-name, which is what every host this
 * client can reach marks hidden today; the Windows hidden attribute arrives
 * with fs.list.v2.
 *
 * Pure and DOM-free. Mobile mirrors these rules in its own module.
 */

export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/** The typed text as it is matched: trimmed, case-folded. */
export function normalizeFilter(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Where `query` first occurs in `name`, as [start, end) for highlighting, or
 * null. Case-insensitive. When case-folding changes a name's length (a few
 * scripts do) the match still counts but has no range to draw.
 */
export function matchName(name: string, query: string): [number, number] | null | "unranged" {
  const needle = normalizeFilter(query);
  if (!needle) return null;
  const folded = name.toLowerCase();
  const at = folded.indexOf(needle);
  if (at < 0) return null;
  if (folded.length !== name.length) return "unranged";
  return [at, at + needle.length];
}

export function nameMatches(name: string, query: string): boolean {
  const needle = normalizeFilter(query);
  return !needle || name.toLowerCase().includes(needle);
}

export interface FilteredEntries<T> {
  visible: T[];
  /**
   * Entries left out only because they are hidden: the hidden names the
   * filter would otherwise show (every hidden name while nothing is typed).
   * It is the "· H hidden" of the count line, on both platforms.
   */
  hiddenCount: number;
}

export function filterEntries<T extends { name: string }>(
  entries: readonly T[],
  { query = "", showHidden = false }: { query?: string; showHidden?: boolean },
): FilteredEntries<T> {
  const visible: T[] = [];
  let hiddenCount = 0;
  for (const entry of entries) {
    if (!nameMatches(entry.name, query)) continue;
    if (!showHidden && isHiddenName(entry.name)) hiddenCount += 1;
    else visible.push(entry);
  }
  return { visible, hiddenCount };
}
