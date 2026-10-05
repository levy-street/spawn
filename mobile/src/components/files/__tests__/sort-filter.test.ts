import {
  countHiddenMatches,
  filterEntries,
  isHiddenEntry,
  matchesFilter,
} from "@/components/files/filter";
import {
  compareNames,
  compareNamesByRuns,
  DEFAULT_FILE_SORT,
  defaultSortDirection,
  type FileSort,
  sortEntries,
} from "@/components/files/sort";
import type { HostDirEntry } from "@/components/files/types";

function file(name: string, extra: Partial<HostDirEntry> = {}): HostDirEntry {
  return { name, path: `/home/me/${name}`, kind: "file", is_dir: false, ...extra };
}

function folder(name: string, extra: Partial<HostDirEntry> = {}): HostDirEntry {
  return { name, path: `/home/me/${name}`, kind: "directory", is_dir: true, ...extra };
}

const names = (entries: readonly HostDirEntry[]) => entries.map((entry) => entry.name);

describe("natural name order", () => {
  test("numbers compare by value, not by digit", () => {
    expect(["page10", "page2", "page1", "page 3", "page02"].sort(compareNames)).toEqual([
      "page 3",
      "page1",
      "page02",
      "page2",
      "page10",
    ]);
    expect(["v1.10.0", "v1.2.0", "v1.9.9"].sort(compareNames)).toEqual([
      "v1.2.0",
      "v1.9.9",
      "v1.10.0",
    ]);
  });

  test("case and accents set aside, with a stable tie-break", () => {
    expect(["beta", "Alpha", "alpha", "Écrit", "delta"].sort(compareNames)).toEqual([
      "Alpha",
      "alpha",
      "beta",
      "delta",
      "Écrit",
    ]);
    expect(compareNames("Notes", "notes")).not.toBe(0);
    expect(compareNames("same", "same")).toBe(0);
  });

  test("a name that is a prefix of another comes first, punctuation before digits", () => {
    expect(["file2", "file-x", "file"].sort(compareNames)).toEqual(["file", "file-x", "file2"]);
  });

  test("an engine without numeric collation still orders digit runs by value", () => {
    expect(["page10", "page2", "page1", "page09"].sort(compareNamesByRuns)).toEqual([
      "page1",
      "page2",
      "page09",
      "page10",
    ]);
    expect(compareNamesByRuns("Alpha", "alpha")).toBe(0);
    expect(compareNamesByRuns("a", "a1")).toBeLessThan(0);
    expect(compareNamesByRuns("item 2b", "item 2a")).toBeGreaterThan(0);
  });

  test("the fallback orders every name as the numeric collator does, punctuation included", () => {
    const fixture = [
      "page 3",
      "page1",
      "page10",
      "page2",
      "page02",
      "_build",
      ".git",
      ".env.local",
      "10",
      "2",
      "001",
      "1",
      "a",
      "A",
      "b10",
      "b9c",
      "item02",
      "item2",
      "item 2b",
      "item-1",
      "file.txt",
      "file-x",
      "file",
      "file2",
      "v1.10.0",
      "v1.2.0",
      "README",
      "readme.md",
      "Écrit",
      "zeta",
      "Z",
      "~tmp",
      "#hash",
      "node_modules",
      "package.json",
      "x 1",
      "x1",
      "IMG_0009.jpg",
      "IMG_10.jpg",
    ];
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const withTieBreak =
      (compare: (left: string, right: string) => number) => (left: string, right: string) =>
        compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
    expect([...fixture].sort(withTieBreak(compareNamesByRuns))).toEqual(
      [...fixture].sort(withTieBreak((left, right) => collator.compare(left, right))),
    );
  });
});

describe("sorting a folder", () => {
  const entries = [
    file("b.txt", { size: 10, modified_at: 300 }),
    folder("src", { modified_at: 100 }),
    file("A10.md", { size: 999, modified_at: 200 }),
    file("A2.md", { size: 5, modified_at: null }),
    folder("docs", { modified_at: 400 }),
    file("photo.png", { size: null, modified_at: 50 }),
  ];

  test("by name keeps folders first in either direction", () => {
    expect(names(sortEntries(entries, DEFAULT_FILE_SORT))).toEqual([
      "docs",
      "src",
      "A2.md",
      "A10.md",
      "b.txt",
      "photo.png",
    ]);
    expect(names(sortEntries(entries, { key: "name", direction: "desc" }))).toEqual([
      "src",
      "docs",
      "photo.png",
      "b.txt",
      "A10.md",
      "A2.md",
    ]);
  });

  test("by date, newest first by default, with unknown dates last either way", () => {
    expect(defaultSortDirection("modified")).toBe("desc");
    const newest: FileSort = { key: "modified", direction: "desc" };
    expect(names(sortEntries(entries, newest))).toEqual([
      "docs",
      "src",
      "b.txt",
      "A10.md",
      "photo.png",
      "A2.md",
    ]);
    expect(names(sortEntries(entries, { key: "modified", direction: "asc" }))).toEqual([
      "src",
      "docs",
      "photo.png",
      "A10.md",
      "b.txt",
      "A2.md",
    ]);
  });

  test("by size, largest first by default; folders, which have none, go by name", () => {
    expect(defaultSortDirection("size")).toBe("desc");
    expect(names(sortEntries(entries, { key: "size", direction: "desc" }))).toEqual([
      "docs",
      "src",
      "A10.md",
      "b.txt",
      "A2.md",
      "photo.png",
    ]);
  });

  test("by kind groups like types, then by name", () => {
    const sorted = names(sortEntries(entries, { key: "kind", direction: "asc" }));
    expect(sorted.slice(0, 2)).toEqual(["docs", "src"]);
    // The two Markdown files sit together, in name order.
    const markdown = sorted.indexOf("A2.md");
    expect(sorted[markdown + 1]).toBe("A10.md");
  });

  test("with Folders on top off, folders sort among files; by size a folder has none", () => {
    const sized = [...entries, folder("big", { size: 4096 })];
    expect(names(sortEntries(sized, DEFAULT_FILE_SORT, false))).toEqual([
      "A2.md",
      "A10.md",
      "b.txt",
      "big",
      "docs",
      "photo.png",
      "src",
    ]);
    // A folder's reported size is not its contents', so it sinks with the unknowns.
    expect(names(sortEntries(sized, { key: "size", direction: "desc" }, false))).toEqual([
      "A10.md",
      "b.txt",
      "A2.md",
      "big",
      "docs",
      "photo.png",
      "src",
    ]);
    expect(names(sortEntries(sized, { key: "size", direction: "desc" }))).toEqual([
      "big",
      "docs",
      "src",
      "A10.md",
      "b.txt",
      "A2.md",
      "photo.png",
    ]);
  });

  test("does not reorder its input", () => {
    const input = [file("b"), file("a")];
    sortEntries(input);
    expect(names(input)).toEqual(["b", "a"]);
  });
});

describe("filtering a folder", () => {
  const entries = [file(".env"), file("Notes.md"), folder(".git"), folder("notebooks"), file("a")];

  test("hidden means a leading dot", () => {
    expect(isHiddenEntry(file(".env"))).toBe(true);
    expect(isHiddenEntry(file("env."))).toBe(false);
  });

  test("matches anywhere in the name, ignoring case and surrounding spaces", () => {
    expect(matchesFilter(file("Notes.md"), "  NOTE ")).toBe(true);
    expect(matchesFilter(file("Notes.md"), "")).toBe(true);
    expect(names(filterEntries(entries, { query: "note", showHidden: false }))).toEqual([
      "Notes.md",
      "notebooks",
    ]);
  });

  test("hidden entries show only when asked for, and are counted when kept back", () => {
    expect(names(filterEntries(entries, { query: "", showHidden: false }))).toEqual([
      "Notes.md",
      "notebooks",
      "a",
    ]);
    expect(filterEntries(entries, { query: "", showHidden: true })).toHaveLength(5);
    expect(countHiddenMatches(entries, "")).toBe(2);
    expect(countHiddenMatches(entries, "env")).toBe(1);
    expect(countHiddenMatches(entries, "notes")).toBe(0);
  });
});
