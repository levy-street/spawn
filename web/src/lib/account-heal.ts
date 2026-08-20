/**
 * Full-account heal off the root `R` (docs/TRUST_DEVICE_MESH.md §4, stage 5c).
 *
 * Runs at the two passkey moments — minting (passkey creation) and unlock — the
 * only times `sk_R` is legitimately in memory. It is a benign refresh, never an
 * admission: every device it touches already holds the account's trust; the
 * heal re-roots that trust directly at `R` so chains shrink to length 1 and
 * revoking any single device leaves every other device connected (P3′).
 *
 * Two kinds of statement are produced:
 *
 * 1. `R→d` account endorsements for live devices that lack one — signed with
 *    `sk_R`, giving each device a length-1 chain to the root anchor.
 * 2. Per-host endorsements OF the root device — signed by THIS device's own
 *    identity (which the host already pins), telling each host to pin `pk_R`
 *    as an anchor. This reuses the existing pin-adoption statement
 *    (`SPAWN-BROWSER-ENDORSE-V1`): the daemon verifies the signature against a
 *    key it already trusts, so the server relays but can never forge it (P2).
 *    Host public keys come from the sealed bundle, never from the server.
 *
 * The caller supplies `pk_R` from a FIRSTHAND source — the mint it just
 * performed or the bundle it just unsealed — never from the server's device
 * list. The server's `is_root` row is cross-checked against it and a mismatch
 * aborts loudly: a substituted root must never be endorsed or anchored.
 */

import {
  type AccountRoot,
  createRootEndorsementProof,
  createRootRegistrationProof,
} from "./account-root";
import { browserDevices, trust } from "./api";
import {
  type BrowserDeviceIdentity,
  createBrowserEndorsementProof,
} from "./browser-device-identity";
import type { TrustBundleHost } from "./trust-bundle";

export class AccountHealError extends Error {
  constructor(
    readonly code: "root_conflict" | "root_unregistered",
    message: string,
  ) {
    super(message);
    this.name = "AccountHealError";
  }
}

export interface AccountHealReport {
  readonly rootDeviceId: string;
  /** Devices that received a fresh `R→d` endorsement in this heal. */
  readonly endorsedDeviceIds: readonly string[];
  /** Host rows that accepted a root anchor-upgrade endorsement. */
  readonly hostsUpgraded: number;
  /** Host rows that refused one (e.g. this device is not pinned there). */
  readonly hostsSkipped: number;
}

interface DeviceRow {
  readonly id: string;
  readonly public_key: string;
  readonly revoked_at: string | null;
  readonly is_root: boolean;
}

interface EdgeRow {
  readonly endorser_device_id: string;
  readonly endorsed_device_id: string;
}

/** The pure planning half, separated so it is directly testable. */
export function planAccountHeal(
  rootPublicKeyWire: string,
  devices: readonly DeviceRow[],
  edges: readonly EdgeRow[],
): { rootDevice: DeviceRow | null; devicesToEndorse: DeviceRow[] } {
  const liveRoot = devices.find((d) => d.is_root && d.revoked_at === null) ?? null;
  if (liveRoot !== null && liveRoot.public_key !== rootPublicKeyWire) {
    throw new AccountHealError(
      "root_conflict",
      "the server's account root does not match the root sealed in your trust bundle",
    );
  }
  if (liveRoot === null) {
    return { rootDevice: null, devicesToEndorse: [] };
  }
  const alreadyEndorsed = new Set(
    edges
      .filter((edge) => edge.endorser_device_id === liveRoot.id)
      .map((edge) => edge.endorsed_device_id),
  );
  const devicesToEndorse = devices.filter(
    (d) => !d.is_root && d.revoked_at === null && !alreadyEndorsed.has(d.id),
  );
  return { rootDevice: liveRoot, devicesToEndorse };
}

/**
 * Register the root as this account's `is_root` browser device if it is not
 * registered yet. Idempotent by key: re-registering the same `pk_R` returns the
 * existing row. A DIFFERENT live root already present is a trust conflict —
 * surfaced, never papered over.
 */
export async function ensureRootRegistered(root: AccountRoot, accountId: string): Promise<void> {
  const devices = await browserDevices.list();
  const liveRoot = devices.find((d) => d.is_root && d.revoked_at === null);
  if (liveRoot !== undefined) {
    if (liveRoot.public_key !== root.publicKeyWire) {
      throw new AccountHealError(
        "root_conflict",
        "the server's account root does not match the root sealed in your trust bundle",
      );
    }
    return;
  }
  await browserDevices.register({
    key_algorithm: "ed25519",
    public_key: root.publicKeyWire,
    signature: await createRootRegistrationProof(root, accountId),
    label: "Account root",
    is_root: true,
  });
}

/**
 * Heal the whole account off `R`, then let `root` go out of scope — the caller
 * must not retain it. `identity` is this device's own signer for the per-host
 * anchor upgrades; hosts it is not pinned on simply refuse (counted, not fatal).
 */
export async function healAccount(
  root: AccountRoot,
  accountId: string,
  identity: BrowserDeviceIdentity,
  bundleHosts: readonly TrustBundleHost[],
): Promise<AccountHealReport> {
  const [devices, edges] = await Promise.all([browserDevices.list(), trust.accountEndorsements()]);
  const { rootDevice, devicesToEndorse } = planAccountHeal(root.publicKeyWire, devices, edges);
  if (rootDevice === null) {
    throw new AccountHealError(
      "root_unregistered",
      "the account root is not registered; run ensureRootRegistered first",
    );
  }

  const endorsedDeviceIds: string[] = [];
  for (const device of devicesToEndorse) {
    const signature = await createRootEndorsementProof(
      root,
      accountId,
      device.public_key,
      device.id,
    );
    await trust.createAccountEndorsement({
      endorser_device_id: rootDevice.id,
      endorsed_device_id: device.id,
      signature,
    });
    endorsedDeviceIds.push(device.id);
  }

  // Anchor upgrade: this device vouches for pk_R toward each host it is pinned
  // on. Idempotent server-side; a host that does not trust this device answers
  // 409 and is skipped — it gains the root at its own possess/heal moment.
  const currentDevice = devices.find(
    (d) => d.public_key === identity.publicKeyWire && d.revoked_at === null,
  );
  let hostsUpgraded = 0;
  let hostsSkipped = 0;
  for (const host of bundleHosts) {
    for (const hostId of host.hostIds) {
      if (currentDevice === undefined) {
        hostsSkipped += 1;
        continue;
      }
      try {
        const signature = await createBrowserEndorsementProof(
          identity,
          accountId,
          host.hostPublicKey,
          rootDevice.public_key,
          rootDevice.id,
        );
        await trust.endorse({
          host_id: hostId,
          endorser_device_id: currentDevice.id,
          endorsed_device_id: rootDevice.id,
          signature,
        });
        hostsUpgraded += 1;
      } catch {
        hostsSkipped += 1;
      }
    }
  }

  return { rootDeviceId: rootDevice.id, endorsedDeviceIds, hostsUpgraded, hostsSkipped };
}
