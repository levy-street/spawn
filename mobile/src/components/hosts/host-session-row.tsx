import { StyleSheet, View } from "react-native";
import { ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { identifyAgent } from "@/data/selectors/agent";
import { displayPath } from "@/data/selectors/places";
import { activityTone, sessionTitle } from "@/data/selectors/session";
import { spacing } from "@/theme";

export interface HostSessionRowProps {
  agents: readonly AgentOut[];
  session: SessionOut;
  onOpen(session: SessionOut): void;
}

/** One window on a host: what runs in it, where, and what it is doing. */
export function HostSessionRow({ agents, session, onOpen }: HostSessionRowProps) {
  const identity = identifyAgent(session.foreground_command, agents);
  const tone = activityTone(session);
  return (
    <View testID={`host-session-${session.id}`}>
      <ListRow
        height="tall"
        leading={<AgentIcon identity={identity} size={spacing[8]} />}
        onPress={() => onOpen(session)}
        shape="fullBleed"
        subtitle={`${identity.displayName} · ${displayPath(session.cwd)}`}
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
}

const styles = StyleSheet.create({
  status: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    maxWidth: spacing[32],
  },
});
