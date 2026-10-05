import { fileEntry, folderEntry } from "@/components/files/__tests__/fixtures";
import type { DirectoryListing } from "@/components/files/listing";
import {
  CONFLICT_POLICIES,
  conflictChoices,
  destinationPath,
  ESTIMATE_AFTER_SECONDS,
  estimateSeconds,
  expectedRate,
  firstFreeName,
  keepBothName,
  modelRate,
  nameSet,
  needsRelayWarning,
  planSend,
  RateMeter,
  RELAY_WARNING_BYTES,
  relayedHosts,
  routeKey,
  settleDecision,
  worthEstimating,
} from "@/components/files/transfer-plan";
import type { HostDirEntry } from "@/components/files/types";

function listingOf(path: string, entries: HostDirEntry[], truncated = false): DirectoryListing {
  return {
    path,
    homeDir: "/home/me",
    entries,
    truncated,
    singlePage: true,
    head: "",
    changedOnHost: false,
  };
}

describe("a kept-both copy's name", () => {
  test("goes before the extension, keeps a compound one whole, and a dotfile keeps its name", () => {
    expect(keepBothName("notes.md", 1)).toBe("notes.md");
    expect(keepBothName("notes.md", 2)).toBe("notes (2).md");
    expect(keepBothName("logs.tar.gz", 2)).toBe("logs (2).tar.gz");
    expect(keepBothName("Backup.TAR.XZ", 3)).toBe("Backup (3).TAR.XZ");
    expect(keepBothName("README", 2)).toBe("README (2)");
    expect(keepBothName(".env", 2)).toBe(".env (2)");
  });

  test("a folder takes its whole name", () => {
    expect(keepBothName("v1.2", 2, true)).toBe("v1.2 (2)");
    expect(keepBothName("photos", 2, true)).toBe("photos (2)");
  });

  test("is the first one free, starting with the name itself", async () => {
    const taken = new Set(["notes.md", "notes (2).md"]);
    await expect(firstFreeName("notes.md", (name) => taken.has(name))).resolves.toBe(
      "notes (3).md",
    );
    await expect(firstFreeName("free.md", (name) => taken.has(name))).resolves.toBe("free.md");
    await expect(firstFreeName("x", () => true, { attempts: 3 })).resolves.toBeNull();
    await expect(firstFreeName("v1.2", (name) => name === "v1.2", { isDir: true })).resolves.toBe(
      "v1.2 (2)",
    );
  });

  test("is free of every name there without regard to case", () => {
    const there = nameSet(["Notes (2).md"]);
    expect(there.has("notes (2).md")).toBe(true);
    expect(there.has("notes (3).md")).toBe(false);
  });
});

describe("a taken name", () => {
  test("is asked about by default, with the four choices the web offers", () => {
    expect(CONFLICT_POLICIES).toEqual(["ask", "keep_both", "replace", "skip"]);
  });

  test("between a file and a folder offers only Keep both and Skip", () => {
    expect(conflictChoices(false, false)).toEqual(["replace", "keep_both", "skip"]);
    expect(conflictChoices(true, true)).toEqual(["replace", "keep_both", "skip"]);
    expect(conflictChoices(false, true)).toEqual(["keep_both", "skip"]);
    expect(conflictChoices(true, false)).toEqual(["keep_both", "skip"]);
  });

  test("never swaps a file and a folder: Replace between them keeps both", () => {
    expect(settleDecision("replace", false, true)).toBe("keep_both");
    expect(settleDecision("replace", true, false)).toBe("keep_both");
    expect(settleDecision("replace", true, true)).toBe("replace");
    expect(settleDecision("skip", false, true)).toBe("skip");
  });
});

describe("planning a send", () => {
  test("walks folders breadth first, each folder before what it holds, links and specials left out", async () => {
    const listFolder = jest.fn(async (path: string) => {
      if (path === "/home/me/src") {
        return listingOf(path, [
          fileEntry(path, "main.rs", { size: 10 }),
          folderEntry(path, "deep"),
          { name: "link", path: `${path}/link`, kind: "symlink", is_dir: false },
          { name: "sock", path: `${path}/sock`, kind: "other", is_dir: false },
        ]);
      }
      if (path === "/home/me/src/deep") {
        return listingOf(path, [fileEntry(path, "x.txt", { size: 5 })]);
      }
      throw new Error(`unexpected ${path}`);
    });
    const counts: number[] = [];
    const plan = await planSend({
      entries: [fileEntry("/home/me", "notes.md", { size: 100 }), folderEntry("/home/me", "src")],
      listFolder,
      onProgress: (counted) => counts.push(counted),
    });
    expect(plan.items.map((item) => [item.kind, item.relative.join("/")])).toEqual([
      ["file", "notes.md"],
      ["folder", "src"],
      ["file", "src/main.rs"],
      ["folder", "src/deep"],
      ["file", "src/deep/x.txt"],
    ]);
    expect(plan.items[2]?.sourcePath).toBe("/home/me/src/main.rs");
    expect(plan).toMatchObject({
      files: 3,
      folders: 2,
      totalBytes: 115,
      links: 1,
      special: 1,
      tooMany: null,
    });
    // Items counted, folders and files alike.
    expect(counts.at(-1)).toBe(5);
    expect(listFolder).toHaveBeenCalledTimes(2);
  });

  test("an empty folder is a send of its own", async () => {
    const plan = await planSend({
      entries: [folderEntry("/home/me", "empty")],
      listFolder: async (path) => listingOf(path, []),
    });
    expect(plan.items.map((item) => [item.kind, item.relative.join("/")])).toEqual([
      ["folder", "empty"],
    ]);
    expect(plan).toMatchObject({ files: 0, folders: 1, tooMany: null });
  });

  test("names a folder listed only in part and refuses files over the ceiling", async () => {
    const plan = await planSend({
      entries: [
        folderEntry("/home/me", "big"),
        fileEntry("/home/me", "huge.iso", { size: 600 * 1024 * 1024 }),
      ],
      listFolder: async (path) => listingOf(path, [fileEntry(path, "a.txt", { size: 1 })], true),
    });
    expect(plan.truncated).toEqual(["big"]);
    expect(plan.tooLarge.map((file) => file.relative.join("/"))).toEqual(["huge.iso"]);
    expect(plan.items.map((item) => item.relative.join("/"))).toEqual(["big", "big/a.txt"]);
  });

  test("refuses a pick past the item limit, counting folders too, and names it", async () => {
    const plan = await planSend({
      entries: [fileEntry("/home/me", "first.txt", { size: 1 }), folderEntry("/home/me", "many")],
      listFolder: async (path) =>
        listingOf(path, [
          folderEntry(path, "sub"),
          ...Array.from({ length: 5 }, (_, index) => fileEntry(path, `f${index}`, { size: 1 })),
        ]),
      itemLimit: 4,
    });
    expect(plan.tooMany).toBe("many");
  });

  test("stops when cancelled", async () => {
    const controller = new AbortController();
    const walking = planSend({
      entries: [folderEntry("/home/me", "a")],
      listFolder: async (path) => {
        controller.abort();
        return listingOf(path, []);
      },
      signal: controller.signal,
    });
    await expect(walking).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("where a sent file goes", () => {
  test("is joined in the destination's own spelling", () => {
    expect(destinationPath("/Users/you/Inbox", ["src", "main.rs"], "posix")).toBe(
      "/Users/you/Inbox/src/main.rs",
    );
    expect(destinationPath("C:\\Users\\you", ["src", "main.rs"], "windows")).toBe(
      "C:\\Users\\you\\src\\main.rs",
    );
  });
});

describe("the relay warning (OD3)", () => {
  test("is said only for a relayed leg above 100 MB", () => {
    const relayed = relayedHosts([
      { name: "dream", info: { kind: "relay", rttMs: 80 } },
      { name: "mac-mini", info: { kind: "direct", rttMs: 3 } },
      { name: "box", info: null },
    ]);
    expect(relayed).toEqual(["dream"]);
    expect(needsRelayWarning(RELAY_WARNING_BYTES + 1, relayed)).toBe(true);
    expect(needsRelayWarning(RELAY_WARNING_BYTES, relayed)).toBe(false);
    expect(needsRelayWarning(RELAY_WARNING_BYTES * 2, [])).toBe(false);
  });
});

describe("the time a transfer takes", () => {
  test("is modelled at 64 KiB a round trip before anything is measured", () => {
    expect(Math.round(modelRate(50))).toBe(1_310_720);
    expect(modelRate(null)).toBe(modelRate(50));
  });

  test("expects what the route kept last, or its slowest leg", () => {
    const legs = [
      { hostId: "mini", info: { kind: "relay" as const, rttMs: 100 } },
      { hostId: "dream", info: { kind: "direct" as const, rttMs: 10 } },
    ];
    expect(expectedRate(legs, {})).toBe(modelRate(100));
    expect(expectedRate(legs, { [routeKey(["dream", "mini"])]: 42 })).toBe(42);
  });

  test("is said only past 15 seconds", () => {
    expect(ESTIMATE_AFTER_SECONDS).toBe(15);
    expect(worthEstimating(15)).toBe(false);
    expect(worthEstimating(16)).toBe(true);
    expect(worthEstimating(null)).toBe(false);
    expect(estimateSeconds(100, 10)).toBe(10);
    expect(estimateSeconds(100, null)).toBeNull();
  });

  test("is paced by what moved over the last few seconds", () => {
    const meter = new RateMeter(5_000);
    meter.note(0, 0);
    expect(meter.rate()).toBeNull();
    meter.note(2_000, 2_000);
    expect(meter.rate()).toBe(1_000);
    meter.note(10_000, 2_000);
    // A stall shows: the window is the last five seconds.
    expect(meter.rate()).toBe(0);
  });
});
