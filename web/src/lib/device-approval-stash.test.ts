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
