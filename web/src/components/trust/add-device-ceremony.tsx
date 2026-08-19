"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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

/**
 * The browser↔browser add-device ceremony (docs/TRUST_DEVICE_MESH.md §4).
 *
 * One human check admits a device to the whole account: the operator picks a new
 * device on a device they already use ("Approve"), both screens show the same
 * committed-ephemeral SAS number, and on confirmation each side signs a MUTUAL
 * account endorsement. The number is the check — a substituting server cannot
 * make the two screens agree.
 *
 * This one component plays both roles from the polled ceremony state: the
 * initiator (who pressed Approve) and the joiner (who auto-contributes when it
 * discovers an invitation). Ephemeral nonces live only in memory for the life of
 * the ceremony, so a page reload mid-ceremony abandons it — start again.
 */
export function AddDeviceCeremonyPanel({
  accountId,
  currentDevice,
  identity,
  devices,
}: {
  accountId: string;
  currentDevice: BrowserDevice;
  identity: BrowserDeviceIdentity;
  devices: BrowserDevice[];
}) {
  const qc = useQueryClient();
  // Our own fresh nonce per ceremony (N_I as initiator, N_J as joiner).
  const noncesRef = useRef<Map<string, Uint8Array>>(new Map());
  // Guards so a poll that fires before the previous write lands does not double-submit.
  const actedRef = useRef<Set<string>>(new Set());
  const [sasByPairing, setSasByPairing] = useState<Map<string, string>>(new Map());
  const [endorsed, setEndorsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const pairings = useQuery({
    queryKey: ["device-pairings", currentDevice.id],
    queryFn: () => trust.listPairings(currentDevice.id),
    refetchInterval: 1500,
  });
  const endorsements = useQuery({
    queryKey: ["account-endorsements"],
    queryFn: trust.accountEndorsements,
  });

  const alreadyEndorsed = new Set(
    (endorsements.data ?? [])
      .filter((edge) => edge.endorser_device_id === currentDevice.id)
      .map((edge) => edge.endorsed_device_id),
  );

  const invalidatePairings = () =>
    qc.invalidateQueries({ queryKey: ["device-pairings", currentDevice.id] });

  // Drive each live ceremony forward from the relayed state. Re-running only on
  // new poll data is intended; `advance` reads live refs/state, not a closure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: poll-driven effect keyed on pairings.data
  useEffect(() => {
    for (const pairing of pairings.data ?? []) void advance(pairing);
  }, [pairings.data]);

  async function advance(pairing: PairingState): Promise<void> {
    const amInitiator = pairing.initiator_device_id === currentDevice.id;
    const amJoiner = pairing.joiner_device_id === currentDevice.id;
    try {
      if (amJoiner && !pairing.joiner_nonce && !actedRef.current.has(`contribute:${pairing.id}`)) {
        actedRef.current.add(`contribute:${pairing.id}`);
        const nonce = freshSasNonce();
        noncesRef.current.set(pairing.id, nonce);
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
        !sasByPairing.has(pairing.id) &&
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
              "The commitment did not open — the other device's key was substituted. Aborted.",
            );
            await trust.cancelPairing(pairing.id).catch(() => {});
            return;
          }
        }
        const number = await ceremonySas(
          pairing.initiator_public_key,
          pairing.joiner_public_key,
          pairing.initiator_nonce,
          pairing.joiner_nonce,
        );
        setSasByPairing((prev) => new Map(prev).set(pairing.id, number));
      }
    } catch {
      // Transient relay races (e.g. set-once 409 from a duplicate poll) are safe
      // to ignore — the next poll reconciles from the authoritative state.
    }
  }

  const startMutation = useMutation({
    mutationFn: async (target: BrowserDevice) => {
      const nonce = freshSasNonce();
      const commit = await commitWire(currentDevice.public_key, nonce);
      const started = await trust.startPairing({
        initiator_device_id: currentDevice.id,
        joiner_device_id: target.id,
        initiator_public_key: currentDevice.public_key,
        initiator_commit: commit,
      });
      noncesRef.current.set(started.id, nonce);
    },
    onSuccess: () => void invalidatePairings(),
    onError: (e) => setError(e instanceof Error ? e.message : "Could not start pairing"),
  });

  const confirmMutation = useMutation({
    mutationFn: async (pairing: PairingState) => {
      const amInitiator = pairing.initiator_device_id === currentDevice.id;
      const endorsedPublicKey = amInitiator
        ? (pairing.joiner_public_key ?? "")
        : pairing.initiator_public_key;
      const endorsedDeviceId = amInitiator ? pairing.joiner_device_id : pairing.initiator_device_id;
      // Load the identity fresh at sign time rather than trusting a long-lived
      // prop: the signing key handle lives in a WeakMap keyed by the identity
      // object, and a cached object's entry can be collected across reloads.
      const signer = (await loadBrowserDeviceIdentity(accountId)) ?? identity;
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
      return pairing.id;
    },
    onSuccess: (id) => {
      setEndorsed((prev) => new Set(prev).add(id));
      void qc.invalidateQueries({ queryKey: ["account-endorsements"] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Could not record the endorsement"),
  });

  const cancel = (id: string) => {
    void trust.cancelPairing(id).then(() => invalidatePairings());
    setSasByPairing((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const active = (pairings.data ?? []).filter((p) => sasByPairing.has(p.id));
  const others = devices.filter((d) => d.id !== currentDevice.id && d.revoked_at == null);

  const labelFor = (deviceId: string): string =>
    devices.find((d) => d.id === deviceId)?.label ?? "the other device";

  return (
    <section className="space-y-3 rounded-md border border-border p-4">
      <div>
        <h3 className="text-sm font-semibold">Add a device to your account</h3>
        <p className="text-sm text-muted-foreground">
          One check works everywhere: approve a device here and it can reach every host you own.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {active.map((pairing) => {
        const number = sasByPairing.get(pairing.id) ?? "";
        const amInitiator = pairing.initiator_device_id === currentDevice.id;
        const peer = amInitiator
          ? labelFor(pairing.joiner_device_id)
          : labelFor(pairing.initiator_device_id);
        const done = endorsed.has(pairing.id);
        return (
          <div
            key={pairing.id}
            data-testid="ceremony-active"
            className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3"
          >
            <p className="text-sm">
              Confirm this matches the number shown on <span className="font-medium">{peer}</span>:
            </p>
            <p
              data-testid="ceremony-sas"
              className="text-center font-mono text-3xl tracking-widest"
            >
              {number}
            </p>
            {done ? (
              <p data-testid="ceremony-approved" role="status" className="text-sm text-primary">
                Approved on this device. When both sides confirm, the device is trusted everywhere.
              </p>
            ) : (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  data-testid="ceremony-confirm"
                  disabled={confirmMutation.isPending}
                  onClick={() => confirmMutation.mutate(pairing)}
                >
                  The numbers match
                </Button>
                <Button size="sm" variant="secondary" onClick={() => cancel(pairing.id)}>
                  They differ — cancel
                </Button>
              </div>
            )}
          </div>
        );
      })}

      {active.length === 0 && (
        <div className="space-y-2">
          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No other devices yet. Sign in on another device, then it will appear here to approve.
            </p>
          ) : (
            others.map((device) => {
              const trusted = alreadyEndorsed.has(device.id);
              return (
                <div
                  key={device.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border p-2"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {device.label ?? "Unnamed device"}
                  </span>
                  {trusted ? (
                    <span className="text-xs text-muted-foreground">Trusted</span>
                  ) : (
                    <Button
                      size="sm"
                      data-testid={`ceremony-approve-${device.id}`}
                      disabled={startMutation.isPending}
                      onClick={() => startMutation.mutate(device)}
                    >
                      Approve
                    </Button>
                  )}
                </div>
              );
            })
          )}
          <p className="text-xs text-muted-foreground">
            On the device being added, open this page — it will show the number to compare.
          </p>
        </div>
      )}
    </section>
  );
}
