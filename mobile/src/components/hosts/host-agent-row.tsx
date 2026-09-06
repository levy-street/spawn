import { StyleSheet, View } from "react-native";
import { Badge } from "@/components/ui/badge";
import { ListBlock } from "@/components/ui/list-group";
import { Monogram } from "@/components/ui/monogram";
import { Text } from "@/components/ui/text";
import type { HostAgentStatus } from "@/data/api/schemas/hosts";
import { spacing } from "@/theme";

export interface HostAgentRowProps {
  agent: HostAgentStatus;
}

export function HostAgentRow({ agent }: HostAgentRowProps) {
  return (
    <ListBlock bleed={false} testID={`host-agent-${agent.agent_id}`}>
      <View style={styles.heading}>
        <Monogram seed={agent.agent_name} size={spacing[8]} />
        <View style={styles.headingCopy}>
          <Text variant="label">{agent.agent_name}</Text>
          <Text color="mutedForeground" variant="caption">
            {agent.command}
          </Text>
        </View>
        {!agent.installed ? (
          <Badge variant="outline">not installed</Badge>
        ) : agent.update_available ? (
          <Badge variant="warning">{`update ${agent.latest_version ?? "available"}`}</Badge>
        ) : agent.version ? (
          <Badge variant="success">{agent.version}</Badge>
        ) : null}
      </View>
      {agent.error ? (
        <Text accessibilityRole="alert" color="destructive" variant="caption">
          {agent.error}
        </Text>
      ) : null}
      {agent.last_auto_update_error ? (
        <Text accessibilityRole="alert" color="destructive" variant="caption">
          Last auto-update: {agent.last_auto_update_error}
        </Text>
      ) : null}
      <Text color="mutedForeground" variant="caption">
        {agent.installed
          ? (agent.path ?? agent.command)
          : (agent.install ?? "No install command is available.")}
      </Text>
    </ListBlock>
  );
}

const styles = StyleSheet.create({
  heading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  headingCopy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
});
