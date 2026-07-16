import { describe, expect, test } from "bun:test";

import type { HostDirList } from "@/lib/hostControl";
import { retainDirectoryPages } from "./fileExplorerPaging";

function page(names: string[], nextCursor: number | null): HostDirList {
  return {
    path: "/home/tester",
    home_dir: "/home/tester",
    entries: names.map((name) => ({
      name,
      path: `/home/tester/${name}`,
      kind: "file",
      is_dir: false,
    })),
    next_cursor: nextCursor,
  };
}

describe("FileExplorer paging", () => {
  test("retains only explicitly supplied pages and exposes the next cursor", () => {
    expect(retainDirectoryPages([page(["one", "two"], 2)])).toEqual({
      entries: [expect.objectContaining({ name: "one" }), expect.objectContaining({ name: "two" })],
      nextCursor: 2,
      limitReached: false,
    });
  });

  test("caps retained entries and stops exposing further cursors", () => {
    const retained = retainDirectoryPages([page(["one", "two"], 2), page(["three", "four"], 4)], 3);
    expect(retained.entries.map((entry) => entry.name)).toEqual(["one", "two", "three"]);
    expect(retained.nextCursor).toBeNull();
    expect(retained.limitReached).toBe(true);
  });

  test("surfaces the daemon directory scan ceiling as a terminal limit", () => {
    const capped = page(["last"], null);
    capped.truncated = true;
    expect(retainDirectoryPages([capped])).toEqual({
      entries: [expect.objectContaining({ name: "last" })],
      nextCursor: null,
      limitReached: true,
    });
  });
});
