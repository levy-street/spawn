import type { HostDirList } from "@/components/files/types";

export const HOST_DIRECTORY_PAGE_ENTRIES = 96;
/** A v1 host lists at most this many entries of a folder, in the order it finds them. */
export const HOST_DIRECTORY_SCAN_LIMIT = 1024;

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
