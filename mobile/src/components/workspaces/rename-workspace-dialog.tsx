import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { WorkspaceOut } from "@/data/api/schemas/workspaces";
import { spacing } from "@/theme";

export interface RenameWorkspaceDialogProps {
  workspace: WorkspaceOut | null;
  busy: boolean;
  onDismiss: () => void;
  onRename: (name: string) => void;
}

export function RenameWorkspaceDialog({
  workspace,
  busy,
  onDismiss,
  onRename,
}: RenameWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    setName(workspace.name);
    setError(null);
  }, [workspace]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a workspace name.");
      return;
    }
    if (trimmed === workspace?.name) {
      onDismiss();
      return;
    }
    onRename(trimmed);
  };

  const footer = (
    <>
      <Button disabled={busy} onPress={onDismiss} size="sm" variant="outline">
        Cancel
      </Button>
      <Button loading={busy} onPress={submit} size="sm">
        Rename
      </Button>
    </>
  );

  return (
    <Dialog
      footer={footer}
      onDismiss={onDismiss}
      showCloseButton={false}
      size="sm"
      title="Rename workspace"
      visible={workspace !== null}
    >
      <View style={styles.content} testID="rename-workspace-dialog">
        <Field error={error} label="Name" required>
          <Input
            autoFocus
            editable={!busy}
            onChangeText={setName}
            onSubmitEditing={submit}
            purpose="name"
            returnKeyType="done"
            selectTextOnFocus
            value={name}
          />
        </Field>
      </View>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[2],
  },
});
