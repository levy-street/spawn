import { describe, expect, test } from "bun:test";
import type { HostDirEntry, HostDirList } from "@/lib/hostControl";
import {
  breadcrumbParts,
  folderColumns,
  isWithinHome,
  joinDirectory,
  listAllEntries,
  parentWithinHome,
  visibleDirectories,
} from "./folder-picker-helpers";

const entries = [
  { name: "src", is_dir: true },
  { name: ".git", is_dir: true },
  { name: "README.md", is_dir: false },
  { name: "Archive", is_dir: true },
];

describe("folder picker path helpers", () => {
  test("joins and normalizes a child directory", () => {
    expect(joinDirectory("/Users/alice/project/", "../archive")).toBe("/Users/alice/archive");
  });

  test("builds clickable breadcrumb paths rooted at home", () => {
    expect(breadcrumbParts("/Users/alice/project/web", "/Users/alice")).toEqual([
      { label: "Home", path: "/Users/alice" },
      { label: "project", path: "/Users/alice/project" },
      { label: "web", path: "/Users/alice/project/web" },
    ]);
  });

  test("home itself is the only crumb at home", () => {
    expect(breadcrumbParts("/Users/alice", "/Users/alice")).toEqual([
      { label: "Home", path: "/Users/alice" },
    ]);
  });

  test("a path above home collapses to the home crumb — its ancestors are not browsable", () => {
    expect(breadcrumbParts("/Users", "/Users/alice")).toEqual([
      { label: "Home", path: "/Users/alice" },
    ]);
  });

  test("a home of / still walks from the filesystem root", () => {
    expect(breadcrumbParts("/srv/data", "/")).toEqual([
      { label: "/", path: "/" },
      { label: "srv", path: "/srv" },
      { label: "data", path: "/srv/data" },
    ]);
  });
});

describe("folder picker home boundary", () => {
  test("home and its descendants are inside, ancestors and siblings are not", () => {
    expect(isWithinHome("/Users/alice", "/Users/alice")).toBe(true);
    expect(isWithinHome("/Users/alice/project", "/Users/alice/")).toBe(true);
    expect(isWithinHome("/Users", "/Users/alice")).toBe(false);
    expect(isWithinHome("/", "/Users/alice")).toBe(false);
    // A prefix match on the string is not a match on the tree.
    expect(isWithinHome("/Users/alicia", "/Users/alice")).toBe(false);
  });

  test("stepping up stops at home", () => {
    expect(parentWithinHome("/Users/alice/project/web", "/Users/alice")).toBe(
      "/Users/alice/project",
    );
    expect(parentWithinHome("/Users/alice/project", "/Users/alice")).toBe("/Users/alice");
    expect(parentWithinHome("/Users/alice", "/Users/alice")).toBeNull();
    expect(parentWithinHome("/Users", "/Users/alice")).toBeNull();
  });
});

describe("folder picker listing", () => {
  test("drops files and dot-folders, sorting case-insensitively", () => {
    expect(visibleDirectories(entries).map((entry) => entry.name)).toEqual(["Archive", "src"]);
  });

  test("keeps dot-folders when hidden folders are shown", () => {
    expect(visibleDirectories(entries, { showHidden: true }).map((entry) => entry.name)).toEqual([
      ".git",
      "Archive",
      "src",
    ]);
  });

  test("narrows to the filter regardless of case", () => {
    expect(visibleDirectories(entries, { filter: " ARCH " }).map((entry) => entry.name)).toEqual([
      "Archive",
    ]);
  });

  test("a filter never reveals hidden folders on its own", () => {
    expect(visibleDirectories(entries, { filter: "git" })).toEqual([]);
  });

  test("handles a listing that has not loaded yet", () => {
    expect(visibleDirectories(undefined)).toEqual([]);
  });
});

describe("folderColumns", () => {
  test("one column at the home root, with nothing selected", () => {
    expect(folderColumns("/home/ada", "/home/ada")).toEqual([
      { path: "/home/ada", selectedChild: null },
    ]);
  });

  test("each ancestor column highlights the child the trail continues through", () => {
    expect(folderColumns("/home/ada/dev/spawn", "/home/ada")).toEqual([
      { path: "/home/ada", selectedChild: "/home/ada/dev" },
      { path: "/home/ada/dev", selectedChild: "/home/ada/dev/spawn" },
      // The trailing column lists the selection's own contents.
      { path: "/home/ada/dev/spawn", selectedChild: null },
    ]);
  });

  test("a path above home collapses to the home column alone", () => {
    expect(folderColumns("/etc", "/home/ada")).toEqual([
      { path: "/home/ada", selectedChild: null },
    ]);
  });
});

describe("listAllEntries", () => {
  const entry = (name: string): HostDirEntry =>
    ({ name, path: `/home/ada/${name}`, kind: "directory", is_dir: true }) as HostDirEntry;

  const page = (names: string[], next: number | null, truncated = false): HostDirList =>
    ({
      path: "/home/ada",
      home_dir: "/home/ada",
      entries: names.map(entry),
      next_cursor: next,
      truncated,
    }) as HostDirList;

  test("drains the cursor rather than stopping at the first page", async () => {
    // The regression: the daemon pages at 96 in raw readdir order, so one page
    // is an arbitrary slice — a home full of dotfiles hid every real folder.
    const pages = [page(["a", "b"], 2), page(["c", "d"], 4), page(["e"], null)];
    const seen: number[] = [];
    const result = await listAllEntries((cursor) => {
      seen.push(cursor);
      return Promise.resolve(pages[seen.length - 1] as HostDirList);
    });
    expect(seen).toEqual([0, 2, 4]);
    expect(result.entries.map((e) => e.name)).toEqual(["a", "b", "c", "d", "e"]);
    expect(result.truncated).toBe(false);
  });

  test("a single complete page needs no second request", async () => {
    let calls = 0;
    const result = await listAllEntries(() => {
      calls += 1;
      return Promise.resolve(page(["only"], null));
    });
    expect(calls).toBe(1);
    expect(result).toEqual({ entries: result.entries, truncated: false });
  });

  test("reports the daemon's own ceiling as truncated", async () => {
    const result = await listAllEntries(() => Promise.resolve(page(["a"], 1, true)));
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(1);
  });

  test("stops at the page budget and says the listing is short", async () => {
    let calls = 0;
    const result = await listAllEntries((cursor) => {
      calls += 1;
      return Promise.resolve(page(["x"], cursor + 1));
    }, 3);
    expect(calls).toBe(3);
    expect(result.truncated).toBe(true);
  });
});
