import { useIsFocused } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { errorMessage } from "@/components/hosts/host-model";
import { LegionHostCard } from "@/components/hosts/legion-host-card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { useAgentsQuery, useAllSessionsQuery, useHostsQuery } from "@/data/queries/hosts";
import { fleetRollup, sessionsForHost, sortHosts } from "@/data/selectors/host";
import { borderWidth, spacing, useTheme } from "@/theme";

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

  return (
    <SafeAreaView
      edges={["top"]}
      style={[styles.screen, { backgroundColor: theme.colors.background }]}
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <IconButton accessibilityLabel="Back to hosts" icon="ChevronLeft" onPress={router.back} />
        <View style={styles.headerCopy}>
          <Text accessibilityRole="header" variant="title">
            The legion
          </Text>
          <Text color="mutedForeground" variant="caption">
            {hostsQuery.isPending
              ? "Counting your machines…"
              : `${rollup.onlineHosts} online · ${rollup.hosts} total`}
          </Text>
        </View>
        <Text variant="caption">{live ? "Live" : "Go live"}</Text>
        <Switch accessibilityLabel="Live capacity" onValueChange={setLive} value={live} />
      </View>
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
            <Button onPress={() => router.push("/(onboarding)/host")}>Possess a machine</Button>
          }
          description="Connect a host to see fleet capacity and sessions here."
          icon="Network"
          title="No hosts possessed yet."
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl
              onRefresh={refresh}
              refreshing={hostsQuery.isRefetching || sessionsQuery.isRefetching}
              tintColor={theme.colors.mutedForeground}
            />
          }
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
                Live figures come straight from each daemon over its direct channel. They never pass
                through the spawnd server, which only ever sees a five-level reading on the
                thirty-second heartbeat.
              </Text>
            </View>
          ) : null}
          <View style={styles.hosts}>
            {hosts.map((host) => (
              <LegionHostCard
                agents={agentsQuery.data ?? []}
                host={host}
                key={host.id}
                liveEnabled={live && focused}
                onOpen={() => router.push({ pathname: "/host/[id]", params: { id: host.id } })}
                sessions={sessionsForHost(sessionsQuery.data ?? [], host.id)}
              />
            ))}
          </View>
          <Button onPress={() => router.push("/(onboarding)/host")} variant="outline">
            Possess another machine
          </Button>
        </ScrollView>
      )}
    </SafeAreaView>
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
  header: {
    alignItems: "center",
    borderBottomWidth: borderWidth.hairline,
    flexDirection: "row",
    minHeight: spacing[14],
    paddingHorizontal: spacing[2],
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
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
