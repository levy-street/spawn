import { classifyFile } from "@/components/files/file-kinds";
import type { HostDirEntry } from "@/components/files/types";

/**
 * How a folder is ordered. The same four fields and the same rules as the web
 * file browser's Details view: folders on top unless the person turns that
 * off, then the chosen field, and anything the field cannot tell apart falls
 * back to the name, A to Z.
 */
export type FileSortKey = "name" | "modified" | "size" | "kind";
export type FileSortDirection = "asc" | "desc";

export interface FileSort {
  key: FileSortKey;
  direction: FileSortDirection;
}

export const FILE_SORT_KEYS: readonly FileSortKey[] = ["name", "modified", "size", "kind"];
export const DEFAULT_FILE_SORT: Readonly<FileSort> = Object.freeze({
  key: "name",
  direction: "asc",
});

export const FILE_SORT_LABELS: Readonly<Record<FileSortKey, string>> = {
  name: "Name",
  modified: "Date modified",
  size: "Size",
  kind: "Kind",
};

/** What each direction reads as for a field, the field's starting direction first. */
export const FILE_SORT_DIRECTION_LABELS: Readonly<
  Record<FileSortKey, Readonly<Record<FileSortDirection, string>>>
> = {
  name: { asc: "A to Z", desc: "Z to A" },
  modified: { desc: "Newest first", asc: "Oldest first" },
  size: { desc: "Largest first", asc: "Smallest first" },
  kind: { asc: "A to Z", desc: "Z to A" },
};

/** A field starts the way people look for it: names A to Z, the newest and the largest first. */
export function defaultSortDirection(key: FileSortKey): FileSortDirection {
  return key === "modified" || key === "size" ? "desc" : "asc";
}

export function isFileSortKey(value: unknown): value is FileSortKey {
  return typeof value === "string" && (FILE_SORT_KEYS as readonly string[]).includes(value);
}

export function isFileSortDirection(value: unknown): value is FileSortDirection {
  return value === "asc" || value === "desc";
}

let textCollator: Intl.Collator | null | undefined;
let naturalCollator: Intl.Collator | null | undefined;

function compareText(left: string, right: string): number {
  if (textCollator === undefined) {
    try {
      textCollator = new Intl.Collator(undefined, { sensitivity: "base" });
    } catch {
      textCollator = null;
    }
  }
  if (textCollator) return textCollator.compare(left, right);
  const lower = left.toLocaleLowerCase();
  const upper = right.toLocaleLowerCase();
  return lower < upper ? -1 : lower > upper ? 1 : 0;
}

/**
 * The platform's own natural order — `Intl.Collator` with numeric collation and
 * base sensitivity, the same collator the web explorer sorts with — but only on
 * an engine that really honours `numeric`. One that accepts the option and
 * ignores it would put "item10" before "item2", so it gets the fallback below.
 */
function platformNaturalCollator(): Intl.Collator | null {
  if (naturalCollator !== undefined) return naturalCollator;
  try {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    naturalCollator = collator.compare("item2", "item10") < 0 ? collator : null;
  } catch {
    naturalCollator = null;
  }
  return naturalCollator;
}

const DIGIT_RUN = /\d+/gu;

function longestDigitRun(name: string): number {
  let longest = 0;
  for (const run of name.match(DIGIT_RUN) ?? []) {
    longest = Math.max(longest, run.replace(/^0+(?=\d)/u, "").length);
  }
  return longest;
}

/**
 * Natural order without numeric collation: every digit run is written out to
 * the same width, leading zeros aside, so the base comparison of whole names
 * orders numbers by value and everything else — punctuation and spaces
 * against digits, say — exactly as the numeric collator would. Exported for
 * its tests; use `compareNames`.
 */
export function compareNamesByRuns(left: string, right: string): number {
  const width = Math.max(longestDigitRun(left), longestDigitRun(right));
  const padded = (name: string) =>
    name.replace(DIGIT_RUN, (run) => run.replace(/^0+(?=\d)/u, "").padStart(width, "0"));
  return compareText(padded(left), padded(right));
}

/**
 * Natural order: "page 2" before "page 10", case and accents set aside. Names
 * that still compare equal ("Notes" and "notes") fall back to their code
 * units, so the order is total and the same on every poll.
 */
export function compareNames(left: string, right: string): number {
  if (left === right) return 0;
  const collator = platformNaturalCollator();
  const natural = collator ? collator.compare(left, right) : compareNamesByRuns(left, right);
  if (natural !== 0) return natural;
  return left < right ? -1 : 1;
}

function compareKnownNumbers(
  left: number | null | undefined,
  right: number | null | undefined,
  direction: FileSortDirection,
): number {
  const leftKnown = typeof left === "number" && Number.isFinite(left);
  const rightKnown = typeof right === "number" && Number.isFinite(right);
  // An unknown size or date says nothing about order, so it goes last either way.
  if (!leftKnown || !rightKnown) return leftKnown === rightKnown ? 0 : leftKnown ? -1 : 1;
  const difference = left - right;
  return direction === "asc" ? difference : -difference;
}

function kindLabel(entry: HostDirEntry): string {
  return entry.is_dir ? "Folder" : classifyFile(entry).label;
}

/**
 * A total order for one folder's entries under `sort`. With `foldersFirst`,
 * folders sit above files whichever way the field runs. A folder has no size,
 * so by size it goes with the other unknowns, last.
 */
export function compareEntries(
  left: HostDirEntry,
  right: HostDirEntry,
  sort: FileSort,
  foldersFirst = true,
): number {
  if (foldersFirst && left.is_dir !== right.is_dir) return left.is_dir ? -1 : 1;
  let byField = 0;
  switch (sort.key) {
    case "name": {
      const names = compareNames(left.name, right.name);
      return sort.direction === "asc" ? names : -names;
    }
    case "modified":
      byField = compareKnownNumbers(left.modified_at, right.modified_at, sort.direction);
      break;
    case "size":
      byField = compareKnownNumbers(
        left.is_dir ? null : left.size,
        right.is_dir ? null : right.size,
        sort.direction,
      );
      break;
    case "kind": {
      const kinds = compareNames(kindLabel(left), kindLabel(right));
      byField = sort.direction === "asc" ? kinds : -kinds;
      break;
    }
  }
  return byField !== 0 ? byField : compareNames(left.name, right.name);
}

export function sortEntries(
  entries: readonly HostDirEntry[],
  sort: FileSort = DEFAULT_FILE_SORT,
  foldersFirst = true,
): HostDirEntry[] {
  return [...entries].sort((left, right) => compareEntries(left, right, sort, foldersFirst));
}
