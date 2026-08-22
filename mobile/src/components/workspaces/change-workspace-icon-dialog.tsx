import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { WorkspaceIconChoice } from "@/components/workspaces/workspace-icon";
import { WorkspaceIconPicker } from "@/components/workspaces/workspace-icon-picker";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { spacing } from "@/theme";

export interface ChangeWorkspaceIconDialogProps {
  workspace: WorkspaceOut | null;
  busy: boolean;
  onDismiss: () => void;
  onSave: (choice: WorkspaceIconChoice) => void;
}

export function ChangeWorkspaceIconDialog({
  workspace,
  busy,
  onDismiss,
  onSave,
}: ChangeWorkspaceIconDialogProps) {
  const [choice, setChoice] = useState<WorkspaceIconChoice | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!workspace) return;
    setChoice({ icon: workspace.icon, iconSource: "custom" });
    setDirty(false);
  }, [workspace]);

  const footer = (
    <>
      <Button disabled={busy} onPress={onDismiss} size="sm" variant="outline">
        Cancel
      </Button>
      <Button
        disabled={!dirty || !choice}
        loading={busy}
        onPress={() => choice && onSave(choice)}
        size="sm"
      >
        Save icon
      </Button>
    </>
  );

  return (
    <Dialog
      footer={footer}
      onDismiss={onDismiss}
      showCloseButton={false}
      size="sm"
      title="Change workspace icon"
      visible={workspace !== null}
    >
      <View style={styles.content} testID="change-workspace-icon-dialog">
        <WorkspaceIconPicker
          name={workspace?.name ?? "Workspace"}
          onChange={(next) => {
            setChoice(next);
            setDirty(true);
          }}
          value={choice}
        />
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing[4],
  },
});
