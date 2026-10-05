import type { HostDirEntry, HostDirList } from "@/lib/hostControl";

/**
 * Where a folder's listing comes from.
 *
 * A v1 host (`fs.list`) answers 96 entries a page in raw directory order,
 * behind a positional cursor, and stops reading a folder at 1,024 entries
 * (daemon/src/host_files.rs, MAX_DIRECTORY_ENTRIES). One page is therefore an
 * arbitrary 96 — not the first 96 by name — so anything that sorts has to
 * drain every page first, and anything that says "all of them" has to admit
 * when the host stopped at its cap.
 *
 * Polling a drained folder costs eleven requests, so a refresh on a timer
 * reads page one only. A folder that fits on one page is then replaced
 * exactly, and one that has just grown past a page is read again in full,
 * once. A bigger folder cannot be brought up to date from one page — a name
 * missing from it may have been removed or only moved to a later page — so
 * when its first page differs from the one read with the rest, the listing is
 * marked `changedOnHost` and left as it was: the browser says "This folder
 * changed on <host>." with Refresh, rather than show rows that may be gone as
 * if they were live (the phone does the same). Everything is read again in
 * full on Refresh, when the tab comes back into focus, and after this
 * device's own changes. A host with `fs.list.v2` gets a snapshot source
 * behind the same interface (M8).
 *
 * Pure: the page fetcher is passed in.
 */

/** The host's own ceiling on one folder's listing. */
export const HOST_DIRECTORY_ENTRY_CAP = 1_024;

/**
 * Pages to ask for before giving up. Eleven 96-entry pages pass the host's
 * 1,024 cap; the twelfth is headroom for entries the host skipped (`.`/`..`).
 */
export const DRAIN_PAGE_BUDGET = 12;

export interface DirectoryListing {
  /** The folder, as the host spells it (absolute). */
  path: string;
  homeDir: string;
  parent: string | null;
  /** In the host's order, one entry per name. */
  entries: HostDirEntry[];
  /** The host stopped before the end of the folder. */
  truncated: boolean;
  /** It took more than one page, so page one alone cannot stand for it. */
  multiPage: boolean;
  /** Page one as it was read with the rest: what a poll compares against. */
  head: string;
  /**
   * A poll found page one different in a folder bigger than one page. The
   * entries are as last read in full; only a full read clears this.
   */
  changedOnHost: boolean;
}

export type FetchPage = (
  path: string | undefined,
  cursor: number,
  signal?: AbortSignal,
) => Promise<HostDirList>;

export interface DirectorySource {
  readonly kind: "v1-drain";
  /** Every entry the host will return for the folder. */
  drain(path: string | undefined, signal?: AbortSignal): Promise<DirectoryListing>;
  /** A cheap look at page one, folded into a listing already held. */
  poll(listing: DirectoryListing, signal?: AbortSignal): Promise<DirectoryListing>;
}

function sameEntry(a: HostDirEntry, b: HostDirEntry): boolean {
  return (
    a.name === b.name &&
    a.path === b.path &&
    a.kind === b.kind &&
    a.is_dir === b.is_dir &&
    (a.size ?? null) === (b.size ?? null) &&
    (a.modified_at ?? null) === (b.modified_at ?? null)
  );
}

/**
 * One entry per name. A positional cursor read while the folder changes can
 * hand the same name back on two pages; the later sighting is the fresher, so
 * it wins, in the place the name was first seen.
 */
export function dedupeByName(entries: readonly HostDirEntry[]): HostDirEntry[] {
  const index = new Map<string, number>();
  const out: HostDirEntry[] = [];
  for (const entry of entries) {
    const at = index.get(entry.name);
    if (at === undefined) {
      index.set(entry.name, out.length);
      out.push(entry);
    } else {
      out[at] = entry;
    }
  }
  return out;
}

/** What page one said, compactly: a poll of a multi-page folder compares this alone. */
export function pageFingerprint(page: HostDirList): string {
  return JSON.stringify([
    !pageIsWhole(page),
    page.entries.map((entry) => [
      entry.name,
      entry.kind,
      entry.is_dir === true,
      entry.size ?? null,
      entry.modified_at ?? null,
    ]),
  ]);
}

function sameEntries(a: readonly HostDirEntry[], b: readonly HostDirEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right || !sameEntry(left, right)) return false;
  }
  return true;
}

function pageIsWhole(page: HostDirList): boolean {
  return typeof page.next_cursor !== "number" && page.truncated !== true;
}

export async function drainDirectory(
  fetchPage: FetchPage,
  path: string | undefined,
  { budget = DRAIN_PAGE_BUDGET, signal }: { budget?: number; signal?: AbortSignal } = {},
): Promise<DirectoryListing> {
  const collected: HostDirEntry[] = [];
  let first: HostDirList | null = null;
  let cursor = 0;
  let truncated = true;
  let pages = 0;
  while (pages < budget) {
    if (signal?.aborted) throw new DOMException("Listing cancelled", "AbortError");
    const page = await fetchPage(path, cursor, signal);
    pages += 1;
    first ??= page;
    collected.push(...page.entries);
    // The host's own ceiling: it stopped reading, though more is on disk.
    if (page.truncated === true) break;
    if (typeof page.next_cursor !== "number") {
      truncated = false;
      break;
    }
    cursor = page.next_cursor;
  }
  const head = first as HostDirList;
  return {
    path: head.path,
    homeDir: head.home_dir,
    parent: head.parent ?? null,
    entries: dedupeByName(collected),
    truncated,
    multiPage: pages > 1,
    head: pageFingerprint(head),
    changedOnHost: false,
  };
}

/**
 * Fold a fresh page one into `listing`. Returns `listing` itself when the
 * page changes nothing, so an idle poll re-renders nothing.
 *
 * - Page one is the whole folder: the folder is exactly page one.
 * - A bigger folder whose page one is as it was: nothing is known to differ.
 * - A bigger folder whose page one moved: marked `changedOnHost`, entries
 *   untouched — a name gone from page one may be removed or just later on.
 */
export function mergeFirstPage(listing: DirectoryListing, page: HostDirList): DirectoryListing {
  const head = pageFingerprint(page);
  if (pageIsWhole(page)) {
    const entries = dedupeByName(page.entries);
    if (
      !listing.multiPage &&
      !listing.truncated &&
      !listing.changedOnHost &&
      listing.path === page.path &&
      sameEntries(entries, listing.entries)
    ) {
      return listing;
    }
    return {
      path: page.path,
      homeDir: page.home_dir,
      parent: page.parent ?? null,
      entries,
      truncated: false,
      multiPage: false,
      head,
      changedOnHost: false,
    };
  }
  if (head === listing.head || listing.changedOnHost) return listing;
  return { ...listing, changedOnHost: true };
}

export function createV1DrainSource(
  fetchPage: FetchPage,
  budget = DRAIN_PAGE_BUDGET,
): DirectorySource {
  return {
    kind: "v1-drain",
    drain: (path, signal) => drainDirectory(fetchPage, path, { budget, signal }),
    async poll(listing, signal) {
      const page = await fetchPage(listing.path, 0, signal);
      // A folder that fit on one page has grown past it: what is beyond page
      // one is unknown, so read it once rather than show half a folder sorted.
      if (!listing.multiPage && !pageIsWhole(page)) {
        return drainDirectory(fetchPage, listing.path, { budget, signal });
      }
      return mergeFirstPage(listing, page);
    },
  };
}
