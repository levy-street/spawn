"use client";

/**
 * Continuous host-key gossip (docs/TRUST_DEVICE_MESH.md R7, continuous leg).
 *
 * The ceremony leg hands a NEW device the approver's hosts once; this module
 * makes the handoff ongoing in both roles, silently:
 *
 *  - PUBLISH: any host key this device verified out of band (its ACTIVE local
 *    pins) that is not yet in the account's introduction store under this
 *    device's signature gets published — at possess time and via a reconcile
 *    sweep, so pre-existing pins flow out too.
 *  - CONSUME: rows whose publisher key this device holds FIRSTHAND (its peer
 *    device-key store, seeded only inside ceremonies) are verified against
 *    that firsthand key and pinned locally, exactly as a hand-run possession.
 *
 * The server is the mailbox: it can withhold rows (denial, which it always
 * could) but cannot forge one — substituting any field kills the signature,
 * and a signature under a key nobody learned firsthand moves no trust.
 * A row whose host key CONFLICTS with an existing local binding never
 * overwrites it: the pin already held wins, and the conflict is precisely the
 * substitution signal the pin store refuses on.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  type BrowserDevice,
  browserDevices,
  type HostIntroductionRow,
  hosts as hostsApi,
  trust,
} from "./api";
import { useAuth } from "./auth";
import {
  type BrowserDeviceIdentity,
  createHostIntroductionBroadcastProof,
  loadBrowserDeviceIdentity,
} from "./browser-device-identity";
import { useBrowserDeviceRegistration } from "./browser-device-registration";
import {
  approveBrowserHostPin,
  type BrowserHostPin,
  browserHostPinServerOrigin,
  listActiveBrowserHostPins,
  resolveActiveBrowserHostPin,
} from "./browser-host-pins";
import { planBroadcastIntroductionAcceptance } from "./host-introduction";
import { forgetPeerDeviceKey, listPeerDeviceKeys } from "./peer-device-keys";

export const PEER_DEVICE_KEYS_QUERY_KEY = ["peer-device-keys"] as const;
export const HOST_INTRODUCTIONS_QUERY_KEY = ["host-introductions"] as const;

export interface BroadcastPublishTarget {
  readonly hostId: string;
  readonly hostName: string;
  readonly hostPublicKey: string;
}

/**
 * Which of this device's ACTIVE pins still lack its own broadcast row. Pure:
 * pins vouch keys; the host list supplies ids/names for pins not yet bound.
 */
export function planBroadcastPublishes(input: {
  ownPublicKey: string;
  pins: readonly Pick<BrowserHostPin, "hostPublicKey" | "hostIds">[];
  hostList: readonly { id: string; name: string; host_public_key?: string | null }[];
  rows: readonly Pick<HostIntroductionRow, "publisher_public_key" | "host_public_key">[];
}): BroadcastPublishTarget[] {
  const mine = new Set(
    input.rows
      .filter((row) => row.publisher_public_key === input.ownPublicKey)
      .map((row) => row.host_public_key),
  );
  const targets: BroadcastPublishTarget[] = [];
  for (const pin of input.pins) {
    if (mine.has(pin.hostPublicKey)) continue;
    const boundId =
      pin.hostIds[0] ??
      input.hostList.find((host) => host.host_public_key === pin.hostPublicKey)?.id;
    if (boundId === undefined) continue; // unresolvable yet; a later sweep retries
    const name = input.hostList.find((host) => host.id === boundId)?.name ?? "host";
    targets.push({ hostId: boundId, hostName: name, hostPublicKey: pin.hostPublicKey });
  }
  return targets;
}

/** Sign + publish one broadcast introduction. Best-effort; throws to caller. */
export async function publishHostIntroductionBroadcast(input: {
  accountId: string;
  deviceId: string;
  identity: BrowserDeviceIdentity;
  target: BroadcastPublishTarget;
}): Promise<void> {
  const signature = await createHostIntroductionBroadcastProof(
    input.identity,
    input.accountId,
    input.target.hostPublicKey,
  );
  await trust.publishHostIntroduction({
    publisher_device_id: input.deviceId,
    host_id: input.target.hostId,
    host_name: input.target.hostName,
    host_public_key: input.target.hostPublicKey,
    signature,
  });
}

/**
 * The background sync, both roles. Mounted app-level (AppShell); everything is
 * silent by design — failures leave the device exactly where it was (verified
 * hosts stay verified, unverified ones stay honestly first-contact) and the
 * next cycle retries.
 */
export function useHostGossipSync(): void {
  const { user } = useAuth();
  const qc = useQueryClient();
  const registration = useBrowserDeviceRegistration(user?.id);
  const ready = user !== null && registration.data?.status === "ready";

  const rows = useQuery({
    queryKey: [...HOST_INTRODUCTIONS_QUERY_KEY],
    queryFn: trust.listHostIntroductions,
    enabled: ready,
    refetchInterval: 60_000,
  });
  const devices = useQuery({
    queryKey: ["browser-devices"],
    queryFn: browserDevices.list,
    enabled: ready,
    // Shared cache key: the ceremony host polls this at 10s app-wide already.
  });
  const hostList = useQuery({
    queryKey: ["trust", "hosts"],
    queryFn: () => hostsApi.list(),
    enabled: ready,
  });

  // Session-scoped work ledgers so each poll cycle only touches new rows.
  const publishedRef = useRef<Set<string>>(new Set());
  const consumedRef = useRef<Set<string>>(new Set());
  const forgottenRef = useRef<Set<string>>(new Set());
  const busyRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: poll-driven effect keyed on poll data
  useEffect(() => {
    if (!ready || user === null) return;
    if (rows.data === undefined || devices.data === undefined) return;
    if (registration.data?.status !== "ready") return;
    if (busyRef.current) return;
    busyRef.current = true;
    const accountId = user.id;
    const ownDevice = registration.data.device;
    const allRows = rows.data;
    const deviceRows = devices.data;
    const hostRows = hostList.data ?? [];
    void (async () => {
      try {
        const origin = browserHostPinServerOrigin();

        // Hygiene: a revoked peer's key leaves the firsthand store (its vouches
        // must stop being honored here; the account deny-list already severed
        // its access). Its delivered pins stay — they are OUR verified state.
        const revokedKeys = new Set(
          deviceRows.filter((d: BrowserDevice) => d.revoked_at !== null).map((d) => d.public_key),
        );
        const peers = await listPeerDeviceKeys({ accountId, origin }).catch(() => []);
        for (const peer of peers) {
          if (revokedKeys.has(peer.publicKey) && !forgottenRef.current.has(peer.publicKey)) {
            forgottenRef.current.add(peer.publicKey);
            await forgetPeerDeviceKey({ accountId, origin, publicKey: peer.publicKey }).catch(
              () => {},
            );
          }
        }
        const trustedPeerKeys = new Set(
          peers.filter((peer) => !revokedKeys.has(peer.publicKey)).map((peer) => peer.publicKey),
        );

        // CONSUME: verify + pin rows from firsthand-known publishers.
        const fresh = allRows.filter((row) => !consumedRef.current.has(row.id));
        if (fresh.length > 0 && trustedPeerKeys.size > 0) {
          const plan = await planBroadcastIntroductionAcceptance({
            accountId,
            ownPublicKey: ownDevice.public_key,
            trustedPeerKeys,
            claimed: fresh,
          });
          for (const intro of plan.accepted) {
            try {
              await approveBrowserHostPin({
                accountId,
                origin,
                hostPublicKey: intro.hostPublicKey,
                hostFingerprint: intro.hostFingerprint,
              });
              await resolveActiveBrowserHostPin({
                accountId,
                origin,
                hostId: intro.hostId,
                claimedHostPublicKey: intro.hostPublicKey,
                claimedHostFingerprint: intro.hostFingerprint,
              });
            } catch (cause) {
              // A conflicting binding is the substitution signal: the pin this
              // device verified itself stays authoritative and is never
              // overwritten. The trace keeps the refusal diagnosable.
              console.warn(
                `spawn: host introduction for ${intro.hostName} not applied:`,
                cause instanceof Error ? cause.message : cause,
              );
            }
          }
          for (const reason of plan.rejected) {
            console.warn(`spawn: host introduction rejected: ${reason}`);
          }
          // Every trusted-publisher row has now been fully judged this round
          // (applied, binding-refused, or unverifiable-forever); ledger them
          // all. Unknown-publisher rows stay fresh — the peer key may arrive
          // in a later ceremony and make them honorable.
          for (const row of fresh) {
            if (trustedPeerKeys.has(row.publisher_public_key)) {
              consumedRef.current.add(row.id);
            }
          }
        }

        // PUBLISH: the reconcile sweep — every ACTIVE pin without our row.
        const identity = await loadBrowserDeviceIdentity(accountId).catch(() => null);
        if (identity !== null && identity.publicKeyWire === ownDevice.public_key) {
          const pins = await listActiveBrowserHostPins({ accountId, origin }).catch(() => []);
          const targets = planBroadcastPublishes({
            ownPublicKey: ownDevice.public_key,
            pins,
            hostList: hostRows,
            rows: allRows,
          }).filter((target) => !publishedRef.current.has(target.hostPublicKey));
          for (const target of targets) {
            try {
              publishedRef.current.add(target.hostPublicKey);
              await publishHostIntroductionBroadcast({
                accountId,
                deviceId: ownDevice.id,
                identity,
                target,
              });
            } catch (cause) {
              publishedRef.current.delete(target.hostPublicKey); // retry next sweep
              console.warn(
                `spawn: publishing host introduction for ${target.hostName} failed:`,
                cause instanceof Error ? cause.message : cause,
              );
            }
          }
          if (targets.length > 0) {
            void qc.invalidateQueries({ queryKey: [...HOST_INTRODUCTIONS_QUERY_KEY] });
          }
        }
      } finally {
        busyRef.current = false;
      }
    })();
  }, [ready, rows.data, devices.data, hostList.data, registration.data]);
}
