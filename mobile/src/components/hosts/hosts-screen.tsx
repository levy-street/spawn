import { useIsFocused } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useMemo, useRef, useState } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  View,
  type ViewabilityConfigCallbackPairs,
} from "react-native";
import { HostActionsSheet } from "@/components/hosts/host-actions-sheet";
import { HostCard } from "@/components/hosts/host-card";
import { errorMessage, pluralize } from "@/components/hosts/host-model";
import { REMOVE_HOST_DESCRIPTION } from "@/components/hosts/host-trust-copy";
import { RenameHostDialog } from "@/components/hosts/rename-host-dialog";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { POSSESS_A_HOST } from "@/components/onboarding/possess-copy";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { useDeviceHostApprovals } from "@/data/queries/device-trust";
import {
  useAgentsQuery,
  useAllSessionsQuery,
  useHostsQuery,
  useRemoveHostMutation,
  useRenameHostMutation,
} from "@/data/queries/hosts";
import { fleetRollup, sessionsForHost, sortHosts } from "@/data/selectors/host";
import type { FleetRollup } from "@/data/types/domain";
import { useAppActive } from "@/lib/app-active";
import { haptics } from "@/lib/haptics";
import { spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

const ON_SCREEN = { itemVisiblePercentThreshold: 1 } as const;
const NO_HOSTS: ReadonlySet<string> = new Set();

/**
 * The header's one line of totals. The fleet's figures used to sit above the
 * hosts in a bank of tiles, which on a phone was a screen of arithmetic before
 * the first host; a line under the mark says the same without pushing them down.
 */
export function hostsSummaryLine(hosts: readonly HostOut[], rollup: FleetRollup): string {
  const cores = hosts.reduce((total, host) => total + (host.cpu_cores ?? 0), 0);
  return [
    `${rollup.onlineHosts} of ${rollup.hosts} online`,
    cores > 0 ? pluralize(cores, "core") : null,
    rollup.attention > 0 ? `${rollup.attention} need you` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

/**
 * Which hosts' cards are on screen in the list, as FlatList reports them. Any
 * sliver of a card counts: it is the card a person is looking at.
 */
export function useOnScreenHosts(): {
  onScreen: ReadonlySet<string>;
  viewabilityConfigCallbackPairs: ViewabilityConfigCallbackPairs;
} {
  const [onScreen, setOnScreen] = useState<ReadonlySet<string>>(NO_HOSTS);
  // FlatList refuses a viewability callback that changes between renders.
  const viewabilityConfigCallbackPairs = useRef<ViewabilityConfigCallbackPairs>([
    {
      viewabilityConfig: ON_SCREEN,
      onViewableItemsChanged: ({ viewableItems }) => {
        // The list keys each card by its host's ID.
        const next = new Set(viewableItems.map((token) => token.key));
        setOnScreen((current) =>
          current.size === next.size && [...current].every((hostId) => next.has(hostId))
            ? current
            : next,
        );
      },
    },
  ]).current;
  return { onScreen, viewabilityConfigCallbackPairs };
}

export interface HostsViewProps {
  hosts: readonly HostOut[];
  /** Every session in the fleet; each card takes its own. */
  sessions?: readonly SessionOut[];
  /** Account agents, so a session's command resolves to a known agent. */
  agents?: readonly AgentOut[];
  refreshing: boolean;
  /** Hosts that have not pinned this device; they cannot open a terminal here. */
  unapprovedCount?: number;
  /**
   * The tab is focused and the app is in the foreground, so the cards on screen
   * may ask their hosts for exact figures. Cards scrolled away never do.
   */
  live?: boolean;
  onConnect(): void;
  onOpen(host: HostOut): void;
  onOpenActions(host: HostOut): void;
  onRefresh(): void;
  onApproveDevice?(): void;
}

export function HostsView({
  hosts,
  sessions = [],
  agents = [],
  refreshing,
  unapprovedCount = 0,
  live = false,
  onConnect,
  onOpen,
  onOpenActions,
  onRefresh,
  onApproveDevice,
}: HostsViewProps) {
  const theme = useTheme();
  const { onScreen, viewabilityConfigCallbackPairs } = useOnScreenHosts();

  return (
    <FlatList
      contentContainerStyle={styles.list}
      data={[...hosts]}
      keyExtractor={(host) => host.id}
      ListEmptyComponent={
        <EmptyState
          style={styles.emptyState}
          action={<Button onPress={onConnect}>{POSSESS_A_HOST}</Button>}
          description="A host is a computer your agents run on. Install SPAWN D on it, then run spawnd possess there."
          icon="Server"
          title="No hosts yet."
        />
      }
      ListHeaderComponent={
        hosts.length > 0 && unapprovedCount > 0 && onApproveDevice ? (
          <View style={styles.header}>
            <Card padded={false} variant="flat">
              <ListRow
                height="tall"
                leading={<Icon color="warning" name="ShieldAlert" size={spacing[5]} />}
                onPress={() => {
                  haptics.selection();
                  onApproveDevice();
                }}
                subtitle={`${pluralize(unapprovedCount, "host")} will not open a terminal here until this device is approved.`}
                title="This device is not approved yet"
                trailing={<Icon color="mutedForeground" name="ChevronRight" />}
              />
            </Card>
          </View>
        ) : null
      }
      ItemSeparatorComponent={ListSeparator}
      // Closes the list under the last host, rather than letting the cards stop
      // mid-air above the empty space below them, then says once where the
      // exact figures on them come from.
      ListFooterComponent={
        hosts.length > 0 ? (
          <>
            <ListSeparator />
            <Text color="mutedForeground" style={styles.footnote} variant="caption">
              Exact figures travel straight from each host to this device. The spawnd server only
              ever sees a five-level reading every thirty seconds.
            </Text>
          </>
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
        <HostCard
          agents={agents}
          host={item}
          liveCapacity={live && onScreen.has(item.id)}
          onOpen={() => onOpen(item)}
          onOpenActions={() => onOpenActions(item)}
          sessions={sessionsForHost(sessions, item.id)}
        />
      )}
      testID="hosts-list"
      viewabilityConfigCallbackPairs={viewabilityConfigCallbackPairs}
    />
  );
}

export function HostsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  // Exact figures only while someone can see them: this tab, in front, with
  // the app on screen. A card pushed over it or a phone in a pocket asks nothing.
  const focused = useIsFocused();
  const appActive = useAppActive();
  const hostsQuery = useHostsQuery();
  const sessionsQuery = useAllSessionsQuery();
  const agentsQuery = useAgentsQuery();
  const rename = useRenameHostMutation();
  const remove = useRemoveHostMutation();
  const [actionsHost, setActionsHost] = useState<HostOut | null>(null);
  const [renameHost, setRenameHost] = useState<HostOut | null>(null);
  const [removeHost, setRemoveHost] = useState<HostOut | null>(null);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const hosts = useMemo(() => sortHosts(hostsQuery.data ?? []), [hostsQuery.data]);
  const rollup = useMemo(
    () => fleetRollup(hosts, sessionsQuery.data ?? [], agentsQuery.data ?? []),
    [agentsQuery.data, hosts, sessionsQuery.data],
  );
  const approvals = useDeviceHostApprovals();

  const openHost = (host: HostOut) => {
    router.push({ pathname: "/host/[id]", params: { id: host.id } });
  };
  const possessHost = () => router.push("/onboarding/host");

  return (
    <Screen
      header={
        <AppHeader
          actions={[
            {
              accessibilityLabel: POSSESS_A_HOST,
              icon: "Plus",
              onPress: possessHost,
              testID: "hosts-connect-action",
            },
          ]}
          branded
          {...(hostsQuery.isPending
            ? { subtitle: "Counting your hosts…" }
            : hosts.length > 0
              ? { subtitle: hostsSummaryLine(hosts, rollup) }
              : {})}
          title="Hosts"
        />
      }
      padded={false}
    >
      <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
        {hostsQuery.isPending ? (
          <View style={styles.centered}>
            <Spinner label="Counting your hosts" />
          </View>
        ) : hostsQuery.isError ? (
          <EmptyState
            action={<Button onPress={() => void hostsQuery.refetch()}>Retry</Button>}
            description={`Failed to load hosts: ${errorMessage(hostsQuery.error)}`}
            icon="AlertCircle"
            title="Hosts unavailable"
          />
        ) : (
          <HostsView
            agents={agentsQuery.data ?? []}
            hosts={hosts}
            live={focused && appActive}
            onApproveDevice={() => router.push("/device-approval")}
            onConnect={possessHost}
            onOpen={openHost}
            onOpenActions={setActionsHost}
            onRefresh={() => {
              if (manualRefreshing) return;
              setManualRefreshing(true);
              void Promise.all([
                hostsQuery.refetch(),
                sessionsQuery.refetch(),
                agentsQuery.refetch(),
              ]).finally(() => setManualRefreshing(false));
            }}
            refreshing={manualRefreshing}
            sessions={sessionsQuery.data ?? []}
            unapprovedCount={approvals.awaiting.length}
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
          description={REMOVE_HOST_DESCRIPTION}
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
  header: {
    gap: spacing[3],
    marginHorizontal: spacing[4],
    marginTop: spacing[4],
  },
  centered: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  emptyState: {
    marginHorizontal: spacing[4],
    marginTop: spacing[6],
  },
  footnote: {
    paddingHorizontal: sizing.screen.gutter,
    paddingTop: spacing[4],
  },
  list: {
    flexGrow: 1,
    paddingBottom: spacing[8],
  },
  screen: {
    flex: 1,
  },
});
