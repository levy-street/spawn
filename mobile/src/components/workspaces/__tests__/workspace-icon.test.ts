import {
  initialsWorkspaceIcon,
  WORKSPACE_ICON_MAX_CHARACTERS,
  workspaceIconDataUrl,
} from "@/components/workspaces/workspace-icon";

describe("workspace icon wire format", () => {
  test("encodes PNG and WebP values as the server-compatible data URL", () => {
    expect(workspaceIconDataUrl("image/png", "YWJj\nZA==")).toBe("data:image/png;base64,YWJjZA==");
    expect(workspaceIconDataUrl("image/webp", "YWJj")).toBe("data:image/webp;base64,YWJj");
  });

  test("rejects values beyond the server's 32 KiB character limit", () => {
    expect(() =>
      workspaceIconDataUrl("image/png", "a".repeat(WORKSPACE_ICON_MAX_CHARACTERS)),
    ).toThrow("32 KiB of encoded data");
  });

  test("using initials deliberately stores a custom null icon", () => {
    expect(initialsWorkspaceIcon()).toEqual({ icon: null, iconSource: "custom" });
  });
});
