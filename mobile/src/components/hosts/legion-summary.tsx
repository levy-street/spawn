import { StyleSheet, View } from "react-native";

import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { fleetRollup } from "@/data/selectors/host";
import { spacing, useTheme } from "@/theme";

export interface LegionSummaryProps {
  hosts: readonly HostOut[];
  sessions: readonly SessionOut[];
  agents: readonly AgentOut[];
}

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

/**
 * What the legion adds up to, read straight off the machines it already lists.
 *
 * This was a page of its own behind a "Fleet overview" row, which put a tap and a
 * whole screen between the operator and five numbers about the list underneath.
 */
export function LegionSummary({ agents, hosts, sessions }: LegionSummaryProps): React.JSX.Element {
  const rollup = fleetRollup(hosts, sessions, agents);
  const cores = hosts.reduce((total, host) => total + (host.cpu_cores ?? 0), 0);
  const memory = hosts.reduce((total, host) => total + (host.memory_bytes ?? 0), 0);

  return (
    <View style={styles.stats} testID="legion-summary">
      <Stat label="hosts" value={`${rollup.onlineHosts}/${rollup.hosts}`} />
      {cores > 0 ? <Stat label="cores" value={cores} /> : null}
      {memory > 0 ? <Stat label="memory" value={`${Math.round(memory / 1024 ** 3)} GiB`} /> : null}
      <Stat label="live sessions" value={rollup.liveSessions} />
      <Stat label="need you" value={rollup.attention} />
    </View>
  );
}

const styles = StyleSheet.create({
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
