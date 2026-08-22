import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import {
  initialsWorkspaceIcon,
  pickWorkspaceIcon,
  WorkspaceIcon,
  type WorkspaceIconChoice,
} from "@/components/workspaces/workspace-icon";
import { spacing } from "@/theme";

export interface WorkspaceIconPickerProps {
  name: string;
  value: WorkspaceIconChoice | null;
  onChange: (value: WorkspaceIconChoice) => void;
}

export function WorkspaceIconPicker({ name, value, onChange }: WorkspaceIconPickerProps) {
  const [error, setError] = useState<string | null>(null);

  const chooseImage = async () => {
    setError(null);
    try {
      const picked = await pickWorkspaceIcon();
      if (picked) onChange(picked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The image could not be read.");
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.previewRow}>
        <WorkspaceIcon
          icon={value?.icon ?? null}
          name={name.trim() || "Workspace"}
          size={spacing[12]}
          testID="workspace-icon-preview"
        />
        <View style={styles.copy}>
          <Text variant="label">Workspace icon</Text>
          <Text color="mutedForeground" variant="caption">
            PNG or WebP. Use initials to keep this workspace text-only.
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Button onPress={() => void chooseImage()} size="sm" variant="outline">
          <Icon color="foreground" name="ImagePlus" size={spacing[4]} />
          Upload image
        </Button>
        <Button onPress={() => onChange(initialsWorkspaceIcon())} size="sm" variant="ghost">
          <Icon color="foreground" name="Type" size={spacing[4]} />
          Use initials
        </Button>
      </View>
      {error ? (
        <Text accessibilityRole="alert" color="destructive" variant="caption">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  container: {
    gap: spacing[3],
  },
  copy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
  previewRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
});
