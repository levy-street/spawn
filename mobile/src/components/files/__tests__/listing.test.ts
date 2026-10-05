import {
  applyFirstPagePoll,
  DIRECTORY_DRAIN_PAGE_BUDGET,
  dedupeEntries,
  drainDirectory,
} from "@/components/files/listing";
import { HOST_DIRECTORY_PAGE_ENTRIES } from "@/components/files/pagination";
import type { HostDirEntry, HostDirList } from "@/components/files/types";

function entry(name: string, extra: Partial<HostDirEntry> = {}): HostDirEntry {
  return { name, path: `/home/me/${name}`, kind: "file", is_dir: false, ...extra };
}

/** A folder of `count` entries paged the way a v1 daemon pages it: 96 at a time, 1,024 at most. */
function daemon(count: number) {
  const all = Array.from({ length: count }, (_, index) => entry(`f${index}`));
  const fetchPage = jest.fn(async (cursor: number): Promise<HostDirList> => {
    const end = Math.min(cursor + HOST_DIRECTORY_PAGE_ENTRIES, 1024, count);
    const entries = all.slice(cursor, end);
    const more = end < Math.min(count, 1024);
    return {
      path: "/home/me",
      home_dir: "/home/me",
      entries,
      next_cursor: more ? end : null,
      truncated: !more && count > 1024,
    };
  });
  return { all, fetchPage };
}

const page = (names: string[], extra: Partial<HostDirList> = {}): HostDirList => ({
  path: "/home/me",
  home_dir: "/home/me",
  entries: names.map((name) => entry(name)),
  next_cursor: null,
  ...extra,
});

describe("draining a folder", () => {
  test("a small folder is one page, and says so", async () => {
    const host = daemon(3);
    const listing = await drainDirectory(host.fetchPage);
    expect(host.fetchPage).toHaveBeenCalledTimes(1);
    expect(listing.entries.map(({ name }) => name)).toEqual(["f0", "f1", "f2"]);
    expect(listing).toMatchObject({ singlePage: true, truncated: false, changedOnHost: false });
  });

  test("reads every page, in the host's order", async () => {
    const host = daemon(300);
    const listing = await drainDirectory(host.fetchPage);
    expect(host.fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([0, 96, 192, 288]);
    expect(listing.entries).toHaveLength(300);
    expect(listing).toMatchObject({ singlePage: false, truncated: false });
  });

  test("stops at the host's 1,024 and says the folder has more", async () => {
    const host = daemon(5000);
    const listing = await drainDirectory(host.fetchPage);
    expect(host.fetchPage).toHaveBeenCalledTimes(11);
    expect(listing.entries).toHaveLength(1024);
    expect(listing.truncated).toBe(true);
    expect(DIRECTORY_DRAIN_PAGE_BUDGET).toBeGreaterThanOrEqual(11);
  });

  test("a page budget that runs out is truncation too", async () => {
    const host = daemon(500);
    const listing = await drainDirectory(host.fetchPage, 2);
    expect(listing.entries).toHaveLength(192);
    expect(listing.truncated).toBe(true);
  });

  test("an entry seen twice across shifting pages is listed once", async () => {
    const fetchPage = jest.fn(async (cursor: number) =>
      cursor === 0 ? page(["a", "b"], { next_cursor: 2 }) : page(["b", "c"]),
    );
    const listing = await drainDirectory(fetchPage);
    expect(listing.entries.map(({ name }) => name)).toEqual(["a", "b", "c"]);
    expect(dedupeEntries([entry("x"), entry("x")])).toHaveLength(1);
  });
});

describe("polling page 1", () => {
  test("nothing changed: nothing renders", async () => {
    const current = await drainDirectory(async () => page(["a", "b"]));
    expect(applyFirstPagePoll(current, page(["a", "b"]))).toEqual({ kind: "same" });
  });

  test("a folder that fits on one page is simply replaced", async () => {
    const current = await drainDirectory(async () => page(["a", "b"]));
    const next = applyFirstPagePoll(current, page(["a", "b", "new"]));
    if (next.kind !== "replace") throw new Error(`expected replace, got ${next.kind}`);
    expect(next.listing.entries.map(({ name }) => name)).toEqual(["a", "b", "new"]);
    expect(next.listing).toMatchObject({ singlePage: true, changedOnHost: false });
  });

  test("a changed size or date counts as a change", async () => {
    const current = await drainDirectory(async () => page(["a"]));
    const touched = page(["a"]);
    touched.entries[0] = entry("a", { size: 12 });
    const next = applyFirstPagePoll(current, touched);
    expect(next.kind === "replace" && next.listing.entries[0]?.size).toBe(12);
  });

  test("a larger folder is only marked as changed; its other pages wait for a refresh", async () => {
    const host = daemon(300);
    const current = await drainDirectory(host.fetchPage);
    const firstPage = await host.fetchPage(0);
    const changed = { ...firstPage, entries: [entry("brand-new"), ...firstPage.entries.slice(1)] };
    const next = applyFirstPagePoll(current, changed);
    if (next.kind !== "changed") throw new Error(`expected changed, got ${next.kind}`);
    expect(next.listing.changedOnHost).toBe(true);
    expect(next.listing.entries).toBe(current.entries);
    // Once marked, another changed look renders nothing new.
    expect(applyFirstPagePoll(next.listing, changed)).toEqual({ kind: "same" });
  });

  test("a one-page folder that grows past a page is read again in full", async () => {
    const current = await drainDirectory(async () => page(["a", "b"]));
    expect(applyFirstPagePoll(current, page(["a", "b"], { next_cursor: 96 }))).toEqual({
      kind: "reread",
    });
  });
});

describe("one row per name", () => {
  test("the later reading of a name wins, in the place it was first seen", () => {
    const older = entry("b", { size: 1 });
    const newer = entry("b", { size: 2 });
    expect(dedupeEntries([entry("a"), older, entry("c"), newer])).toEqual([
      entry("a"),
      newer,
      entry("c"),
    ]);
  });
});
