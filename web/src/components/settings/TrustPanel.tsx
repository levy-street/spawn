"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { openSettings } from "@/components/settings/settings-dialog-store";
import { Button } from "@/components/ui/button";
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

function describe(error: unknown): string {
  if (error instanceof PasskeyPrfError) {
    switch (error.code) {
      case "prf_unavailable":
        return "This passkey cannot derive a trust secret. Its authenticator does not support the PRF extension, so this device needs the endorsement path instead.";
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
  if (healed > 0) parts.push(`${healed} device${healed === 1 ? "" : "s"} re-rooted`);
  if (report.hostsUpgraded > 0)
    parts.push(
      `${report.hostsUpgraded} host${report.hostsUpgraded === 1 ? "" : "s"} anchored on your account root`,
    );
  return parts.length === 0 ? "" : ` Healed: ${parts.join(", ")}.`;
}

export function TrustPanel() {
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
      // uses the key-wrapping ceremony ("Add a backup passkey" / "Unlock"),
      // never this path — so refuse outright when a bundle already exists.
      const existing = await trust.getBundle();
      if (existing !== null) {
        throw new Error(
          "A trust bundle already exists for this account. Use “Unlock trust on this device” to " +
            "import it, or “Add a backup passkey” to enroll another key. Setting up here would " +
            "overwrite it and lock out your other devices.",
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
          "This account already has a root key from a previous setup. Revoke it under Devices " +
            "before setting up a new passkey, so the new bundle can mint a fresh one.",
        );
      }

      const passkey = await createTrustPasskey(id, user?.email ?? "spawn operator");
      if (!passkey.prfEnabled) {
        throw new PasskeyPrfError(
          "prf_unavailable",
          "this authenticator reported no PRF support, so it cannot unlock a trust bundle",
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
    onSuccess: ({ hostCount, report }) => {
      setStatus(
        `Passkey ready. ${hostCount} verified host${hostCount === 1 ? "" : "s"} sealed into your trust bundle.` +
          describeHeal(report),
      );
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describe(err)),
  });

  /** Unlock on a device that has never been paired from a host terminal. */
  const unlock = useMutation({
    mutationFn: async () => {
      const id = accountId as string;
      const stored = await trust.getBundle();
      if (stored === null) {
        throw new Error(
          "No trust bundle has been sealed yet. Set one up on a paired device first.",
        );
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
        report = await healBestEffort(id, await importAccountRoot(imported.root), imported.hosts);
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
          ? `Already up to date — ${imported.alreadyTrusted.length} host${imported.alreadyTrusted.length === 1 ? "" : "s"} already trusted on this device.`
          : `Imported ${imported.added.length} host${imported.added.length === 1 ? "" : "s"} onto this device.`;
      const skipped =
        imported.skippedRevoked.length === 0
          ? ""
          : ` ${imported.skippedRevoked.length} host${imported.skippedRevoked.length === 1 ? "" : "s"} you revoked here ${imported.skippedRevoked.length === 1 ? "was" : "were"} left revoked.`;
      setStatus(base + skipped + describeHeal(report));
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describe(err)),
  });

  /**
   * Recovery for a device holding pins the daemon will not accept: it signs
   * offers that are refused, which looks like a terminal that never connects.
   * Unpinned it works again, unprotected, and can be re-endorsed after.
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
    onError: (err) => setError(describe(err)),
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
        throw new Error("Set up a passkey on this device first; there is nothing to back up yet.");
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
      await trust.addPasskey(backup.credentialId, "backup passkey");
      await trust.putBundle(next, stored.revision);
    },
    onMutate: begin,
    onSuccess: () => {
      setStatus("Backup passkey enrolled. Either passkey now opens your trust bundle.");
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describe(err)),
  });

  /**
   * Revoke a passkey by resealing the bundle for the one surviving passkey.
   * Restricted to the two-passkey case: with more, a single device cannot gather
   * every survivor's secret to re-wrap, so revoking here would drop the others.
   */
  const revoke = useMutation({
    mutationFn: async (target: PasskeyCredential) => {
      const id = accountId as string;
      const stored = await trust.getBundle();
      if (stored === null) {
        throw new Error("There is no sealed bundle to revoke a passkey from.");
      }
      const survivors = (await trust.listPasskeys()).filter((row) => row.id !== target.id);
      if (survivors.length !== 1) {
        throw new Error(
          "Revoking needs exactly one surviving passkey so this device can reseal for it. " +
            "With more than two enrolled, revoke from each surviving device instead.",
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
      setStatus("Passkey revoked. It can no longer open your trust bundle.");
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describe(err)),
  });

  const supported = isPasskeySupported();
  const busy =
    setUp.isPending ||
    unlock.isPending ||
    forget.isPending ||
    addBackup.isPending ||
    revoke.isPending;
  const hasBundle = bundle.data !== null && bundle.data !== undefined;
  const pinCount = localPins.data?.length ?? null;
  const passkeyCount = passkeys.data?.length ?? null;

  const actionRow = (props: { title: string; description: string; button: React.ReactNode }) => (
    <div className="flex items-start justify-between gap-3 border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-sm font-medium">{props.title}</p>
        <p className="text-xs text-muted-foreground">{props.description}</p>
      </div>
      <div className="shrink-0">{props.button}</div>
    </div>
  );

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Device trust</h2>
        <p className="text-sm text-muted-foreground">
          Carry the hosts this browser has verified to your other devices, protected by a passkey.
        </p>
      </div>
      {!supported && (
        <p className="text-sm text-muted-foreground">
          This browser cannot use passkeys here. Passkeys need a secure context (HTTPS).
        </p>
      )}

      <p className="text-sm">
        This browser recognizes{" "}
        <span className="font-semibold" data-testid="local-pin-count">
          {pinCount ?? "…"}
        </span>{" "}
        host{pinCount === 1 ? "" : "s"}.{" "}
        {bundle.isLoading ? (
          <span data-testid="bundle-state">…</span>
        ) : hasBundle ? (
          <>
            <span data-testid="bundle-state">Your saved trust</span> opens with any of{" "}
            <span className="font-semibold" data-testid="passkey-count">
              {passkeyCount ?? "…"}
            </span>{" "}
            passkey{passkeyCount === 1 ? "" : "s"}.
          </>
        ) : (
          <>
            <span data-testid="bundle-state">No saved trust yet</span> — set up a passkey below so
            new devices can inherit your hosts (
            <span data-testid="passkey-count">{passkeyCount ?? 0}</span> passkey
            {passkeyCount === 1 ? "" : "s"} registered).
          </>
        )}
      </p>

      <div>
        {!hasBundle &&
          actionRow({
            title: "Set up a passkey",
            description: "Saves this browser's verified hosts under a new passkey.",
            button: (
              <Button
                type="button"
                disabled={!supported || busy || accountId === null}
                onClick={() => setUp.mutate()}
                data-testid="setup-passkey"
              >
                {setUp.isPending ? "Setting up…" : "Set up"}
              </Button>
            ),
          })}
        {actionRow({
          title: "Unlock saved trust here",
          description: "Recognize the hosts you verified elsewhere, using your passkey.",
          button: (
            <Button
              type="button"
              variant="secondary"
              disabled={!supported || busy || accountId === null}
              onClick={() => unlock.mutate()}
              data-testid="unlock-trust"
            >
              {unlock.isPending ? "Unlocking…" : "Unlock"}
            </Button>
          ),
        })}
        {hasBundle &&
          actionRow({
            title: "Add a backup passkey",
            description: "A second passkey that opens the same saved trust.",
            button: (
              <Button
                type="button"
                variant="secondary"
                disabled={!supported || busy || accountId === null}
                onClick={() => addBackup.mutate()}
                data-testid="add-backup-passkey"
              >
                {addBackup.isPending ? "Enrolling…" : "Add backup"}
              </Button>
            ),
          })}
      </div>

      {(passkeys.data?.length ?? 0) > 0 && (
        <div className="rounded border p-3 text-sm" data-testid="passkey-list">
          <p className="font-semibold">Your passkeys</p>
          <ul className="mt-1 flex flex-col gap-2">
            {passkeys.data?.map((passkey) => (
              <li key={passkey.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{passkey.label ?? "passkey"}</span>
                <Button
                  type="button"
                  variant="secondary"
                  className="shrink-0"
                  disabled={busy || accountId === null || (passkeys.data?.length ?? 0) !== 2}
                  onClick={() => revoke.mutate(passkey)}
                  data-testid="revoke-passkey"
                >
                  {revoke.isPending ? "Revoking…" : "Revoke"}
                </Button>
              </li>
            ))}
          </ul>
          {(passkeys.data?.length ?? 0) === 1 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Add a backup passkey before revoking — revoking your only passkey would lock you out
              of your saved trust.
            </p>
          )}
          {(passkeys.data?.length ?? 0) > 2 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Revoking needs exactly two passkeys enrolled. With more, this device cannot reseal for
              every survivor — revoke from each surviving device instead.
            </p>
          )}
        </div>
      )}

      {status !== null && (
        <p className="text-sm font-medium" data-testid="trust-status">
          {status}
        </p>
      )}
      {error !== null && (
        <p className="text-sm font-medium text-destructive" data-testid="trust-error">
          {error}
        </p>
      )}

      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          Recovery &amp; diagnostics
        </summary>
        <div className="mt-2 flex flex-col gap-3">
          {actionRow({
            title: "Forget trust on this browser",
            description:
              "Removes every host this browser recognizes; connections are unprotected until trusted again.",
            button: (
              <Button
                type="button"
                variant="secondary"
                disabled={busy || accountId === null || (localPins.data?.length ?? 0) === 0}
                onClick={() => forget.mutate()}
                data-testid="forget-trust"
              >
                {forget.isPending ? "Forgetting…" : "Forget"}
              </Button>
            ),
          })}
          <div className="rounded border p-3 text-sm" data-testid="storage-report">
            <p className="font-semibold">Browser storage</p>
            {storage.isLoading || storage.data === undefined ? (
              <p className="text-muted-foreground">checking…</p>
            ) : (
              <ul className="mt-1 font-mono text-xs">
                <li>device identity persisted: {String(storage.data.identityPersisted)}</li>
                <li>plain value persists: {String(storage.data.probe.plainValuePersists)}</li>
                <li>Ed25519 key persists: {String(storage.data.probe.ed25519KeyPersists)}</li>
                <li>ECDSA key persists: {String(storage.data.probe.ecdsaKeyPersists)}</li>
                {storage.data.probe.failure !== null && (
                  <li className="text-destructive">failure: {storage.data.probe.failure}</li>
                )}
              </ul>
            )}
            {storage.data !== undefined && !storage.data.identityPersisted && (
              <p className="mt-2 text-destructive">
                This browser did not keep its device identity. It will mint a new one on every load
                and can never be trusted, so signed connections cannot work here.
              </p>
            )}
          </div>
        </div>
      </details>

      <p className="border-t border-border pt-3 text-xs text-muted-foreground">
        Approving new devices happens in{" "}
        <button type="button" className="underline" onClick={() => openSettings("devices")}>
          Browser devices
        </button>
        : press Approve next to the waiting device and compare fingerprints.
      </p>
    </section>
  );
}
