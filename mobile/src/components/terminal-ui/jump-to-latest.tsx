import { Pressable, StyleSheet } from "react-native";

import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, chrome, shadow, useTheme } from "@/theme";

export interface JumpToLatestProps {
  unread: boolean;
  onPress: () => void;
}

export function JumpToLatest({ unread, onPress }: JumpToLatestProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={
        unread ? "Jump to latest output, new output available" : "Jump to latest output"
      }
      accessibilityRole="button"
      onPress={() => {
        haptics.impact("light");
        onPress();
      }}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: pressed ? theme.colors.accent : theme.colors.popover,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.pill,
          borderWidth: borderWidth.hairline,
          boxShadow: shadow.md,
          gap: theme.space(1.5),
          minHeight: chrome.touchTarget,
          paddingHorizontal: theme.space(unread ? 3 : 2.5),
        },
      ]}
      testID="jump-to-latest"
    >
      {unread ? <StatusDot pulse={false} tone="active" /> : null}
      {unread ? <Text variant="label">New</Text> : null}
      <Icon color="mutedForeground" name="ChevronDown" size={theme.space(4)} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    justifyContent: "center",
  },
});
