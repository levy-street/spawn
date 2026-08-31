import { describe, expect, test } from "bun:test";
import type { Host } from "./api";
import { hostHealthPanel } from "./host-health";

const baseHost = (overrides: Partial<Host> = {}): Host => ({
  id: "00000000-0000-4000-8000-000000000002",
  name: "mac-studio",
  os: "macos",
  arch: "aarch64",
  version: "0.4.0",
  daemon_tree: null,
  update: { state: "current", latest_version: "0.4.0", error: null, requested_at: null },
  host_key_algorithm: "ed25519",
  host_public_key: null,
  status: "offline",
  last_seen_at: "2026-08-25T00:00:00Z",
  last_disconnect: null,
  session_count: 0,
  supports_account_chains: false,
  cpu_cores: null,
  cpu_physical_cores: null,
  cpu_model: null,
  memory_bytes: null,
  gpu: null,
  cpu_bucket: null,
  mem_bucket: null,
  capacity_at: null,
  ...overrides,
});

describe("hostHealthPanel", () => {
  test("selects never-connected before every other offline signal", () => {
    const result = hostHealthPanel(
      baseHost({
        last_seen_at: null,
        last_disconnect: { at: null, reason: "auth_rejected" },
        update: { state: "available", latest_version: "0.5.0", error: null, requested_at: null },
      }),
    );
    expect(result).toEqual({
      case: "never-connected",
      message: "SPAWN D hasn't checked in from this machine yet. On it, run: spawnd doctor",
      command: "spawnd doctor",
    });
  });

  test("selects auth rejection and its one login remedy", () => {
    const result = hostHealthPanel(
      baseHost({ last_disconnect: { at: "2026-08-25T00:01:00Z", reason: "auth_rejected" } }),
    );
    expect(result.case).toBe("auth-rejected");
    expect(result.message).toBe("mac-studio can't sign in. On that machine, run: spawnd login");
  });

  test("selects stale version for available and failed updates while offline", () => {
    for (const state of ["available", "failed"] as const) {
      const result = hostHealthPanel(
        baseHost({
          version: "0.3.9",
          update: { state, latest_version: "0.4.0", error: null, requested_at: null },
        }),
      );
      expect(result.case).toBe("stale-version");
      expect(result.message).toBe(
        "mac-studio runs 0.3.9. On it, run: spawnd update (or it will self-update when idle).",
      );
    }
  });

  test("missing last_disconnect degrades to the plain-offline case", () => {
    expect(hostHealthPanel(baseHost({ last_disconnect: undefined })).case).toBe("plain-offline");
  });

  test("online collapses to version and has no command", () => {
    expect(hostHealthPanel(baseHost({ status: "online" }))).toEqual({
      case: "online",
      message: "mac-studio is online · SPAWN D 0.4.0.",
      command: null,
    });
  });
});
