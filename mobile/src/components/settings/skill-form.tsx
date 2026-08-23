import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { SettingsToggleRow } from "@/components/settings/settings-row";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import type { SkillOut } from "@/data/api/schemas/skills";
import { spacing } from "@/theme";

export interface SkillFormValue {
  name: string;
  description: string;
  content: string;
  enabledByDefault: boolean;
}

export interface SkillFormProps {
  skill?: SkillOut;
  busy: boolean;
  onCancel?: () => void;
  onSubmit: (value: SkillFormValue) => Promise<void>;
}

export function SkillForm({ skill, busy, onCancel, onSubmit }: SkillFormProps): React.JSX.Element {
  const [name, setName] = useState(skill?.name ?? "");
  const [description, setDescription] = useState(skill?.description ?? "");
  const [content, setContent] = useState(skill?.content ?? "");
  const [enabledByDefault, setEnabledByDefault] = useState(skill?.enabled_by_default ?? false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!content.trim()) {
      setError("Content is required.");
      return;
    }
    setError(null);
    await onSubmit({
      name: name.trim(),
      description: description.trim(),
      content,
      enabledByDefault,
    });
  };

  return (
    <View style={styles.form} testID="skill-form">
      <Field label="Name" required>
        <Input editable={!busy} maxLength={128} onChangeText={setName} value={name} />
      </Field>
      <Field label="Description">
        <Input editable={!busy} maxLength={512} onChangeText={setDescription} value={description} />
      </Field>
      <Field label="Content" required>
        <Textarea editable={!busy} maxLength={65_535} onChangeText={setContent} value={content} />
      </Field>
      <SettingsToggleRow
        label="Grant to new sessions by default"
        onValueChange={setEnabledByDefault}
        value={enabledByDefault}
      />
      {error ? (
        <Text accessibilityRole="alert" color="destructive" variant="body">
          {error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button loading={busy} onPress={() => void submit()}>
          {busy ? "Saving..." : skill ? "Update skill" : "Add skill"}
        </Button>
        {skill && onCancel ? (
          <Button disabled={busy} onPress={onCancel} variant="secondary">
            Cancel
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  form: {
    gap: spacing[3],
  },
});
