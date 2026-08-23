import { StyleSheet, View } from "react-native";
import { Text } from "@/components/ui/text";
import { AgentIcon } from "@/components/workspace-detail/agent-icon";
import type { RunningAgentGroup } from "@/data/selectors/agent";
import { spacing, useTheme } from "@/theme";

/** Distinct agents a row names before the rest become a count. */
const MAX_CHIPS = 3;

export interface RunningAgentsProps {
  groups: readonly RunningAgentGroup[];
  /** How many chips to draw before the tail collapses into "+N". */
  limit?: number;
  testID?: string;
}

/**
 * What is running on a machine, as the marks people recognise — the Claude
 * plate, the Codex plate, a terminal glyph — each with how many of it.
 *
 * "2 Claude Code, 1 shell" is the thing a person wants to know about a host,
 * and a bare session count never said it. Shared by the legion list row and the
 * legion card so a machine looks the same on both.
 */
export function RunningAgents({
  groups,
  limit = MAX_CHIPS,
  testID,
}: RunningAgentsProps): React.JSX.Element | null {
  const theme = useTheme();
  if (groups.length === 0) return null;

  const shown = groups.slice(0, limit);
  const hidden = groups.slice(limit).reduce((total, group) => total + group.count, 0);

  return (
    <View accessibilityLabel="Running agents" style={styles.chips} testID={testID}>
      {shown.map(({ count, identity, key }) => (
        <View
          key={key}
          style={[
            styles.chip,
            { backgroundColor: theme.colors.muted, borderRadius: theme.radii.md },
          ]}
        >
          <AgentIcon identity={identity} size={spacing[5]} />
          <Text color="mutedForeground" variant="caption">
            {identity.displayName}
            {count > 1 ? ` ×${count}` : ""}
          </Text>
        </View>
      ))}
      {hidden > 0 ? (
        <Text color="mutedForeground" variant="caption">
          +{hidden}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[1.5],
    padding: spacing[1],
    paddingRight: spacing[2],
  },
  chips: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
});
