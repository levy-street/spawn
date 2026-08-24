import { BrowserDeviceOutSchema } from "@/data/api/schemas/devices";
import { formatHostFingerprint } from "@/data/trust/host-pins";

/**
 * The exact shape `GET /api/browser-devices` and `POST .../register` return.
 *
 * Copied from `BrowserDeviceOut` in `server/spawn_server/schemas.py`, which
 * documents the absence of `fingerprint` as a trust property: the key is in
 * the payload, so a display fingerprint is derived locally, and a
 * server-authored one would be a comparison label the server could forge.
 *
 * This schema previously required that field. Zod rejected every response,
 * `ensureDeviceRegistered` swallowed the error in a bare `catch`, and
 * onboarding died on "Device registration was rejected" while the server
 * happily logged 200 OK.
 */
const SERVER_PAYLOAD = {
  id: "4d9e429f-0f62-4329-add2-b59c71bf72ec",
  key_algorithm: "ed25519",
  public_key: "9Ml5wLdEuJt0DhrYVJfHUyXQBqRCJfN6mHnI2gKzPqA",
  label: "spawn on iPhone",
  created_at: "2026-08-24T04:00:55Z",
  last_seen_at: null,
  approval_requested_at: null,
  revoked_at: null,
  revoked_by_device_id: null,
  is_root: false,
};

describe("browser device contract", () => {
  it("accepts what the server actually sends", () => {
    const parsed = BrowserDeviceOutSchema.parse(SERVER_PAYLOAD);
    expect(parsed.public_key).toBe(SERVER_PAYLOAD.public_key);
    expect(parsed.revoked_at).toBeNull();
  });

  it("does not require a server-authored fingerprint", () => {
    // Asserting the negative on purpose: re-adding the field would restore a
    // bug that presents as a client-side rejection of a successful request.
    expect("fingerprint" in BrowserDeviceOutSchema.shape).toBe(false);
  });

  it("derives the display fingerprint from the key in the payload", () => {
    const parsed = BrowserDeviceOutSchema.parse(SERVER_PAYLOAD);
    const derived = formatHostFingerprint(parsed.public_key);
    expect(derived).toEqual(expect.any(String));
    expect(derived.length).toBeGreaterThan(0);
    // Same key in, same label out — that is what makes local derivation a
    // usable substitute for the field the server refuses to invent.
    expect(formatHostFingerprint(SERVER_PAYLOAD.public_key)).toBe(derived);
  });
});
