import { describe, expect, test } from "bun:test";
import type { HostDirEntry } from "@/lib/hostControl";
import type { DirectoryListing } from "./listing";
import { DEFAULT_SORT } from "./sort";
import { entryRows, flattenTree, outermostItems, type TreeFolderState } from "./tree";

function entry(path: string, isDir = false): HostDirEntry {
  const name = path.split("/").at(-1) ?? path;
  return {
    name,
    path,
    kind: isDir ? "directory" : "file",
    is_dir: isDir,
    size: isDir ? null : 1,
    modified_at: 1,
  };
}

function listing(path: string, entries: HostDirEntry[], truncated = false): DirectoryListing {
  return {
    path,
    homeDir: "/h",
    parent: null,
    entries,
    truncated,
    multiPage: truncated,
    head: "",
    changedOnHost: false,
  };
}

const folders = new Map<string, TreeFolderState>([
  [
    "/h",
    {
      listing: listing("/h", [
        entry("/h/zeta.txt"),
        entry("/h/src", true),
        entry("/h/.git", true),
        entry("/h/docs", true),
      ]),
      loading: false,
      error: null,
    },
  ],
  [
    "/h/src",
    {
      listing: listing("/h/src", [entry("/h/src/main10.rs"), entry("/h/src/main2.rs")], true),
      loading: false,
      error: null,
    },
  ],
  ["/h/docs", { listing: undefined, loading: true, error: null }],
]);

const base = {
  root: "/h",
  folder: (path: string) => folders.get(path),
  sort: DEFAULT_SORT,
  query: "",
  showHidden: false,
};

const shape = (rows: ReturnType<typeof flattenTree>["rows"]) =>
  rows.map((row) =>
    row.kind === "entry" ? `${"  ".repeat(row.depth)}${row.entry.name}` : `${row.dir}:${row.state}`,
  );

describe("the flattened tree", () => {
  test("open folders show their sorted children in place, with status rows", () => {
    const { rows, rootHidden, rootShown } = flattenTree({
      ...base,
      expanded: new Set(["/h/src", "/h/docs"]),
    });
    expect(shape(rows)).toEqual([
      "docs",
      "/h/docs:loading",
      "src",
      "  main2.rs",
      "  main10.rs",
      "/h/src:truncated",
      "zeta.txt",
    ]);
    // The count line: the root's own rows on screen, and the hidden one.
    expect(rootShown).toBe(3);
    expect(rootHidden).toBe(1);
  });

  test("the count follows the filter: shown rows at the root, hidden names that match", () => {
    const docs = flattenTree({ ...base, expanded: new Set(), query: "doc" });
    expect(docs.rootShown).toBe(1);
    expect(docs.rootHidden).toBe(0);
    const git = flattenTree({ ...base, expanded: new Set(), query: "git" });
    expect(git.rootShown).toBe(0);
    expect(git.rootHidden).toBe(1);
  });

  test("an open folder that changed on its host says so first, under its own row", () => {
    const src = folders.get("/h/src")!;
    const changed = new Map(folders);
    changed.set("/h/src", {
      ...src,
      listing: { ...src.listing!, changedOnHost: true },
    });
    const { rows } = flattenTree({
      ...base,
      folder: (path) => changed.get(path),
      expanded: new Set(["/h/src"]),
    });
    expect(shape(rows)).toEqual([
      "docs",
      "src",
      "/h/src:changed",
      "  main2.rs",
      "  main10.rs",
      "/h/src:truncated",
      "zeta.txt",
    ]);
  });

  test("closed folders hide their children", () => {
    const { rows } = flattenTree({ ...base, expanded: new Set() });
    expect(shape(rows)).toEqual(["docs", "src", "zeta.txt"]);
  });

  test("hidden folders show when asked", () => {
    const { rows } = flattenTree({ ...base, expanded: new Set(), showHidden: true });
    expect(shape(rows)).toEqual([".git", "docs", "src", "zeta.txt"]);
  });

  test("a filter keeps an open folder that holds a match, showing only the match", () => {
    const { rows } = flattenTree({ ...base, expanded: new Set(["/h/src"]), query: "main2" });
    expect(shape(rows)).toEqual(["src", "  main2.rs", "/h/src:truncated"]);
    expect(entryRows(rows).map((row) => row.entry.name)).toEqual(["src", "main2.rs"]);
  });

  test("a folder still loading is a status row, and a failed one says so", () => {
    expect(shape(flattenTree({ ...base, root: "/h/docs", expanded: new Set() }).rows)).toEqual([
      "/h/docs:loading",
    ]);
    const failed = flattenTree({
      ...base,
      root: "/x",
      folder: () => ({ listing: undefined, loading: false, error: new Error("nope") }),
      expanded: new Set(),
    });
    expect(shape(failed.rows)).toEqual(["/x:error"]);
  });

  test("a folder cannot contain itself", () => {
    const loop = new Map<string, TreeFolderState>([
      ["/l", { listing: listing("/l", [entry("/l", true)]), loading: false, error: null }],
    ]);
    const { rows } = flattenTree({
      ...base,
      root: "/l",
      folder: (path) => loop.get(path),
      expanded: new Set(["/l"]),
    });
    expect(shape(rows)).toEqual(["l"]);
  });
});

describe("what a delete removes", () => {
  const within = (path: string, folder: string) => path.startsWith(`${folder}/`);

  test("an item inside a folder that is also going is not asked for twice", () => {
    const items = [
      { path: "/h/src", isDir: true },
      { path: "/h/src/main.rs", isDir: false },
      { path: "/h/src/lib", isDir: true },
      { path: "/h/src/lib/mod.rs", isDir: false },
      { path: "/h/srcx.txt", isDir: false },
      { path: "/h/zeta.txt", isDir: false },
    ];
    expect(outermostItems(items, within).map((item) => item.path)).toEqual([
      "/h/src",
      "/h/srcx.txt",
      "/h/zeta.txt",
    ]);
  });

  test("siblings all stay", () => {
    const items = [
      { path: "/h/a", isDir: true },
      { path: "/h/b", isDir: false },
    ];
    expect(outermostItems(items, within)).toEqual(items);
  });
});
