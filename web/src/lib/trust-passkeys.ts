"use client";

/**
 * Passkey-backed trust, as one reusable hook (docs/TRUST_UX.md: the passkey is
 * the whole safety story — "recovery" is not a concept the UI teaches).
 *
 * The mutation BODIES live in passkey-flows.ts as plain functions over an
 * injected IO seam, so their ordering and interleaving guarantees are
 * unit-tested (P-C5/P-C6); this hook wires them to the real API client,
 * WebAuthn, and the heal machinery, and owns the screen voice — status and
 * error copy. Surfaces mount whichever slices they need — the Access screen
 * its "Use passkey" and "Add passkey" moments, account settings the passkey
 * list.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  AccountHealError,
  type AccountHealReport,
  ensureRootRegistered,
  healAccount,
  unionHealHosts,
} from "@/lib/account-heal";
import type { AccountRoot } from "@/lib/account-root";
import { browserDevices, type PasskeyCredential, trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  createRootIntroductionProof,
  loadBrowserDeviceIdentity,
} from "@/lib/browser-device-identity";
import { browserHostPinServerOrigin, listActiveBrowserHostPins } from "@/lib/browser-host-pins";
import {
  addBackupPasskey,
  describeUnlockImport,
  type HealOutcome,
  type PasskeyFlowsIo,
  removeBackupPasskey,
  removeLastPasskey,
  setUpPasskey,
  unlockPasskey,
} from "@/lib/passkey-flows";
import {
  createTrustPasskey,
  evaluateTrustPrf,
  isPasskeySupported,
  PasskeyPrfError,
} from "@/lib/passkey-prf";
import { rememberFirsthandRoot } from "@/lib/root-knowledge";
import { probeStoragePersistence } from "@/lib/storage-diagnostics";
import { forgetTrustOnThisDevice } from "@/lib/trust-bootstrap";
import type { TrustBundleHost } from "@/lib/trust-bundle";
import { envelopeWrapCredentialIds } from "@/lib/trust-envelope";

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

  /**
   * Which credentials hold a wrap in the CURRENT envelope — the honest
   * "protects something" set. A server-listed credential outside it is a
   * ghost (a partial enrollment's leftover): it opens nothing, is never
   * offered at unlock, and account settings lets it be removed as cleanup.
   * Null while unknown (no bundle, or an unparseable one).
   */
  const wrapCredentialIds = useMemo(() => {
    const sealed = bundle.data?.sealed;
    if (accountId === null || sealed === undefined) return null;
    try {
      return envelopeWrapCredentialIds(accountId, sealed);
    } catch {
      return null;
    }
  }, [accountId, bundle.data?.sealed]);

  function begin() {
    setStatus(null);
    setError(null);
  }

  function flowsIo(): PasskeyFlowsIo {
    const id = accountId as string;
    return {
      scope: { accountId: id },
      userLabel: user?.email ?? "SPAWN D operator",
      trust,
      browserDevices,
      createTrustPasskey,
      evaluateTrustPrf,
      heal: (root, hosts, source) => healBestEffort(id, root, hosts, source),
    };
  }

  /** See setUpPasskey (passkey-flows.ts) for the seal-before-enroll ordering. */
  const setUp = useMutation({
    mutationFn: () => setUpPasskey(flowsIo()),
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

  /** See unlockPasskey (passkey-flows.ts): import + heal + honest offer/repair. */
  const unlock = useMutation({
    mutationFn: () => unlockPasskey(flowsIo()),
    onMutate: begin,
    onSuccess: ({ imported, heal, warning, resealFailure, repairFailure }) => {
      const base = describeUnlockImport(imported);
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
      if (repairFailure !== null) {
        problems.push(
          `Re-listing this passkey for the account failed: ${repairFailure} ` +
            "It still works here; use it again later so other devices can see it.",
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
   * Forgetting DELETES the local records (no tombstones — see
   * forgetTrustOnThisDevice), so the device truly returns to the unpinned
   * path and a later passkey use brings the hosts back.
   */
  const forget = useMutation({
    mutationFn: () => forgetTrustOnThisDevice({ accountId: accountId as string }),
    onMutate: begin,
    onSuccess: (result) => {
      setStatus(
        result.forgotten === 0
          ? "This device held no host trust to forget."
          : `Forgot ${result.forgotten} host${result.forgotten === 1 ? "" : "s"}. This device now connects unprotected until it is trusted again — using your passkey brings them back.`,
      );
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describePasskeyError(err)),
  });

  /** See addBackupPasskey (passkey-flows.ts): wrap first, enroll after. */
  const addBackup = useMutation({
    mutationFn: () => addBackupPasskey(flowsIo()),
    onMutate: begin,
    onSuccess: () => {
      setStatus("Backup passkey added. Either passkey now works.");
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describePasskeyError(err)),
  });

  /**
   * Remove a passkey while another remains. A wrap-holding credential is
   * revoked by resealing for the one surviving wrap-holder; a ghost (no wrap
   * in the current envelope) is deleted as cleanup after a working passkey
   * proves the envelope. See removeBackupPasskey (passkey-flows.ts).
   */
  const revokePasskey = useMutation({
    mutationFn: (target: PasskeyCredential) => removeBackupPasskey(flowsIo(), target),
    onMutate: begin,
    onSuccess: (outcome) => {
      setStatus(
        outcome.kind === "ghost"
          ? "Passkey removed. It couldn't open your saved protection, so nothing else changed."
          : "Passkey removed. It no longer opens anything.",
      );
      queryClient.invalidateQueries({ queryKey: ["trust"] });
    },
    onError: (err) => setError(describePasskeyError(err)),
  });

  /**
   * Remove the ONLY passkey — abandoning the protection it provided. The
   * caller shows the honest cost before calling. One state re-asks: a bundle
   * that exists but cannot be read is only abandoned when the caller passes
   * `acknowledgeUnreadable` after showing exactly that state (the flow throws
   * UnreadableTrustStateError otherwise). See removeLastPasskey
   * (passkey-flows.ts).
   */
  const removeLast = useMutation({
    mutationFn: ({
      target,
      acknowledgeUnreadable,
    }: {
      target: PasskeyCredential;
      acknowledgeUnreadable?: boolean;
    }) => removeLastPasskey(flowsIo(), target, { acknowledgeUnreadable }),
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
    removeLast.isPending;

  return {
    accountId,
    passkeys,
    bundle,
    storage,
    localPins,
    wrapCredentialIds,
    setUp,
    unlock,
    forget,
    addBackup,
    revokePasskey,
    removeLastPasskey: removeLast,
    busy,
    status,
    error,
    supported: isPasskeySupported(),
    hasBundle: bundle.data !== null && bundle.data !== undefined,
  };
}
