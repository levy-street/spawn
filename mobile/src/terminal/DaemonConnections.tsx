import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { listHosts } from "@/data/api/endpoints/hosts";
import { qk } from "@/data/queryKeys";
import { DEVICE_NOT_TRUSTED_CODE, invalidateDeviceHostTrust } from "@/data/trust/device-trust";
import { useHostApprovalWatch } from "@/data/trust/use-host-approval-watch";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { spacing, useTheme } from "@/theme";

function DaemonSurface({
  hostId,
  name,
  publicKey,
}: {
  hostId: string;
  name: string;
  publicKey: string;
}) {
  const transport = useRef<HostTransport | null>(null);
  const wasReady = useRef(false);
  const [state, setState] = useState<TransportState>("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const [awaitingApproval, setAwaitingApproval] = useState(false);
  const approval = useHostApprovalWatch(hostId, awaitingApproval);
  useEffect(() => {
    if (!awaitingApproval || approval !== "trusted") return;
    setAwaitingApproval(false);
    invalidateDeviceHostTrust(hostId);
    const current = transport.current;
    current?.close();
    void current?.open().catch(() => {});
  }, [approval, awaitingApproval, hostId]);
  return (
    <>
      <HostTransportSurface
        connectionOwner
        hostId={hostId}
        hostIdentityPublicKey={publicKey}
        onTransport={(next) => {
          transport.current = next;
        }}
        onStateChange={(next) => {
          if (next === "ready") {
            wasReady.current = true;
            setFailure(null);
            setAwaitingApproval(false);
          }
          setState(next);
        }}
        onError={(error) => {
          setFailure(error.message);
          if (error.code === DEVICE_NOT_TRUSTED_CODE) setAwaitingApproval(true);
        }}
      />
      {(failure || (wasReady.current && state !== "ready")) && (
        <View style={styles.row}>
          <Text style={styles.copy}>
            {failure ?? `Reconnecting to ${name}. Terminal input is paused.`}
          </Text>
          <Button
            accessibilityLabel={`Retry connection to ${name}`}
            variant="secondary"
            onPress={() => {
              const current = transport.current;
              if (!current) return;
              setFailure(null);
              current.close();
              void current
                .open()
                .catch((error: unknown) =>
                  setFailure(error instanceof Error ? error.message : "Connection failed."),
                );
            }}
          >
            Retry
          </Button>
        </View>
      )}
    </>
  );
}

/** Mounted inside the authenticated app, above navigation and terminal views. */
export function DaemonConnections({ accountId }: { accountId: string }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
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
    <View
      pointerEvents="box-none"
      style={[styles.container, { top: insets.top, backgroundColor: theme.colors.background }]}
    >
      {hosts.map((host) => (
        <DaemonSurface
          key={`${host.id}:${host.host_public_key}`}
          hostId={host.id}
          name={host.name}
          publicKey={host.host_public_key ?? ""}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { position: "absolute", left: 0, right: 0, zIndex: 100 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing[2], padding: spacing[2] },
  copy: { flex: 1 },
});
