import { Pressable, StyleSheet, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { borderWidth, chrome, shadow, useTheme } from "@/theme";

export interface SelectionToolbarProps {
  visible: boolean;
  onCopy: () => void;
  onCancel: () => void;
}

export function SelectionToolbar({
  visible,
  onCopy,
  onCancel,
}: SelectionToolbarProps): React.JSX.Element | null {
  const theme = useTheme();
  if (!visible) return null;
  return (
    <View
      accessibilityRole="toolbar"
      style={[
        styles.toolbar,
        {
          backgroundColor: theme.colors.popover,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          borderWidth: borderWidth.hairline,
          boxShadow: shadow.lg,
          padding: theme.space(1),
        },
      ]}
      testID="terminal-selection-toolbar"
    >
      <Pressable
        accessibilityLabel="Copy terminal selection"
        accessibilityRole="button"
        onPress={onCopy}
        style={[
          styles.action,
          { minHeight: chrome.touchTarget, paddingHorizontal: theme.space(3) },
        ]}
      >
        <Icon color="mutedForeground" name="Copy" size={theme.space(4)} />
        <Text variant="label">Copy</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Cancel terminal selection"
        accessibilityRole="button"
        onPress={onCancel}
        style={[
          styles.action,
          { minHeight: chrome.touchTarget, paddingHorizontal: theme.space(3) },
        ]}
      >
        <Icon color="mutedForeground" name="X" size={theme.space(4)} />
        <Text variant="label">Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: "center",
    flexDirection: "row",
  },
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
  },
});
