import { expect, test } from "bun:test";
import { droppedEntries, pickedFolder, walkDropped } from "./drop-walk";

type Node = { name: string; children?: Node[]; content?: string };

/** A dropped entry tree, answering readEntries in batches of `batch` the way Chromium does. */
function entry(node: Node, batch = 2): Record<string, unknown> {
  if (!node.children) {
    return {
      isFile: true,
      isDirectory: false,
      name: node.name,
      file: (ok: (file: File) => void) => ok(new File([node.content ?? ""], node.name)),
    };
  }
  return {
    isFile: false,
    isDirectory: true,
    name: node.name,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (ok: (entries: unknown[]) => void) => {
          const slice = (node.children ?? [])
            .slice(at, at + batch)
            .map((child) => entry(child, batch));
          at += batch;
          queueMicrotask(() => ok(slice));
        },
      };
    },
  };
}

test("a dropped folder is walked in full, batches and all, keeping empty folders", async () => {
  const site = entry({
    name: "site",
    children: [
      { name: "index.html", content: "<h1>" },
      { name: "css", children: [{ name: "a.css" }, { name: "b.css" }, { name: "c.css" }] },
      { name: "empty", children: [] },
    ],
  });
  const loose = new File(["n"], "notes.md");
  const pick = await walkDropped({ entries: [site as never], files: [loose] });
  expect(pick.items.map((item) => item.rel)).toEqual([
    "notes.md",
    "site/index.html",
    "site/css/a.css",
    "site/css/b.css",
    "site/css/c.css",
  ]);
  expect(pick.emptyDirs).toEqual(["site/empty"]);
  expect(await pick.items[1]?.file.text()).toBe("<h1>");
});

test("a walk stops just past the limit, leaving the refusal to the upload", async () => {
  const many = entry({
    name: "many",
    children: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}` })),
  });
  const pick = await walkDropped({ entries: [many as never], files: [] }, 5);
  expect(pick.items.length).toBe(6);
});

test("a picked folder keeps each file's path under it", () => {
  const file = new File(["x"], "a.css");
  Object.defineProperty(file, "webkitRelativePath", { value: "site/css/a.css" });
  expect(pickedFolder([file, new File(["y"], "loose.txt")]).items.map((item) => item.rel)).toEqual([
    "site/css/a.css",
    "loose.txt",
  ]);
});

test("a drop without entries still gives its files", () => {
  const file = new File(["x"], "a.txt");
  const plain = droppedEntries({ items: [], files: [file] } as unknown as DataTransfer);
  expect(plain).toEqual({ entries: [], files: [file] });
  const withEntries = droppedEntries({
    items: [
      { kind: "file", webkitGetAsEntry: () => ({ name: "d", isFile: false, isDirectory: true }) },
      { kind: "string", webkitGetAsEntry: () => null },
    ],
    files: [file],
  } as unknown as DataTransfer);
  expect(withEntries.entries.map((item) => item.name)).toEqual(["d"]);
  expect(withEntries.files).toEqual([]);
});
