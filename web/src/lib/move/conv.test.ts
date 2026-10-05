import { describe, expect, test } from "bun:test";
import { parseProbe } from "./conv";

describe("parseProbe", () => {
  const base = { folder_exists: true, store_ready: true };
  const claude = (fields: Record<string, unknown>) => {
    const probe = parseProbe({ ...base, ...fields });
    return { cliPath: probe.cliPath, cliVersion: probe.cliVersion };
  };

  test("a probe says where claude resolves, apart from its version", () => {
    // Missing: nothing found, and a daemon from before `cli_path` reads the same.
    expect(claude({ cli_path: null, cli_version: null })).toEqual({
      cliPath: null,
      cliVersion: null,
    });
    expect(claude({ cli_version: null })).toEqual({ cliPath: null, cliVersion: null });
    // Found, with its version.
    expect(claude({ cli_path: "/Users/me/.local/bin/claude", cli_version: "2.1.289" })).toEqual({
      cliPath: "/Users/me/.local/bin/claude",
      cliVersion: "2.1.289",
    });
    // Found, version unknown: a path, not a missing Claude Code.
    expect(claude({ cli_path: "/opt/spawn/claude", cli_version: null })).toEqual({
      cliPath: "/opt/spawn/claude",
      cliVersion: null,
    });
  });

  test("anything but a path is ignored, never refused", () => {
    for (const odd of [42, true, "", ["/opt/spawn/claude"], { path: "/opt/spawn/claude" }]) {
      expect(claude({ cli_path: odd, cli_version: null }).cliPath).toBeNull();
    }
  });
});
