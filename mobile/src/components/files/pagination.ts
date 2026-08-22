import type { HostDirEntry, HostDirList } from "@/components/files/types";

export const HOST_DIRECTORY_PAGE_ENTRIES = 96;
export const HOST_DIRECTORY_SCAN_LIMIT = 1024;
export const FILE_EXPLORER_RETAINED_PAGE_LIMIT = 32;
export const FILE_EXPLORER_RETAINED_ENTRY_LIMIT =
  FILE_EXPLORER_RETAINED_PAGE_LIMIT * HOST_DIRECTORY_PAGE_ENTRIES;

export interface RetainedDirectoryListing {
  entries: HostDirEntry[];
  nextCursor: number | null;
  limitReached: boolean;
}

export function validateDirectoryPage(page: HostDirList, cursor: number): HostDirList {
  const nextCursor = page.next_cursor;
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    typeof page.path !== "string" ||
    typeof page.home_dir !== "string" ||
    !Array.isArray(page.entries) ||
    page.entries.length > HOST_DIRECTORY_PAGE_ENTRIES ||
    (page.truncated !== undefined && typeof page.truncated !== "boolean") ||
    (nextCursor !== undefined &&
      nextCursor !== null &&
      (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor))
  ) {
    throw new Error("Host returned an invalid directory page.");
  }
  return { ...page, next_cursor: typeof nextCursor === "number" ? nextCursor : null };
}

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
  const last = pages.at(-1);
  const nextCursor = last?.next_cursor;
  if (last?.truncated === true) limitReached = true;
  if (entries.length >= entryLimit && typeof nextCursor === "number") limitReached = true;
  return {
    entries,
    nextCursor: limitReached || typeof nextCursor !== "number" ? null : nextCursor,
    limitReached,
  };
}
