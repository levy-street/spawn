import { auth, type DeviceApproval, type DevicePendingApproval, type Host, hosts } from "./api";
import {
  type BrowserDeviceIdentity,
  createHostPairApprovalProof,
  loadBrowserDeviceIdentity,
  scopeBrowserDeviceIdentityToTrustEpoch,
} from "./browser-device-identity";
import {
  type ApproveBrowserHostPinInput,
  approveBrowserHostPin,
  type BrowserHostPin,
  BrowserHostPinAbortError,
  type ResolveBrowserHostPinInput,
  type RevokeBrowserHostPinInput,
  resolveActiveBrowserHostPinMaterial,
  revokeBrowserHostPin,
} from "./browser-host-pins";
import type { BrowserTrustEpochLease } from "./browser-trust-capabilities";
import { ed25519PublicKeyFingerprint } from "./signed-signal";

export type BrowserTrustOperationRecovery =
  | "none"
  | "local_pin_retained"
  | "approval_outcome_unknown"
  | "resolver_binding_retained"
  | "local_tombstone_retained"
  | "delete_outcome_unknown";

export class BrowserTrustOperationError extends Error {
  constructor(
    message: string,
    readonly recovery: BrowserTrustOperationRecovery,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "BrowserTrustOperationError";
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEpochAbort(error: unknown, lease: BrowserTrustEpochLease): boolean {
  return lease.signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function assertRegistration(
  lease: BrowserTrustEpochLease,
  registration: ApprovalBrowserRegistration,
): void {
  lease.assertActive();
  if (
    registration.deviceId !== lease.browserDeviceId ||
    registration.publicKey !== lease.browserPublicKey
  ) {
    throw new DOMException(
      "Browser registration no longer matches the trust epoch",
      "InvalidStateError",
    );
  }
}

export interface ApprovalBrowserRegistration {
  readonly deviceId: string;
  readonly keyAlgorithm: "ed25519";
  readonly publicKey: string;
  readonly fingerprint: string;
}

export interface ApproveDeviceWithinTrustEpochInput {
  readonly lease: BrowserTrustEpochLease;
  readonly userCode: string;
  readonly pending: DevicePendingApproval;
  readonly registration: ApprovalBrowserRegistration;
  readonly origin: string;
}

export interface ApprovalTrustDependencies {
  loadIdentity(accountId: string, signal: AbortSignal): Promise<BrowserDeviceIdentity | null>;
  scopeIdentity(
    identity: BrowserDeviceIdentity,
    accountId: string,
    expectedPublicKey: string,
    signal: AbortSignal,
  ): BrowserDeviceIdentity;
  fingerprint(publicKey: string): Promise<string>;
  persistPin(input: ApproveBrowserHostPinInput, signal: AbortSignal): Promise<BrowserHostPin>;
  signApproval(
    identity: BrowserDeviceIdentity,
    accountId: string,
    approvalNonce: string,
    hostPublicKey: string,
    signal: AbortSignal,
  ): Promise<string>;
  approveServer(
    body: Parameters<typeof auth.approveDevice>[0],
    signal: AbortSignal,
  ): Promise<DeviceApproval>;
}

const approvalDependencies: ApprovalTrustDependencies = {
  loadIdentity: (accountId, signal) => loadBrowserDeviceIdentity(accountId, { signal }),
  scopeIdentity: scopeBrowserDeviceIdentityToTrustEpoch,
  fingerprint: ed25519PublicKeyFingerprint,
  persistPin: (input, signal) => approveBrowserHostPin(input, { signal }),
  signApproval: createHostPairApprovalProof,
  approveServer: (body, signal) => auth.approveDevice(body, signal),
};

/** Approval is linearized around the local pin commit and server dispatch. */
export async function approveDeviceWithinTrustEpoch(
  input: ApproveDeviceWithinTrustEpochInput,
  dependencies: ApprovalTrustDependencies = approvalDependencies,
): Promise<DeviceApproval> {
  const { lease, pending, registration } = input;
  assertRegistration(lease, registration);
  let localPinRetained = false;
  let approvalDispatched = false;
  try {
    lease.assertActive();
    const rawIdentity = await dependencies.loadIdentity(lease.accountOwnerUserId, lease.signal);
    lease.assertActive();
    if (rawIdentity === null) {
      throw new Error("Local browser identity changed; refresh and review the daemon again");
    }
    const identity = dependencies.scopeIdentity(
      rawIdentity,
      lease.accountOwnerUserId,
      lease.browserPublicKey,
      lease.signal,
    );

    lease.assertActive();
    const expectedFingerprint = await dependencies.fingerprint(pending.host_public_key);
    lease.assertActive();
    if (pending.host_key_fingerprint !== expectedFingerprint) {
      throw new Error("Daemon fingerprint changed after review; approval was blocked");
    }

    lease.assertActive();
    try {
      await dependencies.persistPin(
        {
          accountId: lease.accountOwnerUserId,
          origin: input.origin,
          hostPublicKey: pending.host_public_key,
          hostFingerprint: expectedFingerprint,
        },
        lease.signal,
      );
      localPinRetained = true;
    } catch (error) {
      if (error instanceof BrowserHostPinAbortError && error.durableMutation) {
        localPinRetained = true;
      }
      throw error;
    }
    lease.assertActive();

    // The scoped signer checks the epoch before and after its non-abortable
    // WebCrypto await, so a stale closure never returns a usable signature.
    lease.assertActive();
    const signature = await dependencies.signApproval(
      identity,
      lease.accountOwnerUserId,
      pending.approval_nonce,
      pending.host_public_key,
      lease.signal,
    );
    lease.assertActive();

    assertRegistration(lease, registration);
    approvalDispatched = true;
    const response = await dependencies.approveServer(
      {
        user_code: input.userCode,
        approval_nonce: pending.approval_nonce,
        host_key_algorithm: pending.host_key_algorithm,
        host_public_key: pending.host_public_key,
        host_key_fingerprint: pending.host_key_fingerprint,
        browser_device_id: registration.deviceId,
        browser_key_algorithm: registration.keyAlgorithm,
        browser_public_key: registration.publicKey,
        browser_key_fingerprint: registration.fingerprint,
        signature,
      },
      lease.signal,
    );
    lease.assertActive();
    if (
      response.host_name !== pending.host_name ||
      response.approval_nonce !== pending.approval_nonce ||
      response.host_key_algorithm !== pending.host_key_algorithm ||
      response.host_public_key !== pending.host_public_key ||
      response.host_key_fingerprint !== pending.host_key_fingerprint ||
      response.browser_device_id !== registration.deviceId ||
      response.browser_key_algorithm !== registration.keyAlgorithm ||
      response.browser_public_key !== registration.publicKey ||
      response.browser_key_fingerprint !== registration.fingerprint
    ) {
      throw new Error("Approval response changed the reviewed host or browser identity");
    }
    return response;
  } catch (error) {
    if (approvalDispatched) {
      throw new BrowserTrustOperationError(
        `Server approval was dispatched and its final outcome must be reconciled: ${messageFor(error)}`,
        "approval_outcome_unknown",
        { cause: error },
      );
    }
    if (localPinRetained) {
      throw new BrowserTrustOperationError(
        `The exact local host pin remains durable, but server approval was not dispatched: ${messageFor(error)}`,
        "local_pin_retained",
        { cause: error },
      );
    }
    throw new BrowserTrustOperationError(
      isEpochAbort(error, lease)
        ? "Browser trust ended before any local pin mutation or approval call"
        : messageFor(error),
      "none",
      { cause: error },
    );
  }
}

export interface ResolveHostWithinTrustEpochInput {
  readonly lease: BrowserTrustEpochLease;
  readonly origin: string;
  readonly hostId: string;
  readonly claimedHostPublicKey: string | null;
  readonly claimedHostFingerprint: string | null;
}

export async function resolveHostWithinTrustEpoch(
  input: ResolveHostWithinTrustEpochInput,
  dependency: (
    pinInput: ResolveBrowserHostPinInput,
    signal: AbortSignal,
  ) => Promise<BrowserHostPin> = (pinInput, signal) =>
    resolveActiveBrowserHostPinMaterial(pinInput, { signal }),
): Promise<BrowserHostPin> {
  const { lease } = input;
  let bindingRetained = false;
  try {
    lease.assertActive();
    let pin: BrowserHostPin;
    try {
      pin = await dependency(
        {
          accountId: lease.accountOwnerUserId,
          origin: input.origin,
          hostId: input.hostId,
          claimedHostPublicKey: input.claimedHostPublicKey,
          claimedHostFingerprint: input.claimedHostFingerprint,
        },
        lease.signal,
      );
      bindingRetained = pin.hostIds.includes(input.hostId);
    } catch (error) {
      if (error instanceof BrowserHostPinAbortError && error.durableMutation) {
        bindingRetained = true;
      }
      throw error;
    }
    lease.assertActive();
    return pin;
  } catch (error) {
    throw new BrowserTrustOperationError(
      bindingRetained
        ? `The local Host-ID binding remains durable, but the trust epoch ended: ${messageFor(error)}`
        : messageFor(error),
      bindingRetained ? "resolver_binding_retained" : "none",
      { cause: error },
    );
  }
}

export interface DeleteHostWithinTrustEpochInput {
  readonly lease: BrowserTrustEpochLease;
  readonly origin: string;
  readonly targetHostId: string;
  readonly host: Host;
}

export interface DeleteHostTrustDependencies {
  tombstone(input: RevokeBrowserHostPinInput, signal: AbortSignal): Promise<BrowserHostPin>;
  removeServer(hostId: string, signal: AbortSignal): Promise<void>;
}

const deletionDependencies: DeleteHostTrustDependencies = {
  tombstone: (input, signal) => revokeBrowserHostPin(input, { signal }),
  removeServer: (hostId, signal) => hosts.remove(hostId, signal),
};

/** Deletion never binds trust; it requires the resolver's pre-existing exact binding. */
export async function deleteHostWithinTrustEpoch(
  input: DeleteHostWithinTrustEpochInput,
  dependencies: DeleteHostTrustDependencies = deletionDependencies,
): Promise<void> {
  const { lease, host, targetHostId } = input;
  let tombstoneRetained = false;
  let deleteDispatched = false;
  try {
    lease.assertActive();
    if (host.id !== targetHostId) {
      throw new Error("Host API response ID does not exactly match the route and DELETE target");
    }
    try {
      await dependencies.tombstone(
        {
          accountId: lease.accountOwnerUserId,
          origin: input.origin,
          targetHostId,
          claimedHostId: host.id,
          claimedHostPublicKey: host.host_public_key ?? null,
          claimedHostFingerprint: host.host_key_fingerprint ?? null,
        },
        lease.signal,
      );
      tombstoneRetained = true;
    } catch (error) {
      if (error instanceof BrowserHostPinAbortError && error.durableMutation) {
        tombstoneRetained = true;
      }
      throw error;
    }
    lease.assertActive();

    deleteDispatched = true;
    await dependencies.removeServer(targetHostId, lease.signal);
    lease.assertActive();
  } catch (error) {
    if (deleteDispatched) {
      throw new BrowserTrustOperationError(
        `Server DELETE was dispatched and its final outcome must be reconciled; the local tombstone remains: ${messageFor(error)}`,
        "delete_outcome_unknown",
        { cause: error },
      );
    }
    if (tombstoneRetained) {
      throw new BrowserTrustOperationError(
        `The local host tombstone remains durable, but server DELETE was not dispatched: ${messageFor(error)}`,
        "local_tombstone_retained",
        { cause: error },
      );
    }
    throw new BrowserTrustOperationError(
      isEpochAbort(error, lease)
        ? "Browser trust ended before any local tombstone mutation or server DELETE"
        : messageFor(error),
      "none",
      { cause: error },
    );
  }
}
