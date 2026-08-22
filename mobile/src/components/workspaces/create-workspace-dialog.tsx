import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { WorkspaceIconChoice } from "@/components/workspaces/workspace-icon";
import { WorkspaceIconPicker } from "@/components/workspaces/workspace-icon-picker";
import type { WorkspaceTemplateOut } from "@/data/api/schemas/templates";
import { spacing } from "@/theme";

const BLANK_TEMPLATE = "__blank__";

export interface CreateWorkspaceDraft {
  name: string;
  templateId: string | null;
  iconChoice: WorkspaceIconChoice | null;
}

export interface CreateWorkspaceDialogProps {
  visible: boolean;
  templates: readonly WorkspaceTemplateOut[];
  busy: boolean;
  onDismiss: () => void;
  onCreate: (draft: CreateWorkspaceDraft) => void;
}

function templateNeedsSavedHome(template: WorkspaceTemplateOut): boolean {
  return template.spec.tabs.some((tab) => (tab.tiles?.length ?? 0) > 0);
}

export function CreateWorkspaceDialog({
  visible,
  templates,
  busy,
  onDismiss,
  onCreate,
}: CreateWorkspaceDialogProps) {
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<string>(BLANK_TEMPLATE);
  const [iconChoice, setIconChoice] = useState<WorkspaceIconChoice | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setName("");
    setTemplateId(BLANK_TEMPLATE);
    setIconChoice(null);
    setError(null);
  }, [visible]);

  const options = useMemo(
    () => [
      { value: BLANK_TEMPLATE, label: "Blank workspace" },
      ...templates.map((template) => {
        const needsHome = templateNeedsSavedHome(template);
        const missingHome = needsHome && (!template.host_id || !template.cwd);
        return {
          value: template.id,
          label: template.name,
          ...(missingHome
            ? { detail: "Choose a folder on desktop first", disabled: true }
            : { detail: "Use saved tabs and windows" }),
        };
      }),
    ],
    [templates],
  );

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a workspace name.");
      return;
    }
    setError(null);
    onCreate({
      name: trimmed,
      templateId: templateId === BLANK_TEMPLATE ? null : templateId,
      iconChoice,
    });
  };

  const footer = (
    <>
      <Button disabled={busy} onPress={onDismiss} size="sm" variant="outline">
        Cancel
      </Button>
      <Button loading={busy} onPress={submit} size="sm">
        Create workspace
      </Button>
    </>
  );

  return (
    <Dialog
      footer={footer}
      onDismiss={onDismiss}
      showCloseButton={false}
      size="full-mobile"
      title="New workspace"
      visible={visible}
    >
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        testID="create-workspace-dialog"
      >
        <Field error={error} label="Name" required>
          <Input
            autoFocus
            editable={!busy}
            onChangeText={setName}
            onSubmitEditing={submit}
            placeholder="Workspace name"
            purpose="name"
            returnKeyType="done"
            value={name}
          />
        </Field>
        <Field label="Template">
          <Select
            disabled={busy}
            onChange={setTemplateId}
            options={options}
            placeholder="Choose a template"
            value={templateId}
          />
        </Field>
        <WorkspaceIconPicker name={name} onChange={setIconChoice} value={iconChoice} />
        <View style={styles.bottomSpacer} />
      </ScrollView>
    </Dialog>
  );
}

const styles = StyleSheet.create({
  bottomSpacer: {
    height: spacing[8],
  },
  content: {
    gap: spacing[5],
    padding: spacing[4],
  },
});
