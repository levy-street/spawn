import { describe, expect, test } from "bun:test";
import { shortcutBarPosition, shortcutBarVisible } from "./shortcut-bar-helpers";

describe("shortcut bar helpers", () => {
  test("requires a running shell at an empty prompt", () => {
    expect(shortcutBarVisible({ status: "running", foreground_command: null }, "empty")).toBe(true);
    expect(shortcutBarVisible({ status: "running", foreground_command: "-zsh" }, "empty")).toBe(
      true,
    );
    expect(shortcutBarVisible({ status: "running", foreground_command: "claude" }, "empty")).toBe(
      false,
    );
    expect(shortcutBarVisible({ status: "running", foreground_command: "bash" }, "typing")).toBe(
      false,
    );
    expect(shortcutBarVisible({ status: "exited", foreground_command: "bash" }, "empty")).toBe(
      false,
    );
  });

  test("anchors below and clamps horizontally", () => {
    expect(
      shortcutBarPosition({ left: 290, top: 20, cellWidth: 8, cellHeight: 18 }, 320, 200, 180, 44),
    ).toEqual({ left: 132, top: 42, maxWidth: 304, flipped: false });
  });

  test("flips above a cursor near the bottom", () => {
    expect(
      shortcutBarPosition({ left: 20, top: 170, cellWidth: 8, cellHeight: 18 }, 320, 200, 180, 44),
    ).toEqual({ left: 20, top: 122, maxWidth: 304, flipped: true });
  });
});
