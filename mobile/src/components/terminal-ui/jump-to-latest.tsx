import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { borderWidth, shadow, useTheme } from "@/theme";

export interface JumpToLatestProps {
  unread: boolean;
  onPress: () => void;
}

export function JumpToLatest({ unread, onPress }: JumpToLatestProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.surface,
        {
          backgroundColor: theme.colors.popover,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.pill,
          borderWidth: borderWidth.hairline,
          boxShadow: shadow.md,
        },
      ]}
    >
      <Button
        accessibilityLabel={
          unread ? "Jump to latest output, new output available" : "Jump to latest output"
        }
        onPress={onPress}
        style={[styles.button, { borderRadius: theme.radii.pill }]}
        testID="jump-to-latest"
        variant="ghost"
      >
        {unread ? <StatusDot pulse={false} tone="active" /> : null}
        {unread ? "New" : null}
        <Icon name="ChevronDown" size={theme.space(4)} />
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    borderWidth: borderWidth.none,
  },
  surface: {
    alignSelf: "center",
  },
});
