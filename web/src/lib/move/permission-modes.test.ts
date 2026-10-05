import { describe, expect, test } from "bun:test";
import {
  defaultPermissionMode,
  PERMISSION_MODES,
  readTargetSettings,
  SETTINGS_LIMIT_BYTES,
} from "./permission-modes";

const YOLO = { yolo: true, yolo_args: "--dangerously-skip-permissions" };

describe("the permission picker", () => {
  test("lists Claude Code's own six modes, in the phone's order, by the names its footer shows", () => {
    expect(PERMISSION_MODES.map((choice) => choice.mode)).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "auto",
      "dontAsk",
      "bypassPermissions",
    ]);
    expect(PERMISSION_MODES.map((choice) => choice.label)).toEqual([
      "manual mode",
      "accept edits",
      "plan mode",
      "auto mode",
      "don't ask",
      "bypass permissions",
    ]);
  });
});

describe("defaultPermissionMode", () => {
  test("a yolo window keeps bypassing; its target's settings do not change that", () => {
    expect(defaultPermissionMode(YOLO, '{"permissions":{"defaultMode":"plan"}}')).toBe(
      "bypassPermissions",
    );
  });

  test("a yolo flag with no yolo mode to run is not bypass", () => {
    expect(defaultPermissionMode({ yolo: true }, null)).toBe("default");
  });

  test("otherwise the target's own default, when it is one of the six", () => {
    expect(defaultPermissionMode({}, '{"permissions":{"defaultMode":"acceptEdits"}}')).toBe(
      "acceptEdits",
    );
    expect(defaultPermissionMode({}, '{"permissions":{"defaultMode":"manual"}}')).toBe("default");
    expect(defaultPermissionMode({}, '{"permissions":{"defaultMode":"--evil"}}')).toBe("default");
    expect(defaultPermissionMode({}, "not json")).toBe("default");
    expect(defaultPermissionMode({}, null)).toBe("default");
  });
});

describe("readTargetSettings", () => {
  test("reads <store>/settings.json, bounded, and nothing without a store", async () => {
    const asked: Array<[string, number]> = [];
    const read = async (path: string, limit: number) => {
      asked.push([path, limit]);
      return "{}";
    };
    expect(await readTargetSettings("~/.claude/", read)).toBe("{}");
    expect(asked).toEqual([["~/.claude/settings.json", SETTINGS_LIMIT_BYTES]]);
    expect(await readTargetSettings(null, read)).toBeNull();
    expect(
      await readTargetSettings("/x", async () => {
        throw new Error("no such file");
      }),
    ).toBeNull();
  });
});
