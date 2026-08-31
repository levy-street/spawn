"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { hosts, trust } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  type CarriedEndorsement,
  HostControlClient,
  type HostControlState,
} from "@/lib/hostControl";
import { resolveSignedRtcTrust, type SignedRtcTrustDecision } from "@/lib/signed-rtc-trust";

const EMPTY_CAPABILITIES: ReadonlySet<string> = new Set();

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

  const signalingReady = (user?.id ?? null) !== null && hostId !== null && !hostQuery.isLoading;
  const accountEndorsementsQuery = useQuery({
    queryKey: ["account-endorsements", user?.id ?? null],
    queryFn: () => trust.accountEndorsements(),
    enabled: signalingReady,
    staleTime: 5 * 60_000,
  });
  const endorsementsRef = useRef(accountEndorsementsQuery.data);
  endorsementsRef.current = accountEndorsementsQuery.data;

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
              const edges = endorsementsRef.current ?? [];
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

  // Capabilities travel with the state, and land before `ready`: a subscriber
  // that saw a ready client with an empty capability set would conclude the
  // host supports nothing and cache that conclusion.
  const [snapshot, setSnapshot] = useState<{
    state: HostControlState;
    capabilities: ReadonlySet<string>;
  }>({ state: "idle", capabilities: EMPTY_CAPABILITIES });
  const { state } = snapshot;

  // Only connect once the account and the host record are known, so a pinned
  // host is never reached (or falsely, terminally refused) before its identity
  // is available for the gate to check.
  useEffect(() => {
    if (!client || !enabled || !signalingReady) {
      setSnapshot({ state: "idle", capabilities: EMPTY_CAPABILITIES });
      return;
    }
    const unsubscribe = client.subscribe((next) =>
      setSnapshot({ state: next, capabilities: client.getCapabilities() }),
    );
    client.connect();
    return () => {
      unsubscribe();
      client.close();
    };
  }, [client, enabled, signalingReady]);

  const signedRtcRefusal = state === "error" ? (client?.getSignedRtcRefusal() ?? null) : null;
  const retry = useCallback(() => {
    if (!client || !enabled || !signalingReady) return;
    // Error/unauthorized states are terminal for the current generation.
    // Closing first also makes connect() re-entrant for an explicit retry.
    client.close();
    client.connect();
  }, [client, enabled, signalingReady]);
  return {
    client,
    state,
    retry,
    capabilities: snapshot.capabilities,
    /** Host platform, for wording only — never for gating a capability. */
    os: hostQuery.data?.os ?? null,
    signedRtcRefusal,
  };
}
