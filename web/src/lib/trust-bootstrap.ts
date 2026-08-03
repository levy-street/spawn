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
  loadBrowserHostPin,
  revokeBrowserHostPin,
} from "./browser-host-pins";
import type { TrustBundleHost } from "./trust-bundle";
import {
  enrollPasskeyInEnvelope,
  openTrustEnvelope,
  type PasskeyWrapInput,
  revokePasskeyFromEnvelope,
  sealTrustEnvelope,
} from "./trust-envelope";
import {
  enforceBundleFreshness,
  readHighestSeenRevision,
  recordSeenRevision,
  type TrustRevisionStorageOptions,
} from "./trust-revision";

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
  /** Hosts the bundle named that this device has locally revoked, left untouched. */
  readonly skippedRevoked: readonly string[];
}

/** The bundle rollback floor lives in the same origin-partitioned storage as pins. */
function revisionOptions(scope: TrustBootstrapScope): TrustRevisionStorageOptions {
  return { indexedDBFactory: scope.pinStorage?.indexedDBFactory };
}

function pinToBundleHost(pin: BrowserHostPin): TrustBundleHost {
  return {
    hostPublicKey: pin.hostPublicKey,
    hostFingerprint: pin.hostFingerprint,
    hostIds: pin.hostIds,
  };
}

/**
 * Seal every host this device has verified, at a revision strictly above both
 * this device's rollback floor and the server's current revision.
 *
 * The caller supplies the key; this module never touches the authenticator, so
 * the PRF secret's lifetime stays owned by the caller rather than being captured
 * here. The returned revision is the one bound into the ciphertext; the caller
 * must call `recordBundleRevision` only after the sealed bundle is durably
 * stored, so a failed write does not advance this device's floor past the
 * revision the server actually holds.
 */
export async function sealCurrentTrust(
  passkey: PasskeyWrapInput,
  scope: TrustBootstrapScope,
  serverRevision: number,
): Promise<{ readonly sealed: string; readonly hostCount: number; readonly revision: number }> {
  const origin = scope.origin ?? browserHostPinServerOrigin();
  const pins = await listActiveBrowserHostPins(
    { accountId: scope.accountId, origin },
    scope.pinStorage ?? {},
  );
  const hosts = pins.map(pinToBundleHost);
  const floor = await readHighestSeenRevision(scope.accountId, revisionOptions(scope));
  const revision = Math.max(floor, Number.isInteger(serverRevision) ? serverRevision : 0) + 1;
  return {
    sealed: await sealTrustEnvelope(scope.accountId, hosts, [passkey], revision),
    hostCount: hosts.length,
    revision,
  };
}

/** Advance this device's rollback floor after a sealed bundle is durably stored. */
export async function recordBundleRevision(
  scope: TrustBootstrapScope,
  revision: number,
): Promise<void> {
  await recordSeenRevision(scope.accountId, revision, revisionOptions(scope));
}

/**
 * Enroll a backup passkey into the current bundle, refusing to enroll into a
 * bundle older than one this device already trusted (which would let a server
 * launder a rolled-back envelope back to the current revision via the operator's
 * own write). Returns the new envelope wire for the caller to store.
 */
export async function enrollBackupPasskey(
  scope: TrustBootstrapScope,
  sealed: string,
  unlockWith: PasskeyWrapInput,
  newPasskey: PasskeyWrapInput,
): Promise<string> {
  const opened = await openTrustEnvelope(scope.accountId, sealed, unlockWith);
  await enforceBundleFreshness(scope.accountId, opened.revision, revisionOptions(scope));
  return enrollPasskeyInEnvelope(scope.accountId, sealed, unlockWith, newPasskey);
}

/**
 * Revoke one passkey and reseal the bundle for the surviving passkey under a
 * fresh data key and a higher revision.
 *
 * The revoked passkey loses access two ways: the fresh data key is never wrapped
 * for it, and the bumped revision drops every prior envelope (including the one
 * the server kept with the old wrap) below this device's rollback floor.
 *
 * `keep` must be a passkey that can currently unlock and should retain access.
 * This reseals for `keep` alone, so an account with more than two passkeys would
 * lose the others — a single device cannot gather every survivor's PRF secret.
 * The caller must restrict this to the single-survivor case.
 */
export async function revokeBackupPasskey(
  scope: TrustBootstrapScope,
  sealed: string,
  serverRevision: number,
  keep: PasskeyWrapInput,
  revokedCredentialId: string,
): Promise<{ readonly sealed: string; readonly revision: number }> {
  const opened = await openTrustEnvelope(scope.accountId, sealed, keep);
  // Refuse to revoke against a rolled-back bundle, and floor the opened revision.
  await enforceBundleFreshness(scope.accountId, opened.revision, revisionOptions(scope));
  const floor = await readHighestSeenRevision(scope.accountId, revisionOptions(scope));
  const revision =
    Math.max(floor, Number.isInteger(serverRevision) ? serverRevision : 0, opened.revision) + 1;
  const next = await revokePasskeyFromEnvelope(
    scope.accountId,
    sealed,
    [keep],
    revokedCredentialId,
    revision,
  );
  return { sealed: next, revision };
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
  passkey: PasskeyWrapInput,
  sealed: string,
  scope: TrustBootstrapScope,
): Promise<ImportedTrust> {
  const origin = scope.origin ?? browserHostPinServerOrigin();
  const pinStorage = scope.pinStorage ?? {};
  const bundle = await openTrustEnvelope(scope.accountId, sealed, passkey);
  // Rollback guard: refuse a bundle older than one already trusted here, then
  // raise the floor. A server replaying an old authentic bundle is stopped
  // before any pin is touched.
  await enforceBundleFreshness(scope.accountId, bundle.revision, revisionOptions(scope));

  const before = new Set(
    (await listActiveBrowserHostPins({ accountId: scope.accountId, origin }, pinStorage)).map(
      (pin) => pin.hostPublicKey,
    ),
  );

  const added: string[] = [];
  const alreadyTrusted: string[] = [];
  const skippedRevoked: string[] = [];
  for (const host of bundle.hosts) {
    if (before.has(host.hostPublicKey)) {
      alreadyTrusted.push(host.hostPublicKey);
      continue;
    }
    // Honour a local tombstone: importing must never silently resurrect a host
    // the operator revoked on this device. approveBrowserHostPin would otherwise
    // reactivate it, undoing a deliberate withdrawal.
    const existing = await loadBrowserHostPin(
      {
        accountId: scope.accountId,
        origin,
        hostPublicKey: host.hostPublicKey,
        hostFingerprint: host.hostFingerprint,
      },
      pinStorage,
    );
    if (existing?.state === "revoked") {
      skippedRevoked.push(host.hostPublicKey);
      continue;
    }
    await approveBrowserHostPin(
      {
        accountId: scope.accountId,
        origin,
        hostPublicKey: host.hostPublicKey,
        hostFingerprint: host.hostFingerprint,
        // Carry the bundle's Host IDs so the signed-RTC downgrade check can
        // recognise this host by ID right away. Without them an imported pin is
        // invisible to that check until a first successful signed resolve, and a
        // server can hold the device on the raw path by never presenting the key.
        hostIds: host.hostIds,
      },
      pinStorage,
    );
    added.push(host.hostPublicKey);
  }
  return { added, alreadyTrusted, skippedRevoked };
}

/**
 * Drop every host pin this device holds, returning it to the unpinned path.
 *
 * The recovery when a device holds pins the daemon will not accept: it signs
 * offers that are refused, which presents as a connection that simply never
 * establishes. Unpinned it connects again -- unprotected, but working -- and
 * can be re-endorsed afterwards. Without this the only remedy is clearing site
 * data through browser settings, which also destroys the device identity and so
 * invalidates any endorsement already granted to it.
 */
export async function forgetTrustOnThisDevice(
  scope: TrustBootstrapScope,
): Promise<{ readonly forgotten: number }> {
  const origin = scope.origin ?? browserHostPinServerOrigin();
  const pins = await listActiveBrowserHostPins(
    { accountId: scope.accountId, origin },
    scope.pinStorage ?? {},
  );
  let forgotten = 0;
  for (const pin of pins) {
    for (const hostId of pin.hostIds) {
      await revokeBrowserHostPin(
        {
          accountId: scope.accountId,
          origin,
          targetHostId: hostId,
          claimedHostId: hostId,
          claimedHostPublicKey: pin.hostPublicKey,
          claimedHostFingerprint: pin.hostFingerprint,
        },
        scope.pinStorage ?? {},
      );
      forgotten += 1;
      break;
    }
  }
  return { forgotten };
}
