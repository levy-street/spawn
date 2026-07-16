import {
  HOST_DIRECTORY_PAGE_ENTRIES,
  type HostDirEntry,
  type HostDirList,
} from "@/lib/hostControl";

export const FILE_EXPLORER_RETAINED_PAGE_LIMIT = 32;
export const FILE_EXPLORER_RETAINED_ENTRY_LIMIT =
  FILE_EXPLORER_RETAINED_PAGE_LIMIT * HOST_DIRECTORY_PAGE_ENTRIES;

export interface RetainedDirectoryListing {
  entries: HostDirEntry[];
  nextCursor: number | null;
  limitReached: boolean;
}

/** Merge only pages the user explicitly requested, retaining a fixed entry budget. */
export function retainDirectoryPages(
  pages: readonly HostDirList[],
  entryLimit = FILE_EXPLORER_RETAINED_ENTRY_LIMIT,
): RetainedDirectoryListing {
  const entries: HostDirEntry[] = [];
  let limitReached = false;
  for (const page of pages) {
    const remaining = Math.max(0, entryLimit - entries.length);
    entries.push(...page.entries.slice(0, remaining));
    if (page.entries.length > remaining) {
      limitReached = true;
      break;
    }
  }
  const nextCursor = pages.at(-1)?.next_cursor;
  if (pages.at(-1)?.truncated === true) limitReached = true;
  if (entries.length >= entryLimit && typeof nextCursor === "number") limitReached = true;
  return {
    entries,
    nextCursor: limitReached || typeof nextCursor !== "number" ? null : nextCursor,
    limitReached,
  };
}
