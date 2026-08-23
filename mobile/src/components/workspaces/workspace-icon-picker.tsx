import { useState } from "react";
import { StyleSheet, View } from "react-native";
import type { ImageSource } from "@/components/media/image-source";
import { ImageSourceSheet } from "@/components/media/image-source-sheet";
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
  const [sourceVisible, setSourceVisible] = useState(false);

  const chooseImage = async (source: ImageSource) => {
    setError(null);
    try {
      const picked = await pickWorkspaceIcon(source);
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
            Any photo works; it is squared down for you. Use initials to keep this workspace
            text-only.
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Button onPress={() => setSourceVisible(true)} size="sm" variant="outline">
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
      <ImageSourceSheet
        onDismiss={() => setSourceVisible(false)}
        onSelect={(source) => {
          setSourceVisible(false);
          void chooseImage(source);
        }}
        visible={sourceVisible}
      />
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
