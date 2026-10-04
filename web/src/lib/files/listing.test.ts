import { describe, expect, test } from "bun:test";
import type { HostDirEntry, HostDirList } from "@/lib/hostControl";
import {
  createV1DrainSource,
  type DirectoryListing,
  dedupeByName,
  drainDirectory,
  HOST_DIRECTORY_ENTRY_CAP,
  mergeFirstPage,
  pageFingerprint,
} from "./listing";

const PAGE = 96;

function entry(name: string, extra: Partial<HostDirEntry> = {}): HostDirEntry {
  return {
    name,
    path: `/home/me/dir/${name}`,
    kind: "file",
    is_dir: false,
    size: 1,
    modified_at: 1,
    ...extra,
  };
}

function page(entries: HostDirEntry[], extra: Partial<HostDirList> = {}): HostDirList {
  return {
    path: "/home/me/dir",
    home_dir: "/home/me",
    parent: "/home/me",
    entries,
    next_cursor: null,
    ...extra,
  };
}

/** A host folder of `count` entries served the way the daemon serves it. */
function hostFolder(count: number) {
  const all = Array.from({ length: count }, (_, i) => entry(`f${i}`));
  const calls: number[] = [];
  const fetchPage = async (_path: string | undefined, cursor: number) => {
    calls.push(cursor);
    const end = Math.min(cursor + PAGE, count, HOST_DIRECTORY_ENTRY_CAP);
    const truncated = count > HOST_DIRECTORY_ENTRY_CAP && end === HOST_DIRECTORY_ENTRY_CAP;
    return page(all.slice(cursor, end), {
      next_cursor: !truncated && end < count ? end : null,
      truncated,
    });
  };
  return { all, calls, fetchPage };
}

describe("draining a folder", () => {
  test("a small folder is one request", async () => {
    const host = hostFolder(40);
    const listing = await drainDirectory(host.fetchPage, "/home/me/dir");
    expect(listing.entries).toHaveLength(40);
    expect(listing.truncated).toBe(false);
    expect(listing.multiPage).toBe(false);
    expect(host.calls).toEqual([0]);
  });

  test("a bigger folder is read page by page to the end", async () => {
    const host = hostFolder(500);
    const listing = await drainDirectory(host.fetchPage, "/home/me/dir");
    expect(listing.entries).toHaveLength(500);
    expect(listing.truncated).toBe(false);
    expect(listing.multiPage).toBe(true);
    expect(host.calls).toEqual([0, 96, 192, 288, 384, 480]);
  });

  test("a folder past the host's cap stops there and says so", async () => {
    const host = hostFolder(5_000);
    const listing = await drainDirectory(host.fetchPage, "/home/me/dir");
    expect(listing.entries).toHaveLength(HOST_DIRECTORY_ENTRY_CAP);
    expect(listing.truncated).toBe(true);
    expect(host.calls).toHaveLength(11);
  });

  test("a host that never ends is cut off at the page budget, and that is truncation", async () => {
    let cursor = 0;
    const endless = async () => {
      cursor += 1;
      return page([entry(`n${cursor}`)], { next_cursor: cursor });
    };
    const listing = await drainDirectory(endless, undefined, { budget: 3 });
    expect(listing.entries).toHaveLength(3);
    expect(listing.truncated).toBe(true);
  });

  test("a name seen on two pages is listed once, with its later reading", async () => {
    const pages = [
      page([entry("a"), entry("b", { size: 1 })], { next_cursor: 2 }),
      page([entry("b", { size: 9 }), entry("c")]),
    ];
    const listing = await drainDirectory(async (_p, cursor) => pages[cursor === 0 ? 0 : 1]!, "/x");
    expect(listing.entries.map((e) => [e.name, e.size])).toEqual([
      ["a", 1],
      ["b", 9],
      ["c", 1],
    ]);
  });

  test("stops when cancelled", async () => {
    const controller = new AbortController();
    const fetchPage = async (_p: string | undefined, cursor: number) => {
      controller.abort();
      return page([entry(`x${cursor}`)], { next_cursor: cursor + 1 });
    };
    await expect(drainDirectory(fetchPage, "/x", { signal: controller.signal })).rejects.toThrow(
      "Listing cancelled",
    );
  });

  test("dedupe keeps first position and last value", () => {
    expect(
      dedupeByName([entry("a", { size: 1 }), entry("b"), entry("a", { size: 2 })]).map((e) => [
        e.name,
        e.size,
      ]),
    ).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });
});

describe("polling page one", () => {
  const small: DirectoryListing = {
    path: "/home/me/dir",
    homeDir: "/home/me",
    parent: "/home/me",
    entries: [entry("a"), entry("b")],
    truncated: false,
    multiPage: false,
    head: pageFingerprint(page([entry("a"), entry("b")])),
    changedOnHost: false,
  };

  test("an unchanged single-page folder is the same object", () => {
    expect(mergeFirstPage(small, page([entry("a"), entry("b")]))).toBe(small);
  });

  test("a single-page folder is replaced, so removals show", () => {
    const next = mergeFirstPage(small, page([entry("b"), entry("c")]));
    expect(next.entries.map((e) => e.name)).toEqual(["b", "c"]);
    expect(next.changedOnHost).toBe(false);
  });

  test("a multi-page folder whose page one moved is marked changed, never merged into", () => {
    const first = [entry("a"), entry("b")];
    const big: DirectoryListing = {
      ...small,
      entries: [...first, entry("c"), entry("d")],
      multiPage: true,
      head: pageFingerprint(page(first, { next_cursor: 2 })),
    };
    // "a" was deleted on the host: page one now starts with what was later.
    const next = mergeFirstPage(big, page([entry("b"), entry("c")], { next_cursor: 2 }));
    expect(next.changedOnHost).toBe(true);
    // No ghost is presented as live, and nothing half-known is folded in:
    // the rows stay as last read in full, under the notice, until Refresh.
    expect(next.entries).toBe(big.entries);
    // Asking again changes nothing more.
    expect(mergeFirstPage(next, page([entry("c")], { next_cursor: 1 }))).toBe(next);
  });

  test("a multi-page folder whose page one is as it was is the same object", () => {
    const first = [entry("a"), entry("b")];
    const big: DirectoryListing = {
      ...small,
      multiPage: true,
      head: pageFingerprint(page(first, { next_cursor: 2 })),
    };
    expect(mergeFirstPage(big, page(first, { next_cursor: 2 }))).toBe(big);
    // A size or date that moved on page one is a change too.
    const resized = mergeFirstPage(
      big,
      page([entry("a", { size: 9 }), entry("b")], { next_cursor: 2 }),
    );
    expect(resized.changedOnHost).toBe(true);
  });

  test("a big folder that shrank to one page is exact again", () => {
    const big: DirectoryListing = { ...small, multiPage: true, changedOnHost: true };
    const next = mergeFirstPage(big, page([entry("z")]));
    expect(next.entries.map((e) => e.name)).toEqual(["z"]);
    expect(next.multiPage).toBe(false);
    expect(next.changedOnHost).toBe(false);
  });

  test("the source re-drains a single-page folder that grew past one page", async () => {
    const host = hostFolder(200);
    const source = createV1DrainSource(host.fetchPage);
    const next = await source.poll(small);
    expect(next.entries).toHaveLength(200);
    expect(next.multiPage).toBe(true);
    expect(next.changedOnHost).toBe(false);
    expect(host.calls).toEqual([0, 0, 96, 192]);
  });

  test("the source polls a drained folder with one request", async () => {
    const host = hostFolder(300);
    const source = createV1DrainSource(host.fetchPage);
    const drained = await source.drain("/home/me/dir");
    host.calls.length = 0;
    const polled = await source.poll(drained);
    expect(host.calls).toEqual([0]);
    expect(polled).toBe(drained);
  });

  test("a drained folder with an entry gone from page one is flagged, and a full read clears it", async () => {
    const host = hostFolder(300);
    const source = createV1DrainSource(host.fetchPage);
    const drained = await source.drain("/home/me/dir");
    host.all.splice(0, 1);
    const polled = await source.poll(drained);
    expect(polled.changedOnHost).toBe(true);
    expect(polled.entries.map((e) => e.name)).toContain("f0");
    const reread = await source.drain("/home/me/dir");
    expect(reread.changedOnHost).toBe(false);
    expect(reread.entries.map((e) => e.name)).not.toContain("f0");
  });
});
