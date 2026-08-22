import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { borderWidth, shadow, useTheme } from "@/theme";

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
      <Button
        accessibilityLabel="Copy terminal selection"
        onPress={onCopy}
        size="sm"
        variant="ghost"
      >
        <Icon name="Copy" size={theme.space(4)} />
        Copy
      </Button>
      <Button
        accessibilityLabel="Cancel terminal selection"
        onPress={onCancel}
        size="sm"
        variant="ghost"
      >
        <Icon name="X" size={theme.space(4)} />
        Cancel
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
  },
});
