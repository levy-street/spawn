"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { hosts, trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  type CarriedEndorsement,
  HostControlClient,
  type HostControlState,
} from "@/lib/hostControl";
import { resolveSignedRtcTrust, type SignedRtcTrustDecision } from "@/lib/signed-rtc-trust";

export function useHostControl(hostId: string | null, enabled = true) {
  const { user } = useAuth();
  const hostQuery = useQuery({
    queryKey: ["host", hostId],
    queryFn: () => hosts.get(hostId as string),
    enabled: hostId !== null,
    staleTime: 30_000,
  });

  // Latest trust inputs, read by a stable resolver so the client (and its
  // connection) is not recreated whenever the host record refreshes. The
  // server-claimed key is untrusted; the local pin gate decides.
  const trustRef = useRef({
    accountId: null as string | null,
    hostId,
    claimedHostPublicKey: null as string | null,
  });
  trustRef.current = {
    accountId: user?.id ?? null,
    hostId,
    claimedHostPublicKey: hostQuery.data?.host_public_key ?? null,
  };

  const client = useMemo(
    () =>
      hostId
        ? new HostControlClient(hostId, {
            resolveSignedRtcTrust: (): Promise<SignedRtcTrustDecision> => {
              const t = trustRef.current;
              const epochAccountId = t.accountId;
              return resolveSignedRtcTrust({
                accountId: epochAccountId as string,
                hostId: t.hostId as string,
                claimedHostPublicKey: t.claimedHostPublicKey,
                // The trust epoch ends the moment the signed-in account changes:
                // a negotiation spanning a logout or account switch must abort
                // rather than complete under the previous account's pin and
                // signing identity.
                isActive: () => trustRef.current.accountId === epochAccountId,
              });
            },
            loadCarriedEndorsements: async (): Promise<CarriedEndorsement[]> => {
              const accountId = trustRef.current.accountId;
              if (!accountId) return [];
              const edges = await trust.accountEndorsements();
              return edges.map((edge) => ({
                account_id: accountId,
                endorser_public_key: edge.endorser_public_key,
                endorsed_public_key: edge.endorsed_public_key,
                endorsed_device_id: edge.endorsed_device_id,
                signature: edge.signature,
              }));
            },
          })
        : null,
    [hostId],
  );

  const [state, setState] = useState<HostControlState>("idle");

  // Only connect once the account and the host record are known, so a pinned
  // host is never reached (or falsely, terminally refused) before its identity
  // is available for the gate to check.
  const signalingReady = (user?.id ?? null) !== null && hostId !== null && !hostQuery.isLoading;

  useEffect(() => {
    if (!client || !enabled || !signalingReady) {
      setState("idle");
      return;
    }
    const unsubscribe = client.subscribe(setState);
    client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [client, enabled, signalingReady]);

  const signedRtcRefusal = state === "error" ? (client?.getSignedRtcRefusal() ?? null) : null;
  return { client, state, signedRtcRefusal };
}
