"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { trust } from "@/lib/api";
import { loadBrowserDeviceIdentity } from "@/lib/browser-device-identity";
import {
  acceptEndorsementIntroductions,
  type EndorsementIntroduction,
  verifyEndorsementIntroductions,
} from "@/lib/endorsement-introduction";

/**
 * The receiving half of bidirectional approval: this browser was endorsed by
 * a trusted device, and each endorsement carries a host key signed by that
 * device. Signatures are verified locally first; then the operator confirms
 * the ENDORSER's fingerprint — the same comparison the endorsing browser made
 * in the other direction — and only then are the hosts pinned here.
 */
export function IntroductionPanel({
  accountId,
  deviceId,
}: {
  accountId: string;
  deviceId: string | null;
}) {
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const introductions = useQuery({
    queryKey: ["trust", "introductions", accountId, deviceId],
    enabled: deviceId !== null,
    refetchInterval: 15_000,
    queryFn: async (): Promise<EndorsementIntroduction[]> => {
      const identity = await loadBrowserDeviceIdentity(accountId);
      if (identity === null || deviceId === null) return [];
      const claimed = await trust.endorsementsFor(deviceId);
      return verifyEndorsementIntroductions({
        accountId,
        deviceId,
        devicePublicKeyWire: identity.publicKeyWire,
        claimed,
      });
    },
  });

  const accept = useMutation({
    mutationFn: async () => {
      const verified = introductions.data ?? [];
      if (verified.length === 0) throw new Error("nothing to accept");
      return acceptEndorsementIntroductions(accountId, verified);
    },
    onSuccess: (result) => {
      setError(result.failures.length > 0 ? result.failures.join("; ") : null);
      setDone(
        `Verified ${result.approved} host${result.approved === 1 ? "" : "s"} on this browser.`,
      );
      void introductions.refetch();
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : String(cause)),
  });

  const verified = introductions.data ?? [];
  if (verified.length === 0) return null;

  // Every verified introduction from one endorser shares its fingerprint;
  // group so the operator confirms once per endorsing device.
  const endorsers = new Map<
    string,
    { fingerprint: string; label: string | null; hosts: string[] }
  >();
  for (const introduction of verified) {
    const entry = endorsers.get(introduction.endorserDeviceId) ?? {
      fingerprint: introduction.endorserFingerprint,
      label: introduction.endorserLabel,
      hosts: [],
    };
    entry.hosts.push(introduction.hostName);
    endorsers.set(introduction.endorserDeviceId, entry);
  }

  return (
    <div
      className="space-y-3 rounded-md border border-emerald-600/50 p-3"
      data-testid="introduction-panel"
    >
      <div>
        <p className="text-sm font-medium">Finish verifying this browser</p>
        <p className="text-sm text-muted-foreground">
          A device you trust approved this browser and vouched for these hosts. Check that the
          approving device shows this fingerprint, then accept — this browser will verify those
          hosts itself, with no first-contact trust.
        </p>
      </div>
      {[...endorsers.entries()].map(([id, entry]) => (
        <div key={id} className="space-y-1">
          <p className="text-sm">
            {entry.label ?? "Approving device"} — vouched for {entry.hosts.join(", ")}
          </p>
          <p className="break-all rounded bg-muted px-2 py-1.5 font-mono text-sm font-semibold">
            {entry.fingerprint}
          </p>
        </div>
      ))}
      {error !== null && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      {done !== null && (
        <p className="text-sm font-medium" role="status">
          {done}
        </p>
      )}
      <Button size="sm" disabled={accept.isPending} onClick={() => accept.mutate()}>
        {accept.isPending ? "Verifying…" : "It matches — verify these hosts"}
      </Button>
    </div>
  );
}
