import { describe, expect, test } from "bun:test";
import {
  deriveFileCapabilities,
  FILE_OPS,
  MAX_CAPABILITIES,
  parseCapabilities,
} from "./capabilities";

const ALL = new Set(Object.values(FILE_OPS) as string[]);
const LEGACY = new Set(["ping", "fs.home", "fs.list", "fs.stat", "fs.read"]);

describe("deriveFileCapabilities", () => {
  test("a fully capable macOS host offers everything", () => {
    const caps = deriveFileCapabilities(ALL, "macos");
    expect(caps.reveal).toBe(true);
    expect(caps.open).toBe(true);
    expect(caps.quicklook).toBe(true);
    expect(caps.range).toBe(true);
    expect(caps.revealLabel).toBe("Reveal in Finder");
    expect(caps.openLabel).toBe("Open in default program");
    expect(caps.unavailableReason).toBeNull();
  });

  test("an old daemon on a Mac hides the desktop actions", () => {
    // The gate is the capability list, not the platform: an old agent on
    // macOS must not be offered actions it cannot perform.
    const caps = deriveFileCapabilities(LEGACY, "macos");
    expect(caps.reveal).toBe(false);
    expect(caps.open).toBe(false);
    expect(caps.quicklook).toBe(false);
    expect(caps.range).toBe(false);
    expect(caps.stat).toBe(true);
    expect(caps.unavailableReason).toBe(
      "This host cannot render previews with its current daemon.",
    );
  });

  test("a Linux host gets the same capability-neutral explanation", () => {
    const caps = deriveFileCapabilities(new Set(["fs.read.range", "fs.stat"]), "linux");
    expect(caps.quicklook).toBe(false);
    expect(caps.range).toBe(true);
    expect(caps.unavailableReason).toBe(
      "This host cannot render previews with its current daemon.",
    );
  });

  test("labels follow the host platform, not the browser", () => {
    expect(deriveFileCapabilities(ALL, "linux").revealLabel).toBe("Show in file manager");
    expect(deriveFileCapabilities(ALL, "windows").revealLabel).toBe("Reveal in File Explorer");
    expect(deriveFileCapabilities(ALL, null).revealLabel).toBe("Show in file manager");
  });

  test("a future Linux daemon lights the actions up with no UI change", () => {
    const caps = deriveFileCapabilities(ALL, "linux");
    expect(caps.reveal).toBe(true);
    expect(caps.open).toBe(true);
    expect(caps.revealLabel).toBe("Show in file manager");
  });

  test("an empty capability set offers nothing", () => {
    const caps = deriveFileCapabilities(new Set(), "macos");
    expect(caps.reveal).toBe(false);
    expect(caps.open).toBe(false);
    expect(caps.stat).toBe(false);
  });
});

describe("parseCapabilities", () => {
  test("accepts a well-formed list", () => {
    const parsed = parseCapabilities(["fs.list", "fs.read.range", "desktop.open"]);
    expect(parsed.has("fs.read.range")).toBe(true);
    expect(parsed.size).toBe(3);
  });

  test("a missing or non-array value degrades to empty", () => {
    // Degrading is the point: an odd hello must not disconnect a working
    // channel, it must simply offer nothing extra.
    expect(parseCapabilities(undefined).size).toBe(0);
    expect(parseCapabilities("fs.list").size).toBe(0);
    expect(parseCapabilities({ a: 1 }).size).toBe(0);
  });

  test("skips a malformed entry and keeps every name it can read", () => {
    // A newer daemon's odd entry must not cost the names this client knows.
    for (const odd of [42, null, { op: "x" }, "Fs.Upper", "has space", "-leading"]) {
      expect([...parseCapabilities(["fs.list", odd, "session.transport.v1"])]).toEqual([
        "fs.list",
        "session.transport.v1",
      ]);
    }
    expect([...parseCapabilities([`fs.${"x".repeat(80)}`, "ping"])]).toEqual(["ping"]);
  });

  test("a list longer than 64 names keeps them all: there is no cliff", () => {
    // The old parser emptied the set past 64 names, which made a host look like
    // a daemon without session transport and refused a working connection.
    const names = Array.from({ length: 80 }, (_, index) => `family${index}.v1`);
    const parsed = parseCapabilities([...names, "session.transport.v1"]);
    expect(parsed.size).toBe(81);
    expect(parsed.has("session.transport.v1")).toBe(true);
  });

  test("reads at most MAX_CAPABILITIES names and ignores the rest", () => {
    const names = Array.from({ length: MAX_CAPABILITIES + 50 }, (_, index) => `op${index}`);
    const parsed = parseCapabilities(names);
    expect(parsed.size).toBe(MAX_CAPABILITIES);
    expect(parsed.has("op0")).toBe(true);
    expect(parsed.has(`op${MAX_CAPABILITIES}`)).toBe(false);
  });

  test("an empty list is valid and empty", () => {
    expect(parseCapabilities([]).size).toBe(0);
  });
});
