import { describe, expect, test } from "bun:test";
import { ApiError } from "@/lib/api";
import { isWorkspaceFullError } from "./new-session-menu-helpers";

describe("new session errors", () => {
  test("recognizes each workspace_full response shape", () => {
    expect(isWorkspaceFullError(new ApiError(409, "workspace_full", "full"))).toBe(true);
    expect(isWorkspaceFullError(new ApiError(409, "http_409", "full", "workspace_full"))).toBe(
      true,
    );
    expect(
      isWorkspaceFullError(new ApiError(409, "http_409", "full", { code: "workspace_full" })),
    ).toBe(true);
  });

  test("does not swallow unrelated conflicts", () => {
    expect(isWorkspaceFullError(new ApiError(409, "name_conflict", "already exists"))).toBe(false);
    expect(isWorkspaceFullError(new Error("workspace_full"))).toBe(false);
  });
});
