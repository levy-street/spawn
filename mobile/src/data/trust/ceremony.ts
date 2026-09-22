import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelPairing,
  contributePairing,
  listAccountEndorsements,
  listPairings,
  revealPairing,
  startPairing,
} from "@/data/api/endpoints/trust";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import type { DevicePairingState } from "@/data/api/schemas/pairing";
import type { AccountEndorsementRecord } from "@/data/api/schemas/trust";
import { qk } from "@/data/queryKeys";
import { invalidateDeviceHostTrust } from "@/data/trust/device-trust";
import { createAccountDeviceEndorsement } from "@/data/trust/endorsement";
import { decodeBase64UrlExact, encodeBase64Url } from "@/lib/crypto/bytes";
import { verifyPureEd25519Strict } from "@/lib/crypto/ed25519";
import { ceremonySas, commitWire, freshSasNonce, verifyCommitWire } from "@/lib/crypto/sas";
import { encodeAccountEndorsementV1 } from "@/lib/crypto/transcripts";

/**
 * The add-device ceremony, phone edition (docs/TRUST_DEVICE_MESH.md §4,
 * Appendix A; the web's `approve-ceremony.ts` is the reference).
 *
 * Two roles, one number. As the NEW DEVICE (joiner) the phone contributes its
 * key and a fresh nonce, checks that the approver's revealed nonce opens the
 * commitment it made before seeing that contribution, derives the number and
 * shows it; when the approver's endorsement of this key lands, verified
 * against the ceremony-pinned initiator key, it signs the reciprocal edge and
 * is done. As the APPROVER (initiator) the phone commits, reveals once the
 * joiner has contributed, derives the same number and asks the human to type
 * it; a match signs the endorsement over the pinned joiner key, and the
 * reciprocal edge landing finishes the pair.
 *
 * Everything security-relevant is a pure planner below, tested on its own:
 * the hook only moves relay state and calls them.
 */

export const CEREMONY_TRIES = 3;
/** Relay poll cadence while a pairing names this device (a number is on screen). */
export const PAIRING_POLL_MS = 1_500;
/** Relay poll cadence with no pairing live; the approval prompt polls fast for both. */
export const PAIRING_IDLE_POLL_MS = 15_000;
/** Endorsement poll cadence while a ceremony is live, so the peer's edge is noticed. */
export const ENDORSEMENT_POLL_MS = 4_000;
/** Endorsement poll cadence with nothing live; edits elsewhere invalidate the key. */
export const ENDORSEMENT_IDLE_POLL_MS = 60_000;

export type CeremonyRole = "approver" | "new-device";
export type CeremonyPhase = "connecting" | "show" | "enter" | "waiting" | "done" | "stopped";

export interface PinnedCeremonyKeys {
  initiatorPublicKey: string;
  joinerPublicKey: string;
}

export interface CeremonyView {
  pairingId: string;
  role: CeremonyRole;
  peerDeviceId: string;
  phase: CeremonyPhase;
  number: string | null;
  triesLeft: number;
  entryError: string | null;
}

export type CeremonyStepPlan =
  | { kind: "wait" }
  | { kind: "abort"; reason: string }
  | { kind: "sign"; endorsedDeviceId: string; endorsedPublicKey: string };

export const TAMPER_STOP_MESSAGE =
  "The other device's key changed during the check, so nothing was trusted. Start over.";

type PairingKeys = Pick<
  DevicePairingState,
  "initiator_device_id" | "initiator_public_key" | "joiner_device_id" | "joiner_public_key"
>;

/** Whether the edge's signature is genuine under exactly the keys it claims. */
export function verifyAccountEndorsementEdge(input: {
  accountId: string;
  endorserPublicKey: string;
  endorsedPublicKey: string;
  endorsedDeviceId: string;
  signature: string;
}): boolean {
  try {
    const transcript = encodeAccountEndorsementV1({
      accountId: input.accountId,
      endorserPublicKey: input.endorserPublicKey,
      endorsedPublicKey: input.endorsedPublicKey,
      endorsedDeviceId: input.endorsedDeviceId,
    });
    return verifyPureEd25519Strict(
      decodeBase64UrlExact(input.endorserPublicKey, 32),
      transcript,
      decodeBase64UrlExact(input.signature, 64),
    );
  } catch {
    return false;
  }
}

/**
 * APPROVER, after a correct entry: sign over the PINNED joiner key, the exact
 * bytes the typed number authenticated, and only while the live relay row
 * still carries them. Anything else is server tampering: sign nothing.
 */
export function planApproverEndorsement(input: {
  pairing: PairingKeys;
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
 * NEW DEVICE: reciprocate only an approver edge that is real, i.e. names this
 * device's own key, claims the pinned initiator key, and verifies under it.
 * Server-claimed rows that fail any of that are not the edge this ceremony is
 * waiting for. Aborts if the relay row's keys drift from the pinned ones.
 */
export function planReciprocalEndorsement(input: {
  accountId: string;
  pairing: PairingKeys;
  pinned: PinnedCeremonyKeys;
  self: { id: string; public_key: string };
  edges: readonly AccountEndorsementRecord[];
}): CeremonyStepPlan {
  if (
    input.pairing.initiator_public_key !== input.pinned.initiatorPublicKey ||
    input.pairing.joiner_public_key !== input.pinned.joinerPublicKey
  ) {
    return { kind: "abort", reason: "pairing keys changed after the match" };
  }
  if (input.pinned.joinerPublicKey !== input.self.public_key) {
    return { kind: "abort", reason: "the number did not cover this device's key" };
  }
  const edge = input.edges.find(
    (e) =>
      e.endorser_device_id === input.pairing.initiator_device_id &&
      e.endorsed_device_id === input.self.id,
  );
  if (!edge) return { kind: "wait" };
  if (
    edge.endorser_public_key !== input.pinned.initiatorPublicKey ||
    edge.endorsed_public_key !== input.self.public_key
  ) {
    return { kind: "wait" };
  }
  const valid = verifyAccountEndorsementEdge({
    accountId: input.accountId,
    endorserPublicKey: input.pinned.initiatorPublicKey,
    endorsedPublicKey: input.self.public_key,
    endorsedDeviceId: input.self.id,
    signature: edge.signature,
  });
  if (!valid) return { kind: "wait" };
  return {
    kind: "sign",
    endorsedDeviceId: input.pairing.initiator_device_id,
    endorsedPublicKey: input.pinned.initiatorPublicKey,
  };
}

/** Whether the peer's reciprocal edge toward this device provably exists. */
export function reciprocalEdgeVerified(input: {
  accountId: string;
  edges: readonly AccountEndorsementRecord[];
  peerDeviceId: string;
  peerPublicKey: string;
  self: { id: string; public_key: string };
}): boolean {
  const edge = input.edges.find(
    (e) => e.endorser_device_id === input.peerDeviceId && e.endorsed_device_id === input.self.id,
  );
  if (!edge) return false;
  if (edge.endorser_public_key !== input.peerPublicKey) return false;
  if (edge.endorsed_public_key !== input.self.public_key) return false;
  return verifyAccountEndorsementEdge({
    accountId: input.accountId,
    endorserPublicKey: input.peerPublicKey,
    endorsedPublicKey: input.self.public_key,
    endorsedDeviceId: input.self.id,
    signature: edge.signature,
  });
}

interface CeremonyRecord {
  role: CeremonyRole;
  peerDeviceId: string;
  sas: string | null;
  pinned: PinnedCeremonyKeys | null;
  triesLeft: number;
  entryError: string | null;
  signedMine: boolean;
  done: boolean;
  stopped: boolean;
}

function fresh(role: CeremonyRole, peerDeviceId: string): CeremonyRecord {
  return {
    role,
    peerDeviceId,
    sas: null,
    pinned: null,
    triesLeft: CEREMONY_TRIES,
    entryError: null,
    signedMine: false,
    done: false,
    stopped: false,
  };
}

export interface DeviceCeremony {
  ceremonies: CeremonyView[];
  error: string | null;
  /** APPROVER: open a ceremony toward `target`. */
  start: (target: Pick<BrowserDeviceOut, "id" | "public_key">) => void;
  starting: boolean;
  /** APPROVER: the typed digits. A match signs; three misses stop the ceremony. */
  submitDigits: (pairingId: string, digits: string) => void;
  cancel: (pairingId: string) => void;
  dismiss: (pairingId: string) => void;
}

export function useDeviceCeremony(input: {
  accountId: string | undefined;
  self: Pick<BrowserDeviceOut, "id" | "public_key"> | undefined;
  enabled: boolean;
}): DeviceCeremony {
  const { accountId, self } = input;
  const queryClient = useQueryClient();
  const noncesRef = useRef<Map<string, Uint8Array>>(new Map());
  const actedRef = useRef<Set<string>>(new Set());
  const [records, setRecords] = useState<Map<string, CeremonyRecord>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const active = input.enabled && accountId !== undefined && self !== undefined;
  const selfId = self?.id ?? "";

  // This hook runs for as long as the app is signed in. It polls fast only
  // while a pairing that names this device exists — when a person is watching
  // a number — and idles otherwise; at the always-fast cadence these two
  // queries were most of the server's request volume (2026-09-22).
  const pairings = useQuery({
    queryKey: qk.trustPairings(selfId),
    queryFn: () => listPairings(selfId),
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) > 0 ? PAIRING_POLL_MS : PAIRING_IDLE_POLL_MS,
    enabled: active,
  });
  const ceremonyLive = (pairings.data?.length ?? 0) > 0 || records.size > 0;
  const endorsements = useQuery({
    queryKey: qk.trustAccountEndorsements(),
    queryFn: listAccountEndorsements,
    refetchInterval: ceremonyLive ? ENDORSEMENT_POLL_MS : ENDORSEMENT_IDLE_POLL_MS,
    enabled: active,
  });

  const patch = useCallback((id: string, change: Partial<CeremonyRecord>) => {
    setRecords((prev) => {
      const current = prev.get(id);
      if (current === undefined) return prev;
      const next = new Map(prev);
      next.set(id, { ...current, ...change });
      return next;
    });
  }, []);
  const ensure = useCallback((id: string, role: CeremonyRole, peerDeviceId: string) => {
    setRecords((prev) => {
      if (prev.has(id)) return prev;
      const next = new Map(prev);
      next.set(id, fresh(role, peerDeviceId));
      return next;
    });
  }, []);
  const invalidatePairings = useCallback(
    () => queryClient.invalidateQueries({ queryKey: qk.trustPairings(selfId) }),
    [queryClient, selfId],
  );
  const invalidateEdges = useCallback(
    () => queryClient.invalidateQueries({ queryKey: qk.trustAccountEndorsements() }),
    [queryClient],
  );

  const stop = useCallback(
    async (pairingId: string) => {
      setError(TAMPER_STOP_MESSAGE);
      await cancelPairing(pairingId).catch(() => {});
      patch(pairingId, { stopped: true });
    },
    [patch],
  );

  const sign = useCallback(
    async (endorsedDeviceId: string, endorsedPublicKey: string) => {
      if (accountId === undefined || self === undefined) throw new Error("Not signed in");
      await createAccountDeviceEndorsement({
        accountId,
        endorserDeviceId: self.id,
        endorsedDeviceId,
        endorsedPublicKey,
      });
      void invalidateEdges();
    },
    [accountId, self, invalidateEdges],
  );

  // Drive each live ceremony forward from the relayed state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: poll-driven; reads live refs
  useEffect(() => {
    if (!self) return;
    for (const pairing of pairings.data ?? []) void advance(pairing);
  }, [pairings.data]);

  async function advance(pairing: DevicePairingState): Promise<void> {
    if (!self) return;
    const amInitiator = pairing.initiator_device_id === self.id;
    const amJoiner = pairing.joiner_device_id === self.id;
    if (!amInitiator && !amJoiner) return;
    ensure(
      pairing.id,
      amInitiator ? "approver" : "new-device",
      amInitiator ? pairing.joiner_device_id : pairing.initiator_device_id,
    );
    try {
      if (amJoiner && !pairing.joiner_nonce && !actedRef.current.has(`contribute:${pairing.id}`)) {
        actedRef.current.add(`contribute:${pairing.id}`);
        const nonce = freshSasNonce();
        noncesRef.current.set(pairing.id, nonce);
        await contributePairing(pairing.id, {
          joiner_public_key: self.public_key,
          joiner_nonce: encodeBase64Url(nonce),
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
        await revealPairing(pairing.id, { initiator_nonce: encodeBase64Url(nonce) });
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
        const initiatorKey = pairing.initiator_public_key;
        const joinerKey = pairing.joiner_public_key;
        // This side's OWN key on the relay row must be its real key: a swapped
        // own-key would put attacker bytes into the number and lead the peer
        // to endorse a key this phone does not hold.
        const ownKeyHonest = amInitiator
          ? initiatorKey === self.public_key
          : joinerKey === self.public_key;
        if (!ownKeyHonest) {
          await stop(pairing.id);
          return;
        }
        if (amJoiner) {
          const opens = verifyCommitWire(
            pairing.initiator_commit,
            initiatorKey,
            pairing.initiator_nonce,
          );
          if (!opens) {
            await stop(pairing.id);
            return;
          }
        }
        const number = ceremonySas(
          initiatorKey,
          joinerKey,
          pairing.initiator_nonce,
          pairing.joiner_nonce,
        );
        patch(pairing.id, {
          sas: number,
          pinned: { initiatorPublicKey: initiatorKey, joinerPublicKey: joinerKey },
        });
      }
    } catch {
      // Transient relay races (a set-once 409 from a duplicate poll) are safe
      // to ignore; the next poll reconciles from the authoritative state.
    }
  }

  // NEW DEVICE: the approver's verified edge is the cue to reciprocate.
  // APPROVER: the reciprocal landing is the cue to finish. A row that vanished
  // after this side signed is the peer having finished and torn it down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: poll-driven; reads live refs
  useEffect(() => {
    if (!self || accountId === undefined) return;
    const edges = endorsements.data ?? [];
    const live = new Map((pairings.data ?? []).map((row) => [row.id, row]));
    for (const [id, record] of records) {
      if (record.done || record.stopped || !record.sas || !record.pinned) continue;
      const pairing = live.get(id);
      if (record.role === "new-device") {
        if (record.signedMine || !pairing) continue;
        if (actedRef.current.has(`reciprocate:${id}`)) continue;
        actedRef.current.add(`reciprocate:${id}`);
        const pinned = record.pinned;
        void (async () => {
          const plan = planReciprocalEndorsement({
            accountId,
            pairing,
            pinned,
            self: { id: self.id, public_key: self.public_key },
            edges,
          });
          if (plan.kind === "wait") {
            actedRef.current.delete(`reciprocate:${id}`);
            return;
          }
          if (plan.kind === "abort") {
            await stop(id);
            return;
          }
          try {
            await sign(plan.endorsedDeviceId, plan.endorsedPublicKey);
            patch(id, { signedMine: true, done: true });
            // Admitted: the hosts anchored on the approver will take this
            // phone now, and the row has served its purpose.
            invalidateDeviceHostTrust();
            await cancelPairing(id).catch(() => {});
            void invalidatePairings();
          } catch {
            actedRef.current.delete(`reciprocate:${id}`);
          }
        })();
        continue;
      }
      // approver
      if (!record.signedMine) continue;
      const finished =
        reciprocalEdgeVerified({
          accountId,
          edges,
          peerDeviceId: record.peerDeviceId,
          peerPublicKey: record.pinned.joinerPublicKey,
          self: { id: self.id, public_key: self.public_key },
        }) || pairing === undefined;
      if (finished) patch(id, { done: true });
    }
  }, [pairings.data, endorsements.data, records]);

  const startMutation = useMutation({
    mutationFn: async (target: Pick<BrowserDeviceOut, "id" | "public_key">) => {
      if (!self) throw new Error("This phone's identity is unavailable");
      const nonce = freshSasNonce();
      const started = await startPairing({
        initiator_device_id: self.id,
        joiner_device_id: target.id,
        initiator_public_key: self.public_key,
        initiator_commit: commitWire(self.public_key, nonce),
      });
      noncesRef.current.set(started.id, nonce);
      return { id: started.id, peer: target.id };
    },
    onSuccess: ({ id, peer }) => {
      ensure(id, "approver", peer);
      void invalidatePairings();
    },
    onError: (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "Could not start the approval"),
  });

  const submitDigits = useCallback(
    (pairingId: string, digits: string) => {
      const record = records.get(pairingId);
      const pairing = (pairings.data ?? []).find((row) => row.id === pairingId);
      if (!record?.sas || !record.pinned || record.signedMine || record.stopped || !pairing) return;
      const expected = record.sas.replace(/\D/gu, "");
      if (digits.replace(/\D/gu, "") === expected) {
        const pinned = record.pinned;
        patch(pairingId, { entryError: null });
        void (async () => {
          const plan = planApproverEndorsement({ pairing, pinned });
          if (plan.kind !== "sign") {
            await stop(pairingId);
            return;
          }
          try {
            await sign(plan.endorsedDeviceId, plan.endorsedPublicKey);
            setError(null);
            patch(pairingId, { signedMine: true, entryError: null });
            void queryClient.invalidateQueries({ queryKey: qk.deviceApprovals() });
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not record the approval");
          }
        })();
        return;
      }
      const triesLeft = record.triesLeft - 1;
      if (triesLeft <= 0) {
        void cancelPairing(pairingId)
          .catch(() => {})
          .then(() => invalidatePairings());
        patch(pairingId, { triesLeft: 0, stopped: true });
        return;
      }
      patch(pairingId, {
        triesLeft,
        entryError: `That is not it. ${triesLeft} ${triesLeft === 1 ? "try" : "tries"} left.`,
      });
    },
    [records, pairings.data, patch, stop, sign, invalidatePairings, queryClient],
  );

  const cancel = useCallback(
    (pairingId: string) => {
      void cancelPairing(pairingId)
        .catch(() => {})
        .then(() => invalidatePairings());
      setRecords((prev) => {
        const next = new Map(prev);
        next.delete(pairingId);
        return next;
      });
    },
    [invalidatePairings],
  );

  const dismiss = useCallback((pairingId: string) => {
    setRecords((prev) => {
      const next = new Map(prev);
      next.delete(pairingId);
      return next;
    });
  }, []);

  const ceremonies: CeremonyView[] = [];
  for (const [id, record] of records) {
    const phase: CeremonyPhase = record.stopped
      ? "stopped"
      : record.done
        ? "done"
        : record.signedMine
          ? "waiting"
          : record.sas === null
            ? "connecting"
            : record.role === "approver"
              ? "enter"
              : "show";
    ceremonies.push({
      pairingId: id,
      role: record.role,
      peerDeviceId: record.peerDeviceId,
      phase,
      number: record.sas,
      triesLeft: record.triesLeft,
      entryError: record.entryError,
    });
  }

  return {
    ceremonies,
    error,
    start: (target) => startMutation.mutate(target),
    starting: startMutation.isPending,
    submitDigits,
    cancel,
    dismiss,
  };
}
