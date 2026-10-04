import { useIsFocused } from "@react-navigation/native";
import { type Href, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS, withSpring } from "react-native-reanimated";
import { AccessTab } from "@/components/hosts/cockpit/access-tab";
import {
  COCKPIT_TAB_LABELS,
  COCKPIT_TABS,
  type CockpitTab,
  cockpitStatusLine,
  stepCockpitTab,
  windowBlockedReason,
  workspaceBySession,
} from "@/components/hosts/cockpit/cockpit-model";
import { FilesTab, filesBlocked } from "@/components/hosts/cockpit/files-tab";
import { OverviewTab } from "@/components/hosts/cockpit/overview-tab";
import { SessionsTab } from "@/components/hosts/cockpit/sessions-tab";
import { HostIdentityConflict } from "@/components/hosts/host-identity-conflict";
import { errorMessage, type HostMetrics } from "@/components/hosts/host-model";
import { REMOVE_HOST_DESCRIPTION } from "@/components/hosts/host-trust-copy";
import { HostUpdateDialog } from "@/components/hosts/host-update-dialog";
import {
  claimHostDetailUpdatePrompt,
  hostNeedsUpdatePrompt,
} from "@/components/hosts/host-update-status";
import { useLiveHostMetrics } from "@/components/hosts/live-host-metrics";
import { RenameHostDialog } from "@/components/hosts/rename-host-dialog";
import { type OpenHereRequest, OpenHereSheet } from "@/components/launcher/open-here-sheet";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { ActionSheet, type ActionSheetAction } from "@/components/ui/action-sheet";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import { UnderlineTabs, useTabSwipe } from "@/components/ui/underline-tabs";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import {
  useAgentsQuery,
  useHostBrowserDevicesQuery,
  useHostIdentityConflictQuery,
  useHostPinsQuery,
  useHostQuery,
  useHostSessionsQuery,
  useHostsQuery,
  useRemoveHostMutation,
  useRenameHostMutation,
} from "@/data/queries/hosts";
import { useWorkspacesQuery } from "@/data/queries/workspaces";
import { sortHosts } from "@/data/selectors/host";
import { displayPath, HOST_HOME } from "@/data/selectors/places";
import { recordHostCapabilities, useHostOffers } from "@/data/stores/host-capabilities";
import { useHostLiveStatus } from "@/data/stores/host-live";
import { useAppActive } from "@/lib/app-active";
import { haptics } from "@/lib/haptics";
import { HostTransportSurface } from "@/terminal/HostTransportSurface";
import type { HostTransport, TransportState } from "@/terminal/transport/types";
import { spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/** Sideways travel before the page starts following a swipe. */
const SWIPE_ACTIVATION = 16;
/** Vertical slack that hands the touch back to the tab's own scrolling. */
const SWIPE_AXIS_SLOP = 12;
/** Fraction of the width past which a release changes tab. */
const SWIPE_COMMIT_RATIO = 0.25;
/** How far ahead of the finger a release is read, so a flick commits early. */
const SWIPE_PROJECTION_SECONDS = 0.15;
const SETTLE_SPRING = { damping: 24, mass: 0.6, stiffness: 260 } as const;

const TAB_OPTIONS = COCKPIT_TABS.map((value) => ({ value, label: COCKPIT_TAB_LABELS[value] }));

/** The placeholder a host's live status reads from before the host has loaded. */
const NO_HOST = { id: "", name: "", status: "offline" } as const;

export interface HostCockpitScreenProps {
  hostId: string;
  tab: CockpitTab;
}

/**
 * A host's page: Overview, Files, Sessions and Access, under a header that says
 * whether this device can reach it, opens a window on it, switches to another
 * host on the same tab, and carries its rename, update and removal.
 *
 * The tab lives in the address (`?tab=`) and changes in place, so back leaves
 * the page rather than walking back through its tabs; the page swipes between
 * them the way the strip does. A changed identity sits above every tab, and
 * while it does nothing here opens a connection to the host.
 *
 * One channel to the host, held only while the page is on screen in a
 * foregrounded app: its hello says what the host offers, and the Overview asks
 * it for exact figures every three seconds while it is the tab in front.
 */
export function HostCockpitScreen({ hostId, tab }: HostCockpitScreenProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const focused = useIsFocused();
  const appActive = useAppActive();
  const { width: pageWidth } = useWindowDimensions();
  const swipe = useTabSwipe();

  const hostQuery = useHostQuery(hostId);
  const host = hostQuery.data;
  const sessionsQuery = useHostSessionsQuery(hostId);
  const agentsQuery = useAgentsQuery();
  const workspacesQuery = useWorkspacesQuery();
  const archivedQuery = useWorkspacesQuery(true);
  const hostPinsQuery = useHostPinsQuery(hostId);
  const browserDevicesQuery = useHostBrowserDevicesQuery(hostId);
  const identityConflict = useHostIdentityConflictQuery(host).data === true;
  const live = useHostLiveStatus(host ?? NO_HOST);
  const offers = useHostOffers(hostId);
  const rename = useRenameHostMutation();
  const remove = useRemoveHostMutation();

  const [actionsVisible, setActionsVisible] = useState(false);
  const [switcherVisible, setSwitcherVisible] = useState(false);
  const [folderActions, setFolderActions] = useState<string | null>(null);
  const [openHere, setOpenHere] = useState<OpenHereRequest | null>(null);
  const [renameVisible, setRenameVisible] = useState(false);
  const [removeVisible, setRemoveVisible] = useState(false);
  const [updateVisible, setUpdateVisible] = useState(false);
  const hostsQuery = useHostsQuery({ enabled: switcherVisible });

  const sessions = sessionsQuery.data ?? [];
  const agents = agentsQuery.data ?? [];
  const online = host?.status === "online";
  // Why "New window here…" is shut, said as the browser says it: only an
  // offline host or a changed identity shuts it.
  const windowBlocked = host ? windowBlockedReason(host, identityConflict) : null;

  // The page's one channel to the host, and the figures asked over it. It
  // needs the key this device verifies the host by.
  const channelWanted =
    focused && appActive && online && host?.host_public_key != null && !identityConflict;
  const [transport, setTransport] = useState<HostTransport | null>(null);
  const [channelState, setChannelState] = useState<TransportState>("idle");
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  useEffect(() => {
    if (channelWanted) return;
    setTransport(null);
    setChannelState("idle");
    setMetrics(null);
    setMetricsError(null);
  }, [channelWanted]);

  useEffect(() => {
    const operations = channelState === "ready" ? transport?.capabilities?.operations : undefined;
    if (operations) recordHostCapabilities(hostId, operations);
  }, [channelState, hostId, transport]);

  useLiveHostMetrics({
    enabled: channelWanted && tab === "overview",
    transport,
    state: channelState,
    onMetrics: (next) => {
      setMetrics(next);
      setMetricsError(null);
    },
    onUnavailable: setMetricsError,
  });
  const metricsUnavailable = channelState === "ready" && metrics === null && metricsError !== null;

  // Offered once per host per launch, as the browser's host page does; after
  // that the update chip under Machine, and the menu, open it.
  useEffect(() => {
    if (host && claimHostDetailUpdatePrompt(host)) setUpdateVisible(true);
  }, [host]);

  const owners = useMemo(
    () => workspaceBySession([...(workspacesQuery.data ?? []), ...(archivedQuery.data ?? [])]),
    [archivedQuery.data, workspacesQuery.data],
  );

  const setTab = useCallback(
    (next: CockpitTab) => {
      if (next !== tab) router.setParams({ tab: next });
    },
    [router, tab],
  );
  const stepTab = useCallback(
    (delta: -1 | 1) => {
      const next = stepCockpitTab(tab, delta);
      if (next) setTab(next);
    },
    [setTab, tab],
  );

  // The page swipes between tabs the way a paged view does: the strip's
  // indicator follows the finger, and letting go past a quarter of the width,
  // or with a flick, changes the tab. The card's own back gesture is kept to
  // its edge on this screen (`(drawer)/_layout.tsx`), so the two never meet.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-SWIPE_ACTIVATION, SWIPE_ACTIVATION])
        .failOffsetY([-SWIPE_AXIS_SLOP, SWIPE_AXIS_SLOP])
        .onUpdate((event) => {
          "worklet";
          swipe.drift.value = Math.max(-1, Math.min(1, -event.translationX / pageWidth));
        })
        .onEnd((event) => {
          "worklet";
          const projected = event.translationX + event.velocityX * SWIPE_PROJECTION_SECONDS;
          const velocity = -event.velocityX / pageWidth;
          const threshold = pageWidth * SWIPE_COMMIT_RATIO;
          const delta = projected < -threshold ? 1 : projected > threshold ? -1 : 0;
          const index = COCKPIT_TABS.indexOf(tab);
          if (delta === 0 || index + delta < 0 || index + delta >= COCKPIT_TABS.length) {
            swipe.drift.value = withSpring(0, { ...SETTLE_SPRING, velocity });
            return;
          }
          swipe.velocity.value = velocity;
          runOnJS(stepTab)(delta);
        }),
    [pageWidth, stepTab, swipe, tab],
  );

  // Only a pull shows the spinner: the page's own polling (sessions every five
  // seconds) refetches underneath it without one.
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void Promise.all([
      hostQuery.refetch(),
      sessionsQuery.refetch(),
      ...(tab === "sessions" ? [workspacesQuery.refetch(), archivedQuery.refetch()] : []),
      ...(tab === "access" ? [hostPinsQuery.refetch(), browserDevicesQuery.refetch()] : []),
    ]).finally(() => setRefreshing(false));
  };

  /** A window opens in its terminal, over the workspace it belongs to. */
  const openSession = (session: SessionOut) => {
    haptics.selection();
    const owner = owners.get(session.id);
    if (owner && owner.archived_at === null) {
      router.push({ pathname: "/workspace/[id]", params: { id: owner.id } });
    }
    router.push(`/terminal/${session.id}` as Href);
  };

  const openFiles = (path?: string) => {
    if (!host || filesBlocked(host, identityConflict)) return;
    router.push({
      pathname: "/host/[id]/files",
      params: path === undefined || path === HOST_HOME ? { id: host.id } : { id: host.id, path },
    });
  };

  const header = (
    <AppHeader
      actions={[
        {
          accessibilityLabel: "New window here…",
          disabled: host === undefined || windowBlocked !== null,
          icon: "Plus",
          onPress: () => setOpenHere({ cwd: null }),
          testID: "host-new-window",
          ...(windowBlocked === null ? {} : { accessibilityHint: windowBlocked }),
        },
        {
          accessibilityLabel: "Switch host",
          icon: "ArrowRightLeft",
          onPress: () => setSwitcherVisible(true),
          testID: "host-switcher",
        },
        {
          accessibilityLabel: "Host actions",
          disabled: host === undefined,
          icon: "Ellipsis",
          onPress: () => setActionsVisible(true),
        },
      ]}
      onBack={router.back}
      {...(host === undefined ? {} : { subtitle: cockpitStatusLine(host, live.status) })}
      title={host?.name ?? "Host"}
    />
  );

  if (hostQuery.isPending || hostQuery.isError || !host) {
    return (
      <Screen header={header} padded={false}>
        <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
          {hostQuery.isPending ? (
            <View style={styles.centered}>
              <Spinner label="Loading host" />
            </View>
          ) : (
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
          )}
        </View>
      </Screen>
    );
  }

  const otherHosts = sortHosts(hostsQuery.data ?? []).filter((other) => other.id !== host.id);
  const hostActions: ActionSheetAction[] = [
    {
      id: "rename",
      label: "Rename",
      icon: <Icon color="mutedForeground" name="Pencil" />,
      onPress: () => setRenameVisible(true),
    },
    // Always listed, so the menu keeps one shape; it does something when an
    // update is available, under way, failed or unsupported.
    {
      id: "update",
      label: "Update SPAWN D…",
      disabled: !hostNeedsUpdatePrompt(host),
      icon: <Icon color="mutedForeground" name="Download" />,
      onPress: () => setUpdateVisible(true),
    },
    {
      id: "remove",
      label: "Remove host",
      destructive: true,
      icon: <Icon color="destructive" name="Trash2" />,
      onPress: () => setRemoveVisible(true),
    },
  ];

  return (
    <Screen header={header} padded={false}>
      <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
        {identityConflict ? (
          <View style={styles.banner}>
            <HostIdentityConflict
              onRemove={() => setRemoveVisible(true)}
              removing={remove.isPending}
            />
          </View>
        ) : null}
        {live.status.reconnecting ? (
          <View style={styles.reconnect} testID="host-reconnect">
            <Text color="warning" numberOfLines={2} style={styles.reconnectLabel} variant="caption">
              {live.status.label}
            </Text>
            {live.retry ? (
              <Button
                accessibilityLabel={`Retry connection to ${host.name}`}
                onPress={() => {
                  haptics.selection();
                  live.retry?.();
                }}
                size="sm"
                variant="secondary"
              >
                Retry
              </Button>
            ) : null}
          </View>
        ) : null}
        <UnderlineTabs
          accessibilityLabel={`${host.name} sections`}
          onChange={setTab}
          options={TAB_OPTIONS}
          swipe={swipe}
          testID="host-tabs"
          value={tab}
        />
        <GestureDetector gesture={pan}>
          {/* The detector needs a native view of its own to attach to. */}
          <View collapsable={false} style={styles.body}>
            {tab === "overview" ? (
              <OverviewTab
                agents={agents}
                host={host}
                identityConflict={identityConflict}
                metrics={metrics}
                metricsUnavailable={metricsUnavailable}
                offers={offers}
                onFolderActions={setFolderActions}
                onOpenAllSessions={() => setTab("sessions")}
                onOpenFolder={openFiles}
                onOpenSession={openSession}
                onOpenUpdate={() => setUpdateVisible(true)}
                onRefresh={refresh}
                refreshing={refreshing}
                sessions={sessions}
              />
            ) : tab === "files" ? (
              <FilesTab
                host={host}
                identityConflict={identityConflict}
                onOpenFiles={openFiles}
                onRefresh={refresh}
                refreshing={refreshing}
              />
            ) : tab === "sessions" ? (
              <SessionsTab
                agents={agents}
                hostName={host.name}
                onOpenSession={openSession}
                onRefresh={refresh}
                refreshing={refreshing}
                sessions={sessions}
                workspaces={[...(workspacesQuery.data ?? []), ...(archivedQuery.data ?? [])]}
              />
            ) : (
              <AccessTab
                browserDevices={browserDevicesQuery.data ?? []}
                host={host}
                hostPins={{
                  data: hostPinsQuery.data,
                  error: hostPinsQuery.error,
                  isPending: hostPinsQuery.isPending,
                  retry: () => void hostPinsQuery.refetch(),
                }}
                onManageDevices={() => router.push("/settings/devices")}
                onRefresh={refresh}
                refreshing={refreshing}
              />
            )}
          </View>
        </GestureDetector>

        {channelWanted && host.host_public_key ? (
          <HostTransportSurface
            hostId={host.id}
            hostIdentityPublicKey={host.host_public_key}
            key={host.id}
            onError={(error) => setMetricsError(error.message)}
            onStateChange={setChannelState}
            onTransport={setTransport}
          />
        ) : null}

        <ActionSheet
          actions={hostActions}
          onDismiss={() => setActionsVisible(false)}
          title={host.name}
          visible={actionsVisible}
        />
        <HostSwitcherSheet
          currentTab={tab}
          hosts={otherHosts}
          loading={hostsQuery.isPending}
          onDismiss={() => setSwitcherVisible(false)}
          onSwitch={(other) =>
            router.replace({ pathname: "/host/[id]", params: { id: other.id, tab } })
          }
          visible={switcherVisible}
        />
        <ActionSheet
          actions={
            folderActions === null
              ? []
              : [
                  ...(filesBlocked(host, identityConflict) === null
                    ? [
                        {
                          id: "files",
                          label: "Open in Files",
                          icon: <Icon color="mutedForeground" name="FolderOpen" />,
                          onPress: () => openFiles(folderActions),
                        },
                      ]
                    : []),
                  {
                    id: "shell",
                    label: "Open a shell here",
                    icon: <Icon color="mutedForeground" name="SquareTerminal" />,
                    onPress: () => setOpenHere({ cwd: folderActions, run: "shell" }),
                  },
                  {
                    id: "agent",
                    label: "Start an agent here…",
                    icon: <Icon color="mutedForeground" name="Bot" />,
                    onPress: () => setOpenHere({ cwd: folderActions, run: "agent" }),
                  },
                ]
          }
          onDismiss={() => setFolderActions(null)}
          visible={folderActions !== null}
          {...(folderActions === null ? {} : { title: displayPath(folderActions) })}
        />
        <OpenHereSheet
          host={host}
          onDismiss={() => setOpenHere(null)}
          onOpened={({ workspaceId, sessionId, warning }) => {
            if (warning) toast.error("Agent not queued", { detail: warning });
            router.push({ pathname: "/workspace/[id]", params: { id: workspaceId } });
            router.push(`/terminal/${sessionId}` as Href);
          }}
          request={openHere}
          sessions={sessions}
        />
        <RenameHostDialog
          currentName={host.name}
          error={rename.error ? errorMessage(rename.error) : null}
          loading={rename.isPending}
          onCancel={() => {
            setRenameVisible(false);
            rename.reset();
          }}
          onRename={(name) => {
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
          visible={renameVisible}
        />
        <Confirm
          confirmLabel={remove.error ? "Retry deletion" : "Remove host"}
          description={REMOVE_HOST_DESCRIPTION}
          destructive
          onCancel={() => setRemoveVisible(false)}
          onConfirm={() => {
            if (remove.isPending) return;
            remove.mutate(host, {
              onError: (error) => toast.error("Could not remove host", { detail: error.message }),
              onSuccess: () => {
                toast.success("Host removed");
                router.replace("/hosts");
              },
            });
          }}
          title={`Remove ${host.name}?`}
          visible={removeVisible}
        />
        {updateVisible ? (
          <HostUpdateDialog host={host} onDismiss={() => setUpdateVisible(false)} visible />
        ) : null}
      </View>
    </Screen>
  );
}

/**
 * Another host's page, on the tab this one is showing: browsing one machine's
 * sessions and then the next is two taps, not a trip back through the list.
 */
function HostSwitcherSheet({
  currentTab,
  hosts,
  loading,
  onDismiss,
  onSwitch,
  visible,
}: {
  currentTab: CockpitTab;
  hosts: readonly HostOut[];
  loading: boolean;
  onDismiss(): void;
  onSwitch(host: HostOut): void;
  visible: boolean;
}): React.JSX.Element {
  return (
    <ActionSheet
      actions={hosts.map((other) => ({
        id: other.id,
        label: other.name,
        detail: other.status === "online" ? "Online" : "Offline",
        icon: <StatusDot tone={other.status === "online" ? "active" : "offline"} />,
        onPress: () => onSwitch(other),
      }))}
      message={
        loading
          ? "Counting your hosts…"
          : hosts.length === 0
            ? "This is your only host."
            : `Opens on ${COCKPIT_TAB_LABELS[currentTab]}.`
      }
      onDismiss={onDismiss}
      title="Switch host"
      visible={visible}
    />
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: spacing[4],
    paddingTop: spacing[4],
  },
  body: {
    flex: 1,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  errorActions: {
    flexDirection: "row",
    gap: spacing[2],
  },
  reconnect: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.listRow.contentGap,
    paddingHorizontal: sizing.screen.gutter,
    paddingTop: spacing[3],
  },
  reconnectLabel: {
    flex: 1,
    minWidth: 0,
  },
  screen: {
    flex: 1,
  },
});
