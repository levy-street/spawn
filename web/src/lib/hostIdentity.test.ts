import { describe, expect, test } from "bun:test";
import { DeviceApproveResponseSchema, HostSchema } from "./api";

describe("host identity API schemas", () => {
  test("retain the authorized public pin and fingerprint", () => {
    const host = HostSchema.parse({
      id: "00000000-0000-4000-8000-000000000002",
      name: "host",
      status: "offline",
      last_seen_at: null,
      agent_count: 0,
      host_key_algorithm: "ed25519",
      host_public_key: "A".repeat(43),
      host_key_fingerprint: "SHA256:0123456789abcdef",
    });
    expect(host.host_key_algorithm).toBe("ed25519");
    expect(host.host_key_fingerprint).toBe("SHA256:0123456789abcdef");
    expect(JSON.stringify(host)).not.toContain("private");
    expect(JSON.stringify(host)).not.toContain("seed");
  });

  test("approval presentation requires the server fingerprint", () => {
    expect(() =>
      DeviceApproveResponseSchema.parse({
        host_name: "host",
        host_key_algorithm: "ed25519",
        host_public_key: "A".repeat(43),
      }),
    ).toThrow();
  });
});
