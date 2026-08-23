import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { FooterActions } from "@/components/ui/footer-actions";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import type { WorkspaceIconChoice } from "@/components/workspaces/workspace-icon";
import { WorkspaceIconPicker } from "@/components/workspaces/workspace-icon-picker";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { sizing } from "@/theme/sizing";

export interface ChangeWorkspaceIconSheetProps {
  workspace: WorkspaceOut | null;
  busy: boolean;
  onDismiss: () => void;
  onSave: (choice: WorkspaceIconChoice) => void;
}

export function ChangeWorkspaceIconSheet({
  workspace,
  busy,
  onDismiss,
  onSave,
}: ChangeWorkspaceIconSheetProps) {
  const [choice, setChoice] = useState<WorkspaceIconChoice | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    setChoice({ icon: workspace.icon, iconSource: "custom" });
    setDirty(false);
  }, [workspace]);

  // Picking an icon is two taps against a preview, not a form: it comes up from
  // the bottom like the rest of the app's short decisions rather than taking the
  // whole screen for a row and two buttons.
  return (
    <Sheet onDismiss={onDismiss} testID="change-workspace-icon-sheet" visible={workspace !== null}>
      <View style={styles.body}>
        <Text accessibilityRole="header" variant="uiLg" weight="semibold">
          Change workspace icon
        </Text>
        <WorkspaceIconPicker
          name={workspace?.name ?? "Workspace"}
          onChange={(next) => {
            setChoice(next);
            setDirty(true);
          }}
          value={choice}
        />
      </View>
      <FooterActions>
        <Button disabled={busy} onPress={onDismiss} variant="outline">
          Cancel
        </Button>
        <Button
          disabled={!dirty || !choice}
          loading={busy}
          onPress={() => choice && onSave(choice)}
        >
          Save icon
        </Button>
      </FooterActions>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    gap: sizing.space.cluster,
    paddingBottom: sizing.space.block,
    paddingHorizontal: sizing.space.block,
    paddingTop: sizing.space.tight,
  },
});
