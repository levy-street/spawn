/**
 * Bootstrapping a device's trust from the operator's sealed bundle.
 *
 * This is the join between the two halves: the pin store the signed-RTC gate
 * reads, and the bundle a passkey unlocks. Sealing publishes what this device
 * has verified; importing gives a new device the same knowledge without a
 * terminal ceremony and without trusting the server.
 *
 * See docs/TRUST.md "how a new device bootstraps trust".
 */

import {
  approveBrowserHostPin,
  type BrowserHostPin,
  type BrowserHostPinStorageOptions,
  browserHostPinServerOrigin,
  listActiveBrowserHostPins,
} from "./browser-host-pins";
import { openTrustBundle, sealTrustBundle, type TrustBundleHost } from "./trust-bundle";

export interface TrustBootstrapScope {
  readonly accountId: string;
  /** Defaults to the current origin; pins are origin-scoped. */
  readonly origin?: string;
  readonly pinStorage?: BrowserHostPinStorageOptions;
}

export interface ImportedTrust {
  /** Hosts newly pinned on this device by the import. */
  readonly added: readonly string[];
  /** Hosts the bundle named that this device already trusted. */
  readonly alreadyTrusted: readonly string[];
}

function pinToBundleHost(pin: BrowserHostPin): TrustBundleHost {
  return {
    hostPublicKey: pin.hostPublicKey,
    hostFingerprint: pin.hostFingerprint,
    hostIds: pin.hostIds,
  };
}

/**
 * Seal every host this device has verified.
 *
 * The caller supplies the key; this module never touches the authenticator, so
 * the PRF secret's lifetime stays owned by the caller rather than being
 * captured here.
 */
export async function sealCurrentTrust(
  key: CryptoKey,
  scope: TrustBootstrapScope,
): Promise<{ readonly sealed: string; readonly hostCount: number }> {
  const origin = scope.origin ?? browserHostPinServerOrigin();
  const pins = await listActiveBrowserHostPins(
    { accountId: scope.accountId, origin },
    scope.pinStorage ?? {},
  );
  const hosts = pins.map(pinToBundleHost);
  return {
    sealed: await sealTrustBundle(key, scope.accountId, hosts),
    hostCount: hosts.length,
  };
}

/**
 * Open a sealed bundle and pin every host it names.
 *
 * Safe to do without asking the operator to re-verify each fingerprint: the
 * bundle is authenticated under a key only their authenticator can produce, so
 * a host key in it is one they already verified out of band on another device.
 * A server that substitutes a key cannot produce a bundle that opens.
 *
 * Idempotent — approveBrowserHostPin returns an existing active pin unchanged,
 * so re-importing neither duplicates nor resurrects anything.
 */
export async function importTrustBundle(
  key: CryptoKey,
  sealed: string,
  scope: TrustBootstrapScope,
): Promise<ImportedTrust> {
  const origin = scope.origin ?? browserHostPinServerOrigin();
  const bundle = await openTrustBundle(key, scope.accountId, sealed);

  const before = new Set(
    (
      await listActiveBrowserHostPins(
        { accountId: scope.accountId, origin },
        scope.pinStorage ?? {},
      )
    ).map((pin) => pin.hostPublicKey),
  );

  const added: string[] = [];
  const alreadyTrusted: string[] = [];
  for (const host of bundle.hosts) {
    if (before.has(host.hostPublicKey)) {
      alreadyTrusted.push(host.hostPublicKey);
      continue;
    }
    await approveBrowserHostPin(
      {
        accountId: scope.accountId,
        origin,
        hostPublicKey: host.hostPublicKey,
        hostFingerprint: host.hostFingerprint,
      },
      scope.pinStorage ?? {},
    );
    added.push(host.hostPublicKey);
  }
  return { added, alreadyTrusted };
}
