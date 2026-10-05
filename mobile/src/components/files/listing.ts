import {
  HOST_DIRECTORY_PAGE_ENTRIES,
  HOST_DIRECTORY_SCAN_LIMIT,
} from "@/components/files/pagination";
import type { HostDirEntry, HostDirList } from "@/components/files/types";

/**
 * Pages to ask for before giving up on a folder. The daemon stops listing at
 * 1,024 entries, which is eleven pages of 96; one more covers a folder that
 * changed while it was being read.
 */
export const DIRECTORY_DRAIN_PAGE_BUDGET =
  Math.ceil(HOST_DIRECTORY_SCAN_LIMIT / HOST_DIRECTORY_PAGE_ENTRIES) + 1;

/**
 * One folder, every page of it read, in the host's own order. Sorting and
 * filtering happen on the device, over all of it, so they can only cover what
 * a v1 host lists: the first 1,024 entries it finds.
 */
export interface DirectoryListing {
  path: string;
  homeDir: string;
  entries: HostDirEntry[];
  /** The host had more than it lists (or the page budget ran out first). */
  truncated: boolean;
  /** Page 1 was the whole folder, so polling page 1 sees all of it. */
  singlePage: boolean;
  /** Page 1 as it was read, to tell whether a later look at it differs. */
  head: string;
  /**
   * A poll of page 1 found it changed, in a folder too large for page 1 to
   * stand for the whole: the rest is read again only when asked.
   */
  changedOnHost: boolean;
}

/**
 * Page cursors are positions in a directory that can change between two
 * reads, so a name can come round twice. One row per name: the later reading
 * is the fresher, so it wins, in the place the name was first seen — the web
 * file browser keeps the same rule.
 */
export function dedupeEntries(entries: readonly HostDirEntry[]): HostDirEntry[] {
  const at = new Map<string, number>();
  const unique: HostDirEntry[] = [];
  for (const entry of entries) {
    const index = at.get(entry.name);
    if (index === undefined) {
      at.set(entry.name, unique.length);
      unique.push(entry);
    } else {
      unique[index] = entry;
    }
  }
  return unique;
}

function pageHasMore(page: HostDirList): boolean {
  return page.truncated === true || typeof page.next_cursor === "number";
}

/** What page 1 said, compactly: a poll compares this and nothing else. */
export function pageFingerprint(page: HostDirList): string {
  return JSON.stringify([
    pageHasMore(page),
    page.entries.map((entry) => [
      entry.name,
      entry.kind,
      entry.size ?? null,
      entry.modified_at ?? null,
    ]),
  ]);
}

/** Reads a folder to its end, or to the host's 1,024-entry limit. */
export async function drainDirectory(
  fetchPage: (cursor: number) => Promise<HostDirList>,
  budget = DIRECTORY_DRAIN_PAGE_BUDGET,
): Promise<DirectoryListing> {
  const first = await fetchPage(0);
  const entries = [...first.entries];
  let last = first;
  let pages = 1;
  while (last.truncated !== true && typeof last.next_cursor === "number" && pages < budget) {
    last = await fetchPage(last.next_cursor);
    entries.push(...last.entries);
    pages += 1;
  }
  return {
    path: first.path,
    homeDir: first.home_dir,
    entries: dedupeEntries(entries),
    truncated: pageHasMore(last),
    singlePage: !pageHasMore(first),
    head: pageFingerprint(first),
    changedOnHost: false,
  };
}

/**
 * What a fresh look at page 1 means for what is shown:
 * - `same`: nothing changed, so nothing renders.
 * - `replace`: the folder fits on one page, so page 1 is all of it.
 * - `reread`: a folder that fit on one page has grown past it. What lies
 *   beyond page 1 is unknown, so it is read once in full rather than shown
 *   half-sorted.
 * - `changed`: page 1 of a larger folder changed. Reading every page on every
 *   poll would spend a channel's request budget in minutes, so the folder only
 *   says it changed; the rest is read on Refresh or when it comes back into
 *   view. Nothing that may no longer exist is passed off as live.
 */
export type FirstPagePoll =
  | { kind: "same" }
  | { kind: "replace"; listing: DirectoryListing }
  | { kind: "reread" }
  | { kind: "changed"; listing: DirectoryListing };

export function applyFirstPagePoll(current: DirectoryListing, page: HostDirList): FirstPagePoll {
  const head = pageFingerprint(page);
  if (head === current.head) return { kind: "same" };
  if (!pageHasMore(page)) {
    return {
      kind: "replace",
      listing: {
        path: page.path,
        homeDir: page.home_dir,
        entries: dedupeEntries(page.entries),
        truncated: false,
        singlePage: true,
        head,
        changedOnHost: false,
      },
    };
  }
  if (current.singlePage) return { kind: "reread" };
  return current.changedOnHost
    ? { kind: "same" }
    : { kind: "changed", listing: { ...current, changedOnHost: true } };
}
