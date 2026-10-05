import { expect, test } from "bun:test";
import type { HostDirEntry, HostDirList } from "@/lib/hostControl";
import {
  conflictChoices,
  estimateSeconds,
  keepBothName,
  type LocalItem,
  landingFor,
  MAX_TRANSFER_ITEMS,
  modelRate,
  nameSet,
  needsRelayWarning,
  RateMeter,
  relayedHosts,
  splitExtension,
  splitRel,
  TransferTooLargeError,
  totalBytes,
  uploadFolders,
  uploadOverLimit,
  uploadTopItems,
  walkHostItems,
  walkSourceOf,
  worthEstimating,
} from "./transfer-plan";

const entry = (dir: string, name: string, extra: Partial<HostDirEntry> = {}): HostDirEntry => ({
  name,
  path: `${dir}/${name}`,
  kind: "file",
  is_dir: false,
  size: 10,
  modified_at: 1_700_000_000,
  ...extra,
});
const folder = (dir: string, name: string) =>
  entry(dir, name, { kind: "directory", is_dir: true, size: null });

/** A fake host tree, paged at `pageSize` entries. */
function host(tree: Record<string, HostDirEntry[]>, pageSize = 96, truncated = new Set<string>()) {
  const calls: string[] = [];
  const fetchPage = async (path: string | undefined, cursor: number): Promise<HostDirList> => {
    const key = path ?? "/home/u";
    calls.push(`${key}@${cursor}`);
    const all = tree[key];
    if (!all) throw new Error(`not_found ${key}`);
    const entries = all.slice(cursor, cursor + pageSize);
    const more = cursor + pageSize < all.length;
    return {
      path: key,
      home_dir: "/home/u",
      entries,
      next_cursor: more ? cursor + pageSize : null,
      truncated: !more && truncated.has(key),
    };
  };
  return { fetchPage, calls };
}

test("extensions split the way a person reads them", () => {
  expect(splitExtension("notes.md")).toEqual(["notes", ".md"]);
  expect(splitExtension("logs.tar.gz")).toEqual(["logs", ".tar.gz"]);
  expect(splitExtension(".env")).toEqual([".env", ""]);
  expect(splitExtension("Makefile")).toEqual(["Makefile", ""]);
  expect(splitExtension("a.b.c")).toEqual(["a.b", ".c"]);
  expect(splitExtension(".tar.gz")).toEqual([".tar", ".gz"]);
});

test("Keep both gives the first free numbered name, without case", () => {
  const taken = nameSet(["notes.md", "Notes (2).md"]);
  expect(keepBothName("notes.md", (name) => taken.has(name))).toBe("notes (3).md");
  expect(keepBothName("logs.tar.gz", () => false)).toBe("logs (2).tar.gz");
  expect(keepBothName("v1.2", () => false, true)).toBe("v1.2 (2)");
  expect(keepBothName(".env", () => false)).toBe(".env (2)");
});

test("a name already there lands per the decision, and Replace never takes a folder away", () => {
  const taken = nameSet(["notes.md", "photos"]);
  const file = { name: "notes.md", isDir: false };
  const dir = { name: "photos", isDir: true };
  const fileThere = { name: "notes.md", isDir: false };
  const dirThere = { name: "photos", isDir: true };
  expect(landingFor(file, null, null, taken)).toEqual({
    name: "notes.md",
    skip: false,
    overwrite: false,
    merge: false,
  });
  expect(landingFor(file, fileThere, "replace", taken).overwrite).toBe(true);
  expect(landingFor(file, fileThere, "skip", taken).skip).toBe(true);
  expect(landingFor(file, fileThere, "keep-both", taken).name).toBe("notes (2).md");
  expect(landingFor(dir, dirThere, "replace", taken)).toMatchObject({
    name: "photos",
    merge: true,
  });
  // A file where a folder of that name is: never swapped, kept beside it.
  expect(landingFor(file, dirThere, "replace", taken)).toMatchObject({
    name: "notes (2).md",
    overwrite: false,
  });
  expect(conflictChoices(file, fileThere)).toEqual(["replace", "keep-both", "skip"]);
  expect(conflictChoices(file, dirThere)).toEqual(["keep-both", "skip"]);
});

test("a walk lists parents before children, skips links and special files, and says what the host cut short", async () => {
  const { fetchPage } = host(
    {
      "/home/u/photos": [
        entry("/home/u/photos", "b.jpg", { size: 300 }),
        folder("/home/u/photos", "trip"),
        entry("/home/u/photos", "a.jpg", { size: 200 }),
        entry("/home/u/photos", "latest", { kind: "symlink" }),
        entry("/home/u/photos", "fifo", { kind: "other" }),
      ],
      "/home/u/photos/trip": [entry("/home/u/photos/trip", "c.jpg", { size: 50 })],
    },
    96,
    new Set(["/home/u/photos/trip"]),
  );
  const result = await walkHostItems(fetchPage, [
    { path: "/home/u/photos", name: "photos", isDir: true },
    { path: "/home/u/notes.md", name: "notes.md", isDir: false, size: 7 },
  ]);
  expect(result.items.map((item) => `${item.kind}:${item.rel.join("/")}`)).toEqual([
    "dir:photos",
    "file:photos/a.jpg",
    "file:photos/b.jpg",
    "dir:photos/trip",
    "file:photos/trip/c.jpg",
    "file:notes.md",
  ]);
  expect(result.links).toBe(1);
  expect(result.others).toBe(1);
  // An entry without a kind is read by is_dir, as the file list reads it.
  const bare = host({
    "/home/u/x": [{ name: "y", path: "/home/u/x/y", is_dir: false } as HostDirEntry],
  });
  const plain = await walkHostItems(bare.fetchPage, [
    { path: "/home/u/x", name: "x", isDir: true },
  ]);
  expect(plain.items.map((item) => item.kind)).toEqual(["dir", "file"]);
  expect(result.truncated).toEqual(["photos/trip"]);
  expect(totalBytes(result.items)).toBe(200 + 300 + 50 + 7);
});

test("a link or a special file picked directly is skipped and counted, as one inside a folder is", async () => {
  const link = walkSourceOf(entry("/home/u", "latest", { kind: "symlink" }));
  const fifo = walkSourceOf(entry("/home/u", "fifo", { kind: "other" }));
  const notes = walkSourceOf(entry("/home/u", "notes.md", { size: 7 }));
  expect(link).toMatchObject({ kind: "link", isDir: false });
  expect(walkSourceOf(folder("/home/u", "photos"))).toMatchObject({ kind: "dir", isDir: true });
  const { fetchPage, calls } = host({});
  const result = await walkHostItems(fetchPage, [link, fifo, notes]);
  expect(result.items.map((item) => item.rel.join("/"))).toEqual(["notes.md"]);
  expect(result).toMatchObject({ links: 1, others: 1 });
  expect(calls).toEqual([]);
});

test("an upload past the item limit names the picked item it passes it at, counting folders too", () => {
  const file = (rel: string): LocalItem => ({ rel, file: new File(["x"], "x") });
  // Three files and their one folder: four items.
  const items = [file("a.txt"), file("big/1"), file("big/2")];
  expect(uploadOverLimit(items, [], 4)).toBeNull();
  expect(uploadOverLimit(items, [], 3)).toBe("big");
  expect(uploadOverLimit(items, ["empty"], 4)).toBe("empty");
});

test("a walk drains every page of a big folder", async () => {
  const many = Array.from({ length: 250 }, (_, i) => entry("/home/u/big", `f${i}.txt`));
  const { fetchPage, calls } = host({ "/home/u/big": many });
  const result = await walkHostItems(fetchPage, [
    { path: "/home/u/big", name: "big", isDir: true },
  ]);
  expect(result.items).toHaveLength(251);
  expect(calls).toEqual(["/home/u/big@0", "/home/u/big@96", "/home/u/big@192"]);
});

test("a folder past the item limit is refused whole, not sent in part", async () => {
  const many = Array.from({ length: 30 }, (_, i) => entry("/home/u/big", `f${i}.txt`));
  const { fetchPage } = host({ "/home/u/big": many });
  await expect(
    walkHostItems(fetchPage, [{ path: "/home/u/big", name: "big", isDir: true }], { limit: 10 }),
  ).rejects.toBeInstanceOf(TransferTooLargeError);
  expect(MAX_TRANSFER_ITEMS).toBe(10_000);
});

test("a walk stops when cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchPage } = host({ "/home/u/x": [] });
  await expect(
    walkHostItems(fetchPage, [{ path: "/home/u/x", name: "x", isDir: true }], {
      signal: controller.signal,
    }),
  ).rejects.toThrow();
});

test("an upload's folders come parents first, and its top level is what was picked", () => {
  const file = (rel: string): LocalItem => ({
    rel,
    file: new File(["x"], rel.split("/").at(-1) ?? ""),
  });
  const items = [file("site/css/a.css"), file("site/index.html"), file("notes.md")];
  expect(uploadFolders(items, ["site/empty", "other/deep/er"])).toEqual([
    "other",
    "site",
    "other/deep",
    "site/css",
    "site/empty",
    "other/deep/er",
  ]);
  expect(uploadTopItems(items, ["other/deep"])).toEqual([
    { name: "site", isDir: true },
    { name: "notes.md", isDir: false },
    { name: "other", isDir: true },
  ]);
  expect(splitRel("../a/./b\\c/")).toEqual(["a", "b", "c"]);
});

test("OD3: relayed and over 100 MB asks first; a time is said only past 15 s", () => {
  const legs = [
    { name: "dream", kind: "relay" as const },
    { name: "mac-mini", kind: "direct" as const },
  ];
  expect(relayedHosts(legs)).toEqual(["dream"]);
  expect(needsRelayWarning(101 * 1024 * 1024, legs)).toBe(true);
  expect(needsRelayWarning(99 * 1024 * 1024, legs)).toBe(false);
  expect(needsRelayWarning(10 * 1024 ** 3, [{ name: "x", kind: "stun" }])).toBe(false);
  expect(worthEstimating(15)).toBe(false);
  expect(worthEstimating(16)).toBe(true);
  expect(worthEstimating(null)).toBe(false);
  expect(estimateSeconds(1000, 100)).toBe(10);
  expect(estimateSeconds(1000, 0)).toBeNull();
  // 64 KiB a round trip: 50 ms is about 1.3 MB/s.
  expect(Math.round(modelRate(50))).toBe(1_310_720);
  expect(modelRate(null)).toBe(modelRate(50));
});

test("the rate meter measures the last few seconds, not the whole run", () => {
  const meter = new RateMeter(5_000);
  meter.note(0, 0);
  expect(meter.rate()).toBeNull();
  meter.note(1_000, 1_000);
  expect(meter.rate()).toBe(1_000);
  // A stall shows: nothing moved in the last six seconds.
  meter.note(7_000, 1_000);
  expect(meter.rate()).toBe(0);
  meter.note(8_000, 3_000);
  expect(meter.rate()).toBe(2_000);
});
