"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";

import { hosts } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { HostControlClient, type HostControlState } from "@/lib/hostControl";
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
              return resolveSignedRtcTrust({
                accountId: t.accountId as string,
                hostId: t.hostId as string,
                claimedHostPublicKey: t.claimedHostPublicKey,
                claimedHostFingerprint: t.claimedHostFingerprint,
                isActive: () => true,
              });
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
