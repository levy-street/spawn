import { describe, expect, test } from "bun:test";
import type { DeviceApproval, Host } from "./api";
import type {
  BrowserDeviceIdentity,
  EpochScopedBrowserDeviceIdentity,
} from "./browser-device-identity";
import { type BrowserHostPin, BrowserHostPinAbortError } from "./browser-host-pins";
import type { BrowserTrustStatus } from "./browser-trust";
import {
  BrowserTrustEpochCapabilityRegistry,
  type BrowserTrustEpochLease,
} from "./browser-trust-capabilities";
import {
  type ApprovalTrustDependencies,
  approveDeviceWithinTrustEpoch,
  type DeleteHostTrustDependencies,
  deleteHostWithinTrustEpoch,
  resolveHostWithinTrustEpoch,
} from "./browser-trust-operations";

const USER_A = "00000000-0000-4000-8000-000000000001";
const USER_B = "00000000-0000-4000-8000-000000000002";
const DEVICE_A = "00000000-0000-4000-8000-000000000003";
const HOST_ID = "00000000-0000-4000-8000-000000000004";
const PUBLIC_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HOST_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const HOST_FINGERPRINT = "SHA256:BBBBBBBBBBBBBBBB";
const ORIGIN = "https://spawn.example";

function trusted(userId = USER_A, epoch = 1): Extract<BrowserTrustStatus, { status: "trusted" }> {
  return {
    status: "trusted",
    reason: null,
    epoch,
    epochKey: `${epoch}:trusted:${userId}`,
    accountOwnerUserId: userId,
    observedUserId: userId,
    browserDeviceId: DEVICE_A,
    browserPublicKey: PUBLIC_KEY,
  };
}

function leaseFor(registry: BrowserTrustEpochCapabilityRegistry): BrowserTrustEpochLease {
  const trust = trusted();
  registry.applyTrust(trust);
  return registry.acquire({
    accountOwnerUserId: trust.accountOwnerUserId,
    browserDeviceId: trust.browserDeviceId,
    browserPublicKey: trust.browserPublicKey,
    epochKey: trust.epochKey,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function reached(promise: Promise<unknown>, marker: () => boolean): Promise<void> {
  for (let index = 0; index < 20 && !marker(); index += 1) await Promise.resolve();
  expect(marker()).toBe(true);
  // The operation intentionally remains pending at the selected await.
  void promise;
}

const identity = {
  publicKey: {} as CryptoKey,
  publicKeyWire: PUBLIC_KEY,
} satisfies BrowserDeviceIdentity;

const activePin: BrowserHostPin = {
  accountId: USER_A,
  approvedAtMs: 1,
  createdAtMs: 1,
  hostFingerprint: HOST_FINGERPRINT,
  hostIds: [HOST_ID],
  hostPublicKey: HOST_KEY,
  origin: ORIGIN,
  revokedAtMs: null,
  state: "active",
  version: 1,
};

const approvalResponse: DeviceApproval = {
  host_name: "host-a",
  approval_nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  host_key_algorithm: "ed25519",
  host_public_key: HOST_KEY,
  host_key_fingerprint: HOST_FINGERPRINT,
  browser_device_id: DEVICE_A,
  browser_key_algorithm: "ed25519",
  browser_public_key: PUBLIC_KEY,
  browser_key_fingerprint: "SHA256:AAAAAAAAAAAAAAAA",
};

function approvalInput(lease: BrowserTrustEpochLease) {
  return {
    lease,
    userCode: "ABCD-EFGH",
    origin: ORIGIN,
    pending: {
      host_name: "host-a",
      approval_nonce: approvalResponse.approval_nonce,
      host_key_algorithm: "ed25519" as const,
      host_public_key: HOST_KEY,
      host_key_fingerprint: HOST_FINGERPRINT,
    },
    registration: {
      deviceId: DEVICE_A,
      keyAlgorithm: "ed25519" as const,
      publicKey: PUBLIC_KEY,
      fingerprint: approvalResponse.browser_key_fingerprint,
    },
  };
}

function approvalDeps(
  overrides: Partial<ApprovalTrustDependencies> = {},
): ApprovalTrustDependencies {
  return {
    loadIdentity: async () => identity,
    scopeIdentity: (value) => value as EpochScopedBrowserDeviceIdentity,
    fingerprint: async () => HOST_FINGERPRINT,
    persistPin: async () => activePin,
    signApproval: async () => "signature",
    approveServer: async () => approvalResponse,
    ...overrides,
  };
}

function invalidateAs(
  registry: BrowserTrustEpochCapabilityRegistry,
  reason:
    | "account_switch"
    | "logout"
    | "auth_error"
    | "registration_error"
    | "registration_revoked",
): void {
  if (reason === "account_switch") registry.applyTrust(trusted(USER_B, 2));
  else registry.invalidate();
}

describe("browser trust epoch operations", () => {
  test("account switch during identity load produces zero pin, signature, and approval calls", async () => {
    const registry = new BrowserTrustEpochCapabilityRegistry();
    const lease = leaseFor(registry);
    const gate = deferred<BrowserDeviceIdentity | null>();
    let entered = false;
    let pins = 0;
    let signs = 0;
    let posts = 0;
    const operation = approveDeviceWithinTrustEpoch(
      approvalInput(lease),
      approvalDeps({
        loadIdentity: () => {
          entered = true;
          return gate.promise;
        },
        persistPin: async () => {
          pins += 1;
          return activePin;
        },
        signApproval: async () => {
          signs += 1;
          return "signature";
        },
        approveServer: async () => {
          posts += 1;
          return approvalResponse;
        },
      }),
    );
    await reached(operation, () => entered);
    invalidateAs(registry, "account_switch");
    gate.resolve(identity);
    await expect(operation).rejects.toMatchObject({ recovery: "none" });
    expect({ pins, signs, posts }).toEqual({ pins: 0, signs: 0, posts: 0 });
  });

  test("logout during fingerprint derivation produces zero mutation or signing", async () => {
    const registry = new BrowserTrustEpochCapabilityRegistry();
    const lease = leaseFor(registry);
    const gate = deferred<string>();
    let entered = false;
    let pins = 0;
    let signs = 0;
    const operation = approveDeviceWithinTrustEpoch(
      approvalInput(lease),
      approvalDeps({
        fingerprint: () => {
          entered = true;
          return gate.promise;
        },
        persistPin: async () => {
          pins += 1;
          return activePin;
        },
        signApproval: async () => {
          signs += 1;
          return "signature";
        },
      }),
    );
    await reached(operation, () => entered);
    invalidateAs(registry, "logout");
    gate.resolve(HOST_FINGERPRINT);
    await expect(operation).rejects.toMatchObject({ recovery: "none" });
    expect({ pins, signs }).toEqual({ pins: 0, signs: 0 });
  });

  test("auth error before the local pin commit aborts with zero durable mutation and zero call", async () => {
    const registry = new BrowserTrustEpochCapabilityRegistry();
    const lease = leaseFor(registry);
    const gate = deferred<BrowserHostPin>();
    let entered = false;
    let posts = 0;
    const operation = approveDeviceWithinTrustEpoch(
      approvalInput(lease),
      approvalDeps({
        persistPin: () => {
          entered = true;
          return gate.promise;
        },
        approveServer: async () => {
          posts += 1;
          return approvalResponse;
        },
      }),
    );
    await reached(operation, () => entered);
    invalidateAs(registry, "auth_error");
    gate.reject(new BrowserHostPinAbortError(false));
    await expect(operation).rejects.toMatchObject({ recovery: "none" });
    expect(posts).toBe(0);
  });

  test("registration error after the local pin commit retains explicit recovery and makes zero approval calls", async () => {
    const registry = new BrowserTrustEpochCapabilityRegistry();
    const lease = leaseFor(registry);
    const gate = deferred<BrowserHostPin>();
    let entered = false;
    let posts = 0;
    const operation = approveDeviceWithinTrustEpoch(
      approvalInput(lease),
      approvalDeps({
        persistPin: () => {
          entered = true;
          return gate.promise;
        },
        approveServer: async () => {
          posts += 1;
          return approvalResponse;
        },
      }),
    );
    await reached(operation, () => entered);
    invalidateAs(registry, "registration_error");
    gate.reject(new BrowserHostPinAbortError(true));
    await expect(operation).rejects.toMatchObject({ recovery: "local_pin_retained" });
    expect(posts).toBe(0);
  });

  test("registration revoke during signing keeps the pin and never dispatches approval", async () => {
    const registry = new BrowserTrustEpochCapabilityRegistry();
    const lease = leaseFor(registry);
    const gate = deferred<string>();
    let entered = false;
    let posts = 0;
    const operation = approveDeviceWithinTrustEpoch(
      approvalInput(lease),
      approvalDeps({
        signApproval: () => {
          entered = true;
          return gate.promise;
        },
        approveServer: async () => {
          posts += 1;
          return approvalResponse;
        },
      }),
    );
    await reached(operation, () => entered);
    invalidateAs(registry, "registration_revoked");
    gate.resolve("stale-signature");
    await expect(operation).rejects.toMatchObject({ recovery: "local_pin_retained" });
    expect(posts).toBe(0);
  });

  test("logout after approval dispatch reports outcome_unknown and retains the local pin", async () => {
    const registry = new BrowserTrustEpochCapabilityRegistry();
    const lease = leaseFor(registry);
    const gate = deferred<DeviceApproval>();
    let entered = false;
    const operation = approveDeviceWithinTrustEpoch(
      approvalInput(lease),
      approvalDeps({
        approveServer: () => {
          entered = true;
          return gate.promise;
        },
      }),
    );
    await reached(operation, () => entered);
    invalidateAs(registry, "logout");
    gate.reject(new DOMException("aborted", "AbortError"));
    await expect(operation).rejects.toMatchObject({ recovery: "approval_outcome_unknown" });
  });

  test("resolver binding distinguishes pre-commit abort from retained post-commit state", async () => {
    for (const durableMutation of [false, true]) {
      const registry = new BrowserTrustEpochCapabilityRegistry();
      const lease = leaseFor(registry);
      const gate = deferred<BrowserHostPin>();
      let entered = false;
      const operation = resolveHostWithinTrustEpoch(
        {
          lease,
          origin: ORIGIN,
          hostId: HOST_ID,
          claimedHostPublicKey: HOST_KEY,
          claimedHostFingerprint: HOST_FINGERPRINT,
        },
        () => {
          entered = true;
          return gate.promise;
        },
      );
      await reached(operation, () => entered);
      registry.invalidate();
      gate.reject(new BrowserHostPinAbortError(durableMutation));
      await expect(operation).rejects.toMatchObject({
        recovery: durableMutation ? "resolver_binding_retained" : "none",
      });
    }
  });

  test("deletion distinguishes tombstone pre/post-commit and DELETE dispatch", async () => {
    const host = {
      id: HOST_ID,
      host_public_key: HOST_KEY,
      host_key_fingerprint: HOST_FINGERPRINT,
    } as Host;
    for (const durableMutation of [false, true]) {
      const registry = new BrowserTrustEpochCapabilityRegistry();
      const lease = leaseFor(registry);
      const gate = deferred<BrowserHostPin>();
      let entered = false;
      let deletes = 0;
      const dependencies: DeleteHostTrustDependencies = {
        tombstone: () => {
          entered = true;
          return gate.promise;
        },
        removeServer: async () => {
          deletes += 1;
        },
      };
      const operation = deleteHostWithinTrustEpoch(
        { lease, origin: ORIGIN, targetHostId: HOST_ID, host },
        dependencies,
      );
      await reached(operation, () => entered);
      registry.invalidate();
      gate.reject(new BrowserHostPinAbortError(durableMutation));
      await expect(operation).rejects.toMatchObject({
        recovery: durableMutation ? "local_tombstone_retained" : "none",
      });
      expect(deletes).toBe(0);
    }

    const registry = new BrowserTrustEpochCapabilityRegistry();
    const lease = leaseFor(registry);
    const deleteGate = deferred<void>();
    let deleteEntered = false;
    const operation = deleteHostWithinTrustEpoch(
      { lease, origin: ORIGIN, targetHostId: HOST_ID, host },
      {
        tombstone: async () => ({ ...activePin, state: "revoked", revokedAtMs: 2 }),
        removeServer: () => {
          deleteEntered = true;
          return deleteGate.promise;
        },
      },
    );
    await reached(operation, () => deleteEntered);
    registry.invalidate();
    deleteGate.reject(new DOMException("aborted", "AbortError"));
    await expect(operation).rejects.toMatchObject({ recovery: "delete_outcome_unknown" });
  });
});
