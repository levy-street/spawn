"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { HostControlClient, type HostControlState } from "@/lib/hostControl";
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
  // server-claimed key/fingerprint are untrusted; the local pin gate decides.
  const trustRef = useRef({
    accountId: null as string | null,
    hostId,
    claimedHostPublicKey: null as string | null,
    claimedHostFingerprint: null as string | null,
  });
  trustRef.current = {
    accountId: user?.id ?? null,
    hostId,
    claimedHostPublicKey: hostQuery.data?.host_public_key ?? null,
    claimedHostFingerprint: hostQuery.data?.host_key_fingerprint ?? null,
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
                claimedHostFingerprint: t.claimedHostFingerprint,
                // The trust epoch ends the moment the signed-in account changes:
                // a negotiation spanning a logout or account switch must abort
                // rather than complete under the previous account's pin and
                // signing identity.
                isActive: () => trustRef.current.accountId === epochAccountId,
              });
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
  const signalingReady = (user?.id ?? null) !== null && hostId !== null && !hostQuery.isLoading;

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
  return {
    client,
    state,
    capabilities: snapshot.capabilities,
    /** Host platform, for wording only — never for gating a capability. */
    os: hostQuery.data?.os ?? null,
    signedRtcRefusal,
  };
}
