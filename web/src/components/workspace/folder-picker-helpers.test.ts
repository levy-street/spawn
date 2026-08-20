import { describe, expect, test } from "bun:test";
import {
  breadcrumbParts,
  isWithinHome,
  joinDirectory,
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
