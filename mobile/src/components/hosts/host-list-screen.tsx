import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { HostActionsSheet } from "@/components/hosts/host-actions-sheet";
import { HostListItem } from "@/components/hosts/host-list-item";
import { errorMessage, pluralize } from "@/components/hosts/host-model";
import { RenameHostDialog } from "@/components/hosts/rename-host-dialog";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import type { HostOut } from "@/data/api/schemas/hosts";
import { useHostsQuery, useRemoveHostMutation, useRenameHostMutation } from "@/data/queries/hosts";
import { sortHosts } from "@/data/selectors/host";
import { haptics } from "@/lib/haptics";
import { spacing, useTheme } from "@/theme";

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
  const sessionCount = hosts.reduce((total, host) => total + host.session_count, 0);
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
          <Card padded={false} style={styles.fleet} variant="flat">
            <ListRow
              height="tall"
              leading={<Icon color="mutedForeground" name="Network" size={spacing[5]} />}
              onPress={() => {
                haptics.selection();
                onOpenLegion();
              }}
              subtitle={`${online} online · ${offline} offline · ${pluralize(sessionCount, "session")}`}
              title="Fleet overview"
              trailing={<Icon color="mutedForeground" name="ChevronRight" />}
            />
          </Card>
        ) : null
      }
      ItemSeparatorComponent={() => <ListSeparator inset={false} />}
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
    <Screen
      header={
        <AppHeader
          actions={[
            {
              accessibilityLabel: "Open the legion",
              icon: "Network",
              onPress: () => router.push("/legion"),
              testID: "hosts-legion-action",
            },
            {
              accessibilityLabel: "Open settings",
              icon: "Settings",
              onPress: () => router.push("/settings"),
              testID: "hosts-settings-action",
            },
            {
              accessibilityLabel: "Connect a host",
              icon: "Plus",
              onPress: () => router.push("/onboarding/host"),
              testID: "hosts-connect-action",
            },
          ]}
          onBack={router.back}
          title="Hosts"
        />
      }
      padded={false}
    >
      <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
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
            onOpenLegion={() => router.push("/legion")}
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
      </View>
    </Screen>
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
    margin: spacing[4],
    overflow: "hidden",
  },
  list: {
    paddingBottom: spacing[8],
  },
  screen: {
    flex: 1,
  },
});
