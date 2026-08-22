import { Pressable, StyleSheet, View } from "react-native";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { identifyAgent } from "@/data/selectors/agent";
import { activityTone, sessionTitle } from "@/data/selectors/session";
import { borderWidth, chrome, spacing, useTheme } from "@/theme";

export interface HostSessionListProps {
  agents: readonly AgentOut[];
  sessions: readonly SessionOut[];
  onOpen(session: SessionOut): void;
}

export function HostSessionList({ agents, sessions, onOpen }: HostSessionListProps) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      <View style={styles.headingRow}>
        <Text accessibilityRole="header" variant="label" weight="semibold">
          Sessions
        </Text>
        <Text color="mutedForeground" variant="caption">
          {sessions.length}
        </Text>
      </View>
      {sessions.length === 0 ? (
        <Text color="mutedForeground" variant="body">
          No sessions are running on this host.
        </Text>
      ) : (
        <View
          style={[styles.rows, { borderColor: theme.colors.border, borderRadius: theme.radii.lg }]}
        >
          {sessions.map((session, index) => {
            const identity = identifyAgent(session.foreground_command, agents);
            const tone = activityTone(session);
            return (
              <Pressable
                accessibilityLabel={`Open ${sessionTitle(session, agents)}`}
                accessibilityRole="button"
                key={session.id}
                onPress={() => onOpen(session)}
                style={({ pressed }) => [
                  styles.row,
                  {
                    backgroundColor: pressed ? theme.colors.accent : "transparent",
                    borderTopColor: theme.colors.border,
                    borderTopWidth: index === 0 ? borderWidth.none : borderWidth.hairline,
                    minHeight: chrome.touchTarget + spacing[4],
                  },
                ]}
              >
                <AgentIcon identity={identity} size={spacing[8]} />
                <View style={styles.copy}>
                  <View style={styles.titleRow}>
                    <Text numberOfLines={1} style={styles.title} variant="label">
                      {sessionTitle(session, agents)}
                    </Text>
                    <StatusDot
                      accessibilityLabel={session.activity_label}
                      pulse={session.activity_state === "active"}
                      tone={tone}
                    />
                  </View>
                  <Text color="mutedForeground" numberOfLines={1} variant="caption">
                    {identity.displayName} · {session.cwd}
                  </Text>
                  <Text color="mutedForeground" variant="caption">
                    {session.activity_label}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
  headingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    padding: spacing[3],
  },
  rows: {
    borderWidth: borderWidth.hairline,
    overflow: "hidden",
  },
  section: {
    gap: spacing[3],
  },
  title: {
    flex: 1,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
});
