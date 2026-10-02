import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { listHosts } from "@/data/api/endpoints/hosts";
import { qk } from "@/data/queryKeys";
import { useConnectionStore } from "@/data/stores/connection";
import { DEVICE_NOT_TRUSTED_CODE, invalidateDeviceHostTrust } from "@/data/trust/device-trust";
import { useHostApprovalWatch } from "@/data/trust/use-host-approval-watch";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport } from "@/terminal/transport/types";

/**
 * One host's connection, owned for the whole signed-in app. It shows nothing
 * itself: its state is published to the connection store, and read where the
 * host already appears — its Legion card, the terminals running on it — so a
 * host that is only asleep never puts a banner over everything else.
 */
function DaemonSurface({ hostId, publicKey }: { hostId: string; publicKey: string }) {
  const transport = useRef<HostTransport | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const approval = useHostApprovalWatch(hostId, awaitingApproval);
  const { setHostTransport, setHostProblem, setHostRetry, removeHost } =
    useConnectionStore.getState();
  useEffect(() => {
    setHostRetry(hostId, () => {
      const current = transport.current;
      if (!current) return;
      setHostProblem(hostId, null);
      current.close();
      void current
        .open()
        .catch((error: unknown) =>
          setHostProblem(hostId, error instanceof Error ? error.message : "Connection failed."),
        );
    });
    return () => removeHost(hostId);
  }, [hostId, removeHost, setHostProblem, setHostRetry]);
  useEffect(() => {
    if (!awaitingApproval || approval !== "trusted") return;
    setAwaitingApproval(false);
    invalidateDeviceHostTrust(hostId);
    const current = transport.current;
    current?.close();
    void current?.open().catch(() => {});
  }, [approval, awaitingApproval, hostId]);
  return (
    <HostTransportSurface
      connectionOwner
      hostId={hostId}
      hostIdentityPublicKey={publicKey}
      onTransport={(next) => {
        transport.current = next;
      }}
      onStateChange={(next) => {
        if (next === "ready") {
          setHostProblem(hostId, null);
          setAwaitingApproval(false);
        }
        setHostTransport(hostId, next);
      }}
      onError={(error) => {
        setHostProblem(hostId, error.message);
        if (error.code === DEVICE_NOT_TRUSTED_CODE) setAwaitingApproval(true);
      }}
    />
  );
}

/** Mounted inside the authenticated app, above navigation and terminal views. */
export function DaemonConnections({ accountId }: { accountId: string }) {
  const retained = useRef(new Set<string>());
  const query = useQuery({
    queryKey: [...qk.hosts(), "daemon-connections", accountId],
    queryFn: listHosts,
    refetchInterval: 30_000,
  });
  const hosts = (query.data ?? []).filter((host) => {
    if (host.status === "online") retained.current.add(host.id);
    return retained.current.has(host.id) && host.host_public_key !== null;
  });
  return (
    <View pointerEvents="none" style={styles.container}>
      {hosts.map((host) => (
        <DaemonSurface
          key={`${host.id}:${host.host_public_key}`}
          hostId={host.id}
          publicKey={host.host_public_key ?? ""}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: "absolute", left: 0, right: 0, top: 0 },
});
