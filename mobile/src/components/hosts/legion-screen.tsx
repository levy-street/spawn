import { useIsFocused } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { errorMessage } from "@/components/hosts/host-model";
import { LegionHostCard } from "@/components/hosts/legion-host-card";
import { AppHeader } from "@/components/layout/app-header";
import { Screen } from "@/components/layout/screen";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useAgentsQuery, useAllSessionsQuery, useHostsQuery } from "@/data/queries/hosts";
import { fleetRollup, sessionsForHost, sortHosts } from "@/data/selectors/host";
import { spacing, useTheme } from "@/theme";

function Stat({ label, value }: { label: string; value: string | number }) {
  const theme = useTheme();
  return (
    <View
      style={[styles.stat, { backgroundColor: theme.colors.muted, borderRadius: theme.radii.md }]}
    >
      <Text variant="title">{value}</Text>
      <Text color="mutedForeground" variant="caption">
        {label}
      </Text>
    </View>
  );
}

export function LegionScreen() {
  const theme = useTheme();
  const router = useRouter();
  const focused = useIsFocused();
  const hostsQuery = useHostsQuery();
  const sessionsQuery = useAllSessionsQuery();
  const agentsQuery = useAgentsQuery();
  const [live, setLive] = useState(false);
  const viewport = useRef({ height: 0, scrollY: 0, hostListY: 0 });
  const hostFrames = useRef(new Map<string, { y: number; height: number }>());
  const [visibleHostIds, setVisibleHostIds] = useState<ReadonlySet<string>>(() => new Set());
  const hosts = useMemo(() => sortHosts(hostsQuery.data ?? []), [hostsQuery.data]);
  const rollup = useMemo(
    () => fleetRollup(hosts, sessionsQuery.data ?? [], agentsQuery.data ?? []),
    [agentsQuery.data, hosts, sessionsQuery.data],
  );
  const cores = hosts.reduce((total, host) => total + (host.cpu_cores ?? 0), 0);
  const memory = hosts.reduce((total, host) => total + (host.memory_bytes ?? 0), 0);
  const refresh = () => {
    void Promise.all([hostsQuery.refetch(), sessionsQuery.refetch(), agentsQuery.refetch()]);
  };
  const recalculateVisibleHosts = useCallback(() => {
    const { height, hostListY, scrollY } = viewport.current;
    if (height <= 0) return;
    const next = new Set<string>();
    for (const [hostId, frame] of hostFrames.current) {
      const top = hostListY + frame.y;
      if (top + frame.height > scrollY && top < scrollY + height) next.add(hostId);
    }
    setVisibleHostIds((current) => {
      if (current.size === next.size && [...current].every((hostId) => next.has(hostId))) {
        return current;
      }
      return next;
    });
  }, []);
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      viewport.current.scrollY = event.nativeEvent.contentOffset.y;
      recalculateVisibleHosts();
    },
    [recalculateVisibleHosts],
  );
  const handleViewportLayout = useCallback(
    (event: LayoutChangeEvent) => {
      viewport.current.height = event.nativeEvent.layout.height;
      recalculateVisibleHosts();
    },
    [recalculateVisibleHosts],
  );

  return (
    <Screen
      header={
        <AppHeader
          accessory={
            <Switch accessibilityLabel="Live capacity" onValueChange={setLive} value={live} />
          }
          onBack={router.back}
          subtitle={
            hostsQuery.isPending
              ? "Counting your machines…"
              : `${rollup.onlineHosts} online · ${rollup.hosts} total`
          }
          title="The legion"
        />
      }
      padded={false}
    >
      <View style={[styles.screen, { backgroundColor: theme.colors.background }]}>
        {hostsQuery.isPending || sessionsQuery.isPending ? (
          <View style={styles.centered}>
            <Spinner label="Counting your machines" />
          </View>
        ) : hostsQuery.isError || sessionsQuery.isError ? (
          <EmptyState
            action={<Button onPress={refresh}>Retry</Button>}
            description={errorMessage(hostsQuery.error ?? sessionsQuery.error)}
            icon="AlertCircle"
            title="Fleet unavailable"
          />
        ) : hosts.length === 0 ? (
          <EmptyState
            action={
              <Button onPress={() => router.push("/onboarding/host")}>Possess a machine</Button>
            }
            description="Connect a host to see fleet capacity and sessions here."
            icon="Network"
            title="No hosts possessed yet."
          />
        ) : (
          <ScrollView
            contentContainerStyle={styles.content}
            onLayout={handleViewportLayout}
            onScroll={handleScroll}
            refreshControl={
              <RefreshControl
                onRefresh={refresh}
                refreshing={hostsQuery.isRefetching || sessionsQuery.isRefetching}
                tintColor={theme.colors.mutedForeground}
              />
            }
            scrollEventThrottle={100}
          >
            <View style={styles.stats}>
              <Stat label="hosts" value={`${rollup.onlineHosts}/${rollup.hosts}`} />
              {cores > 0 ? <Stat label="cores" value={cores} /> : null}
              {memory > 0 ? (
                <Stat label="memory" value={`${Math.round(memory / 1024 ** 3)} GiB`} />
              ) : null}
              <Stat label="live sessions" value={rollup.liveSessions} />
              <Stat label="need you" value={rollup.attention} />
            </View>
            {live ? (
              <View
                style={[
                  styles.privacy,
                  { backgroundColor: theme.colors.muted, borderRadius: theme.radii.lg },
                ]}
              >
                <Text color="mutedForeground" variant="caption">
                  Live figures come straight from each daemon over its direct channel. They never
                  pass through the spawnd server, which only ever sees a five-level reading on the
                  thirty-second heartbeat.
                </Text>
              </View>
            ) : null}
            <View
              onLayout={(event) => {
                viewport.current.hostListY = event.nativeEvent.layout.y;
                recalculateVisibleHosts();
              }}
              style={styles.hosts}
            >
              {hosts.map((host) => (
                <View
                  key={host.id}
                  onLayout={(event) => {
                    const { height, y } = event.nativeEvent.layout;
                    hostFrames.current.set(host.id, { y, height });
                    recalculateVisibleHosts();
                  }}
                >
                  <LegionHostCard
                    agents={agentsQuery.data ?? []}
                    host={host}
                    liveEnabled={live && focused}
                    onOpen={() => router.push({ pathname: "/host/[id]", params: { id: host.id } })}
                    probeEnabled={visibleHostIds.has(host.id)}
                    sessions={sessionsForHost(sessionsQuery.data ?? [], host.id)}
                  />
                </View>
              ))}
            </View>
            <Button onPress={() => router.push("/onboarding/host")} variant="outline">
              Possess another machine
            </Button>
          </ScrollView>
        )}
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
  content: {
    gap: spacing[5],
    padding: spacing[4],
    paddingBottom: spacing[8],
  },
  hosts: {
    gap: spacing[3],
  },
  privacy: {
    padding: spacing[4],
  },
  screen: {
    flex: 1,
  },
  stat: {
    flexGrow: 1,
    gap: spacing[1],
    minWidth: spacing[20],
    padding: spacing[3],
  },
  stats: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
});
