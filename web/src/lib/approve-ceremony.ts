"use client";

/**
 * The approve-a-device ceremony, entry-style (docs/TRUST_UX.md; protocol per
 * docs/TRUST_DEVICE_MESH.md §4, Appendix A).
 *
 * One human check admits a device to the whole account. The NEW device shows
 * the committed-ephemeral SAS number; the device the operator already uses
 * TYPES it. A correct entry is the approval — the approver signs its account
 * endorsement with no further tap. The new device then verifies that
 * endorsement's signature against the ceremony-authenticated initiator key and
 * signs the reciprocal edge automatically: one entry covers both directions
 * (P4 — one ceremony, one human action).
 *
 * The wire protocol is unchanged from the shipped mesh: the same DevicePairing
 * relay, the same commit/reveal, the same mutual account endorsements. Only
 * who displays and who confirms moved.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { encodeAcctEndorsementTranscript } from "@/lib/acct-endorsement-transcript";
import {
  ceremonySas,
  commitWire,
  freshSasNonce,
  verifyCommitWire,
} from "@/lib/add-device-ceremony";
import {
  type BrowserDevice,
  hosts as hostsApi,
  type PairingDeviceIntroduction,
  type PairingIntroduction,
  type PairingState,
  trust,
} from "@/lib/api";
import {
  type BrowserDeviceIdentity,
  createAccountEndorsementProof,
  createDeviceIntroductionProof,
  createHostIntroductionProof,
  loadBrowserDeviceIdentity,
} from "@/lib/browser-device-identity";
import {
  approveBrowserHostPin,
  browserHostPinServerOrigin,
  listActiveBrowserHostPins,
  resolveActiveBrowserHostPin,
} from "@/lib/browser-host-pins";
import {
  MAX_DEVICE_INTRODUCTIONS,
  MAX_HOST_INTRODUCTIONS,
  planDeviceIntroductionAcceptance,
  planHostIntroductionAcceptance,
} from "@/lib/host-introduction";
import { listPeerDeviceKeys, rememberPeerDeviceKey } from "@/lib/peer-device-keys";
import { b64urlEncode } from "@/lib/sas";
import {
  decodeBase64Url,
  ED25519_SIGNATURE_BYTES,
  importEd25519PublicKeyWire,
} from "@/lib/signed-signal";

export const APPROVE_CEREMONY_TRIES = 3;

export type ApproveCeremonyRole = "approver" | "new-device";
export type ApproveCeremonyPhase = "connecting" | "compare" | "waiting" | "done" | "stopped";

export interface ApproveCeremonyView {
  pairingId: string;
  role: ApproveCeremonyRole;
  peerDeviceId: string;
  peerName: string;
  phase: ApproveCeremonyPhase;
  /** Displayed on the new device; the approver compares typed digits against it. */
  number: string | null;
  /** Approver only: wrong-entry feedback for the current attempt. */
  entryError: string | null;
  /** Set when the approver signed and is waiting on the reciprocal edge. */
  waitingSince: number | null;
}

/**
 * Verify one account-endorsement signature against a caller-chosen endorser
 * key. The caller passes the key it AUTHENTICATED (the pairing's committed
 * initiator key), never the edge's server-claimed one — a hostile server can
 * claim anything, but it cannot make this signature verify under the key the
 * ceremony bound.
 */
export async function verifyAccountEndorsementSignature(input: {
  accountId: string;
  endorserPublicKey: string;
  endorsedPublicKey: string;
  endorsedDeviceId: string;
  signature: string;
}): Promise<boolean> {
  try {
    const transcript = encodeAcctEndorsementTranscript(
      input.accountId,
      input.endorserPublicKey,
      input.endorsedPublicKey,
      input.endorsedDeviceId,
    );
    const owned = new ArrayBuffer(transcript.byteLength);
    new Uint8Array(owned).set(transcript);
    const signature = decodeBase64Url(input.signature, ED25519_SIGNATURE_BYTES);
    const ownedSignature = new ArrayBuffer(signature.byteLength);
    new Uint8Array(ownedSignature).set(signature);
    const key = await importEd25519PublicKeyWire(input.endorserPublicKey);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, ownedSignature, owned);
  } catch {
    return false;
  }
}

/**
 * The exact peer key bytes (wire form) that went into the SAS number — pinned
 * at SAS-compute time. The human's match authenticates THESE bytes and no
 * others, so every later verify and sign must use only these, never the live
 * relay row: a server that relayed honestly through the match could otherwise
 * swap the key on a later poll and collect a valid endorsement of a key the
 * human never checked.
 */
export interface PinnedCeremonyKeys {
  initiatorPublicKey: string;
  joinerPublicKey: string;
}

interface CeremonyRecord {
  sas: string | null;
  /** Pinned alongside `sas`; null exactly while `sas` is null. */
  pinnedKeys: PinnedCeremonyKeys | null;
  triesLeft: number;
  entryError: string | null;
  /** This side's endorsement has been recorded on the relay. */
  signedMine: boolean;
  /** JOINER side: relayed host introductions (R7), stashed from the live
   * pairing snapshot so the row's post-completion deletion cannot lose them.
   * Untrusted until verified against the pinned initiator key. */
  introductions: PairingIntroduction[] | null;
  /** JOINER side: relayed device-key introductions (continuous gossip
   * bootstrap), stashed under the same rule and judged the same way. */
  deviceIntroductions: PairingDeviceIntroduction[] | null;
  waitingSince: number | null;
  done: boolean;
  stopped: boolean;
}

const FRESH: CeremonyRecord = {
  sas: null,
  pinnedKeys: null,
  triesLeft: APPROVE_CEREMONY_TRIES,
  entryError: null,
  signedMine: false,
  introductions: null,
  deviceIntroductions: null,
  waitingSince: null,
  done: false,
  stopped: false,
};

const TAMPER_STOP_MESSAGE =
  "The other device's key changed mid-ceremony, so nothing was trusted. Start over.";

/** One account-endorsement edge as the server claims it (every field unverified). */
interface AccountEndorsementEdge {
  endorser_device_id: string;
  endorser_public_key: string;
  endorsed_device_id: string;
  endorsed_public_key: string;
  signature: string;
}

export type CeremonyStepPlan =
  | { kind: "wait" }
  | { kind: "abort"; reason: string }
  | { kind: "sign"; endorsedDeviceId: string; endorsedPublicKey: string };

/**
 * APPROVER side, after a correct entry: decide what to sign. The typed number
 * authenticated exactly the pinned bytes, so the endorsement target is the
 * PINNED joiner key — and only while the live relay row still carries the same
 * bytes. A key that differs from what the human matched is server tampering:
 * abort the ceremony, sign nothing.
 */
export function planApproverEndorsement(input: {
  pairing: Pick<PairingState, "initiator_public_key" | "joiner_public_key" | "joiner_device_id">;
  pinned: PinnedCeremonyKeys;
}): CeremonyStepPlan {
  if (
    input.pairing.initiator_public_key !== input.pinned.initiatorPublicKey ||
    input.pairing.joiner_public_key !== input.pinned.joinerPublicKey
  ) {
    return { kind: "abort", reason: "pairing keys changed after the match" };
  }
  return {
    kind: "sign",
    endorsedDeviceId: input.pairing.joiner_device_id,
    endorsedPublicKey: input.pinned.joinerPublicKey,
  };
}

/**
 * NEW-DEVICE side: decide whether the approver's endorsement is real and, if
 * so, what to reciprocate. Verifies the edge's signature against the PINNED
 * initiator key (the one whose commitment opened and whose bytes are in the
 * number the approver typed) and signs only those pinned bytes. Aborts if the
 * live relay row's keys no longer equal the pinned ones; waits (signing
 * nothing) while no verifiable edge exists.
 */
export async function planReciprocalEndorsement(input: {
  accountId: string;
  pairing: Pick<PairingState, "initiator_device_id" | "initiator_public_key" | "joiner_public_key">;
  pinned: PinnedCeremonyKeys;
  currentDevice: { id: string; public_key: string };
  edges: AccountEndorsementEdge[];
}): Promise<CeremonyStepPlan> {
  if (
    input.pairing.initiator_public_key !== input.pinned.initiatorPublicKey ||
    input.pairing.joiner_public_key !== input.pinned.joinerPublicKey
  ) {
    return { kind: "abort", reason: "pairing keys changed after the match" };
  }
  if (input.pinned.joinerPublicKey !== input.currentDevice.public_key) {
    // The number authenticated bytes this device does not hold.
    return { kind: "abort", reason: "the number did not cover this device's key" };
  }
  const edge = input.edges.find(
    (e) =>
      e.endorser_device_id === input.pairing.initiator_device_id &&
      e.endorsed_device_id === input.currentDevice.id,
  );
  if (!edge) return { kind: "wait" };
  if (
    edge.endorser_public_key !== input.pinned.initiatorPublicKey ||
    edge.endorsed_public_key !== input.currentDevice.public_key
  ) {
    // Server-claimed metadata names keys the ceremony never authenticated —
    // not the edge this ceremony is waiting for.
    return { kind: "wait" };
  }
  const valid = await verifyAccountEndorsementSignature({
    accountId: input.accountId,
    endorserPublicKey: input.pinned.initiatorPublicKey,
    endorsedPublicKey: input.currentDevice.public_key,
    endorsedDeviceId: input.currentDevice.id,
    signature: edge.signature,
  });
  if (!valid) return { kind: "wait" }; // forged or damaged — never reciprocate
  return {
    kind: "sign",
    endorsedDeviceId: input.pairing.initiator_device_id,
    endorsedPublicKey: input.pinned.initiatorPublicKey,
  };
}

export function useApproveDeviceCeremony({
  accountId,
  currentDevice,
  identity,
  devices,
  enabled = true,
}: {
  accountId: string;
  currentDevice: BrowserDevice | null;
  identity: BrowserDeviceIdentity | null;
  devices: BrowserDevice[];
  enabled?: boolean;
}) {
  const qc = useQueryClient();
  // Our own fresh nonce per ceremony (N_I as initiator, N_J as joiner).
  const noncesRef = useRef<Map<string, Uint8Array>>(new Map());
  // Guards so a poll that fires before the previous write lands does not double-submit.
  const actedRef = useRef<Set<string>>(new Set());
  // Role/peer per pairing, remembered past the relay row's deletion.
  const rolesRef = useRef<Map<string, { role: ApproveCeremonyRole; peerDeviceId: string }>>(
    new Map(),
  );
  const [records, setRecords] = useState<Map<string, CeremonyRecord>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const deviceId = currentDevice?.id ?? null;
  const active = enabled && deviceId !== null;

  const pairings = useQuery({
    queryKey: ["device-pairings", deviceId],
    queryFn: () => trust.listPairings(deviceId ?? ""),
    refetchInterval: 1500,
    enabled: active,
  });
  // Polled while ceremonies can be live, so each side notices the PEER's
  // endorsement landing and can flip to its completed state.
  const endorsements = useQuery({
    queryKey: ["account-endorsements"],
    queryFn: trust.accountEndorsements,
    refetchInterval: 4000,
    enabled: active,
  });

  const patch = (id: string, change: Partial<CeremonyRecord>) => {
    setRecords((prev) => {
      const next = new Map(prev);
      next.set(id, { ...(prev.get(id) ?? FRESH), ...change });
      return next;
    });
  };

  const invalidatePairings = () =>
    qc.invalidateQueries({ queryKey: ["device-pairings", deviceId] });

  /**
   * APPROVER side, after a correct entry: sign one host introduction per host
   * this device has itself verified (its ACTIVE local pins — it may only vouch
   * keys it checked out of band) toward the PINNED joiner key, and post them on
   * the relay BEFORE the endorsement edge. The ordering closes the completion
   * race: the joiner cannot see the edge (its cue to reciprocate and finish)
   * until the introductions are already on the row its poll snapshots.
   * Best-effort by design — a failure here must never block the approval, but
   * it is surfaced, not swallowed: the joiner then verifies each host on first
   * use exactly as before this leg existed.
   */
  const postIntroductions = async (
    pairing: PairingState,
    pinned: PinnedCeremonyKeys,
  ): Promise<void> => {
    try {
      const signer = (await loadBrowserDeviceIdentity(accountId)) ?? identity;
      if (!signer || !currentDevice) return;
      const origin = browserHostPinServerOrigin();
      const pins = await listActiveBrowserHostPins({ accountId, origin });
      const hostList = await hostsApi.list().catch(() => []);
      const items: PairingIntroduction[] = [];
      for (const pin of pins) {
        const boundIds =
          pin.hostIds.length > 0
            ? pin.hostIds
            : hostList
                .filter((host) => host.host_public_key === pin.hostPublicKey)
                .map((host) => host.id);
        if (boundIds.length === 0) continue;
        const signature = await createHostIntroductionProof(
          signer,
          accountId,
          pin.hostPublicKey,
          pinned.joinerPublicKey,
        );
        for (const hostId of boundIds) {
          if (items.length >= MAX_HOST_INTRODUCTIONS) break;
          items.push({
            host_id: hostId,
            host_name: hostList.find((host) => host.id === hostId)?.name ?? "host",
            host_public_key: pin.hostPublicKey,
            signature,
          });
        }
      }
      // Continuous-gossip bootstrap: also hand over the peer device keys THIS
      // device learned firsthand, so the joiner can honor those peers' future
      // broadcast introductions without ever having met them. The joiner and
      // this device itself are excluded (the ceremony is their provenance).
      const deviceItems: PairingDeviceIntroduction[] = [];
      try {
        const peers = await listPeerDeviceKeys({ accountId, origin });
        for (const peer of peers) {
          if (deviceItems.length >= MAX_DEVICE_INTRODUCTIONS) break;
          if (peer.publicKey === pinned.joinerPublicKey) continue;
          if (peer.publicKey === currentDevice.public_key) continue;
          const signature = await createDeviceIntroductionProof(
            signer,
            accountId,
            peer.publicKey,
            peer.deviceId,
            pinned.joinerPublicKey,
          );
          deviceItems.push({
            device_id: peer.deviceId,
            device_label:
              devices.find((device) => device.id === peer.deviceId)?.label ?? "a device",
            device_public_key: peer.publicKey,
            signature,
          });
        }
      } catch {
        // Peer handover is a bonus on top of a bonus; hosts still ride alone.
      }
      if (items.length === 0 && deviceItems.length === 0) return;
      await trust.postPairingIntroductions(pairing.id, items, deviceItems);
    } catch {
      setError(
        "Approved, but this device couldn't hand over its hosts — the new device will verify each host when it first connects.",
      );
    }
  };

  const signEndorsement = async (endorsedDeviceId: string, endorsedPublicKey: string) => {
    // Load the identity fresh at sign time rather than trusting a long-lived
    // prop: the signing key handle lives in a WeakMap keyed by the identity
    // object, and a cached object's entry can be collected across reloads.
    const signer = (await loadBrowserDeviceIdentity(accountId)) ?? identity;
    if (!signer || !currentDevice) throw new Error("This browser's identity is unavailable");
    const signature = await createAccountEndorsementProof(
      signer,
      accountId,
      endorsedPublicKey,
      endorsedDeviceId,
    );
    await trust.createAccountEndorsement({
      endorser_device_id: currentDevice.id,
      endorsed_device_id: endorsedDeviceId,
      signature,
    });
    void qc.invalidateQueries({ queryKey: ["account-endorsements"] });
  };

  // Drive each live ceremony forward from the relayed state. Re-running only on
  // new poll data is intended; `advance` reads live refs/state, not a closure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: poll-driven effect keyed on poll data
  useEffect(() => {
    if (!currentDevice) return;
    for (const pairing of pairings.data ?? []) void advance(pairing);
  }, [pairings.data]);

  async function advance(pairing: PairingState): Promise<void> {
    if (!currentDevice) return;
    const amInitiator = pairing.initiator_device_id === currentDevice.id;
    const amJoiner = pairing.joiner_device_id === currentDevice.id;
    if (!amInitiator && !amJoiner) return;
    // Stash relayed introductions (R7 hosts + continuous-gossip device keys)
    // the moment any snapshot carries them: the pairing row is deleted at
    // completion, and acceptance must run from data this side already holds,
    // never a post-completion re-fetch.
    if (amJoiner) {
      const record = records.get(pairing.id);
      const change: Partial<CeremonyRecord> = {};
      if (record !== undefined) {
        if (record.introductions === null && (pairing.introductions?.length ?? 0) > 0) {
          change.introductions = pairing.introductions ?? null;
        }
        if (
          record.deviceIntroductions === null &&
          (pairing.device_introductions?.length ?? 0) > 0
        ) {
          change.deviceIntroductions = pairing.device_introductions ?? null;
        }
        if (Object.keys(change).length > 0) patch(pairing.id, change);
      }
    }
    try {
      if (amJoiner && !pairing.joiner_nonce && !actedRef.current.has(`contribute:${pairing.id}`)) {
        actedRef.current.add(`contribute:${pairing.id}`);
        const nonce = freshSasNonce();
        noncesRef.current.set(pairing.id, nonce);
        patch(pairing.id, {});
        await trust.contributePairing(pairing.id, {
          joiner_public_key: currentDevice.public_key,
          joiner_nonce: b64urlEncode(nonce),
        });
        await invalidatePairings();
        return;
      }
      if (
        amInitiator &&
        pairing.joiner_nonce &&
        !pairing.initiator_nonce &&
        !actedRef.current.has(`reveal:${pairing.id}`)
      ) {
        const nonce = noncesRef.current.get(pairing.id);
        if (!nonce) return; // not started in this session; cannot open the commitment
        actedRef.current.add(`reveal:${pairing.id}`);
        await trust.revealPairing(pairing.id, { initiator_nonce: b64urlEncode(nonce) });
        await invalidatePairings();
        return;
      }
      if (
        pairing.initiator_nonce &&
        pairing.joiner_nonce &&
        pairing.joiner_public_key &&
        !actedRef.current.has(`sas:${pairing.id}`)
      ) {
        actedRef.current.add(`sas:${pairing.id}`);
        // Snapshot the exact bytes that go into the number. These — and only
        // these — are what the human's match authenticates, so they are pinned
        // into the record and every later verify/sign uses the pinned copies.
        const initiatorKey = pairing.initiator_public_key;
        const joinerKey = pairing.joiner_public_key;
        // This side's OWN key on the relay row must be its real key: a swapped
        // own-key would put attacker bytes into the number and induce the peer
        // to endorse a key this device does not hold.
        const ownKeyHonest = amInitiator
          ? initiatorKey === currentDevice.public_key
          : joinerKey === currentDevice.public_key;
        if (!ownKeyHonest) {
          setError(TAMPER_STOP_MESSAGE);
          await trust.cancelPairing(pairing.id).catch(() => {});
          patch(pairing.id, { stopped: true });
          return;
        }
        if (amJoiner) {
          const opens = await verifyCommitWire(
            pairing.initiator_commit,
            initiatorKey,
            pairing.initiator_nonce,
          );
          if (!opens) {
            setError(TAMPER_STOP_MESSAGE);
            await trust.cancelPairing(pairing.id).catch(() => {});
            patch(pairing.id, { stopped: true });
            return;
          }
        }
        const number = await ceremonySas(
          initiatorKey,
          joinerKey,
          pairing.initiator_nonce,
          pairing.joiner_nonce,
        );
        patch(pairing.id, {
          sas: number,
          pinnedKeys: { initiatorPublicKey: initiatorKey, joinerPublicKey: joinerKey },
        });
      }
    } catch {
      // Transient relay races (e.g. set-once 409 from a duplicate poll) are safe
      // to ignore — the next poll reconciles from the authoritative state.
    }
  }

  // NEW-DEVICE side: the approver's correct entry produced a signed endorsement
  // naming us. Verify that signature against the PINNED initiator key (the one
  // whose commitment opened and whose bytes are in the number the approver
  // typed) and sign the reciprocal edge — the one human entry covers both
  // directions. A server-forged edge fails this verification and grants
  // nothing; a relay row whose keys drifted from the pinned bytes aborts the
  // ceremony outright.
  // biome-ignore lint/correctness/useExhaustiveDependencies: poll-driven effect keyed on poll data
  useEffect(() => {
    if (!currentDevice) return;
    const edges = endorsements.data ?? [];
    for (const pairing of pairings.data ?? []) {
      if (pairing.joiner_device_id !== currentDevice.id) continue;
      const record = records.get(pairing.id);
      if (!record?.sas || !record.pinnedKeys || record.signedMine || record.stopped) continue;
      if (actedRef.current.has(`reciprocate:${pairing.id}`)) continue;
      actedRef.current.add(`reciprocate:${pairing.id}`);
      const pinned = record.pinnedKeys;
      void (async () => {
        const plan = await planReciprocalEndorsement({
          accountId,
          pairing,
          pinned,
          currentDevice: { id: currentDevice.id, public_key: currentDevice.public_key },
          edges,
        });
        if (plan.kind === "wait") {
          actedRef.current.delete(`reciprocate:${pairing.id}`); // retry on next poll
          return;
        }
        if (plan.kind === "abort") {
          setError(TAMPER_STOP_MESSAGE);
          await trust.cancelPairing(pairing.id).catch(() => {});
          patch(pairing.id, { stopped: true });
          return;
        }
        try {
          // Collect the approver's host introductions (R7) BEFORE signing the
          // reciprocal. The polled `pairing` snapshot can predate them (this
          // effect is triggered by the ENDORSEMENTS poll), but the approver
          // posts introductions before its edge — so the edge we just verified
          // proves they are already on the row, and the row provably still
          // lives because completion needs the reciprocal we have not signed
          // yet. One fresh read closes the deletion race for good; best-effort
          // (a failed read must not block the approval — the acceptance step
          // simply has nothing to accept and this device verifies each host on
          // first use instead).
          let introductions = pairing.introductions ?? null;
          let deviceIntroductions = pairing.device_introductions ?? null;
          if (introductions === null || introductions.length === 0) {
            const row = await trust
              .listPairings(currentDevice.id)
              .then((rows) => rows.find((candidate) => candidate.id === pairing.id) ?? null)
              .catch(() => null);
            introductions = row?.introductions ?? null;
            deviceIntroductions = row?.device_introductions ?? deviceIntroductions;
          }
          await signEndorsement(plan.endorsedDeviceId, plan.endorsedPublicKey);
          patch(pairing.id, {
            signedMine: true,
            waitingSince: Date.now(),
            // Never clobber an earlier stash with a failed re-read.
            ...(introductions !== null && introductions.length > 0 ? { introductions } : {}),
            ...(deviceIntroductions !== null && deviceIntroductions.length > 0
              ? { deviceIntroductions }
              : {}),
          });
        } catch {
          actedRef.current.delete(`reciprocate:${pairing.id}`); // retry on next poll
        }
      })();
    }
  }, [pairings.data, endorsements.data, records]);

  // NEW-DEVICE side, after its reciprocal is signed: accept the approver's host
  // introductions (R7). Each signature is verified against the CEREMONY-PINNED
  // initiator key and this device's own key — the exact bytes the human's
  // number covered — then the host key is approved locally like a hand-run
  // possession, so this device's first connection is already fully verified
  // instead of first-contact. Failures reject only that host and are surfaced;
  // the approval itself (admission) is unaffected either way.
  // biome-ignore lint/correctness/useExhaustiveDependencies: poll-driven effect keyed on poll data
  useEffect(() => {
    if (!currentDevice) return;
    for (const [id, record] of records) {
      if (!record.signedMine || record.stopped) continue;
      const hasHosts = record.introductions !== null && record.introductions.length > 0;
      const hasDevices =
        record.deviceIntroductions !== null && record.deviceIntroductions.length > 0;
      if (!hasHosts && !hasDevices) continue;
      if (!record.pinnedKeys) continue;
      if (rolesRef.current.get(id)?.role !== "new-device") continue;
      if (actedRef.current.has(`introductions:${id}`)) continue;
      actedRef.current.add(`introductions:${id}`);
      const pinned = record.pinnedKeys;
      const claimed = record.introductions ?? [];
      const claimedDevices = record.deviceIntroductions ?? [];
      void (async () => {
        // Device-key handover (continuous gossip bootstrap): judged against
        // the same ceremony-pinned key, remembered as firsthand-by-proxy.
        // Quiet best-effort — the host leg below is the user-visible one.
        try {
          if (claimedDevices.length > 0) {
            const devicePlan = await planDeviceIntroductionAcceptance({
              accountId,
              pinnedIntroducerPublicKey: pinned.initiatorPublicKey,
              ownPublicKey: currentDevice.public_key,
              claimed: claimedDevices,
            });
            const origin = browserHostPinServerOrigin();
            for (const peer of devicePlan.accepted) {
              await rememberPeerDeviceKey({
                accountId,
                origin,
                publicKey: peer.devicePublicKey,
                deviceId: peer.deviceId,
                source: "ceremony-introduction",
              }).catch(() => {});
            }
            for (const reason of devicePlan.rejected) {
              console.warn(`spawn: device introduction rejected: ${reason}`);
            }
            void qc.invalidateQueries({ queryKey: ["peer-device-keys"] });
          }
        } catch {
          // Nothing was trusted; broadcast rows from unmet peers stay unhonored.
        }
        try {
          if (claimed.length === 0) return;
          const plan = await planHostIntroductionAcceptance({
            accountId,
            pinnedIntroducerPublicKey: pinned.initiatorPublicKey,
            ownPublicKey: currentDevice.public_key,
            claimed,
          });
          const origin = browserHostPinServerOrigin();
          const failures = [...plan.rejected];
          for (const intro of plan.accepted) {
            try {
              await approveBrowserHostPin({
                accountId,
                origin,
                hostPublicKey: intro.hostPublicKey,
                hostFingerprint: intro.hostFingerprint,
              });
              // Bind the host id so the downgrade gate sees this host as
              // pinned from the very first connection (never a silent no-op:
              // resolve only binds when the claimed key equals the pinned one).
              await resolveActiveBrowserHostPin({
                accountId,
                origin,
                hostId: intro.hostId,
                claimedHostPublicKey: intro.hostPublicKey,
              });
            } catch (cause) {
              failures.push(
                `${intro.hostName}: ${cause instanceof Error ? cause.message : String(cause)}`,
              );
            }
          }
          if (failures.length > 0) {
            setError(
              `This device is approved, but some hosts couldn't be verified here yet (${failures.join("; ")}). Each will be checked when it first connects.`,
            );
          }
        } catch (cause) {
          setError(
            `This device is approved, but the hosts it was handed could not be verified (${cause instanceof Error ? cause.message : String(cause)}). Each will be checked when it first connects.`,
          );
        }
      })();
    }
  }, [records]);

  /**
   * A COMPLETED ceremony is the one moment a peer device key is learned
   * firsthand: persist it into the durable peer-key store (continuous gossip's
   * provenance root) — the exact bytes the SAS pinned, never the relay's live
   * claim. Both roles remember their opposite. Best-effort: a storage failure
   * costs future broadcast acceptance, never the approval itself.
   */
  const persistCeremonyPeerKey = (
    pairingId: string,
    record: CeremonyRecord,
    role: ApproveCeremonyRole,
    peerDeviceId: string,
  ): void => {
    if (!record.pinnedKeys || peerDeviceId === "") return;
    if (actedRef.current.has(`peerkey:${pairingId}`)) return;
    actedRef.current.add(`peerkey:${pairingId}`);
    const peerKey =
      role === "approver"
        ? record.pinnedKeys.joinerPublicKey
        : record.pinnedKeys.initiatorPublicKey;
    void (async () => {
      try {
        await rememberPeerDeviceKey({
          accountId,
          origin: browserHostPinServerOrigin(),
          publicKey: peerKey,
          deviceId: peerDeviceId,
          source: "ceremony",
        });
        void qc.invalidateQueries({ queryKey: ["peer-device-keys"] });
      } catch {
        actedRef.current.delete(`peerkey:${pairingId}`); // retry on a later pass
      }
    })();
  };

  // Completion: once BOTH directions of the mutual endorsement exist, the
  // ceremony is done — flip the phase and delete the pairing so neither screen
  // lingers until the relay TTL. Either side may win the delete; the loser's
  // 404 is fine.
  // biome-ignore lint/correctness/useExhaustiveDependencies: poll-driven effect keyed on poll data
  useEffect(() => {
    if (!currentDevice) return;
    const edges = endorsements.data ?? [];
    for (const pairing of pairings.data ?? []) {
      const record = records.get(pairing.id);
      if (!record?.sas || record.done || record.stopped) continue;
      const amInitiator = pairing.initiator_device_id === currentDevice.id;
      const peerId = amInitiator ? pairing.joiner_device_id : pairing.initiator_device_id;
      const mine =
        record.signedMine ||
        edges.some(
          (e) => e.endorser_device_id === currentDevice.id && e.endorsed_device_id === peerId,
        );
      const theirs = edges.some(
        (e) => e.endorser_device_id === peerId && e.endorsed_device_id === currentDevice.id,
      );
      if (!mine || !theirs) continue;
      persistCeremonyPeerKey(pairing.id, record, amInitiator ? "approver" : "new-device", peerId);
      patch(pairing.id, { done: true });
      void trust
        .cancelPairing(pairing.id)
        .catch(() => {})
        .then(() => invalidatePairings());
    }
    // The peer may delete the pairing before our edge-poll notices completion:
    // a ceremony we signed (this session, or a prior one — the edge proves it)
    // that vanished from the relay is also done. One we had NOT signed (a
    // number was up, then the row vanished — the peer's mismatch, exhausted
    // tries, or cancel deleted it) is stopped: the terminal "nothing was
    // trusted" screen must appear on this side too, not silently disappear.
    const liveIds = new Set((pairings.data ?? []).map((p) => p.id));
    for (const [id, record] of records) {
      if (record.done || record.stopped || record.sas === null || liveIds.has(id)) continue;
      const remembered = rolesRef.current.get(id);
      const peerId = remembered?.peerDeviceId;
      const mine =
        record.signedMine ||
        (peerId !== undefined &&
          edges.some(
            (e) => e.endorser_device_id === currentDevice.id && e.endorsed_device_id === peerId,
          ));
      if (mine && remembered !== undefined && peerId !== undefined) {
        persistCeremonyPeerKey(id, record, remembered.role, peerId);
      }
      patch(id, mine ? { done: true } : { stopped: true });
    }
  }, [pairings.data, endorsements.data, records]);

  const startMutation = useMutation({
    mutationFn: async (target: BrowserDevice) => {
      if (!currentDevice) throw new Error("This browser's identity is unavailable");
      const nonce = freshSasNonce();
      const commit = await commitWire(currentDevice.public_key, nonce);
      const started = await trust.startPairing({
        initiator_device_id: currentDevice.id,
        joiner_device_id: target.id,
        initiator_public_key: currentDevice.public_key,
        initiator_commit: commit,
      });
      noncesRef.current.set(started.id, nonce);
      return started.id;
    },
    onSuccess: (id) => {
      patch(id, {});
      void invalidatePairings();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not start the approval"),
  });

  /**
   * APPROVER side: the typed digits ARE the check. A match signs the account
   * endorsement immediately — against the PINNED joiner key, the exact bytes
   * the typed number authenticated, and only while the live relay row still
   * carries those bytes. A mismatch burns one of three tries; the last
   * mismatch aborts the ceremony — there is no "approve anyway".
   */
  const submitDigits = (pairing: PairingState, digits: string) => {
    const record = records.get(pairing.id);
    if (!record?.sas || !record.pinnedKeys || record.signedMine || record.stopped) return;
    const pinned = record.pinnedKeys;
    const expected = record.sas.replace(/\D/gu, "");
    if (digits.replace(/\D/gu, "") === expected) {
      patch(pairing.id, { entryError: null });
      void (async () => {
        try {
          const plan = planApproverEndorsement({ pairing, pinned });
          if (plan.kind !== "sign") {
            setError(TAMPER_STOP_MESSAGE);
            await trust.cancelPairing(pairing.id).catch(() => {});
            patch(pairing.id, { stopped: true });
            return;
          }
          // Host introductions FIRST (R7): they must be on the relay row
          // before the edge whose appearance lets the joiner finish.
          await postIntroductions(pairing, pinned);
          await signEndorsement(plan.endorsedDeviceId, plan.endorsedPublicKey);
          setError(null); // a retried approve that lands clears the stale failure line
          patch(pairing.id, { signedMine: true, waitingSince: Date.now(), entryError: null });
        } catch (e) {
          setError(e instanceof Error ? e.message : "Could not record the approval");
        }
      })();
      return;
    }
    const triesLeft = record.triesLeft - 1;
    if (triesLeft <= 0) {
      void trust
        .cancelPairing(pairing.id)
        .catch(() => {})
        .then(() => invalidatePairings());
      patch(pairing.id, { triesLeft: 0, stopped: true });
      return;
    }
    patch(pairing.id, {
      triesLeft,
      entryError: `That's not it — ${triesLeft} ${triesLeft === 1 ? "try" : "tries"} left.`,
    });
  };

  const cancel = (pairingId: string) => {
    void trust
      .cancelPairing(pairingId)
      .catch(() => {})
      .then(() => invalidatePairings());
    setRecords((prev) => {
      const next = new Map(prev);
      next.delete(pairingId);
      return next;
    });
  };

  /** Clear a finished (done/stopped) ceremony from view. */
  const dismiss = (pairingId: string) => {
    setRecords((prev) => {
      const next = new Map(prev);
      next.delete(pairingId);
      return next;
    });
  };

  const labelFor = (id: string): string =>
    devices.find((d) => d.id === id)?.label ?? "the other device";

  const views: ApproveCeremonyView[] = [];
  for (const pairing of pairings.data ?? []) {
    if (!currentDevice) break;
    const record = records.get(pairing.id);
    if (!record) continue;
    const role: ApproveCeremonyRole =
      pairing.initiator_device_id === currentDevice.id ? "approver" : "new-device";
    const peerDeviceId =
      role === "approver" ? pairing.joiner_device_id : pairing.initiator_device_id;
    // Remember who this ceremony was with: the completed pairing is deleted
    // from the relay while the done screen is still up, and the screen must
    // not forget its role or peer when that happens.
    rolesRef.current.set(pairing.id, { role, peerDeviceId });
    views.push({
      pairingId: pairing.id,
      role,
      peerDeviceId,
      peerName: labelFor(peerDeviceId),
      phase: record.stopped
        ? "stopped"
        : record.done
          ? "done"
          : record.sas === null
            ? "connecting"
            : record.signedMine
              ? "waiting"
              : "compare",
      number: record.sas,
      entryError: record.entryError,
      waitingSince: record.waitingSince,
    });
  }
  // Ceremonies whose pairing vanished after finishing still deserve their
  // terminal screen — done OR stopped — until dismissed, with the role and
  // peer they ran under. Stopped must survive the row's deletion exactly like
  // done: the relay row is gone precisely because the ceremony was aborted.
  for (const [id, record] of records) {
    if ((!record.done && !record.stopped) || views.some((v) => v.pairingId === id)) continue;
    const remembered = rolesRef.current.get(id);
    views.push({
      pairingId: id,
      role: remembered?.role ?? "new-device",
      peerDeviceId: remembered?.peerDeviceId ?? "",
      peerName: remembered ? labelFor(remembered.peerDeviceId) : "the other device",
      phase: record.stopped ? "stopped" : "done",
      number: record.sas,
      entryError: null,
      waitingSince: record.waitingSince,
    });
  }

  return {
    /** Every ceremony this device is currently part of. */
    ceremonies: views,
    /** Relay rows, for callers that need the raw pairing (submitDigits). */
    pairings: pairings.data ?? [],
    start: (target: BrowserDevice) => startMutation.mutate(target),
    startPending: startMutation.isPending,
    submitDigits,
    cancel,
    dismiss,
    error,
    clearError: () => setError(null),
  };
}
