import { StyleSheet, View } from "react-native";
import { HostAgentRow } from "@/components/hosts/host-agent-row";
import { errorMessage } from "@/components/hosts/host-model";
import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-group";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import { useHostAgentsQuery } from "@/data/queries/hosts";
import { haptics } from "@/lib/haptics";
import { spacing, useTheme } from "@/theme";

/**
 * Which agents the host has, checked when asked. Checking means the host runs
 * each agent's version probe, so it is never started by opening the page,
 * repeated on a timer, or rerun because another host came or went: only a
 * press of "Check agents" or "Check again" asks. An answer already in hand
 * (from earlier, or from another screen) is shown straight away.
 */
export function HostAgentsSection({ host }: { host: HostOut }): React.JSX.Element {
  const theme = useTheme();
  const online = host.status === "online";
  const agentsQuery = useHostAgentsQuery(host.id);
  const answer = agentsQuery.data;
  const checking = agentsQuery.isFetching;

  const check = () => {
    if (checking) return;
    haptics.selection();
    void agentsQuery.refetch();
  };

  return (
    <View style={styles.section} testID="host-agents">
      <SectionHeader
        style={styles.sectionHeader}
        title="Agent availability"
        trailing={
          online && answer ? (
            <Button disabled={checking} onPress={check} size="sm" variant="ghost">
              {checking ? "Checking…" : "Check again"}
            </Button>
          ) : undefined
        }
      />
      <Text color="mutedForeground" variant="body">
        Agent installation and auto update are unavailable here. Install or update agents in a
        trusted terminal on this host.
      </Text>
      {!online ? (
        <View
          style={[
            styles.callout,
            { backgroundColor: theme.colors.muted, borderRadius: theme.radii.lg },
          ]}
        >
          <Text color="mutedForeground" variant="body">
            Agent availability is unavailable while the daemon is offline.
          </Text>
        </View>
      ) : agentsQuery.isError && !checking ? (
        <View style={styles.errorBlock}>
          <Text accessibilityRole="alert" color="destructive" variant="body">
            {errorMessage(agentsQuery.error)}
          </Text>
          <Button onPress={check} size="sm" variant="outline">
            Retry
          </Button>
        </View>
      ) : answer ? (
        answer.agents.length === 0 ? (
          <Text color="mutedForeground" variant="body">
            No agents are defined.
          </Text>
        ) : (
          <ListGroup testID="host-agent-rows">
            {answer.agents.map((agent) => (
              <HostAgentRow agent={agent} key={agent.agent_id} />
            ))}
          </ListGroup>
        )
      ) : (
        <View style={styles.prompt}>
          <Text color="mutedForeground" variant="body">
            {`Check to see which agents are installed on ${host.name}.`}
          </Text>
          <Button
            disabled={checking}
            onPress={check}
            size="sm"
            testID="host-agents-check"
            variant="outline"
          >
            {checking ? "Checking…" : "Check agents"}
          </Button>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  callout: {
    padding: spacing[4],
  },
  errorBlock: {
    alignItems: "flex-start",
    gap: spacing[2],
  },
  prompt: {
    alignItems: "flex-start",
    gap: spacing[2],
  },
  section: {
    gap: spacing[3],
  },
  sectionHeader: {
    paddingHorizontal: spacing[0],
  },
});
