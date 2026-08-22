"use client";

/**
 * Passkey-backed trust, as one reusable hook (docs/TRUST_UX.md: the passkey is
 * the whole safety story — "recovery" is not a concept the UI teaches).
 *
 * Every flow here was extracted verbatim from the retired TrustPanel; the
 * mutation bodies are the security-reviewed originals (mesh stage 5): set up
 * (mint root + seal), unlock (import + heal + rotate-if-revoked), backup
 * enrollment, two-passkey revocation, and forget-this-browser. Surfaces mount
 * whichever slices they need — the Access screen its "Use passkey" and "Add
 * passkey" moments, account settings the passkey list.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  AccountHealError,
  type AccountHealReport,
  assessSealedRootRevocation,
  ensureRootRegistered,
  healAccount,
  selectSealedRootRowForRevocation,
  unionHealHosts,
} from "@/lib/account-heal";
import {
  type AccountRoot,
  exportAccountRootMaterial,
  generateAccountRoot,
  importAccountRoot,
} from "@/lib/account-root";
import { ApiError, browserDevices, type PasskeyCredential, trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  createRootIntroductionProof,
  loadBrowserDeviceIdentity,
} from "@/lib/browser-device-identity";
import { browserHostPinServerOrigin, listActiveBrowserHostPins } from "@/lib/browser-host-pins";
import {
  createTrustPasskey,
  evaluateTrustPrf,
  isPasskeySupported,
  PasskeyPrfError,
} from "@/lib/passkey-prf";
import { rememberFirsthandRoot } from "@/lib/root-knowledge";
import { probeStoragePersistence } from "@/lib/storage-diagnostics";
import {
  enrollBackupPasskey,
  forgetTrustOnThisDevice,
  importTrustBundle,
  recordBundleRevision,
  resealBundleWithLocalPins,
  retrofitAccountRoot,
  revokeBackupPasskey,
  sealCurrentTrust,
} from "@/lib/trust-bootstrap";
import type { TrustBundleHost } from "@/lib/trust-bundle";
import { openTrustEnvelope } from "@/lib/trust-envelope";
import { enforceBundleFreshness } from "@/lib/trust-revision";

export function describePasskeyError(error: unknown): string {
  if (error instanceof PasskeyPrfError) {
    switch (error.code) {
      case "prf_unavailable":
        return "This passkey cannot protect your devices — its authenticator does not support the required extension.";
      case "cancelled":
        return "The passkey prompt was dismissed.";
      case "no_credential":
        return "No passkey was offered for this account on this device.";
      case "unsupported":
        return "This browser cannot use passkeys here. A secure context (HTTPS) is required.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export interface HealOutcome {
  readonly report: AccountHealReport | null;
  /** Human-readable reason the heal could not run (or run fully). */
  readonly failure: string | null;
}

/**
 * Heal the account off the root while `sk_R` is legitimately in memory — the
 * mint and unlock moments only. Best-effort in the sense that the passkey
 * action it rides on proceeds even when healing cannot — but never silently:
 * the outcome always carries the report or the reason (P-C3), and the caller
 * decides what to claim on screen. A conflicting root (a substituted is_root
 * row) still throws — that is a trust failure, never a partial one.
 *
 * Device SELECTION inside healAccount trusts nothing server-claimed (C1): it
 * verifies every endorsement edge's signature and anchors only on the sealed
 * root and this device's own key. The host ANCHOR-UPGRADE half iterates the
 * UNION of the caller's hosts (the sealed bundle at unlock, the pin snapshot
 * at mint) and this device's ACTIVE local pins — local-pin host keys are
 * firsthand by definition (P-C1c), so a host possessed after the last seal
 * still gains its anchor at this device's passkey moments.
 *
 * The same moments feed the §4.1 root-introduction channel: pk_R lands in
 * this device's durable firsthand memory and is published (best-effort; the
 * gossip sweep republishes) so PINNED devices can anchor a root whose passkey
 * lives on an unpinned device — the structural fix for the field bug.
 */
async function healBestEffort(
  accountId: string,
  root: AccountRoot,
  hosts: readonly TrustBundleHost[],
  source: "mint" | "bundle",
): Promise<HealOutcome> {
  try {
    await ensureRootRegistered(root, accountId);
    const identity = await loadBrowserDeviceIdentity(accountId);
    if (identity === null) {
      return {
        report: null,
        failure: "this device has not finished setting up its own identity here",
      };
    }
    const origin = browserHostPinServerOrigin();
    const pins = await listActiveBrowserHostPins({ accountId, origin }, {}).catch(
      () => [] as { hostPublicKey: string; hostFingerprint: string; hostIds: readonly string[] }[],
    );
    const report = await healAccount(
      root,
      accountId,
      identity,
      unionHealHosts(
        hosts,
        pins.map((pin) => ({
          hostPublicKey: pin.hostPublicKey,
          hostFingerprint: pin.hostFingerprint,
          hostIds: pin.hostIds,
        })),
      ),
    );

    // Root-introduction leg — never fatal to the heal it rides on.
    try {
      await rememberFirsthandRoot({
        accountId,
        origin,
        rootPublicKey: root.publicKeyWire,
        source,
      });
    } catch {
      // Unrecordable storage only mutes this device's own future sweep.
    }
    if (report.currentDeviceId !== null) {
      try {
        await trust.publishRootIntroduction({
          introducer_device_id: report.currentDeviceId,
          root_public_key: root.publicKeyWire,
          signature: await createRootIntroductionProof(identity, accountId, root.publicKeyWire),
        });
      } catch {
        // The gossip sweep republishes durably.
      }
    }
    return { report, failure: null };
  } catch (error) {
    // A conflicting root is a trust failure (a substituted is_root row), never
    // something to paper over silently.
    if (error instanceof AccountHealError && error.code === "root_conflict") throw error;
    return { report: null, failure: describePasskeyError(error) };
  }
}

function describeHeal(report: AccountHealReport | null): string {
  if (report === null) return "";
  const healed = report.endorsedDeviceIds.length;
  const upgraded = new Set(report.upgradedHostIds).size;
  const parts: string[] = [];
  if (healed > 0) parts.push(`${healed} device${healed === 1 ? "" : "s"} approved`);
  if (upgraded > 0) parts.push(`${upgraded} host${upgraded === 1 ? "" : "s"} protected`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")}.)`;
}

/**
 * Store a bundle with CAS, distinguishing the one benign failure. A 409 means
 * another device updated the bundle concurrently — the caller says so and
 * re-fetches rather than retrying blind. Anything else is a real failure and
 * propagates (P-C3: no more swallowed putBundle errors).
 */
async function putBundleGuarded(
  sealed: string,
  expectedRevision: number,
): Promise<"stored" | "lost_cas"> {
  try {
    await trust.putBundle(sealed, expectedRevision);
    return "stored";
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return "lost_cas";
    throw error;
  }
}

const CONCURRENT_UPDATE_WARNING =
  "Another device updated your passkey's protection at the same time; nothing was " +
  "changed here. Use your passkey again to finish on this device.";

export function usePasskeyTrust() {
  const { user } = useAuth();
  const accountId = user?.id ?? null;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const passkeys = useQuery({
    queryKey: ["trust", "passkeys"],
    queryFn: () => trust.listPasskeys(),
    enabled: accountId !== null,
  });
  const bundle = useQuery({
    queryKey: ["trust", "bundle"],
    queryFn: () => trust.getBundle(),
    enabled: accountId !== null,
  });
  // Does this browser persist what the trust model needs? A device that mints a
  // fresh identity every load can never be pinned, and nothing else here works.
  const storage = useQuery({
    queryKey: ["trust", "storage-probe", accountId],
    queryFn: async () => {
      const existing = accountId === null ? null : await loadBrowserDeviceIdentity(accountId);
      return { identityPersisted: existing !== null, probe: await probeStoragePersistence() };
    },
    enabled: accountId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const localPins = useQuery({
    queryKey: ["trust", "local-pins", accountId],
    queryFn: () =>
      listActiveBrowserHostPins({
        accountId: accountId as string,
        origin: browserHostPinServerOrigin(),
      }),
    enabled: accountId !== null,
  });

  function begin() {
    setStatus(null);
    setError(null);
  }

  /**
   * Create a passkey, then seal this device's verified hosts under it. Creation
   * and sealing are one action deliberately: a passkey with no bundle behind it
   * looks like protection while providing none.
   */
  const setUp = useMutation({
    mutationFn: async () => {
      const id = accountId as string;
      // A bundle is sealed under one passkey's secret, so a second, unrelated
      // passkey cannot open it. Sealing this device's pins over an existing
      // bundle would lose the operator's other host keys AND lock every enrolled
      // passkey out of the old bundle at once. Enrolling another key or device
      // uses the key-wrapping ceremony ("Add a backup passkey" / "Use passkey"),
      // never this path — so refuse outright when a bundle already exists.
      const existing = await trust.getBundle();
      if (existing !== null) {
        throw new Error(
          "This account already has a passkey-protected setup. Use “Use passkey” to bring it to " +
            "this device, or add a backup passkey — setting up again here would overwrite it.",
        );
      }

      // Preflight the account root BEFORE the passkey gesture: a live root from
      // an earlier setup (whose seed this bundle would not hold) must stop us
      // here, not after the operator has enrolled an authenticator.
      const priorRoot = (await browserDevices.list()).find(
        (d) => d.is_root && d.revoked_at === null,
      );
      if (priorRoot !== undefined) {
        throw new Error(
          "This account still has keys from a previous passkey setup. Remove them under " +
            "Access → Advanced before setting up a new passkey.",
        );
      }

      const passkey = await createTrustPasskey(id, user?.email ?? "spawn operator");
      if (!passkey.prfEnabled) {
        throw new PasskeyPrfError(
          "prf_unavailable",
          "this authenticator reported no PRF support, so it cannot protect your devices",
        );
      }
      await trust.addPasskey(passkey.credentialId, "this device");

      // Mint the account root with the passkey (mesh stage 5c): its seed is
      // sealed into this bundle, so any passkey unlock can heal the account.
      const root = await generateAccountRoot();

      const { secret } = await evaluateTrustPrf(id, [passkey.credentialId]);
      const { sealed, hostCount, revision } = await sealCurrentTrust(
        { credentialId: passkey.credentialId, prfSecret: secret },
        { accountId: id },
        0,
        await exportAccountRootMaterial(root),
      );
      await trust.putBundle(sealed, undefined);
      // Advance the rollback floor only after the bundle is durably stored.
      await recordBundleRevision({ accountId: id }, revision);

      // Register + heal only after the sealed seed is durably stored: a root
      // the bundle cannot recover must never become an endorser or anchor.
      // healBestEffort re-reads the active pins itself (the anchor half runs
      // on the union of these and the local store — identical at mint).
      const pins = await listActiveBrowserHostPins(
        { accountId: id, origin: browserHostPinServerOrigin() },
        {},
      );
      const heal = await healBestEffort(
        id,
        root,
        pins.map((pin) => ({
          hostPublicKey: pin.hostPublicKey,
          hostFingerprint: pin.hostFingerprint,
          hostIds: pin.hostIds,
        })),
        "mint",
      );
      return { hostCount, heal };
    },
    onMutate: begin,
    onSuccess: ({ hostCount, heal }) => {
      // HONEST about coverage (P-C1b): a passkey sealed over zero hosts
      // protects nothing yet — say when that changes (which reseal-on-unlock
      // makes true) instead of implying it already did.
      const coverage =
        hostCount === 0
          ? " No hosts are protected yet — the next time you use this passkey after " +
            "possessing a host, it starts protecting them."
          : "";
      setStatus(
        "Passkey added. If you lose every device, it brings everything back." +
          coverage +
          describeHeal(heal.report),
      );
      if (heal.failure !== null) {
        setError(
          `Part of the setup did not finish: ${heal.failure} ` +
            "It completes the next time you use this passkey.",
        );
      }
      queryClient.invalidateQueries({ queryKey: ["trust"] });
      queryClient.invalidateQueries({ queryKey: ["browser-devices"] });
      queryClient.invalidateQueries({ queryKey: ["account-endorsements"] });
    },
    onError: (err) => setError(describePasskeyError(err)),
  });

  /**
   * The one passkey verb a device ever needs: prove the passkey, inherit the
   * account's trusted hosts, and let the sealed root approve this device and
   * re-protect hosts (mesh stage 5c heal; rotation if the sealed root was
   * revoked).
   */
  const unlock = useMutation({
    mutationFn: async () => {
      const id = accountId as string;
      const stored = await trust.getBundle();
      if (stored === null) {
        throw new Error("This account has no passkey yet. Add one on a device that works.");
      }
      const known = (await trust.listPasskeys()).map((row) => row.credential_id);
      const { credentialId, secret } = await evaluateTrustPrf(id, known);
      const passkeyInput = { credentialId, prfSecret: secret };
      const imported = await importTrustBundle(passkeyInput, stored.sealed, {
        accountId: id,
      });

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
        const deviceRows = await browserDevices.list();
        const sealedPk = imported.root.publicKeyWire;
        let tombstonedKeys: string[] = [];
        try {
          tombstonedKeys = (await browserDevices.revokedKeys()).map((row) => row.public_key);
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
            { accountId: id },
            stored.sealed,
            passkeyInput,
            stored.revision,
            await exportAccountRootMaterial(successor),
            true,
          );
          if (rotated !== null) {
            // A CAS loss is said out loud and the winner's state re-fetched
            // (onSuccess invalidates); any OTHER storage failure propagates
            // instead of being swallowed into a cheerful success (P-C3).
            if ((await putBundleGuarded(rotated.sealed, stored.revision)) === "lost_cas") {
              warning = CONCURRENT_UPDATE_WARNING;
            } else {
              await recordBundleRevision({ accountId: id }, rotated.revision);
              latest = { sealed: rotated.sealed, revision: rotated.revision };
              heal = await healBestEffort(id, successor, imported.hosts, "bundle");
            }
          }
        } else {
          if (verdict === "uncorroborated") {
            warning =
              "The server claims your account root was revoked, but its permanent " +
              "revocation record does not corroborate that. Nothing was rotated or " +
              "destroyed; if you really revoked it, retry once the record is consistent.";
          }
          heal = await healBestEffort(
            id,
            await importAccountRoot(imported.root),
            imported.hosts,
            "bundle",
          );
        }
      } else {
        // Pre-root bundle: retrofit a freshly minted root under the same data
        // key (every enrolled passkey keeps working), store it durably, and
        // only then let the root endorse and anchor. A concurrent unlock loses
        // the server's revision CAS — said out loud, and the winner's root
        // heals; a real storage failure propagates (P-C3).
        const root = await generateAccountRoot();
        const retro = await retrofitAccountRoot(
          { accountId: id },
          stored.sealed,
          passkeyInput,
          stored.revision,
          await exportAccountRootMaterial(root),
        );
        if (retro !== null) {
          if ((await putBundleGuarded(retro.sealed, stored.revision)) === "lost_cas") {
            warning = CONCURRENT_UPDATE_WARNING;
          } else {
            await recordBundleRevision({ accountId: id }, retro.revision);
            latest = { sealed: retro.sealed, revision: retro.revision };
            heal = await healBestEffort(id, root, imported.hosts, "bundle");
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
          { accountId: id },
          latest.sealed,
          passkeyInput,
          latest.revision,
        );
        if (
          reseal !== null &&
          (await putBundleGuarded(reseal.sealed, latest.revision)) === "stored"
        ) {
          await recordBundleRevision({ accountId: id }, reseal.revision);
        }
      } catch (cause) {
        resealFailure = describePasskeyError(cause);
      }

      return { imported, heal, warning, resealFailure };
    },
    onMutate: begin,
    onSuccess: ({ imported, heal, warning, resealFailure }) => {
      const base =
        imported.added.length === 0
          ? "This device already knows your hosts."
          : `${imported.added.length} host${imported.added.length === 1 ? "" : "s"} now reachable from this device.`;
      // HONESTY GATE: "approved" is claimed only when this device's own R→d
      // edge verifiably exists after the heal. Anything less is said as the
      // partial result it is, in UX voice.
      const healed = heal.report !== null && heal.report.rootEndorsedSelf === true;
      setStatus(base + (healed ? describeHeal(heal.report) : ""));
      const problems: string[] = [];
      if (warning !== null) {
        problems.push(warning);
      } else if (!healed) {
        problems.push(
          heal.failure !== null
            ? `Approving this device did not finish: ${heal.failure} Use your passkey again in a moment.`
            : "Approving this device did not finish. Use your passkey again in a moment.",
        );
      }
      if (resealFailure !== null) {
        problems.push(`Saving your newly possessed hosts for the passkey failed: ${resealFailure}`);
      }
      if (problems.length > 0) setError(problems.join(" "));
      queryClient.invalidateQueries({ queryKey: ["trust"] });
      queryClient.invalidateQueries({ queryKey: ["browser-devices"] });
      queryClient.invalidateQueries({ queryKey: ["account-endorsements"] });
    },
    onError: (err) => setError(describePasskeyError(err)),
  });

  /**
   * Recovery for a device holding pins the daemon will not accept: it signs
   * offers that are refused, which looks like a terminal that never connects.
   * Unpinned it works again, unprotected, and can be re-approved after.
   */
  const forget = useMutation({
    mutationFn: () => forgetTrustOnThisDevice({ accountId: accountId as string }),
    onMutate: begin,
    onSuccess: (result) => {
      setStatus(
        result.forgotten === 0
          ? "This device held no host trust to forget."
          : `Forgot ${result.forgotten} host${result.forgotten === 1 ? "" : "s"}. This device now connects unprotected until it is trusted again.`,
      );
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describePasskeyError(err)),
  });

  /**
   * Enroll a second passkey as a backup. Requires an existing one that already
   * unlocks, because a wrap can only be added by someone who can recover the
   * data key -- which is exactly the property that keeps the server out.
   */
  const addBackup = useMutation({
    mutationFn: async () => {
      const id = accountId as string;
      const stored = await trust.getBundle();
      if (stored === null) {
        throw new Error("Add a passkey first; there is nothing to back up yet.");
      }
      const known = (await trust.listPasskeys()).map((row) => row.credential_id);
      const existing = await evaluateTrustPrf(id, known);
      const backup = await createTrustPasskey(id, user?.email ?? "spawn operator");
      if (!backup.prfEnabled) {
        throw new PasskeyPrfError(
          "prf_unavailable",
          "this authenticator reported no PRF support, so it cannot be a backup",
        );
      }
      const backupSecret = await evaluateTrustPrf(id, [backup.credentialId]);
      const next = await enrollBackupPasskey(
        { accountId: id },
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
      await trust.putBundle(next, stored.revision);
      await trust.addPasskey(backup.credentialId, "backup passkey");
    },
    onMutate: begin,
    onSuccess: () => {
      setStatus("Backup passkey added. Either passkey now works.");
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describePasskeyError(err)),
  });

  /**
   * Revoke a passkey by resealing the bundle for the one surviving passkey.
   * Restricted to the two-passkey case: with more, a single device cannot gather
   * every survivor's secret to re-wrap, so revoking here would drop the others.
   */
  const revokePasskey = useMutation({
    mutationFn: async (target: PasskeyCredential) => {
      const id = accountId as string;
      const stored = await trust.getBundle();
      if (stored === null) {
        throw new Error("There is no passkey-protected setup to remove a passkey from.");
      }
      const survivors = (await trust.listPasskeys()).filter((row) => row.id !== target.id);
      if (survivors.length !== 1) {
        throw new Error(
          "Removing needs exactly one surviving passkey so this device can reseal for it. " +
            "With more than two enrolled, remove from each surviving device instead.",
        );
      }
      const survivor = survivors[0];
      // Unlock with the survivor: it authorizes the revoke and is the key the
      // bundle is resealed for.
      const { secret } = await evaluateTrustPrf(id, [survivor.credential_id]);
      const { sealed, revision } = await revokeBackupPasskey(
        { accountId: id },
        stored.sealed,
        stored.revision,
        { credentialId: survivor.credential_id, prfSecret: secret },
        target.credential_id,
      );
      await trust.putBundle(sealed, stored.revision);
      await recordBundleRevision({ accountId: id }, revision);
      await trust.removePasskey(target.id);
    },
    onMutate: begin,
    onSuccess: () => {
      setStatus("Passkey removed. It no longer opens anything.");
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describePasskeyError(err)),
  });

  /**
   * Remove the ONLY passkey — abandoning the protection it provided. The
   * sealed anchor is revoked first (fail-closed: everything it approved loses
   * that trust immediately), then the bundle and the credential row go. The
   * caller shows the honest cost before calling; nothing here re-asks.
   */
  const removeLastPasskey = useMutation({
    mutationFn: async (target: PasskeyCredential) => {
      const id = accountId as string;
      const remaining = await trust.listPasskeys();
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
      const stored = await trust.getBundle();
      if (stored !== null) {
        try {
          const { secret } = await evaluateTrustPrf(id, [target.credential_id]);
          const bundle = await openTrustEnvelope(id, stored.sealed, {
            credentialId: target.credential_id,
            prfSecret: secret,
          });
          await enforceBundleFreshness(id, bundle.revision);
          sealedRootPk = bundle.root?.publicKeyWire ?? null;
        } catch (error) {
          if (error instanceof PasskeyPrfError) throw error;
          // An unopenable or rolled-back bundle yields no firsthand pk_R. The
          // operator is deliberately abandoning passkey protection, so do not
          // hold that hostage — but revoke nothing on the server's say-so.
          bundleUnreadable = true;
        }
      }
      const { row, reason } = selectSealedRootRowForRevocation(
        sealedRootPk,
        await browserDevices.list(),
      );
      if (row !== null) {
        await browserDevices.revoke(row.id, row.public_key);
      }
      await trust.deleteBundle();
      await trust.removePasskey(target.id);
      const skippedRootReason =
        reason !== null && bundleUnreadable
          ? "Your trust bundle could not be opened to verify the account root, so it was not revoked on the server's word."
          : reason;
      return { skippedRootReason };
    },
    onMutate: begin,
    onSuccess: ({ skippedRootReason }) => {
      setStatus(
        "Passkey removed. Your devices keep working, but if you lose them all, nothing brings this account's hosts back.",
      );
      // Loud skip (hardening B3): a live root row the sealed bundle did not
      // vouch for stays untouched, and the operator hears why.
      if (skippedRootReason !== null) setError(skippedRootReason);
      queryClient.invalidateQueries({ queryKey: ["trust"] });
      queryClient.invalidateQueries({ queryKey: ["browser-devices"] });
      queryClient.invalidateQueries({ queryKey: ["account-endorsements"] });
    },
    onError: (err) => setError(describePasskeyError(err)),
  });

  const busy =
    setUp.isPending ||
    unlock.isPending ||
    forget.isPending ||
    addBackup.isPending ||
    revokePasskey.isPending ||
    removeLastPasskey.isPending;

  return {
    accountId,
    passkeys,
    bundle,
    storage,
    localPins,
    setUp,
    unlock,
    forget,
    addBackup,
    revokePasskey,
    removeLastPasskey,
    busy,
    status,
    error,
    supported: isPasskeySupported(),
    hasBundle: bundle.data !== null && bundle.data !== undefined,
  };
}
