import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { HostDetailView } from "@/components/hosts/host-detail-view";
import { errorMessage } from "@/components/hosts/host-model";
import { REMOVE_HOST_DESCRIPTION } from "@/components/hosts/host-trust-copy";
import { HostUpdateDialog } from "@/components/hosts/host-update-dialog";
import { claimHostDetailUpdatePrompt } from "@/components/hosts/host-update-status";
import { RenameHostDialog } from "@/components/hosts/rename-host-dialog";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { ActionSheet } from "@/components/ui/action-sheet";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import {
  useAgentsQuery,
  useHostBrowserDevicesQuery,
  useHostIdentityConflictQuery,
  useHostPinsQuery,
  useHostQuery,
  useHostSessionsQuery,
  useRemoveHostMutation,
  useRenameHostMutation,
} from "@/data/queries/hosts";
import { sessionsForHost } from "@/data/selectors/host";
import { spacing, useTheme } from "@/theme";

export function HostDetailScreen({ hostId }: { hostId: string }) {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const hostQuery = useHostQuery(hostId);
  const sessionsQuery = useHostSessionsQuery(hostId);
  const agentsQuery = useAgentsQuery();
  const hostPinsQuery = useHostPinsQuery(hostId);
  const browserDevicesQuery = useHostBrowserDevicesQuery(hostId);
  const rename = useRenameHostMutation();
  const remove = useRemoveHostMutation();
  const [actionsVisible, setActionsVisible] = useState(false);
  const [renameVisible, setRenameVisible] = useState(false);
  const [removeVisible, setRemoveVisible] = useState(false);
  const [updateVisible, setUpdateVisible] = useState(false);
  const host = hostQuery.data;
  const identityConflict = useHostIdentityConflictQuery(host).data === true;

  // Offered once per host per launch, as the browser's host page does; after
  // that the update chip under Details opens it. Nothing waits behind it.
  useEffect(() => {
    if (host && claimHostDetailUpdatePrompt(host)) setUpdateVisible(true);
  }, [host]);

  const openFiles = () => {
    if (!host || identityConflict) return;
    router.push({ pathname: "/host/[id]/files", params: { id: host.id } });
  };

  const refresh = () => {
    void Promise.all([
      hostQuery.refetch(),
      sessionsQuery.refetch(),
      agentsQuery.refetch(),
      hostPinsQuery.refetch(),
      browserDevicesQuery.refetch(),
    ]);
  };

  return (
    <Screen
      header={
        <AppHeader
          actions={[
            {
              accessibilityLabel: "Host actions",
              disabled: host === undefined,
              icon: "Ellipsis",
              onPress: () => setActionsVisible(true),
            },
          ]}
          onBack={router.back}
          title={host?.name ?? "Host"}
        />
      }
      padded={false}
    >
      <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
        {hostQuery.isPending ? (
          <View style={styles.centered}>
            <Spinner label="Loading host" />
          </View>
        ) : hostQuery.isError || !host ? (
          <EmptyState
            action={
              <View style={styles.errorActions}>
                <Button onPress={() => void hostQuery.refetch()}>Retry</Button>
                <Button onPress={router.back} variant="outline">
                  Back
                </Button>
              </View>
            }
            description={`Failed to load host: ${errorMessage(hostQuery.error)}`}
            icon="AlertCircle"
            title="Host unavailable"
          />
        ) : (
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            refreshControl={
              <RefreshControl
                onRefresh={refresh}
                refreshing={
                  hostQuery.isRefetching ||
                  sessionsQuery.isRefetching ||
                  hostPinsQuery.isRefetching ||
                  browserDevicesQuery.isRefetching
                }
                tintColor={theme.colors.mutedForeground}
              />
            }
          >
            <HostDetailView
              agents={agentsQuery.data ?? []}
              browserDevices={browserDevicesQuery.data ?? []}
              host={host}
              hostPins={hostPinsQuery.data ?? null}
              identityConflict={identityConflict}
              onOpenAgents={() =>
                router.push({ pathname: "/host/[id]/agents", params: { id: host.id } })
              }
              onOpenFiles={openFiles}
              onOpenSession={(session) => router.push(`/terminal/${session.id}`)}
              onOpenUpdate={() => setUpdateVisible(true)}
              onRemove={() => setRemoveVisible(true)}
              removing={remove.isPending}
              sessions={sessionsForHost(sessionsQuery.data ?? [], host.id)}
            />
            {sessionsQuery.isError ? (
              <View style={styles.inlineError}>
                <Text accessibilityRole="alert" color="destructive" variant="caption">
                  Failed to load sessions: {errorMessage(sessionsQuery.error)}
                </Text>
                <Button onPress={() => void sessionsQuery.refetch()} size="sm" variant="outline">
                  Retry
                </Button>
              </View>
            ) : null}
          </ScrollView>
        )}
        <ActionSheet
          actions={
            host
              ? [
                  {
                    id: "rename",
                    label: "Rename",
                    icon: <Icon color="mutedForeground" name="Pencil" />,
                    onPress: () => setRenameVisible(true),
                  },
                  {
                    id: "remove",
                    label: "Remove host",
                    destructive: true,
                    icon: <Icon color="destructive" name="Trash2" />,
                    onPress: () => setRemoveVisible(true),
                  },
                ]
              : []
          }
          onDismiss={() => setActionsVisible(false)}
          visible={actionsVisible && host !== undefined}
          {...(host === undefined ? {} : { title: host.name })}
        />
        <RenameHostDialog
          currentName={host?.name ?? ""}
          error={rename.error ? errorMessage(rename.error) : null}
          loading={rename.isPending}
          onCancel={() => {
            setRenameVisible(false);
            rename.reset();
          }}
          onRename={(name) => {
            if (!host) return;
            rename.mutate(
              { hostId: host.id, name },
              {
                onSuccess: () => {
                  toast.success("Host renamed");
                  setRenameVisible(false);
                },
              },
            );
          }}
          visible={renameVisible && host !== undefined}
        />
        <Confirm
          confirmLabel={remove.error ? "Retry deletion" : "Remove host"}
          description={REMOVE_HOST_DESCRIPTION}
          destructive
          onCancel={() => setRemoveVisible(false)}
          onConfirm={() => {
            if (!host || remove.isPending) return;
            remove.mutate(host, {
              onError: (error) => toast.error("Could not remove host", { detail: error.message }),
              onSuccess: () => {
                toast.success("Host removed");
                router.replace("/hosts");
              },
            });
          }}
          title={`Remove ${host?.name ?? "host"}?`}
          visible={removeVisible && host !== undefined}
        />
        {host && updateVisible ? (
          <HostUpdateDialog host={host} onDismiss={() => setUpdateVisible(false)} visible />
        ) : null}
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
  errorActions: {
    flexDirection: "row",
    gap: spacing[2],
  },
  inlineError: {
    alignItems: "flex-start",
    gap: spacing[2],
    paddingHorizontal: spacing[4],
  },
  screen: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: spacing[8],
  },
});
