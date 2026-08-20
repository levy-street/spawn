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
import { type BrowserDevice, type PairingState, trust } from "@/lib/api";
import {
  type BrowserDeviceIdentity,
  createAccountEndorsementProof,
  loadBrowserDeviceIdentity,
} from "@/lib/browser-device-identity";
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

interface CeremonyRecord {
  sas: string | null;
  triesLeft: number;
  entryError: string | null;
  /** This side's endorsement has been recorded on the relay. */
  signedMine: boolean;
  waitingSince: number | null;
  done: boolean;
  stopped: boolean;
}

const FRESH: CeremonyRecord = {
  sas: null,
  triesLeft: APPROVE_CEREMONY_TRIES,
  entryError: null,
  signedMine: false,
  waitingSince: null,
  done: false,
  stopped: false,
};

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
        if (amJoiner) {
          const opens = await verifyCommitWire(
            pairing.initiator_commit,
            pairing.initiator_public_key,
            pairing.initiator_nonce,
          );
          if (!opens) {
            setError(
              "The other device's key changed mid-ceremony, so nothing was trusted. Start over.",
            );
            await trust.cancelPairing(pairing.id).catch(() => {});
            patch(pairing.id, { stopped: true });
            return;
          }
        }
        const number = await ceremonySas(
          pairing.initiator_public_key,
          pairing.joiner_public_key,
          pairing.initiator_nonce,
          pairing.joiner_nonce,
        );
        patch(pairing.id, { sas: number });
      }
    } catch {
      // Transient relay races (e.g. set-once 409 from a duplicate poll) are safe
      // to ignore — the next poll reconciles from the authoritative state.
    }
  }

  // NEW-DEVICE side: the approver's correct entry produced a signed endorsement
  // naming us. Verify that signature against the CEREMONY's initiator key (the
  // one whose commitment opened and whose bytes are in the number the approver
  // typed) and sign the reciprocal edge — the one human entry covers both
  // directions. A server-forged edge fails this verification and grants nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: poll-driven effect keyed on poll data
  useEffect(() => {
    if (!currentDevice) return;
    const edges = endorsements.data ?? [];
    for (const pairing of pairings.data ?? []) {
      if (pairing.joiner_device_id !== currentDevice.id) continue;
      const record = records.get(pairing.id);
      if (!record?.sas || record.signedMine || record.stopped) continue;
      if (actedRef.current.has(`reciprocate:${pairing.id}`)) continue;
      const edge = edges.find(
        (e) =>
          e.endorser_device_id === pairing.initiator_device_id &&
          e.endorsed_device_id === currentDevice.id,
      );
      if (!edge) continue;
      if (
        edge.endorser_public_key !== pairing.initiator_public_key ||
        edge.endorsed_public_key !== currentDevice.public_key
      ) {
        continue;
      }
      actedRef.current.add(`reciprocate:${pairing.id}`);
      void (async () => {
        const valid = await verifyAccountEndorsementSignature({
          accountId,
          endorserPublicKey: pairing.initiator_public_key,
          endorsedPublicKey: currentDevice.public_key,
          endorsedDeviceId: currentDevice.id,
          signature: edge.signature,
        });
        if (!valid) return; // forged or damaged — never reciprocate
        try {
          await signEndorsement(pairing.initiator_device_id, pairing.initiator_public_key);
          patch(pairing.id, { signedMine: true, waitingSince: Date.now() });
        } catch {
          actedRef.current.delete(`reciprocate:${pairing.id}`); // retry on next poll
        }
      })();
    }
  }, [pairings.data, endorsements.data, records]);

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
      patch(pairing.id, { done: true });
      void trust
        .cancelPairing(pairing.id)
        .catch(() => {})
        .then(() => invalidatePairings());
    }
    // The peer may delete the pairing before our edge-poll notices completion:
    // a ceremony we signed that vanished from the relay is also done.
    const liveIds = new Set((pairings.data ?? []).map((p) => p.id));
    for (const [id, record] of records) {
      if (record.signedMine && !record.done && !record.stopped && !liveIds.has(id)) {
        patch(id, { done: true });
      }
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
   * endorsement immediately; a mismatch burns one of three tries; the last
   * mismatch aborts the ceremony — there is no "approve anyway".
   */
  const submitDigits = (pairing: PairingState, digits: string) => {
    const record = records.get(pairing.id);
    if (!record?.sas || record.signedMine || record.stopped) return;
    const expected = record.sas.replace(/\D/gu, "");
    if (digits.replace(/\D/gu, "") === expected) {
      patch(pairing.id, { entryError: null });
      void (async () => {
        try {
          if (!pairing.joiner_public_key) throw new Error("The ceremony is not ready yet");
          await signEndorsement(pairing.joiner_device_id, pairing.joiner_public_key);
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
  // Ceremonies whose pairing vanished after completion still deserve their
  // done screen until dismissed — with the role and peer they ran under.
  for (const [id, record] of records) {
    if (!record.done || views.some((v) => v.pairingId === id)) continue;
    const remembered = rolesRef.current.get(id);
    views.push({
      pairingId: id,
      role: remembered?.role ?? "new-device",
      peerDeviceId: remembered?.peerDeviceId ?? "",
      peerName: remembered ? labelFor(remembered.peerDeviceId) : "the other device",
      phase: "done",
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
