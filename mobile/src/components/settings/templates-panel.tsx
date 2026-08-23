import { File } from "expo-file-system";
import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { encodeIconDataUrl } from "@/components/media/icon-image";
import { type ImageSource, pickImage } from "@/components/media/image-source";
import { ImageSourceSheet } from "@/components/media/image-source-sheet";
import { SettingsBlock } from "@/components/settings/settings-block";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Button } from "@/components/ui/button";
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

/** What the server accepts for a template icon, identical to a workspace's. */
const MAX_ICON_DATA_URL_LENGTH = 32 * 1024;

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
  const [sourceVisible, setSourceVisible] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceTemplateOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = mutations.patch.isPending || mutations.remove.isPending;

  const chooseImage = async (source: ImageSource) => {
    if (!iconTarget) return;
    setError(null);
    try {
      const picked = await pickImage(source, { fileTypes: ["image/png", "image/webp"] });
      if (!picked) return;
      // A PNG or WebP already inside the budget is used untouched; anything else,
      // a camera photo above all, is squared down to one the server accepts.
      const mime = picked.mimeType?.toLowerCase();
      const direct =
        mime === "image/png" || mime === "image/webp"
          ? `data:${mime};base64,${await new File(picked.uri).base64()}`
          : null;
      const dataUrl =
        direct !== null && direct.length <= MAX_ICON_DATA_URL_LENGTH
          ? direct
          : await encodeIconDataUrl(picked.uri, MAX_ICON_DATA_URL_LENGTH);
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
    <SettingsScreen testID="templates-panel" title="Templates">
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
            <SettingsBlock key={template.id}>
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
            </SettingsBlock>
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
            <Button loading={busy} onPress={() => setSourceVisible(true)} variant="outline">
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

      <ImageSourceSheet
        onDismiss={() => setSourceVisible(false)}
        onSelect={(source) => {
          setSourceVisible(false);
          void chooseImage(source);
        }}
        visible={sourceVisible}
      />

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
