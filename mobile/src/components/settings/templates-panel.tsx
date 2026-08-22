import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Monogram } from "@/components/ui/monogram";
import { Text } from "@/components/ui/text";
import type { WorkspaceTemplateOut } from "@/data/api/schemas/templates";
import { useTemplateMutations, useTemplatesSettingsQuery } from "@/data/queries/settings";
import { spacing } from "@/theme";

const MAX_ICON_DATA_URL_LENGTH = 512 * 1024;

export function formatTemplateSummary(template: WorkspaceTemplateOut): string {
  const tabs = template.spec.tabs.length;
  const windows = template.spec.tabs.reduce((total, tab) => total + (tab.tiles?.length ?? 0), 0);
  const agents = template.spec.tabs.reduce(
    (total, tab) => total + (tab.tiles?.filter((tile) => tile.run.kind === "agent").length ?? 0),
    0,
  );
  return `${tabs} ${tabs === 1 ? "tab" : "tabs"} · ${windows} ${
    windows === 1 ? "window" : "windows"
  }${agents > 0 ? ` · ${agents} ${agents === 1 ? "agent" : "agents"}` : ""}`;
}

function TemplateAvatar({ template }: { template: WorkspaceTemplateOut }): React.JSX.Element {
  return template.icon ? (
    <Image
      accessibilityLabel={`${template.name} icon`}
      contentFit="contain"
      source={{ uri: template.icon }}
      style={styles.avatar}
    />
  ) : (
    <Monogram seed={template.name} size={spacing[12]} />
  );
}

export function TemplatesPanel(): React.JSX.Element {
  const templates = useTemplatesSettingsQuery();
  const mutations = useTemplateMutations();
  const [renameTarget, setRenameTarget] = useState<WorkspaceTemplateOut | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [iconTarget, setIconTarget] = useState<WorkspaceTemplateOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceTemplateOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = mutations.patch.isPending || mutations.remove.isPending;

  const chooseImage = async () => {
    if (!iconTarget) return;
    setError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: "image/*",
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      const encoded = await new File(asset.uri).base64();
      const dataUrl = `data:${asset.mimeType ?? "image/png"};base64,${encoded}`;
      if (dataUrl.length > MAX_ICON_DATA_URL_LENGTH) {
        setError("That image is too large. Choose a smaller image.");
        return;
      }
      await mutations.patch.mutateAsync({
        id: iconTarget.id,
        patch: { icon: dataUrl, icon_source: "custom" },
      });
      setIconTarget(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That file could not be read as an image.");
    }
  };

  return (
    <SettingsScreen
      description="Templates are saved from a workspace and used from New workspace."
      testID="templates-panel"
      title="Templates"
    >
      {error || templates.error ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {error ?? templates.error?.message}
        </Text>
      ) : null}
      <SettingsSection>
        {templates.data?.length === 0 && !templates.isPending ? (
          <EmptyState icon="LayoutTemplate" title="No templates yet." />
        ) : (
          templates.data?.map((template) => (
            <Card key={template.id} variant="flat">
              <View style={styles.row}>
                <TemplateAvatar template={template} />
                <View style={styles.rowCopy}>
                  <Text variant="label">{template.name}</Text>
                  <Text color="mutedForeground" variant="caption">
                    {formatTemplateSummary(template)}
                  </Text>
                </View>
              </View>
              {renameTarget?.id === template.id ? (
                <View style={styles.renameForm}>
                  <Field label="Name">
                    <Input
                      autoFocus
                      editable={!busy}
                      maxLength={128}
                      onChangeText={setRenameValue}
                      onSubmitEditing={() => {
                        if (!renameValue.trim()) return;
                        mutations.patch.mutate(
                          { id: template.id, patch: { name: renameValue.trim() } },
                          {
                            onSuccess: () => setRenameTarget(null),
                            onError: (cause) => setError(cause.message),
                          },
                        );
                      }}
                      purpose="name"
                      value={renameValue}
                    />
                  </Field>
                  <View style={styles.actions}>
                    <Button
                      disabled={!renameValue.trim()}
                      loading={mutations.patch.isPending}
                      onPress={() =>
                        mutations.patch.mutate(
                          { id: template.id, patch: { name: renameValue.trim() } },
                          {
                            onSuccess: () => setRenameTarget(null),
                            onError: (cause) => setError(cause.message),
                          },
                        )
                      }
                      size="sm"
                    >
                      Save
                    </Button>
                    <Button onPress={() => setRenameTarget(null)} size="sm" variant="secondary">
                      Cancel
                    </Button>
                  </View>
                </View>
              ) : (
                <View style={styles.actions}>
                  <Button
                    disabled={busy}
                    onPress={() => setIconTarget(template)}
                    size="sm"
                    variant="outline"
                  >
                    Change icon
                  </Button>
                  <Button
                    disabled={busy}
                    onPress={() => {
                      setRenameTarget(template);
                      setRenameValue(template.name);
                    }}
                    size="sm"
                    variant="outline"
                  >
                    Rename
                  </Button>
                  <Button
                    disabled={busy}
                    onPress={() => setDeleteTarget(template)}
                    size="sm"
                    variant="ghost"
                  >
                    Delete
                  </Button>
                </View>
              )}
            </Card>
          ))
        )}
      </SettingsSection>

      <Dialog
        footer={
          <View style={styles.dialogActions}>
            <Button
              disabled={busy || iconTarget?.icon === null}
              onPress={() => {
                if (!iconTarget) return;
                mutations.patch.mutate(
                  { id: iconTarget.id, patch: { icon: null, icon_source: "custom" } },
                  {
                    onSuccess: () => setIconTarget(null),
                    onError: (cause) => setError(cause.message),
                  },
                );
              }}
              variant="ghost"
            >
              Use initials
            </Button>
            <Button loading={busy} onPress={() => void chooseImage()} variant="outline">
              Choose image…
            </Button>
          </View>
        }
        onDismiss={() => setIconTarget(null)}
        size="sm"
        title="Workspace icon"
        visible={iconTarget !== null}
      >
        {iconTarget ? (
          <View style={styles.iconDialog}>
            <TemplateAvatar template={iconTarget} />
            <View style={styles.rowCopy}>
              <Text variant="label">{iconTarget.name}</Text>
              <Text color="mutedForeground" variant="caption">
                {iconTarget.icon ? "Wearing its own mark" : "Drawing its initials"}
              </Text>
            </View>
          </View>
        ) : null}
      </Dialog>

      <Confirm
        confirmLabel="Delete template"
        description="Workspaces already created from it are not affected."
        destructive
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          mutations.remove.mutate(deleteTarget.id, {
            onSuccess: () => setDeleteTarget(null),
            onError: (cause) => setError(cause.message),
          });
        }}
        title={`Delete ${deleteTarget?.name ?? "template"}?`}
        visible={deleteTarget !== null}
      />
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
    marginTop: spacing[3],
  },
  avatar: {
    borderRadius: spacing[2],
    height: spacing[12],
    width: spacing[12],
  },
  dialogActions: {
    flexDirection: "row",
    gap: spacing[2],
  },
  iconDialog: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
    padding: spacing[4],
  },
  renameForm: {
    gap: spacing[2],
    marginTop: spacing[3],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  rowCopy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
});
