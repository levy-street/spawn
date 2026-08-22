import { ScrollView, StyleSheet, View } from "react-native";
import { sortAgents } from "@/components/launcher/agent-command";
import { ChoiceRow } from "@/components/launcher/choice-row";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import { spacing } from "@/theme";

export type RunChoice = { kind: "shell" } | { kind: "agent"; agent: AgentOut };

export interface RunStepProps {
  agents: readonly AgentOut[];
  selected: RunChoice | null;
  onSelect(choice: RunChoice): void;
}

export function RunStep({ agents, selected, onSelect }: RunStepProps): React.JSX.Element {
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.intro}>
        <Text variant="title">What should run?</Text>
        <Text color="mutedForeground">
          Start a plain login shell, or launch an agent visibly inside that shell.
        </Text>
      </View>
      <ChoiceRow
        accessibilityLabel="Start a login shell"
        detail="A plain interactive login shell."
        icon="SquareTerminal"
        onPress={() => onSelect({ kind: "shell" })}
        selected={selected?.kind === "shell"}
        title="Shell"
      />
      {sortAgents(agents).map((agent) => (
        <ChoiceRow
          accessibilityLabel={`Launch agent ${agent.name}`}
          detail={agent.command}
          icon="Bot"
          key={agent.id}
          onPress={() => onSelect({ kind: "agent", agent })}
          selected={selected?.kind === "agent" && selected.agent.id === agent.id}
          title={agent.name}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing[3], padding: spacing[4], paddingBottom: spacing[8] },
  intro: { gap: spacing[2], paddingBottom: spacing[2] },
});
