import {
  HOST_DIRECTORY_PAGE_ENTRIES,
  retainDirectoryPages,
  validateDirectoryPage,
} from "@/components/files/pagination";
import {
  breadcrumbParts,
  normalizeCwdForHost,
  parentWithinHome,
  validateLeafName,
  visibleEntries,
} from "@/components/files/paths";
import type { HostDirEntry, HostDirList } from "@/components/files/types";

const entry = (name: string): HostDirEntry => ({
  name,
  path: `/home/me/${name}`,
  kind: "file",
  is_dir: false,
});
const page = (names: string[], next: number | null, truncated = false): HostDirList => ({
  path: "/home/me",
  home_dir: "/home/me",
  entries: names.map(entry),
  next_cursor: next,
  truncated,
});

describe("file pagination and paths", () => {
  it("preserves daemon order across explicit pages", () => {
    const result = retainDirectoryPages([page(["z", "a"], 2), page(["m"], null)]);
    expect(result.entries.map(({ name }) => name)).toEqual(["z", "a", "m"]);
    expect(result.nextCursor).toBeNull();
  });

  it("rejects oversized pages and non-advancing cursors", () => {
    expect(() =>
      validateDirectoryPage(
        page(
          Array.from({ length: HOST_DIRECTORY_PAGE_ENTRIES + 1 }, (_, index) => String(index)),
          null,
        ),
        0,
      ),
    ).toThrow("invalid directory page");
    expect(() => validateDirectoryPage(page(["a"], 4), 4)).toThrow("invalid directory page");
  });

  it("stops at the retained entry budget", () => {
    const result = retainDirectoryPages([page(["a", "b", "c"], 3)], 2);
    expect(result.entries.map(({ name }) => name)).toEqual(["a", "b"]);
    expect(result.limitReached).toBe(true);
  });

  it("clamps paths to home and derives breadcrumbs", () => {
    expect(normalizeCwdForHost("/etc", "/home/me")).toBe("/home/me");
    expect(parentWithinHome("/home/me/project/src", "/home/me")).toBe("/home/me/project");
    expect(breadcrumbParts("/home/me/project/src", "/home/me")).toEqual([
      { label: "Home", path: "/home/me" },
      { label: "project", path: "/home/me/project" },
      { label: "src", path: "/home/me/project/src" },
    ]);
  });

  it("supports an explicit dotfile toggle without sorting", () => {
    const entries = [entry("z"), entry(".env"), entry("a")];
    expect(visibleEntries(entries, false).map(({ name }) => name)).toEqual(["z", "a"]);
    expect(visibleEntries(entries, true).map(({ name }) => name)).toEqual(["z", ".env", "a"]);
  });

  it("validates daemon-compatible leaf names", () => {
    expect(validateLeafName("folder")).toBeNull();
    expect(validateLeafName("../folder")).toBe("Names cannot contain slashes.");
    expect(validateLeafName("bad\\name")).toBe("Names cannot contain slashes.");
    expect(validateLeafName("bad\u0000name")).toBe("Names cannot contain control characters.");
    expect(validateLeafName("é".repeat(128))).toBe("Names must be 255 bytes or fewer.");
  });
});
