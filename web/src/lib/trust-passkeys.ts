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
  ensureRootRegistered,
  healAccount,
} from "@/lib/account-heal";
import {
  type AccountRoot,
  exportAccountRootMaterial,
  generateAccountRoot,
  importAccountRoot,
} from "@/lib/account-root";
import { browserDevices, type PasskeyCredential, trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { loadBrowserDeviceIdentity } from "@/lib/browser-device-identity";
import { browserHostPinServerOrigin, listActiveBrowserHostPins } from "@/lib/browser-host-pins";
import {
  createTrustPasskey,
  evaluateTrustPrf,
  isPasskeySupported,
  PasskeyPrfError,
} from "@/lib/passkey-prf";
import { probeStoragePersistence } from "@/lib/storage-diagnostics";
import {
  enrollBackupPasskey,
  forgetTrustOnThisDevice,
  importTrustBundle,
  recordBundleRevision,
  retrofitAccountRoot,
  revokeBackupPasskey,
  sealCurrentTrust,
} from "@/lib/trust-bootstrap";
import type { TrustBundleHost } from "@/lib/trust-bundle";

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

/**
 * Heal the account off the root while `sk_R` is legitimately in memory — the
 * mint and unlock moments only. Best-effort by design: the passkey action it
 * rides on must succeed even when healing cannot (e.g. this device's identity
 * is not registered yet); trust already granted is never at stake, and the next
 * passkey moment simply heals again.
 */
async function healBestEffort(
  accountId: string,
  root: AccountRoot,
  hosts: readonly TrustBundleHost[],
): Promise<AccountHealReport | null> {
  try {
    await ensureRootRegistered(root, accountId);
    const identity = await loadBrowserDeviceIdentity(accountId);
    if (identity === null) return null;
    // Device SELECTION inside healAccount trusts nothing server-claimed (C1):
    // it verifies every endorsement edge's signature and anchors only on the
    // sealed root and this device's own key. Server pin-membership is
    // deliberately not consulted — it is not firsthand-verifiable. The host
    // ANCHOR-UPGRADE half still uses `hosts`, whose ids and keys are firsthand
    // (the sealed bundle at unlock, local pins at mint).
    return await healAccount(root, accountId, identity, hosts);
  } catch (error) {
    // A conflicting root is a trust failure (a substituted is_root row), never
    // something to paper over silently.
    if (error instanceof AccountHealError && error.code === "root_conflict") throw error;
    return null;
  }
}

function describeHeal(report: AccountHealReport | null): string {
  if (report === null) return "";
  const healed = report.endorsedDeviceIds.length;
  const parts: string[] = [];
  if (healed > 0) parts.push(`${healed} device${healed === 1 ? "" : "s"} approved`);
  if (report.hostsUpgraded > 0)
    parts.push(`${report.hostsUpgraded} host${report.hostsUpgraded === 1 ? "" : "s"} protected`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")}.)`;
}

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
      const pins = await listActiveBrowserHostPins(
        { accountId: id, origin: browserHostPinServerOrigin() },
        {},
      );
      const report = await healBestEffort(
        id,
        root,
        pins.map((pin) => ({
          hostPublicKey: pin.hostPublicKey,
          hostFingerprint: pin.hostFingerprint,
          hostIds: pin.hostIds,
        })),
      );
      return { hostCount, report };
    },
    onMutate: begin,
    onSuccess: ({ report }) => {
      setStatus(
        `Passkey added. If you lose every device, it brings everything back.${describeHeal(report)}`,
      );
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
      const imported = await importTrustBundle({ credentialId, prfSecret: secret }, stored.sealed, {
        accountId: id,
      });

      // The heal moment (mesh stage 5c): the unlock proved the passkey, so the
      // sealed root is legitimately in memory. Re-root every device off R and
      // upgrade hosts to anchor on it, then let the key go out of scope.
      let report: AccountHealReport | null = null;
      if (imported.root !== null) {
        // Root ROTATION (compromise response): if the sealed root's key was
        // revoked, mint a successor over it and heal off that instead. The old
        // key stays dead — revocation is a permanent tombstone (R10) — and the
        // deny-list has already severed everything anchored on it.
        const deviceRows = await browserDevices.list();
        const sealedPk = imported.root.publicKeyWire;
        const sealedRootRevoked = deviceRows.some(
          (d) => d.public_key === sealedPk && d.revoked_at !== null,
        );
        const liveRoot = deviceRows.find((d) => d.is_root && d.revoked_at === null);
        if (sealedRootRevoked && liveRoot === undefined) {
          const successor = await generateAccountRoot();
          const rotated = await retrofitAccountRoot(
            { accountId: id },
            stored.sealed,
            { credentialId, prfSecret: secret },
            stored.revision,
            await exportAccountRootMaterial(successor),
            true,
          );
          if (rotated !== null) {
            try {
              await trust.putBundle(rotated.sealed, stored.revision);
            } catch {
              return { imported, report };
            }
            await recordBundleRevision({ accountId: id }, rotated.revision);
            report = await healBestEffort(id, successor, imported.hosts);
          }
        } else {
          report = await healBestEffort(id, await importAccountRoot(imported.root), imported.hosts);
        }
      } else {
        // Pre-root bundle: retrofit a freshly minted root under the same data
        // key (every enrolled passkey keeps working), store it durably, and
        // only then let the root endorse and anchor. A concurrent unlock loses
        // the server's revision CAS and simply skips — the winner's root heals.
        const root = await generateAccountRoot();
        const retro = await retrofitAccountRoot(
          { accountId: id },
          stored.sealed,
          { credentialId, prfSecret: secret },
          stored.revision,
          await exportAccountRootMaterial(root),
        );
        if (retro !== null) {
          try {
            await trust.putBundle(retro.sealed, stored.revision);
          } catch {
            return { imported, report };
          }
          await recordBundleRevision({ accountId: id }, retro.revision);
          report = await healBestEffort(id, root, imported.hosts);
        }
      }
      return { imported, report };
    },
    onMutate: begin,
    onSuccess: ({ imported, report }) => {
      const base =
        imported.added.length === 0
          ? "This device already knows your hosts."
          : `${imported.added.length} host${imported.added.length === 1 ? "" : "s"} now reachable from this device.`;
      setStatus(base + describeHeal(report));
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
      const remaining = await trust.listPasskeys();
      if (remaining.length !== 1 || remaining[0].id !== target.id) {
        throw new Error("This path removes only the final passkey.");
      }
      // The root this passkey sealed must not outlive it as a live endorser.
      const liveRoot = (await browserDevices.list()).find(
        (d) => d.is_root && d.revoked_at === null,
      );
      if (liveRoot !== undefined) {
        await browserDevices.revoke(liveRoot.id, liveRoot.public_key);
      }
      await trust.deleteBundle();
      await trust.removePasskey(target.id);
    },
    onMutate: begin,
    onSuccess: () => {
      setStatus(
        "Passkey removed. Your devices keep working, but if you lose them all, nothing brings this account's hosts back.",
      );
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
