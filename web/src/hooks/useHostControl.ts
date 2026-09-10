"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { useDaemonConnection } from "@/components/hosts/DaemonConnectionsProvider";
import { hosts } from "@/lib/api";
import { HostControlClient, type HostControlState } from "@/lib/hostControl";

const EMPTY_CAPABILITIES: ReadonlySet<string> = new Set();

export function useHostControl(hostId: string | null, enabled = true) {
  const hostQuery = useQuery({
    queryKey: ["host", hostId],
    queryFn: () => hosts.get(hostId as string),
    enabled: hostId !== null,
    staleTime: 30_000,
  });

  const connection = useDaemonConnection(hostId);
  const signalingReady = connection !== null;
  const client = useMemo(
    () =>
      hostId && connection ? new HostControlClient(hostId, { sharedConnection: connection }) : null,
    [hostId, connection],
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
  return {
    client,
    state,
    capabilities: snapshot.capabilities,
    /** Host platform, for wording only — never for gating a capability. */
    os: hostQuery.data?.os ?? null,
    signedRtcRefusal,
  };
}
