import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { ScrollView, StyleSheet, View } from "react-native";
import {
  formatProfileDuration,
  formatProfileMemory,
  profileStatsLine,
} from "@/components/settings/profile-format";
import { SettingsInfoRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Monogram } from "@/components/ui/monogram";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { useProfileSettingsQuery } from "@/data/queries/settings";
import { spacing, useTheme } from "@/theme";

function Metric({ label, value }: { label: string; value: string | number }): React.JSX.Element {
  return (
    <View style={styles.metric}>
      <Text variant="title">{value}</Text>
      <Text color="mutedForeground" variant="caption">
        {label}
      </Text>
    </View>
  );
}

export function ProfileScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  const profile = useProfileSettingsQuery();

  if (profile.isPending) {
    return (
      <SettingsScreen title="Profile">
        <Skeleton style={styles.loading} />
      </SettingsScreen>
    );
  }
  if (!profile.data) {
    return (
      <SettingsScreen title="Profile">
        <EmptyState
          description={profile.error?.message}
          icon="AlertCircle"
          title="Profile unavailable"
        />
      </SettingsScreen>
    );
  }

  const data = profile.data;
  const maxAgentCount = Math.max(1, ...data.agents.map((agent) => agent.count));
  const maxDaySessions = Math.max(1, ...data.days.map((day) => day.sessions_started));

  return (
    <SettingsScreen testID="profile-screen" title="Profile">
      <View style={styles.identity}>
        <Monogram seed={data.email} size={spacing[16]} />
        <View style={styles.identityCopy}>
          <Text numberOfLines={1} variant="title">
            {data.email}
          </Text>
          <Text color="mutedForeground" variant="caption">
            Possessing machines since{" "}
            {new Date(data.created_at).toLocaleDateString(undefined, {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </Text>
          {data.totals.current_streak > 0 ? (
            <Badge variant="warning">🔥 {data.totals.current_streak} day streak</Badge>
          ) : null}
        </View>
      </View>

      <SettingsSection title="THE LEGION">
        <Card variant="flat">
          <View style={styles.metrics}>
            <Metric
              label="hosts online"
              value={`${data.totals.hosts_online}/${data.totals.hosts}`}
            />
            {data.totals.cores > 0 ? <Metric label="cores" value={data.totals.cores} /> : null}
            {data.totals.memory_bytes > 0 ? (
              <Metric label="memory" value={formatProfileMemory(data.totals.memory_bytes)} />
            ) : null}
            <Metric label="live now" value={data.totals.sessions_live} />
            <Metric label="sessions summoned" value={data.totals.sessions_started} />
          </View>
          <Button
            onPress={() => void Clipboard.setStringAsync(profileStatsLine(data))}
            size="sm"
            variant="outline"
          >
            Copy stats
          </Button>
        </Card>
      </SettingsSection>

      <SettingsSection title="MACHINES">
        {data.hosts.length === 0 ? (
          <EmptyState icon="Server" title="No hosts possessed yet." />
        ) : (
          data.hosts.map((host) => {
            const specification = [
              host.cpu_cores ? `${host.cpu_cores} cores` : null,
              host.memory_bytes ? formatProfileMemory(host.memory_bytes) : null,
              host.gpu,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <SettingsInfoRow
                hint={`${specification ? `${specification} · ` : ""}${host.session_count} ${
                  host.session_count === 1 ? "session" : "sessions"
                }`}
                icon="Server"
                key={host.id}
                label={host.name}
                trailing={
                  <StatusDot
                    accessibilityLabel={host.status}
                    tone={host.status === "online" ? "active" : "offline"}
                  />
                }
              />
            );
          })
        )}
      </SettingsSection>

      <SettingsSection title={`LAST ${data.history_days} DAYS`}>
        <Card variant="flat">
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.heatmap}>
              {data.days.map((day) => (
                <View
                  accessibilityLabel={`${day.day}: ${day.sessions_started} sessions started`}
                  accessibilityRole="image"
                  key={day.day}
                  style={[
                    styles.day,
                    {
                      backgroundColor:
                        day.sessions_started === 0
                          ? theme.colors.muted
                          : day.sessions_started === maxDaySessions
                            ? theme.colors.brandAccent
                            : theme.colors.brandAccentSoft,
                    },
                  ]}
                />
              ))}
            </View>
          </ScrollView>
          <View style={styles.metrics}>
            <Metric label="active days" value={data.totals.active_days} />
            <Metric
              label="session time"
              value={formatProfileDuration(data.totals.session_seconds)}
            />
            <Metric label="longest streak" value={data.totals.longest_streak} />
            <Metric label="most hosts at once" value={data.totals.peak_hosts_online} />
            <Metric label="most sessions at once" value={data.totals.peak_sessions} />
          </View>
        </Card>
      </SettingsSection>

      {data.agents.length > 0 ? (
        <SettingsSection
          description="Only the foreground process basename is counted. No paths, repositories, or hostnames are included."
          title="AGENTS SUMMONED"
        >
          {data.agents.map((agent) => (
            <View key={agent.command} style={styles.agent}>
              <View style={styles.agentLabels}>
                <Text variant="mono">{agent.command}</Text>
                <Text color="mutedForeground" variant="caption">
                  {agent.count}
                </Text>
              </View>
              <View style={[styles.agentTrack, { backgroundColor: theme.colors.muted }]}>
                <View
                  style={[
                    styles.agentBar,
                    {
                      backgroundColor: theme.colors.brandAccent,
                      width: `${(agent.count / maxAgentCount) * 100}%`,
                    },
                  ]}
                />
              </View>
            </View>
          ))}
        </SettingsSection>
      ) : null}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  agent: {
    gap: spacing[1],
  },
  agentBar: {
    borderRadius: spacing[1],
    height: "100%",
  },
  agentLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  agentTrack: {
    borderRadius: spacing[1],
    height: spacing[1.5],
    overflow: "hidden",
  },
  day: {
    borderRadius: spacing[0.5],
    height: spacing[3],
    width: spacing[3],
  },
  heatmap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[1],
    height: spacing[3] * 7 + spacing[1] * 6,
    width: spacing[3] * 18 + spacing[1] * 17,
  },
  identity: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[4],
  },
  identityCopy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
  loading: {
    height: spacing[32],
  },
  metric: {
    gap: spacing[0.5],
    minWidth: spacing[20],
  },
  metrics: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[4],
    marginBottom: spacing[3],
  },
});
