import { describe, expect, test } from "bun:test";
import { breadcrumbParts, joinDirectory } from "./folder-picker-helpers";

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
