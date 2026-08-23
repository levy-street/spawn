import { describe, expect, test } from "bun:test";
import { DeviceApproveResponseSchema, DevicePendingResponseSchema, HostSchema } from "./api";

describe("host identity API schemas", () => {
  test("retain the public pin key; a served fingerprint is never parsed (mesh B5)", () => {
    const host = HostSchema.parse({
      id: "00000000-0000-4000-8000-000000000002",
      name: "host",
      status: "offline",
      last_seen_at: null,
      session_count: 0,
      host_key_algorithm: "ed25519",
      host_public_key: "A".repeat(43),
      // A legacy/hostile server may still send one; it must be dropped so no
      // consumer can display it — fingerprints are derived from the key.
      host_key_fingerprint: "SHA256:0123456789abcdef",
    });
    expect(host.host_key_algorithm).toBe("ed25519");
    expect("host_key_fingerprint" in host).toBe(false);
    expect(JSON.stringify(host)).not.toContain("fingerprint");
    expect(JSON.stringify(host)).not.toContain("private");
    expect(JSON.stringify(host)).not.toContain("seed");
  });

  test("the pending review still carries the ceremony fingerprint the daemon prints", () => {
    // Kept deliberately (mesh B5 keeps only cross-checked ceremony wire data):
    // the client verifies it against the key before showing or sending it.
    expect(() =>
      DevicePendingResponseSchema.parse({
        host_name: "host",
        approval_nonce: "A".repeat(43),
        host_key_algorithm: "ed25519",
        host_public_key: "A".repeat(43),
      }),
    ).toThrow();
  });

  test("the approve echo carries keys alone — a served fingerprint is dropped", () => {
    const approved = DeviceApproveResponseSchema.parse({
      host_name: "host",
      approval_nonce: "A".repeat(43),
      host_key_algorithm: "ed25519",
      host_public_key: "A".repeat(43),
      browser_device_id: "00000000-0000-4000-8000-000000000005",
      browser_key_algorithm: "ed25519",
      browser_public_key: "B".repeat(43),
      host_key_fingerprint: "SHA256:0123456789abcdef",
      browser_key_fingerprint: "SHA256:0123456789abcdef",
    });
    expect(JSON.stringify(approved)).not.toContain("fingerprint");
  });
});
