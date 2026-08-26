import { describe, expect, test } from "bun:test";
import {
  DEVICE_APPROVAL_STASH_KEY,
  restoreDeviceApproval,
  stashDeviceApproval,
} from "./device-approval-stash";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("device approval session stash", () => {
  test("stashes ref + fragment and restores them after a redirect", () => {
    const storage = memoryStorage();
    expect(
      stashDeviceApproval(
        storage,
        "https://app.example/device?ref=approval-ref#k=out-of-band-key",
        1_000,
      ),
    ).toEqual({ ref: "approval-ref", k: "out-of-band-key", at: 1_000 });
    expect(
      restoreDeviceApproval(storage, "https://app.example/device?ref=approval-ref", 2_000),
    ).toBe("/device?ref=approval-ref#k=out-of-band-key");
    expect(storage.getItem(DEVICE_APPROVAL_STASH_KEY)).toBeNull();
  });

  test("restores an older code path when the callback URL has no identifier", () => {
    const storage = memoryStorage();
    stashDeviceApproval(storage, "https://app.example/device?code=QZ4K-7HMT#k=key", 5_000);
    expect(restoreDeviceApproval(storage, "https://app.example/device", 6_000)).toBe(
      "/device?code=QZ4K-7HMT#k=key",
    );
  });

  test("ignores and clears entries older than 30 minutes", () => {
    const storage = memoryStorage();
    stashDeviceApproval(storage, "https://app.example/device?ref=old#k=key", 1_000);
    expect(restoreDeviceApproval(storage, "https://app.example/device", 1_801_001)).toBeNull();
    expect(storage.getItem(DEVICE_APPROVAL_STASH_KEY)).toBeNull();
  });

  test("never joins a stored key to a different approval identifier", () => {
    const storage = memoryStorage();
    stashDeviceApproval(storage, "https://app.example/device?ref=first#k=first-key", 1_000);
    expect(
      restoreDeviceApproval(storage, "https://app.example/device?ref=second", 2_000),
    ).toBeNull();
    expect(storage.getItem(DEVICE_APPROVAL_STASH_KEY)).toBeNull();
  });

  test("does not stash unrelated routes or identifier-free device pages", () => {
    const storage = memoryStorage();
    expect(stashDeviceApproval(storage, "https://app.example/app#k=key", 1_000)).toBeNull();
    expect(stashDeviceApproval(storage, "https://app.example/device#k=key", 1_000)).toBeNull();
  });
});

describe("who may claim a stash", () => {
  const stashed = (now = 1_000) => {
    const storage = memoryStorage();
    stashDeviceApproval(storage, "https://app.example/device?ref=abc#k=hostkey", now);
    return storage;
  };

  test("onboarding can claim one, so a new account finishes in its own flow", () => {
    const restored = restoreDeviceApproval(stashed(), "https://app.example/onboarding", 2_000, [
      "/onboarding",
    ]);
    expect(restored).toBe("/onboarding?ref=abc#k=hostkey");
  });

  test("a page that did not ask for it never picks one up", () => {
    // The default stays /device: widening the list is opt-in, per caller, so a
    // stray approval cannot be applied on an unrelated screen.
    expect(restoreDeviceApproval(stashed(), "https://app.example/app", 2_000)).toBeNull();
    expect(restoreDeviceApproval(stashed(), "https://app.example/onboarding", 2_000)).toBeNull();
    expect(
      restoreDeviceApproval(stashed(), "https://app.example/app", 2_000, ["/onboarding"]),
    ).toBeNull();
  });

  test("the host key still rides sessionStorage, never the redirect", () => {
    const storage = stashed();
    const restored = restoreDeviceApproval(storage, "https://app.example/onboarding", 2_000, [
      "/onboarding",
    ]);
    // It lands in the fragment, which browsers do not send to the server.
    expect(restored?.split("#")[1]).toBe("k=hostkey");
    // And it is consumed exactly once.
    expect(
      restoreDeviceApproval(storage, "https://app.example/onboarding", 2_000, ["/onboarding"]),
    ).toBeNull();
  });
});
