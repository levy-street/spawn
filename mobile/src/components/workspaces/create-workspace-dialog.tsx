import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Screen } from "@/components/layout/screen";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  type WorkspaceFolder,
  WorkspaceFolderSheet,
} from "@/components/workspaces/workspace-folder-sheet";
import type { WorkspaceIconChoice } from "@/components/workspaces/workspace-icon";
import { WorkspaceIconPicker } from "@/components/workspaces/workspace-icon-picker";
import type { WorkspaceTemplateOut } from "@/data/api/schemas/templates";
import { spacing } from "@/theme";
import { sizing } from "@/theme/sizing";

const BLANK_TEMPLATE = "__blank__";

export interface CreateWorkspaceDraft {
  name: string;
  templateId: string | null;
  iconChoice: WorkspaceIconChoice | null;
  /** Where it opens. Null keeps the workspace unplaced, as it was before. */
  folder: WorkspaceFolder | null;
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
  const [folder, setFolder] = useState<WorkspaceFolder | null>(null);
  const [folderVisible, setFolderVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setName("");
    setTemplateId(BLANK_TEMPLATE);
    setIconChoice(null);
    setFolder(null);
    setFolderVisible(false);
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
      // A template carries its own saved home; the folder chosen here is for
      // the blank workspace that has none.
      folder: templateId === BLANK_TEMPLATE ? folder : null,
    });
  };

  const footer = [
    <Button
      disabled={busy}
      key="cancel"
      onPress={onDismiss}
      testID="create-workspace-cancel"
      variant="outline"
    >
      Cancel
    </Button>,
    <Button key="create" loading={busy} onPress={submit} testID="create-workspace-submit">
      Create workspace
    </Button>,
  ];

  return (
    <Dialog
      contentStyle={styles.dialogContent}
      onDismiss={onDismiss}
      size="full-mobile"
      title="New workspace"
      visible={visible}
    >
      <Screen footer={footer} scroll>
        <View style={styles.content} testID="create-workspace-dialog">
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
          {templateId === BLANK_TEMPLATE ? (
            <Field
              hint={
                folder
                  ? `Opens on ${folder.hostName}.`
                  : "Optional. Terminals in this workspace start here."
              }
              label="Folder"
            >
              <Button
                disabled={busy}
                onPress={() => setFolderVisible(true)}
                testID="create-workspace-folder"
                variant="outline"
              >
                {folder ? folderLabel(folder.path) : "Choose a folder"}
              </Button>
            </Field>
          ) : null}
          <WorkspaceIconPicker name={name} onChange={setIconChoice} value={iconChoice} />
        </View>
      </Screen>
      <WorkspaceFolderSheet
        initial={folder}
        onDismiss={() => setFolderVisible(false)}
        onPick={(picked) => {
          setFolder(picked);
          setFolderVisible(false);
        }}
        visible={folderVisible}
      />
    </Dialog>
  );
}

/** The tail of a path, which is what tells two folders apart on a phone. */
function folderLabel(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

const styles = StyleSheet.create({
  content: {
    gap: sizing.space.section,
    paddingBottom: sizing.space.section,
    paddingTop: sizing.space.block,
  },
  dialogContent: {
    paddingBottom: spacing[0],
  },
});
