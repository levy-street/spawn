import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { SkillForm, type SkillFormValue } from "@/components/settings/skill-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Confirm } from "@/components/ui/confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Text } from "@/components/ui/text";
import type { SkillOut } from "@/data/api/schemas/skills";
import { useSkillMutations, useSkillsSettingsQuery } from "@/data/queries/settings";
import { spacing } from "@/theme";

export function SkillsPanel(): React.JSX.Element {
  const skills = useSkillsSettingsQuery();
  const mutations = useSkillMutations();
  const [editing, setEditing] = useState<SkillOut | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy =
    mutations.create.isPending || mutations.patch.isPending || mutations.remove.isPending;

  const saveNew = async (value: SkillFormValue) => {
    setError(null);
    try {
      await mutations.create.mutateAsync({
        name: value.name,
        description: value.description,
        content: value.content,
        enabled_by_default: value.enabledByDefault,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save skill.");
    }
  };

  const saveEdit = async (value: SkillFormValue) => {
    if (!editing) return;
    setError(null);
    try {
      await mutations.patch.mutateAsync({
        id: editing.id,
        patch: {
          name: value.name,
          description: value.description,
          content: value.content,
          enabled_by_default: value.enabledByDefault,
        },
      });
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save skill.");
    }
  };

  return (
    <SettingsScreen
      description="Skills are account-level agent-accessible text objects."
      testID="skills-panel"
      title="Skills"
    >
      <Card variant="flat">
        <SkillForm busy={busy} onSubmit={saveNew} />
      </Card>

      {error || skills.error ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {error ?? skills.error?.message}
        </Text>
      ) : null}

      <SettingsSection>
        {skills.isPending ? (
          <Text color="mutedForeground" variant="body">
            Loading skills...
          </Text>
        ) : skills.data?.length === 0 ? (
          <EmptyState icon="Wrench" title="No skills yet." />
        ) : (
          skills.data?.map((skill) => (
            <Card key={skill.id} variant="flat">
              {editing?.id === skill.id ? (
                <SkillForm
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSubmit={saveEdit}
                  skill={skill}
                />
              ) : (
                <>
                  <View style={styles.titleLine}>
                    <Text variant="label">{skill.name}</Text>
                    {skill.enabled_by_default ? <Badge variant="outline">default</Badge> : null}
                  </View>
                  {skill.description ? (
                    <Text color="mutedForeground" variant="body">
                      {skill.description}
                    </Text>
                  ) : null}
                  <View style={styles.actions}>
                    <Button
                      disabled={busy}
                      onPress={() => setEditing(skill)}
                      size="sm"
                      variant="outline"
                    >
                      Edit
                    </Button>
                    <Button
                      disabled={busy}
                      onPress={() => setDeleteTarget(skill)}
                      size="sm"
                      variant="ghost"
                    >
                      Delete
                    </Button>
                  </View>
                </>
              )}
            </Card>
          ))
        )}
      </SettingsSection>

      <Confirm
        confirmLabel="Delete"
        destructive
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          mutations.remove.mutate(deleteTarget.id, {
            onSuccess: () => setDeleteTarget(null),
            onError: (cause) => setError(cause.message),
          });
        }}
        title={`Delete skill ${deleteTarget?.name ?? ""}?`}
        visible={deleteTarget !== null}
      />
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    gap: spacing[2],
    marginTop: spacing[3],
  },
  titleLine: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
});
