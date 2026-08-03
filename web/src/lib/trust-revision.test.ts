import { describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import {
  enforceBundleFreshness,
  readHighestSeenRevision,
  recordSeenRevision,
  TrustRevisionError,
} from "./trust-revision";

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

/** A separate IDBFactory is a separate device. */
function device() {
  return { indexedDBFactory: new IDBFactory() };
}

describe("trust revision floor", () => {
  test("an untouched account has floor 0", async () => {
    expect(await readHighestSeenRevision(ACCOUNT, device())).toBe(0);
  });

  test("recording raises the floor but never lowers it", async () => {
    const storage = device();
    await recordSeenRevision(ACCOUNT, 5, storage);
    expect(await readHighestSeenRevision(ACCOUNT, storage)).toBe(5);
    // A stale lower value must not roll the floor back.
    await recordSeenRevision(ACCOUNT, 3, storage);
    expect(await readHighestSeenRevision(ACCOUNT, storage)).toBe(5);
    await recordSeenRevision(ACCOUNT, 8, storage);
    expect(await readHighestSeenRevision(ACCOUNT, storage)).toBe(8);
  });

  test("the floor is per-account", async () => {
    const storage = device();
    await recordSeenRevision(ACCOUNT, 4, storage);
    expect(await readHighestSeenRevision(OTHER, storage)).toBe(0);
  });

  test("enforceBundleFreshness accepts and records an equal-or-higher revision", async () => {
    const storage = device();
    await enforceBundleFreshness(ACCOUNT, 2, storage);
    expect(await readHighestSeenRevision(ACCOUNT, storage)).toBe(2);
    // Equal is allowed (re-opening the current bundle) and does not lower.
    await enforceBundleFreshness(ACCOUNT, 2, storage);
    expect(await readHighestSeenRevision(ACCOUNT, storage)).toBe(2);
    await enforceBundleFreshness(ACCOUNT, 3, storage);
    expect(await readHighestSeenRevision(ACCOUNT, storage)).toBe(3);
  });

  test("enforceBundleFreshness refuses a revision below the floor", async () => {
    const storage = device();
    await recordSeenRevision(ACCOUNT, 4, storage);
    await expect(enforceBundleFreshness(ACCOUNT, 3, storage)).rejects.toThrow(TrustRevisionError);
    // The failed check did not disturb the floor.
    expect(await readHighestSeenRevision(ACCOUNT, storage)).toBe(4);
  });

  test("unavailable storage fails closed rather than silently passing", async () => {
    await expect(readHighestSeenRevision(ACCOUNT, { indexedDBFactory: null })).rejects.toThrow(
      TrustRevisionError,
    );
  });
});
