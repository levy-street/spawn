import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { HostActionsSheet } from "@/components/hosts/host-actions-sheet";
import { HostListItem } from "@/components/hosts/host-list-item";
import { errorMessage } from "@/components/hosts/host-model";
import { RenameHostDialog } from "@/components/hosts/rename-host-dialog";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import type { HostOut } from "@/data/api/schemas/hosts";
import { useHostsQuery, useRemoveHostMutation, useRenameHostMutation } from "@/data/queries/hosts";
import { sortHosts } from "@/data/selectors/host";
import { haptics } from "@/lib/haptics";
import { borderWidth, spacing, useTheme } from "@/theme";

export interface HostListViewProps {
  hosts: readonly HostOut[];
  refreshing: boolean;
  onConnect(): void;
  onOpen(host: HostOut): void;
  onOpenActions(host: HostOut): void;
  onOpenLegion(): void;
  onRefresh(): void;
}

export function HostListView({
  hosts,
  refreshing,
  onConnect,
  onOpen,
  onOpenActions,
  onOpenLegion,
  onRefresh,
}: HostListViewProps) {
  const theme = useTheme();
  const online = hosts.filter((host) => host.status === "online").length;
  const offline = hosts.length - online;
  return (
    <FlatList
      contentContainerStyle={hosts.length === 0 ? styles.emptyList : styles.list}
      data={[...hosts]}
      keyExtractor={(host) => host.id}
      ListEmptyComponent={
        <EmptyState
          action={<Button onPress={onConnect}>Connect a host</Button>}
          description="Run the installer and spawnd login on a supported Mac or Linux machine."
          icon="Server"
          title="No hosts are connected yet."
        />
      }
      ListHeaderComponent={
        hosts.length > 0 ? (
          <Pressable
            accessibilityLabel="Open fleet overview"
            accessibilityRole="button"
            onPress={() => {
              haptics.selection();
              onOpenLegion();
            }}
            style={({ pressed }) => [
              styles.fleet,
              {
                backgroundColor: pressed ? theme.colors.accent : theme.colors.card,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.lg,
              },
            ]}
          >
            <Icon color="mutedForeground" name="Network" size={spacing[5]} />
            <View style={styles.fleetCopy}>
              <Text variant="label">Fleet overview</Text>
              <Text color="mutedForeground" variant="caption">
                {online} online · {offline} offline
              </Text>
            </View>
            <Icon color="mutedForeground" name="ChevronRight" />
          </Pressable>
        ) : null
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={theme.colors.mutedForeground}
        />
      }
      renderItem={({ item }) => (
        <HostListItem
          host={item}
          onOpen={() => onOpen(item)}
          onOpenActions={() => onOpenActions(item)}
        />
      )}
    />
  );
}

export function HostListScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const hostsQuery = useHostsQuery();
  const rename = useRenameHostMutation();
  const remove = useRemoveHostMutation();
  const [actionsHost, setActionsHost] = useState<HostOut | null>(null);
  const [renameHost, setRenameHost] = useState<HostOut | null>(null);
  const [removeHost, setRemoveHost] = useState<HostOut | null>(null);
  const hosts = useMemo(() => sortHosts(hostsQuery.data ?? []), [hostsQuery.data]);

  const openHost = (host: HostOut) => {
    router.push({ pathname: "/host/[id]", params: { id: host.id } });
  };

  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.screen, { backgroundColor: theme.colors.background }]}
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <Text accessibilityRole="header" style={styles.headerTitle} variant="title">
          Hosts
        </Text>
        <IconButton
          accessibilityLabel="Connect a host"
          icon="Plus"
          onPress={() => router.push("/onboarding/host")}
        />
      </View>
      {hostsQuery.isPending ? (
        <View style={styles.centered}>
          <Spinner label="Loading hosts" />
        </View>
      ) : hostsQuery.isError ? (
        <EmptyState
          action={<Button onPress={() => void hostsQuery.refetch()}>Retry</Button>}
          description={`Failed to load hosts: ${errorMessage(hostsQuery.error)}`}
          icon="AlertCircle"
          title="Hosts unavailable"
        />
      ) : (
        <HostListView
          hosts={hosts}
          onConnect={() => router.push("/onboarding/host")}
          onOpen={openHost}
          onOpenActions={setActionsHost}
          onOpenLegion={() => router.push("/(tabs)/hosts/legion")}
          onRefresh={() => void hostsQuery.refetch()}
          refreshing={hostsQuery.isRefetching}
        />
      )}
      <HostActionsSheet
        host={actionsHost}
        onDismiss={() => setActionsHost(null)}
        onOpen={openHost}
        onRemove={setRemoveHost}
        onRename={setRenameHost}
      />
      <RenameHostDialog
        currentName={renameHost?.name ?? ""}
        error={rename.error ? errorMessage(rename.error) : null}
        loading={rename.isPending}
        onCancel={() => {
          setRenameHost(null);
          rename.reset();
        }}
        onRename={(name) => {
          if (!renameHost) return;
          rename.mutate(
            { hostId: renameHost.id, name },
            {
              onSuccess: () => {
                toast.success("Host renamed");
                setRenameHost(null);
              },
            },
          );
        }}
        visible={renameHost !== null}
      />
      <Confirm
        confirmLabel={remove.error ? "Retry deletion" : "Remove host"}
        description="Its daemon token will be revoked and it will no longer be able to connect."
        destructive
        onCancel={() => setRemoveHost(null)}
        onConfirm={() => {
          if (!removeHost || remove.isPending) return;
          remove.mutate(removeHost, {
            onError: (error) => toast.error("Could not remove host", { detail: error.message }),
            onSuccess: () => {
              toast.success("Host removed");
              setRemoveHost(null);
            },
          });
        }}
        title={`Remove ${removeHost?.name ?? "host"}?`}
        visible={removeHost !== null}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  emptyList: {
    flexGrow: 1,
    justifyContent: "center",
    padding: spacing[6],
  },
  fleet: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    margin: spacing[4],
    padding: spacing[4],
  },
  fleetCopy: {
    flex: 1,
    gap: spacing[1],
  },
  header: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    minHeight: spacing[14],
    paddingHorizontal: spacing[4],
  },
  headerTitle: {
    flex: 1,
  },
  list: {
    paddingBottom: spacing[8],
  },
  screen: {
    flex: 1,
  },
});
