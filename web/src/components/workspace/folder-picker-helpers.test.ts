import { describe, expect, test } from "bun:test";
import { breadcrumbParts, joinDirectory, visibleDirectories } from "./folder-picker-helpers";

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

  test("builds clickable breadcrumb paths", () => {
    expect(breadcrumbParts("/Users/alice/project")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "alice", path: "/Users/alice" },
      { label: "project", path: "/Users/alice/project" },
    ]);
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
