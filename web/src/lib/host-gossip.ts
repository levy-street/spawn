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
 *    Rows under this device's OWN key count as firsthand too — nothing but
 *    its private key could have signed them; the desktop app's window
 *    inherits the app's key and the hosts the app possessed with it.
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
import { AccountHealError, ensureRootRegistered, healAccount } from "./account-heal";
import { generateAccountRoot } from "./account-root";
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
  createBrowserEndorsementProof,
  createHostIntroductionBroadcastProof,
  createRootIntroductionProof,
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
import { planRootAnchorSweep, planRootIntroductionAcceptance } from "./root-introduction";
import { loadFirsthandRoot, rememberFirsthandRoot } from "./root-knowledge";

export const PEER_DEVICE_KEYS_QUERY_KEY = ["peer-device-keys"] as const;
export const HOST_INTRODUCTIONS_QUERY_KEY = ["host-introductions"] as const;
export const ROOT_INTRODUCTIONS_QUERY_KEY = ["root-introductions"] as const;

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

/**
 * Whether this device should MINT the account root now (passkey-free
 * establishment / backfill, Stage 1). Every condition is a fail-closed gate;
 * the mint fires only when ALL hold:
 *
 *  - this device knows no root firsthand (else it should CONSUME/anchor, not mint);
 *  - there is NO passkey bundle (`bundleAbsent`) — a bundle's root is minted and
 *    sealed by the passkey flow (setup, or retrofit-on-unlock), so a rival
 *    keyless mint here would make every later unlock throw `root_conflict`;
 *  - this device is itself a LIVE roster member (`selfIsLive`) — a revoked or
 *    absent device must never mint a root nobody can heal;
 *  - the roster carries no LIVE `is_root` row — a live root means the account
 *    already has one, and this is the client half of the server's one-live-root
 *    guard (which serializes any residual race). A merely REVOKED `is_root` row
 *    is not a live root and never blocks a fresh mint;
 *  - this device is an established member — it holds at least one active host
 *    pin, i.e. it verified a host key out of band.
 *
 * Pure so the establishment gate is directly testable; the orchestration it
 * guards reuses `healAccount`.
 */
export function shouldEstablishAccountRoot(input: {
  holdsFirsthandRoot: boolean;
  bundleAbsent: boolean;
  selfIsLive: boolean;
  deviceRows: readonly Pick<BrowserDevice, "is_root" | "revoked_at">[];
  activePinCount: number;
}): boolean {
  if (input.holdsFirsthandRoot) return false;
  if (!input.bundleAbsent) return false;
  if (!input.selfIsLive) return false;
  if (input.deviceRows.some((d) => d.is_root && d.revoked_at === null)) return false;
  return input.activePinCount > 0;
}

/**
 * Revoke an orphaned establishment root (registered, but the heal that would
 * make it useful failed) with a few retries, so the one-live-root gate reopens.
 * A total failure is logged loudly — it leaves a live root nobody can heal and
 * the gate shut until it is removed under Access.
 */
async function revokeOrphanRoot(
  deviceId: string,
  publicKey: string,
  byDeviceId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await browserDevices.revoke(deviceId, publicKey, byDeviceId);
      return;
    } catch {
      // retry
    }
  }
  console.error(
    "spawn: could not revoke an orphaned account root; the root gate stays shut until it is removed under Access → Advanced",
  );
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
  const rootRows = useQuery({
    queryKey: [...ROOT_INTRODUCTIONS_QUERY_KEY],
    queryFn: trust.listRootIntroductions,
    enabled: ready,
    refetchInterval: 60_000,
  });

  // Session-scoped work ledgers so each poll cycle only touches new rows.
  const publishedRef = useRef<Set<string>>(new Set());
  const consumedRef = useRef<Set<string>>(new Set());
  const forgottenRef = useRef<Set<string>>(new Set());
  const sweptRef = useRef<Set<string>>(new Set());
  const rootIntroPublishedRef = useRef<string | null>(null);
  // One passkey-free establishment ATTEMPT per mount: a post-register failure
  // revokes its orphan root (a permanent R10 tombstone), and the roster change
  // re-fires this effect — so an unbounded retry would mint and tombstone a
  // fresh root every poll. One attempt caps that; a route change or reload
  // remounts this and retries (human-bounded, like the other work ledgers).
  const establishAttemptedRef = useRef(false);
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

        // CONSUME: verify + pin rows from firsthand-known publishers — peers
        // met in a ceremony, and this device itself.
        const fresh = allRows.filter((row) => !consumedRef.current.has(row.id));
        if (fresh.length > 0) {
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
                // A broadcast row must never resurrect a key the operator
                // removed HERE: reactivation is reserved for a fresh explicit
                // ceremony. Without this, a stale peer's standing row for a
                // re-keyed host's OLD key would re-activate the tombstone on
                // every fresh session and re-wedge the Host-ID binding the
                // re-possess just migrated to the new key.
                reactivateRevoked: false,
              });
              await resolveActiveBrowserHostPin({
                accountId,
                origin,
                hostId: intro.hostId,
                claimedHostPublicKey: intro.hostPublicKey,
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
            if (
              trustedPeerKeys.has(row.publisher_public_key) ||
              row.publisher_public_key === ownDevice.public_key
            ) {
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

        // ---- ROOT leg (mesh §4.1): learn pk_R firsthand, keep it published,
        // ---- and anchor it on every host this PINNED device can speak for.
        if (identity !== null && identity.publicKeyWire === ownDevice.public_key) {
          await runRootLeg({
            accountId,
            origin,
            identity,
            ownDevice,
            deviceRows,
            hostRows,
            trustedPeerKeys,
            claimedRootRows: rootRows.data ?? [],
            sweptHostIds: sweptRef.current,
            publishedRootRef: rootIntroPublishedRef,
            establishmentAttempted: establishAttemptedRef,
          });
        }
      } finally {
        busyRef.current = false;
      }
    })();
  }, [ready, rows.data, devices.data, hostList.data, rootRows.data, registration.data]);
}

/**
 * The root gossip + sweep cycle. Everything here is deny-only against a lying
 * server: consumption honors only firsthand-verified introductions (with the
 * fail-closed conflict rule), and the sweep's pin lists are advisory — a lie
 * causes at most a skipped or refused statement, never a forged anchor (the
 * daemon re-verifies every signature against keys it already pins).
 */
async function runRootLeg(input: {
  accountId: string;
  origin: string;
  identity: BrowserDeviceIdentity;
  ownDevice: { id: string; public_key: string };
  deviceRows: readonly BrowserDevice[];
  hostRows: readonly { id: string; name: string; host_public_key?: string | null }[];
  trustedPeerKeys: ReadonlySet<string>;
  claimedRootRows: readonly {
    introducer_device_id: string;
    introducer_public_key: string;
    root_public_key: string;
    signature: string;
  }[];
  sweptHostIds: Set<string>;
  publishedRootRef: { current: string | null };
  establishmentAttempted: { current: boolean };
}): Promise<void> {
  const { accountId, origin, identity, ownDevice } = input;

  // CONSUME: a verified introduction may hand this device pk_R (or a
  // corroborated successor). Conflicts record nothing and are loud.
  let held = await loadFirsthandRoot({ accountId, origin }).catch(() => null);
  if (input.trustedPeerKeys.size > 0 && input.claimedRootRows.length > 0) {
    let tombstonedKeys: string[] = [];
    try {
      tombstonedKeys = (await browserDevices.revokedKeys()).map((row) => row.public_key);
    } catch {
      // Unfetchable tombstones corroborate nothing; rotation simply waits.
    }
    const plan = await planRootIntroductionAcceptance({
      accountId,
      ownPublicKey: ownDevice.public_key,
      trustedPeerKeys: input.trustedPeerKeys,
      knownRootPublicKey: held?.rootPublicKey ?? null,
      devices: input.deviceRows,
      tombstonedKeys,
      claimed: input.claimedRootRows,
    });
    for (const conflict of plan.conflicts) {
      console.error(`spawn: root introduction conflict: ${conflict}`);
    }
    for (const reason of plan.rejected) {
      console.warn(`spawn: root introduction rejected: ${reason}`);
    }
    if (plan.accept !== null) {
      try {
        await rememberFirsthandRoot(
          {
            accountId,
            origin,
            rootPublicKey: plan.accept,
            source: "introduction",
            // planRootIntroductionAcceptance only yields a successor over a
            // held key after corroborated rotation — replace is earned.
            replace: held !== null,
          },
          {},
        );
        held = await loadFirsthandRoot({ accountId, origin }).catch(() => null);
      } catch (cause) {
        console.error(
          "spawn: recording the introduced root failed:",
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
  }

  // ESTABLISH (passkey-free root establishment / backfill, Stage 1): when no
  // root exists anywhere, no passkey bundle owns one, and this LIVE, established
  // member holds active host pins, mint the account root, register it, heal
  // every VERIFIED-reachable device onto it (R→d), anchor R on this device's
  // hosts, and publish its introduction. Mirrors trust-passkeys `healBestEffort`
  // minus the passkey. `sk_R` is used here and then goes out of scope: Stage 1
  // keeps no durable custody without a passkey (device-wrapped custody is Stage
  // 2). The server's one-live-root index serializes concurrent minters — the
  // loser's `ensureRootRegistered` 409s and it consumes the winner's
  // introduction on a later cycle. Fetch the pins/bundle only when establishment
  // is even conceivable (no root known firsthand and none live in the roster) —
  // never on the common path where a root already exists.
  const rootAbsent =
    held === null && !input.deviceRows.some((d) => d.is_root && d.revoked_at === null);
  if (rootAbsent) {
    const [ownPins, bundleAbsent] = await Promise.all([
      listActiveBrowserHostPins({ accountId, origin }).catch(() => [] as BrowserHostPin[]),
      // Fail closed: a bundle we cannot confirm ABSENT (a fetch error) is
      // treated as present, so we never mint a rival to a passkey-owned root.
      trust
        .getBundle()
        .then((b) => b === null)
        .catch(() => false),
    ]);
    const selfIsLive = input.deviceRows.some(
      (d) => d.public_key === ownDevice.public_key && d.revoked_at === null,
    );
    if (
      !input.establishmentAttempted.current &&
      shouldEstablishAccountRoot({
        holdsFirsthandRoot: held !== null,
        bundleAbsent,
        selfIsLive,
        deviceRows: input.deviceRows,
        activePinCount: ownPins.length,
      })
    ) {
      // Spend the session's single attempt before the first write, so a
      // post-register failure (which revokes its orphan and re-fires this
      // effect) cannot mint-and-tombstone a fresh root every poll cycle.
      input.establishmentAttempted.current = true;
      const root = await generateAccountRoot();
      try {
        // Register FIRST (the one-live-root gate); only a successful register
        // yields a row this device is responsible for.
        const rootRow = await ensureRootRegistered(root, accountId);
        try {
          const report = await healAccount(
            root,
            accountId,
            identity,
            ownPins.map((pin) => ({
              hostPublicKey: pin.hostPublicKey,
              hostFingerprint: pin.hostFingerprint,
              hostIds: pin.hostIds,
            })),
          );
          if (report.failedEndorsementDeviceIds.length > 0 || report.refusedHosts.length > 0) {
            console.warn(
              "spawn: account root establishment healed partially —",
              `${report.failedEndorsementDeviceIds.length} endorsement(s) failed,`,
              `${report.refusedHosts.length} host anchor(s) refused`,
            );
          }
          // A heal that endorsed nothing (this device was revoked within the
          // roster-staleness window, so it has no live row to self-endorse from)
          // left a live root with zero edges/anchors nobody holds `sk_R` for.
          // Treat it as a failure so the catch below revokes the orphan.
          if (report.currentDeviceId === null) {
            throw new Error(
              "establishment heal endorsed nothing (device not a live roster member)",
            );
          }
          // Non-fatal (mirrors `healBestEffort`): an unrecordable firsthand
          // memory only mutes this device's own future sweep; the introduction
          // below still publishes so pinned peers can anchor R.
          await rememberFirsthandRoot(
            { accountId, origin, rootPublicKey: root.publicKeyWire, source: "mint" },
            {},
          ).catch(() => {});
          try {
            await trust.publishRootIntroduction({
              introducer_device_id: ownDevice.id,
              root_public_key: root.publicKeyWire,
              signature: await createRootIntroductionProof(identity, accountId, root.publicKeyWire),
            });
            // This cycle's republish leg has nothing left to do.
            input.publishedRootRef.current = root.publicKeyWire;
          } catch {
            // The republish leg below covers this on the next cycle.
          }
          held = await loadFirsthandRoot({ accountId, origin }).catch(() => null);
        } catch (healError) {
          // Registered but could not heal (e.g. the heal's initial roster/edge
          // read failed): revoke the orphan root so the one-live-root gate
          // REOPENS and a healthy device re-establishes next cycle, rather than
          // leaving a live root nobody holds `sk_R` for and no device knows
          // firsthand — which would strand the account with the gate shut.
          await revokeOrphanRoot(rootRow.id, root.publicKeyWire, ownDevice.id);
          throw healError;
        }
      } catch (cause) {
        // A one-live-root 409 (another device won the race) or a post-register
        // failure whose orphan we just revoked: establish nothing now and
        // consume the winner's / a later mint's introduction on a later cycle.
        // A `root_conflict` is a substituted-root signal — logged louder.
        const conflict = cause instanceof AccountHealError && cause.code === "root_conflict";
        (conflict ? console.error : console.warn)(
          "spawn: account root establishment skipped:",
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
  }
  if (held === null) return;

  // REPUBLISH: keep this device's own durable introduction current — but only
  // from provenance the channel is defined for (mint/unlock knowledge; an
  // introduction-derived key is consumed here, not re-vouched).
  if (held.source !== "introduction" && input.publishedRootRef.current !== held.rootPublicKey) {
    const mine = input.claimedRootRows.find((row) => row.introducer_device_id === ownDevice.id);
    if (mine === undefined || mine.root_public_key !== held.rootPublicKey) {
      try {
        await trust.publishRootIntroduction({
          introducer_device_id: ownDevice.id,
          root_public_key: held.rootPublicKey,
          signature: await createRootIntroductionProof(identity, accountId, held.rootPublicKey),
        });
      } catch (cause) {
        console.warn(
          "spawn: publishing the root introduction failed:",
          cause instanceof Error ? cause.message : cause,
        );
      }
    }
    input.publishedRootRef.current = held.rootPublicKey;
  }

  // THE SWEEP: anchor the firsthand-known root on hosts this device pins that
  // do not carry it yet. The roster's is_root row supplies only the DEVICE ID
  // to bind; its key must equal the firsthand pk_R or nothing is signed —
  // a substituted root row aborts loudly (provenance rule, P2).
  const rosterRoot = input.deviceRows.find((d) => d.is_root && d.revoked_at === null);
  if (rosterRoot === undefined) return; // nothing registered to anchor yet
  if (rosterRoot.public_key !== held.rootPublicKey) {
    console.error(
      "spawn: the server's account root does not match the firsthand-known root; " +
        "no anchors were written",
    );
    return;
  }

  const pins = await listActiveBrowserHostPins({ accountId, origin }).catch(
    () => [] as BrowserHostPin[],
  );
  if (pins.length === 0) return;
  const sweepPins = pins.map((pin) => ({
    hostPublicKey: pin.hostPublicKey,
    hostIds:
      pin.hostIds.length > 0
        ? pin.hostIds
        : input.hostRows
            .filter((host) => host.host_public_key === pin.hostPublicKey)
            .map((host) => host.id),
  }));
  const pinsByHost = new Map<string, readonly string[]>();
  for (const pin of sweepPins) {
    for (const hostId of pin.hostIds) {
      if (pinsByHost.has(hostId) || input.sweptHostIds.has(hostId)) continue;
      const pinned = await trust.hostPins(hostId).catch(() => undefined);
      if (pinned !== undefined) pinsByHost.set(hostId, pinned);
    }
  }
  const targets = planRootAnchorSweep({
    ownDeviceId: ownDevice.id,
    rootDeviceId: rosterRoot.id,
    pins: sweepPins,
    pinsByHost,
  });
  for (const target of targets) {
    try {
      input.sweptHostIds.add(target.hostId);
      const signature = await createBrowserEndorsementProof(
        identity,
        accountId,
        target.hostPublicKey, // from the LOCAL pin — firsthand
        held.rootPublicKey,
        rosterRoot.id,
      );
      await trust.endorse({
        host_id: target.hostId,
        endorser_device_id: ownDevice.id,
        endorsed_device_id: rosterRoot.id,
        signature,
      });
    } catch (cause) {
      // 409 = this device is not pinned there after all (advisory data was
      // stale) — harmless; retry next cycle in case it was transient.
      input.sweptHostIds.delete(target.hostId);
      console.warn(
        "spawn: root anchor sweep skipped a host:",
        cause instanceof Error ? cause.message : cause,
      );
    }
  }
}
