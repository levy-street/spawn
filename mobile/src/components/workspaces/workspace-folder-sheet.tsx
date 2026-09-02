import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { FolderPicker } from "@/components/launcher/folder-picker";
import { pathFlavorForHostOS } from "@/components/launcher/folder-picker-logic";
import { useDeviceApprovalGate } from "@/components/trust/device-approval-gate";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { listRecentDirectories } from "@/data/api/endpoints/hosts";
import type { HostOut } from "@/data/api/schemas/hosts";
import { useFileHosts } from "@/data/queries/files";
import { qk } from "@/data/queryKeys";
import { sortHosts } from "@/data/selectors/host";
import { haptics } from "@/lib/haptics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { borderWidth, opacity, spacing, useTheme } from "@/theme";

/** Where a workspace opens: a folder, on one machine. */
export interface WorkspaceFolder {
  hostId: string;
  hostName: string;
  path: string;
}

export interface WorkspaceFolderSheetProps {
  visible: boolean;
  /** Reopened on the folder it already has, so a change starts where you left off. */
  initial: WorkspaceFolder | null;
  onDismiss: () => void;
  onPick: (folder: WorkspaceFolder) => void;
}

/**
 * Choosing a workspace's folder from the phone — the same choice the desktop
 * makes in its New workspace menu, in the shape a sheet can hold.
 *
 * Browsing a machine's folders is a live, direct connection to it, so this is
 * one of the surfaces that needs the machine to have approved this device. It
 * asks for that approval before opening the connection rather than after the
 * listing fails: an error where the folders should be is not an answer anybody
 * can act on.
 */
export function WorkspaceFolderSheet({
  visible,
  initial,
  onDismiss,
  onPick,
}: WorkspaceFolderSheetProps): React.JSX.Element {
  const theme = useTheme();
  const hosts = useFileHosts();
  const gate = useDeviceApprovalGate();
  const [host, setHost] = useState<HostOut | null>(null);
  const [transport, setTransport] = useState<HostTransport | null>(null);
  const [transportState, setTransportState] = useState<TransportState>("idle");
  const [error, setError] = useState<string | null>(null);

  const reachable = sortHosts(hosts.data ?? []).filter(
    (candidate) => candidate.status === "online" && candidate.host_public_key,
  );
  // Nothing to choose between: one machine is the machine.
  const only = reachable.length === 1 ? (reachable[0] ?? null) : null;

  const open = useCallback(
    (next: HostOut) => {
      setError(null);
      setTransport(null);
      setTransportState("idle");
      gate.guard(next.id, () => setHost(next));
    },
    [gate.guard],
  );

  useEffect(() => {
    if (visible) return;
    setHost(null);
    setTransport(null);
    setTransportState("idle");
    setError(null);
  }, [visible]);

  useEffect(() => {
    if (!visible || host !== null || only === null) return;
    open(only);
  }, [visible, host, only, open]);

  const recents = useQuery({
    queryKey: qk.hostFolders(host?.id ?? "", "recent"),
    queryFn: async () => (await listRecentDirectories(host?.id ?? "")).dirs,
    enabled: host !== null,
  });

  return (
    <>
      <Sheet onDismiss={onDismiss} size="tall" testID="workspace-folder-sheet" visible={visible}>
        <SheetHeader title={host ? `Folder on ${host.name}` : "Choose a machine"} />
        {host === null ? (
          reachable.length === 0 ? (
            <EmptyState
              description={
                hosts.isLoading
                  ? "Looking for machines on your account…"
                  : "A workspace opens in a folder on one of your machines, and none is online right now."
              }
              icon="Unplug"
              title="No machine is online"
            />
          ) : (
            <View style={styles.hostList}>
              {reachable.map((candidate) => (
                <Pressable
                  accessibilityLabel={`Browse folders on ${candidate.name}`}
                  accessibilityRole="button"
                  key={candidate.id}
                  onPress={() => {
                    haptics.selection();
                    open(candidate);
                  }}
                  style={({ pressed }) => [
                    styles.hostRow,
                    {
                      backgroundColor: pressed ? theme.colors.accent : theme.colors.background,
                      borderBottomColor: theme.colors.border,
                      gap: theme.space(3),
                      paddingHorizontal: theme.space(4),
                      paddingVertical: theme.space(3),
                    },
                  ]}
                >
                  <StatusDot tone="active" />
                  <Text style={styles.hostName} variant="label">
                    {candidate.name}
                  </Text>
                  <Icon color="mutedForeground" name="ChevronRight" />
                </Pressable>
              ))}
            </View>
          )
        ) : (
          <FolderPicker
            initialPath={initial?.hostId === host.id ? initial.path : null}
            onSelect={(path) => {
              haptics.selection();
              onPick({ hostId: host.id, hostName: host.name, path });
            }}
            // Without this the picker defaults to POSIX and mangles every path
            // on a Windows host — separators, the drive root, the home check.
            pathFlavor={pathFlavorForHostOS(host.os)}
            recentDirectories={recents.data ?? []}
            recentError={recents.error instanceof Error ? recents.error.message : null}
            transport={transport}
            transportState={transportState}
          />
        )}
        {error ? (
          <Text
            accessibilityRole="alert"
            color="destructive"
            style={[styles.error, { padding: theme.space(4) }]}
            variant="caption"
          >
            {error}
          </Text>
        ) : null}
      </Sheet>
      {visible && host?.host_public_key ? (
        <HostTransportSurface
          hostId={host.id}
          hostIdentityPublicKey={host.host_public_key}
          onError={(cause) => setError(cause.message)}
          onStateChange={setTransportState}
          onTransport={setTransport}
        />
      ) : null}
      {gate.overlay}
    </>
  );
}

const styles = StyleSheet.create({
  error: {
    textAlign: "center",
  },
  hostList: {
    paddingVertical: spacing[1],
  },
  hostName: {
    flex: 1,
  },
  hostRow: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    opacity: opacity.opaque,
  },
});
