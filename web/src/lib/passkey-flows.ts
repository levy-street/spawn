/**
 * The passkey lifecycle flows — set up, unlock, backup enrollment, revocation,
 * final-passkey removal — as plain async functions over an injected IO seam.
 *
 * Extracted from the usePasskeyTrust hook (where the bodies lived verbatim) so
 * the ORDERING and INTERLEAVING guarantees are unit-testable: a partial setup
 * must be retryable and never deadlock (P-C5), a ghost credential must never
 * be offered at unlock and must be removable, the final removal must not
 * abandon an unreadable bundle without an explicit acknowledgement (P-C6), and
 * the bundle delete must lose a CAS race loudly instead of stranding another
 * device's enrollment. The hook builds `PasskeyFlowsIo` from the real API
 * client, WebAuthn, and heal machinery; tests substitute fakes for exactly
 * those while the envelope/pin/revision logic underneath stays real.
 */

import {
  AccountHealError,
  type AccountHealReport,
  assessSealedRootRevocation,
  selectSealedRootRowForRevocation,
} from "./account-heal";
import {
  type AccountRoot,
  exportAccountRootMaterial,
  generateAccountRoot,
  importAccountRoot,
} from "./account-root";
import { ApiError } from "./api";
import {
  type BrowserHostPin,
  browserHostPinServerOrigin,
  listActiveBrowserHostPins,
} from "./browser-host-pins";
import { PasskeyPrfError, type TrustPasskey, type TrustPrfResult } from "./passkey-prf";
import {
  enrollBackupPasskey,
  type ImportedTrust,
  importTrustBundle,
  recordBundleRevision,
  resealBundleWithLocalPins,
  retrofitAccountRoot,
  revokeBackupPasskey,
  sealCurrentTrust,
  type TrustBootstrapScope,
} from "./trust-bootstrap";
import { TrustBundleError, type TrustBundleHost } from "./trust-bundle";
import { envelopeWrapCredentialIds, openTrustEnvelope } from "./trust-envelope";
import { enforceBundleFreshness, TrustRevisionError } from "./trust-revision";

// ---------------------------------------------------------------------------
// IO seam
// ---------------------------------------------------------------------------

export interface StoredBundleRow {
  readonly sealed: string;
  readonly revision: number;
}

export interface PasskeyRow {
  readonly id: string;
  readonly credential_id: string;
}

export interface DeviceRosterRow {
  readonly id: string;
  readonly public_key: string;
  readonly revoked_at: string | null;
  readonly is_root: boolean;
}

export interface HealOutcome {
  readonly report: AccountHealReport | null;
  /** Human-readable reason the heal could not run (or run fully). */
  readonly failure: string | null;
}

export interface PasskeyFlowsIo {
  readonly scope: TrustBootstrapScope;
  /** The operator label a new authenticator credential is created under. */
  readonly userLabel: string;
  readonly trust: {
    getBundle(): Promise<StoredBundleRow | null>;
    putBundle(sealed: string, expectedRevision?: number): Promise<unknown>;
    deleteBundle(expectedRevision: number): Promise<unknown>;
    listPasskeys(): Promise<readonly PasskeyRow[]>;
    addPasskey(credentialId: string, label?: string): Promise<unknown>;
    removePasskey(id: string): Promise<unknown>;
  };
  readonly browserDevices: {
    list(): Promise<readonly DeviceRosterRow[]>;
    revoke(deviceId: string, expectedPublicKey: string): Promise<unknown>;
    revokedKeys(): Promise<readonly { readonly public_key: string }[]>;
  };
  readonly createTrustPasskey: (accountId: string, userName: string) => Promise<TrustPasskey>;
  readonly evaluateTrustPrf: (
    accountId: string,
    credentialIds: readonly string[],
  ) => Promise<TrustPrfResult>;
  /** Best-effort heal off a root legitimately in memory (mint/unlock only). */
  readonly heal: (
    root: AccountRoot,
    hosts: readonly TrustBundleHost[],
    source: "mint" | "bundle",
  ) => Promise<HealOutcome>;
}

function revisionOptions(scope: TrustBootstrapScope) {
  return { indexedDBFactory: scope.pinStorage?.indexedDBFactory };
}

async function activeLocalPins(scope: TrustBootstrapScope): Promise<BrowserHostPin[]> {
  const origin = scope.origin ?? browserHostPinServerOrigin();
  return listActiveBrowserHostPins({ accountId: scope.accountId, origin }, scope.pinStorage ?? {});
}

function pinHosts(pins: readonly BrowserHostPin[]): TrustBundleHost[] {
  return pins.map((pin) => ({
    hostPublicKey: pin.hostPublicKey,
    hostFingerprint: pin.hostFingerprint,
    hostIds: pin.hostIds,
  }));
}

export const CONCURRENT_UPDATE_WARNING =
  "Another device updated your passkey's protection at the same time; nothing was " +
  "changed here. Use your passkey again to finish on this device.";

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Store a bundle with CAS, distinguishing the one benign failure. A 409 means
 * another device updated the bundle concurrently — the caller says so and
 * re-fetches rather than retrying blind. Anything else is a real failure and
 * propagates (P-C3: no more swallowed putBundle errors).
 */
async function putBundleGuarded(
  io: PasskeyFlowsIo,
  sealed: string,
  expectedRevision: number,
): Promise<"stored" | "lost_cas"> {
  try {
    await io.trust.putBundle(sealed, expectedRevision);
    return "stored";
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return "lost_cas";
    throw error;
  }
}

/**
 * Revoke a device (a keyless account root, in practice) with a few retries.
 * The caller invokes this only once the gate that could mint a rival is already
 * shut, so retrying is safe and converges; a total failure is surfaced.
 */
async function revokeWithRetries(
  io: PasskeyFlowsIo,
  deviceId: string,
  expectedPublicKey: string,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await io.browserDevices.revoke(deviceId, expectedPublicKey);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Set up (fix P-C5, first half: seal before enroll)
// ---------------------------------------------------------------------------

export interface SetUpOutcome {
  readonly hostCount: number;
  readonly heal: HealOutcome;
}

/**
 * Create a passkey, then seal this device's verified hosts under it. Creation
 * and sealing are one action deliberately: a passkey with no bundle behind it
 * looks like protection while providing none.
 *
 * ORDER IS THE FIX (review P-C5): authenticator create → PRF evaluate → seal →
 * putBundle (create-only CAS) → only then the server credential row. The old
 * order registered the row FIRST, so a failure on the second authenticator
 * gesture (Safari's user-activation window expiring is routine) or at
 * putBundle left a GHOST credential: server-listed, offered at every unlock,
 * opening nothing. Now a failure before putBundle leaves only an
 * authenticator-side orphan — inert, since unlock's allowCredentials come from
 * the server list intersected with the envelope's wraps — and a failure AFTER
 * putBundle leaves a stored bundle whose credential the server does not list,
 * which the unlock flow detects and repairs (it falls back to offering the
 * envelope's own wraps and re-registers the credential after a verified open).
 * Neither state deadlocks a retry.
 */
export async function setUpPasskey(io: PasskeyFlowsIo): Promise<SetUpOutcome> {
  const id = io.scope.accountId;
  // A bundle is sealed under one passkey's secret, so a second, unrelated
  // passkey cannot open it. Sealing this device's pins over an existing
  // bundle would lose the operator's other host keys AND lock every enrolled
  // passkey out of the old bundle at once. Enrolling another key or device
  // uses the key-wrapping ceremony ("Add a backup passkey" / "Use passkey"),
  // never this path — so refuse outright when a bundle already exists.
  const existing = await io.trust.getBundle();
  if (existing !== null) {
    throw new Error(
      "This account already has a passkey-protected setup. Use “Use passkey” to bring it to " +
        "this device, or add a backup passkey — setting up again here would overwrite it.",
    );
  }

  // A live account root here is necessarily KEYLESS (we returned above if any
  // bundle existed, so no passkey owns it — the host-gossip backfill established
  // it, or an earlier setup's bundle is gone). It is adopted by revoking it, but
  // NOT here: revoking before a bundle is stored would leave a window with
  // neither a live root nor a bundle, in which the passkey-free establishment
  // gate on another open device would mint a RIVAL root and make this setup's
  // heal conflict permanently. Keeping it live through the gesture holds that
  // gate shut ("no-live-root" is false); it is revoked below, once `putBundle`
  // has closed the gate for good (`bundleAbsent` is false the moment a bundle
  // exists). See the revoke just before the heal.
  const passkey = await io.createTrustPasskey(id, io.userLabel);
  if (!passkey.prfEnabled) {
    throw new PasskeyPrfError(
      "prf_unavailable",
      "this authenticator reported no PRF support, so it cannot protect your devices",
    );
  }

  // Mint the account root with the passkey (mesh stage 5c): its seed is
  // sealed into this bundle, so any passkey unlock can heal the account.
  const root = await generateAccountRoot();

  const { secret } = await io.evaluateTrustPrf(id, [passkey.credentialId]);
  const { sealed, hostCount, revision } = await sealCurrentTrust(
    { credentialId: passkey.credentialId, prfSecret: secret },
    io.scope,
    0,
    await exportAccountRootMaterial(root),
  );
  try {
    await io.trust.putBundle(sealed, undefined);
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      throw new Error(
        "Another device finished setting up a passkey at the same time. Use “Use passkey” " +
          "to bring that setup to this device instead.",
      );
    }
    throw error;
  }
  // Advance the rollback floor only after the bundle is durably stored, and
  // register the credential only after its wrap is (seal-before-enroll).
  await recordBundleRevision(io.scope, revision);
  await io.trust.addPasskey(passkey.credentialId, "this device");

  // Now that a bundle durably exists — the create-only `putBundle` closed the
  // passkey-free establishment gate for every device (`bundleAbsent` is false) —
  // adopt the account under `root`. Any live account root is necessarily KEYLESS
  // (no passkey owns it; this is the account's only bundle and it seals `root`),
  // so it is revoked to free the one live-root slot. A rival keyless root can
  // still have been minted by another device in the tiny window BEFORE our
  // `putBundle` committed and registered just after our scan; the register/heal
  // then conflicts. Since no NEW rival can begin once the bundle exists, one
  // extra revoke-and-retry round drains any straggler. Register + heal only run
  // after the sealed seed is durably stored — a root the bundle cannot recover
  // must never become an endorser or anchor.
  const pins = await activeLocalPins(io.scope);
  for (let round = 0; ; round++) {
    const priorRoot = (await io.browserDevices.list()).find(
      (d) => d.is_root && d.revoked_at === null && d.public_key !== root.publicKeyWire,
    );
    if (priorRoot !== undefined) {
      await revokeWithRetries(io, priorRoot.id, priorRoot.public_key);
    }
    try {
      const heal = await io.heal(root, pinHosts(pins), "mint");
      return { hostCount, heal };
    } catch (error) {
      // A `root_conflict` means a rival root slipped in between the scan and the
      // register; revoke it on the next round and retry. Anything else, or a
      // second conflict (which would mean a NEW rival after the bundle exists —
      // impossible), propagates.
      const conflict = error instanceof AccountHealError && error.code === "root_conflict";
      if (!conflict || round >= 1) throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Unlock (fix P-C5, second half: honest credential offer + enrollment repair)
// ---------------------------------------------------------------------------

/**
 * Which credentials an unlock may offer: the server's enrolled list
 * intersected with the envelope's wrap ids, so a GHOST (a server-listed
 * credential holding no wrap) is never offered — its gesture opens nothing.
 *
 * When the intersection is EMPTY but the envelope holds wraps, the wraps
 * themselves are offered and `repairNeeded` is set: this is the half-finished
 * setup state (bundle stored, `addPasskey` never ran), and the wrapped
 * credential is the only thing that can open the account. Offering
 * unauthenticated wrap metadata is safe — allowCredentials only selects among
 * credentials THIS authenticator actually holds for this origin, so a foreign
 * id in a tampered envelope matches nothing, and the server already controls
 * the enrolled list it could otherwise steer. The caller re-registers the
 * credential after the open verifies.
 */
export function unlockCredentialOffer(
  serverListed: readonly string[],
  envelopeWrapIds: readonly string[],
): { readonly offer: readonly string[]; readonly repairNeeded: boolean } {
  const wraps = new Set(envelopeWrapIds);
  const offer = serverListed.filter((credentialId) => wraps.has(credentialId));
  if (offer.length > 0) return { offer, repairNeeded: false };
  if (envelopeWrapIds.length === 0) {
    throw new Error(
      "Your saved protection names no passkey that could open it. It cannot be used from here.",
    );
  }
  return { offer: [...wraps], repairNeeded: true };
}

export interface UnlockOutcome {
  readonly imported: ImportedTrust;
  readonly heal: HealOutcome;
  readonly warning: string | null;
  readonly resealFailure: string | null;
  /** The opened credential was missing from the server's enrolled list (a
   * half-finished setup) and was re-registered after the verified open. */
  readonly enrollmentRepaired: boolean;
  /** The re-registration was needed but failed — said, not swallowed. */
  readonly repairFailure: string | null;
}

/**
 * The one passkey verb a device ever needs: prove the passkey, inherit the
 * account's trusted hosts, and let the sealed root approve this device and
 * re-protect hosts (mesh stage 5c heal; rotation if the sealed root was
 * revoked).
 */
export async function unlockPasskey(io: PasskeyFlowsIo): Promise<UnlockOutcome> {
  const id = io.scope.accountId;
  const stored = await io.trust.getBundle();
  if (stored === null) {
    throw new Error("This account has no passkey yet. Add one on a device that works.");
  }
  const listed = (await io.trust.listPasskeys()).map((row) => row.credential_id);
  const { offer, repairNeeded } = unlockCredentialOffer(
    listed,
    envelopeWrapCredentialIds(id, stored.sealed),
  );
  const { credentialId, secret } = await io.evaluateTrustPrf(id, offer);
  const passkeyInput = { credentialId, prfSecret: secret };
  const imported = await importTrustBundle(passkeyInput, stored.sealed, io.scope);

  // ENROLLMENT REPAIR (P-C5): the bundle just authenticated (and passed the
  // rollback floor) under a credential the server does not list — the
  // half-finished setup. Re-registering is idempotent server-side; a failure
  // is reported, never swallowed, but does not undo the import above.
  let enrollmentRepaired = false;
  let repairFailure: string | null = null;
  if (repairNeeded || !listed.includes(credentialId)) {
    try {
      await io.trust.addPasskey(credentialId, "this device");
      enrollmentRepaired = true;
    } catch (cause) {
      repairFailure = describeCause(cause);
    }
  }

  // The heal moment (mesh stage 5c): the unlock proved the passkey, so the
  // sealed root is legitimately in memory. Re-root every device off R and
  // upgrade hosts to anchor on it, then let the key go out of scope.
  let heal: HealOutcome = { report: null, failure: null };
  let warning: string | null = null;
  // The latest durably-stored envelope, for the pin-merge reseal below.
  let latest = { sealed: stored.sealed, revision: stored.revision };
  if (imported.root !== null) {
    // Root ROTATION (compromise response): if the sealed root's key was
    // revoked, mint a successor over it and heal off that instead. The old
    // key stays dead — revocation is a permanent tombstone (R10) — and the
    // deny-list has already severed everything anchored on it.
    //
    // The trigger is CORROBORATED, never a bare roster claim (hardening
    // B2): rotation retires the sealed root, so the revoked_at-bearing row
    // must carry the sealed root's exact key AND the key must appear in
    // the account's permanent add-only tombstone table. A server that
    // wants to fake this has to commit the lie into irreversible
    // deny-list state — and even then, rotation now retires the old seed
    // into the bundle instead of destroying it.
    const deviceRows = await io.browserDevices.list();
    const sealedPk = imported.root.publicKeyWire;
    let tombstonedKeys: string[] = [];
    try {
      tombstonedKeys = (await io.browserDevices.revokedKeys()).map((row) => row.public_key);
    } catch {
      // Unfetchable tombstones corroborate nothing: with an empty list a
      // roster claim assesses as uncorroborated and rotation is skipped —
      // a denial of service, which the server can always inflict anyway.
    }
    const verdict = assessSealedRootRevocation(sealedPk, deviceRows, tombstonedKeys);
    const liveRoot = deviceRows.find((d) => d.is_root && d.revoked_at === null);
    if (verdict === "revoked" && liveRoot === undefined) {
      const successor = await generateAccountRoot();
      const rotated = await retrofitAccountRoot(
        io.scope,
        stored.sealed,
        passkeyInput,
        stored.revision,
        await exportAccountRootMaterial(successor),
        true,
      );
      if (rotated !== null) {
        // A CAS loss is said out loud and the winner's state re-fetched
        // (the caller invalidates); any OTHER storage failure propagates
        // instead of being swallowed into a cheerful success (P-C3).
        if ((await putBundleGuarded(io, rotated.sealed, stored.revision)) === "lost_cas") {
          warning = CONCURRENT_UPDATE_WARNING;
        } else {
          await recordBundleRevision(io.scope, rotated.revision);
          latest = { sealed: rotated.sealed, revision: rotated.revision };
          heal = await io.heal(successor, imported.hosts, "bundle");
        }
      }
    } else {
      if (verdict === "uncorroborated") {
        warning =
          "The server claims your account root was revoked, but its permanent " +
          "revocation record does not corroborate that. Nothing was rotated or " +
          "destroyed; if you really revoked it, retry once the record is consistent.";
      }
      heal = await io.heal(await importAccountRoot(imported.root), imported.hosts, "bundle");
    }
  } else {
    // Pre-root bundle: retrofit a freshly minted root under the same data
    // key (every enrolled passkey keeps working), store it durably, and
    // only then let the root endorse and anchor. A concurrent unlock loses
    // the server's revision CAS — said out loud, and the winner's root
    // heals; a real storage failure propagates (P-C3).
    const root = await generateAccountRoot();
    const retro = await retrofitAccountRoot(
      io.scope,
      stored.sealed,
      passkeyInput,
      stored.revision,
      await exportAccountRootMaterial(root),
    );
    if (retro !== null) {
      if ((await putBundleGuarded(io, retro.sealed, stored.revision)) === "lost_cas") {
        warning = CONCURRENT_UPDATE_WARNING;
      } else {
        await recordBundleRevision(io.scope, retro.revision);
        latest = { sealed: retro.sealed, revision: retro.revision };
        heal = await io.heal(root, imported.hosts, "bundle");
      }
    }
  }

  // RESEAL-ON-UNLOCK (P-C1a): merge this device's active local pins into
  // the bundle so the fleet the passkey protects tracks the fleet that
  // exists. The unlock already holds the data key — no extra gesture. A
  // CAS loser just skips (another device's merge won; the next unlock
  // retries); a real failure is reported, not swallowed.
  let resealFailure: string | null = null;
  try {
    const reseal = await resealBundleWithLocalPins(
      io.scope,
      latest.sealed,
      passkeyInput,
      latest.revision,
    );
    if (
      reseal !== null &&
      (await putBundleGuarded(io, reseal.sealed, latest.revision)) === "stored"
    ) {
      await recordBundleRevision(io.scope, reseal.revision);
    }
  } catch (cause) {
    resealFailure = describeCause(cause);
  }

  return { imported, heal, warning, resealFailure, enrollmentRepaired, repairFailure };
}

/**
 * The unlock's host claim, HONEST about every bucket (P-C6): what came over,
 * what the passkey holds nothing of, and what stayed removed because the
 * operator removed it on this device — the one bucket the old copy silently
 * folded into "already knows your hosts" while the device could reach none.
 */
export function describeUnlockImport(imported: ImportedTrust): string {
  const added = imported.added.length;
  const skipped = imported.skippedRevoked.length;
  let base: string;
  if (added > 0) {
    base = `${added} host${added === 1 ? "" : "s"} now reachable from this device.`;
  } else if (imported.hosts.length === 0) {
    base = "Your passkey isn't protecting any hosts yet.";
  } else if (imported.alreadyTrusted.length > 0) {
    base = "This device already knows your hosts.";
  } else {
    base = "No hosts came over to this device.";
  }
  if (skipped > 0) {
    base += ` ${skipped} host${skipped === 1 ? "" : "s"} stayed removed — you removed ${
      skipped === 1 ? "it" : "them"
    } on this device.`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Backup enrollment
// ---------------------------------------------------------------------------

/**
 * Enroll a second passkey as a backup. Requires an existing one that already
 * unlocks, because a wrap can only be added by someone who can recover the
 * data key -- which is exactly the property that keeps the server out.
 */
export async function addBackupPasskey(io: PasskeyFlowsIo): Promise<void> {
  const id = io.scope.accountId;
  const stored = await io.trust.getBundle();
  if (stored === null) {
    throw new Error("Add a passkey first; there is nothing to back up yet.");
  }
  // Only wrap-holding credentials are offered for the unlocking gesture — a
  // ghost gesture would open nothing (P-C5). No wrap-fallback here: "Use
  // passkey" is the repair path for a half-finished setup, and it directs to it.
  const listed = (await io.trust.listPasskeys()).map((row) => row.credential_id);
  const wraps = new Set(envelopeWrapCredentialIds(id, stored.sealed));
  const offer = listed.filter((credentialId) => wraps.has(credentialId));
  if (offer.length === 0) {
    throw new Error(
      "None of the enrolled passkeys can open your saved protection from here. " +
        "Use “Use passkey” first, then add the backup.",
    );
  }
  const existing = await io.evaluateTrustPrf(id, offer);
  const backup = await io.createTrustPasskey(id, io.userLabel);
  if (!backup.prfEnabled) {
    throw new PasskeyPrfError(
      "prf_unavailable",
      "this authenticator reported no PRF support, so it cannot be a backup",
    );
  }
  const backupSecret = await io.evaluateTrustPrf(id, [backup.credentialId]);
  const next = await enrollBackupPasskey(
    io.scope,
    stored.sealed,
    { credentialId: existing.credentialId, prfSecret: existing.secret },
    { credentialId: backup.credentialId, prfSecret: backupSecret.secret },
  );
  // The bundle CAS is the gate: the wrap must be durably stored before the
  // credential is enrolled. The old order registered the passkey first, so
  // a concurrent-reseal 409 here left an enrolled-but-unwrapped passkey —
  // listed as protection while opening nothing. If enrollment fails after
  // the write instead, the orphaned wrap is inert (only this authenticator
  // can open it) and a retry simply reseals over it.
  await io.trust.putBundle(next, stored.revision);
  await io.trust.addPasskey(backup.credentialId, "backup passkey");
}

// ---------------------------------------------------------------------------
// Revocation (fix P-C5, ghost escape hatch) and final removal (P-C6)
// ---------------------------------------------------------------------------

export type RemovePasskeyOutcome = { readonly kind: "resealed" } | { readonly kind: "ghost" };

/**
 * Remove one passkey while at least one other remains.
 *
 * Two distinct cases, decided by the CURRENT envelope's wraps:
 *
 * - A credential that HOLDS a wrap is removed by resealing the bundle for the
 *   one surviving wrap-holder. Restricted to exactly one wrap-holding
 *   survivor: with more, a single device cannot gather every survivor's
 *   secret to re-wrap, so revoking here would drop the others.
 *
 * - A credential with NO wrap is a GHOST (a partial enrollment's leftover): it
 *   opens nothing, so deleting its row is pure cleanup — no reseal, the
 *   bundle is untouched. Authorization still takes a working passkey: the
 *   gesture proves the envelope is authentic and not older than one this
 *   device already trusted (rollback floor), so a served-up stale envelope
 *   cannot "prove" a real credential ghostly — beyond the floor-less residual
 *   documented in trust-revision.ts, which costs at most the row of a
 *   credential whose wrap the server was already withholding.
 */
export async function removeBackupPasskey(
  io: PasskeyFlowsIo,
  target: PasskeyRow,
): Promise<RemovePasskeyOutcome> {
  const id = io.scope.accountId;
  const stored = await io.trust.getBundle();
  if (stored === null) {
    throw new Error("There is no passkey-protected setup to remove a passkey from.");
  }
  const wraps = new Set(envelopeWrapCredentialIds(id, stored.sealed));
  const survivors = (await io.trust.listPasskeys()).filter((row) => row.id !== target.id);

  if (!wraps.has(target.credential_id)) {
    // GHOST: no wrap addresses this credential, so it opens nothing.
    const working = survivors
      .map((row) => row.credential_id)
      .filter((credentialId) => wraps.has(credentialId));
    if (working.length === 0) {
      throw new Error(
        "No other passkey here can open your saved protection to confirm this one is " +
          "safe to remove.",
      );
    }
    const { credentialId, secret } = await io.evaluateTrustPrf(id, working);
    const bundle = await openTrustEnvelope(id, stored.sealed, {
      credentialId,
      prfSecret: secret,
    });
    await enforceBundleFreshness(id, bundle.revision, revisionOptions(io.scope));
    await io.trust.removePasskey(target.id);
    return { kind: "ghost" };
  }

  // Count survivors by WRAPS, not rows: a ghost row among the survivors holds
  // nothing to reseal for and must not block removing a real credential.
  const wrapSurvivors = survivors.filter((row) => wraps.has(row.credential_id));
  if (wrapSurvivors.length !== 1) {
    throw new Error(
      "Removing needs exactly one surviving passkey so this device can reseal for it. " +
        "With more than two enrolled, remove from each surviving device instead.",
    );
  }
  const survivor = wrapSurvivors[0];
  // Unlock with the survivor: it authorizes the revoke and is the key the
  // bundle is resealed for.
  const { secret } = await io.evaluateTrustPrf(id, [survivor.credential_id]);
  const { sealed, revision } = await revokeBackupPasskey(
    io.scope,
    stored.sealed,
    stored.revision,
    { credentialId: survivor.credential_id, prfSecret: secret },
    target.credential_id,
  );
  await io.trust.putBundle(sealed, stored.revision);
  await recordBundleRevision(io.scope, revision);
  await io.trust.removePasskey(target.id);
  return { kind: "resealed" };
}

/**
 * Thrown when the final removal would abandon a bundle it could not read or
 * verify. The caller must show this exact state to the operator and retry with
 * `acknowledgeUnreadable` only on an explicit yes — the flow never proceeds
 * past an unreadable bundle on the first ask (P-C6 hardening).
 */
export class UnreadableTrustStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableTrustStateError";
  }
}

export interface RemoveLastPasskeyOutcome {
  readonly skippedRootReason: string | null;
}

/**
 * Remove the ONLY passkey — abandoning the protection it provided. The
 * sealed anchor is revoked first (fail-closed: everything it approved loses
 * that trust immediately), then the bundle and the credential row go. The
 * caller shows the honest cost before calling; nothing here re-asks — except
 * for one state: a bundle that exists but cannot be read/verified is only
 * abandoned under an explicit `acknowledgeUnreadable`, because proceeding
 * destroys the sealed seed archive while the live root row stays unrevoked.
 * Transient failures (a bundle fetch that errors, local storage trouble)
 * FAIL the operation instead — retrying beats abandoning; only a bundle that
 * is present but provably unopenable here (bad decrypt/parse, or below this
 * device's rollback floor) is eligible for acknowledged abandonment. An
 * absent bundle (a true 404-equivalent null) needs no acknowledgement: there
 * is nothing to abandon.
 */
export async function removeLastPasskey(
  io: PasskeyFlowsIo,
  target: PasskeyRow,
  options: { readonly acknowledgeUnreadable?: boolean } = {},
): Promise<RemoveLastPasskeyOutcome> {
  const id = io.scope.accountId;
  const remaining = await io.trust.listPasskeys();
  if (remaining.length !== 1 || remaining[0].id !== target.id) {
    throw new Error("This path removes only the final passkey.");
  }
  // The root this passkey sealed must not outlive it as a live endorser —
  // but WHICH row is "the root" is decided by the sealed bundle's own
  // pk_R, read firsthand before the bundle is deleted, never by the
  // server's is_root labeling (hardening B3). A hostile roster could
  // otherwise nominate any row and have this flow revoke it on its word.
  let sealedRootPk: string | null = null;
  let bundleUnreadable = false;
  const stored = await io.trust.getBundle();
  if (stored !== null) {
    try {
      const { credentialId, secret } = await io.evaluateTrustPrf(id, [target.credential_id]);
      const bundle = await openTrustEnvelope(id, stored.sealed, {
        credentialId,
        prfSecret: secret,
      });
      await enforceBundleFreshness(id, bundle.revision, revisionOptions(io.scope));
      sealedRootPk = bundle.root?.publicKeyWire ?? null;
    } catch (error) {
      if (error instanceof PasskeyPrfError) throw error;
      // Only a definitively unopenable-or-rolled-back bundle is eligible for
      // acknowledged abandonment; anything else (storage trouble, unexpected
      // failures) is transient and fails the operation outright.
      const abandonable =
        error instanceof TrustBundleError ||
        (error instanceof TrustRevisionError && error.code === "stale_bundle");
      if (!abandonable) throw error;
      bundleUnreadable = true;
    }
    if (bundleUnreadable && options.acknowledgeUnreadable !== true) {
      throw new UnreadableTrustStateError(
        "Your passkey's saved protection can't be read from here. Removing the passkey " +
          "abandons it: your devices and hosts keep trusting the old setup, and if you " +
          "lose every device, nothing brings this account's hosts back. Nothing was removed.",
      );
    }
  }
  const { row, reason } = selectSealedRootRowForRevocation(
    sealedRootPk,
    await io.browserDevices.list(),
  );
  if (row !== null) {
    await io.browserDevices.revoke(row.id, row.public_key);
  }
  if (stored !== null) {
    try {
      // CAS at the revision this flow read (fix: the addBackup race). A 409
      // means another device replaced the bundle between our read and this
      // delete — e.g. a backup enrollment's putBundle landed and its
      // addPasskey is about to. Deleting blind would strand that credential
      // with no bundle; stopping here costs only a retry.
      await io.trust.deleteBundle(stored.revision);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        throw new Error(
          "Your passkey's saved protection changed on another device while this was " +
            "removing it, so the passkey was kept. Check the passkey list and try " +
            "again if you still want it gone.",
        );
      }
      throw error;
    }
  }
  await io.trust.removePasskey(target.id);
  const skippedRootReason =
    reason !== null && bundleUnreadable
      ? "Your trust bundle could not be opened to verify the account root, so it was not revoked on the server's word."
      : reason;
  return { skippedRootReason };
}
