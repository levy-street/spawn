import { ScrollView, StyleSheet, View } from "react-native";

import { ChoiceRow } from "@/components/launcher/choice-row";
import { autoPlaceWorkspaceTiles } from "@/components/launcher/launcher-selection";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { spacing } from "@/theme";

export interface DetailsStepProps {
  isLaunching: boolean;
  name: string;
  onLaunch(): void;
  onNameChange(name: string): void;
  onSelectTab(tabId: string): void;
  selectedTabId: string;
  workspace: WorkspaceOut;
}

export function DetailsStep({
  isLaunching,
  name,
  onLaunch,
  onNameChange,
  onSelectTab,
  selectedTabId,
  workspace,
}: DetailsStepProps): React.JSX.Element {
  const selectedTab = workspace.layout.tabs.find((tab) => tab.id === selectedTabId);
  const selectedHasRoom = Boolean(
    selectedTab && autoPlaceWorkspaceTiles(selectedTab.layout.tiles).tile,
  );

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.intro}>
        <Text variant="title">Session details</Text>
        <Text color="mutedForeground">
          Give the session an optional name and choose where its terminal should appear.
        </Text>
      </View>
      <Field label="Session name" hint="Optional">
        <Input
          accessibilityLabel="Session name"
          maxLength={128}
          onChangeText={onNameChange}
          placeholder="Session name"
          purpose="name"
          value={name}
        />
      </Field>
      <Text variant="label">Target tab</Text>
      {workspace.layout.tabs.map((tab) => {
        const hasRoom = autoPlaceWorkspaceTiles(tab.layout.tiles).tile !== null;
        const detail = hasRoom
          ? `${tab.layout.tiles.length} of 16 panes`
          : "Full · choose another tab";
        return (
          <ChoiceRow
            accessibilityLabel={`Use tab ${tab.name}. ${detail}`}
            detail={detail}
            disabled={!hasRoom}
            icon="LayoutTemplate"
            key={tab.id}
            onPress={() => onSelectTab(tab.id)}
            selected={selectedTabId === tab.id}
            title={tab.name}
          />
        );
      })}
      <Button disabled={!selectedHasRoom} loading={isLaunching} onPress={onLaunch}>
        Launch session
      </Button>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing[3], padding: spacing[4], paddingBottom: spacing[8] },
  intro: { gap: spacing[2], paddingBottom: spacing[2] },
});
