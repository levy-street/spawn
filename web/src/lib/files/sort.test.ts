import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SORT,
  kindLabel,
  naturalCompare,
  parseSortSpec,
  type SortableEntry,
  sortEntries,
  toggleSort,
  typeLabel,
} from "./sort";

function file(name: string, extra: Partial<SortableEntry> = {}): SortableEntry {
  return { name, kind: "file", is_dir: false, size: 10, modified_at: 100, ...extra };
}

function folder(name: string, extra: Partial<SortableEntry> = {}): SortableEntry {
  return { name, kind: "directory", is_dir: true, size: null, modified_at: 100, ...extra };
}

const names = (entries: SortableEntry[]) => entries.map((entry) => entry.name);

describe("natural order", () => {
  test("numbers inside names compare as numbers", () => {
    expect(["file10.txt", "file2.txt", "file1.txt"].sort(naturalCompare)).toEqual([
      "file1.txt",
      "file2.txt",
      "file10.txt",
    ]);
  });

  test("case does not decide the order, but still breaks a tie the same way every time", () => {
    expect(["beta", "Alpha", "alpha"].sort(naturalCompare)).toEqual(["Alpha", "alpha", "beta"]);
    expect(["alpha", "Alpha"].sort(naturalCompare)).toEqual(["Alpha", "alpha"]);
  });
});

describe("sorting a folder", () => {
  const entries = [
    file("notes10.md", { size: 300, modified_at: 300 }),
    folder("src"),
    file("notes2.md", { size: 100, modified_at: 500 }),
    folder("Docs"),
    file("blob", { size: null, modified_at: null }),
  ];

  test("by name: folders first, natural order", () => {
    expect(names(sortEntries(entries, DEFAULT_SORT))).toEqual([
      "Docs",
      "src",
      "blob",
      "notes2.md",
      "notes10.md",
    ]);
  });

  test("by name descending keeps folders on top", () => {
    expect(names(sortEntries(entries, { ...DEFAULT_SORT, order: "desc" }))).toEqual([
      "src",
      "Docs",
      "notes10.md",
      "notes2.md",
      "blob",
    ]);
  });

  test("folders mix in when asked to", () => {
    expect(names(sortEntries(entries, { ...DEFAULT_SORT, foldersFirst: false }))).toEqual([
      "blob",
      "Docs",
      "notes2.md",
      "notes10.md",
      "src",
    ]);
  });

  test("by size, largest first: a missing size sinks either way", () => {
    const desc = sortEntries(entries, { key: "size", order: "desc", foldersFirst: true });
    expect(names(desc)).toEqual(["Docs", "src", "notes10.md", "notes2.md", "blob"]);
    const asc = sortEntries(entries, { key: "size", order: "asc", foldersFirst: true });
    expect(names(asc)).toEqual(["Docs", "src", "notes2.md", "notes10.md", "blob"]);
  });

  test("by date modified, newest first", () => {
    const desc = sortEntries(entries, { key: "modified", order: "desc", foldersFirst: false });
    expect(names(desc)).toEqual(["notes2.md", "notes10.md", "Docs", "src", "blob"]);
  });

  test("by kind, then by name", () => {
    const kinds = sortEntries([file("b.png"), file("a.md"), file("c.md"), folder("z")], {
      key: "kind",
      order: "asc",
      foldersFirst: false,
    });
    expect(names(kinds)).toEqual(["z", "a.md", "c.md", "b.png"]);
    expect(kindLabel(folder("z"))).toBe("Folder");
    expect(kindLabel(file("a.md"))).toBe("Markdown");
  });

  test("a folder's type is Folder, never the host's name-based guess", () => {
    // What fs.stat says of a folder: a type guessed from its name.
    expect(
      typeLabel(folder("src"), { kind: "directory", content_type: "application/octet-stream" }),
    ).toBe("Folder");
    expect(typeLabel(folder("photos.png"), { kind: "directory", content_type: "image/png" })).toBe(
      "Folder",
    );
    // Before the host answers, or on a host without fs.stat, the listing says so.
    expect(typeLabel(folder("src"), null)).toBe("Folder");
    // A file is what the host says, and nothing until it says it.
    expect(typeLabel(file("a.md"), { kind: "file", content_type: "text/markdown" })).toBe(
      "text/markdown",
    );
    expect(
      typeLabel(file("blob"), { kind: "file", content_type: "application/octet-stream" }),
    ).toBe("application/octet-stream");
    expect(typeLabel(file("a.md"), null)).toBeNull();
    expect(typeLabel(file("a.md"), { kind: "file", content_type: null })).toBeNull();
    // The host's answer is the newer one: a row listed as a file that is a folder now.
    expect(
      typeLabel(file("build"), { kind: "directory", content_type: "application/octet-stream" }),
    ).toBe("Folder");
  });

  test("does not reorder the array it was given", () => {
    const input = [file("b"), file("a")];
    sortEntries(input, DEFAULT_SORT);
    expect(names(input)).toEqual(["b", "a"]);
  });
});

describe("column clicks", () => {
  test("the same column reverses", () => {
    expect(toggleSort(DEFAULT_SORT, "name")).toEqual({ ...DEFAULT_SORT, order: "desc" });
  });

  test("a new column starts where people expect it to", () => {
    expect(toggleSort(DEFAULT_SORT, "modified").order).toBe("desc");
    expect(toggleSort(DEFAULT_SORT, "size").order).toBe("desc");
    expect(toggleSort({ ...DEFAULT_SORT, key: "size" }, "kind").order).toBe("asc");
  });

  test("keeps folders on top across clicks", () => {
    expect(toggleSort({ ...DEFAULT_SORT, foldersFirst: false }, "size").foldersFirst).toBe(false);
  });
});

describe("a stored sort", () => {
  test("round-trips", () => {
    const spec = { key: "size", order: "asc", foldersFirst: false } as const;
    expect(parseSortSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });

  test("anything unreadable falls back field by field", () => {
    expect(parseSortSpec(null)).toEqual(DEFAULT_SORT);
    expect(parseSortSpec("name")).toEqual(DEFAULT_SORT);
    expect(parseSortSpec({ key: "colour", order: "up" })).toEqual(DEFAULT_SORT);
    expect(parseSortSpec({ key: "modified" })).toEqual({
      key: "modified",
      order: "desc",
      foldersFirst: true,
    });
  });
});
