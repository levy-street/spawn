import { StyleSheet, View } from "react-native";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { identifyAgent } from "@/data/selectors/agent";
import { activityTone, sessionTitle } from "@/data/selectors/session";
import { spacing } from "@/theme";

export interface HostSessionListProps {
  agents: readonly AgentOut[];
  sessions: readonly SessionOut[];
  onOpen(session: SessionOut): void;
}

export function HostSessionList({ agents, sessions, onOpen }: HostSessionListProps) {
  return (
    <View style={styles.section}>
      <SectionHeader
        style={styles.sectionHeader}
        title="Sessions"
        trailing={
          <Text color="mutedForeground" variant="caption">
            {sessions.length}
          </Text>
        }
      />
      {sessions.length === 0 ? (
        <EmptyState icon="Terminal" title="No sessions are running on this host." />
      ) : (
        <Card padded={false} style={styles.rows} variant="flat">
          {sessions.map((session, index) => {
            const identity = identifyAgent(session.foreground_command, agents);
            const tone = activityTone(session);
            return (
              <View key={session.id}>
                {index > 0 ? <ListSeparator /> : null}
                <ListRow
                  height="tall"
                  leading={<AgentIcon identity={identity} size={spacing[8]} />}
                  onPress={() => onOpen(session)}
                  shape="fullBleed"
                  subtitle={`${identity.displayName} · ${session.cwd}`}
                  title={sessionTitle(session, agents)}
                  trailing={
                    <View style={styles.status}>
                      <StatusDot
                        accessibilityLabel={session.activity_label}
                        pulse={session.activity_state === "active"}
                        tone={tone}
                      />
                      <Text color="mutedForeground" numberOfLines={1} variant="caption">
                        {session.activity_label}
                      </Text>
                    </View>
                  }
                />
              </View>
            );
          })}
        </Card>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  rows: {
    gap: spacing[0],
    overflow: "hidden",
  },
  section: {
    gap: spacing[3],
  },
  sectionHeader: {
    paddingHorizontal: spacing[0],
  },
  status: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    maxWidth: spacing[32],
  },
});
