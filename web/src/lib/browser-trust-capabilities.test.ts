import { describe, expect, test } from "bun:test";
import type { BrowserTrustStatus } from "./browser-trust";
import { BrowserTrustEpochCapabilityRegistry } from "./browser-trust-capabilities";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";

function trusted(
  userId: string,
  epoch: number,
): Extract<BrowserTrustStatus, { status: "trusted" }> {
  return {
    status: "trusted",
    reason: null,
    epoch,
    epochKey: `${epoch}:trusted:${userId}`,
    accountOwnerUserId: userId,
    observedUserId: userId,
    browserDeviceId: `00000000-0000-4000-8000-${epoch.toString().padStart(12, "0")}`,
    browserPublicKey:
      userId === USER_A
        ? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        : "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  };
}

function expectation(trust: Extract<BrowserTrustStatus, { status: "trusted" }>) {
  return {
    accountOwnerUserId: trust.accountOwnerUserId,
    browserDeviceId: trust.browserDeviceId,
    browserPublicKey: trust.browserPublicKey,
    epochKey: trust.epochKey,
  };
}

describe("browser trust epoch capability registry", () => {
  test("requires the exact account, registration key/device, and epoch", () => {
    const registry = new BrowserTrustEpochCapabilityRegistry();
    const trust = trusted(USER_A, 1);
    registry.applyTrust(trust);
    expect(registry.acquire(expectation(trust)).accountOwnerUserId).toBe(USER_A);
    for (const candidate of [
      { ...expectation(trust), accountOwnerUserId: USER_B },
      { ...expectation(trust), browserDeviceId: trusted(USER_A, 2).browserDeviceId },
      { ...expectation(trust), browserPublicKey: trusted(USER_B, 1).browserPublicKey },
      { ...expectation(trust), epochKey: "stale" },
    ]) {
      expect(() => registry.acquire(candidate)).toThrow("exact account, registration");
    }
  });

  test("invalidation synchronously aborts every lease and account replacement cannot revive it", () => {
    const registry = new BrowserTrustEpochCapabilityRegistry();
    const first = trusted(USER_A, 1);
    registry.applyTrust(first);
    const stale = registry.acquire(expectation(first));
    let abortedSynchronously = false;
    stale.signal.addEventListener("abort", () => {
      abortedSynchronously = true;
    });

    const replacement = trusted(USER_B, 2);
    registry.applyTrust(replacement);
    expect(abortedSynchronously).toBe(true);
    expect(stale.signal.aborted).toBe(true);
    expect(() => stale.assertActive()).toThrow();
    expect(() => registry.acquire(expectation(first))).toThrow();
    expect(registry.acquire(expectation(replacement)).accountOwnerUserId).toBe(USER_B);
  });

  test("the React consumer factory exposes no mutable registry authority", async () => {
    const source = await Bun.file("src/lib/browser-trust-capabilities.tsx").text();
    const factory = source.slice(
      source.indexOf("export interface BrowserTrustEpochCapabilityFactory"),
      source.indexOf("const BrowserTrustCapabilityCtx"),
    );
    expect(factory).not.toContain("registry:");
    expect(factory).not.toContain("applyTrust");
    expect(factory).not.toContain("invalidate");
  });
});
