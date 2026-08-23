import { StyleSheet, View } from "react-native";

import { Text } from "@/components/ui/text";
import { layer, useTheme } from "@/theme";

export function TerminalNotice({ message }: { message: string | null }): React.JSX.Element | null {
  const theme = useTheme();
  if (!message) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.notice,
        {
          backgroundColor: theme.colors.popover,
          borderRadius: theme.radii.md,
          bottom: theme.space(3),
          paddingHorizontal: theme.space(3),
          paddingVertical: theme.space(2),
          zIndex: layer.floatingChrome,
        },
      ]}
    >
      <Text numberOfLines={2} variant="caption">
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    alignSelf: "center",
    maxWidth: "90%",
    position: "absolute",
  },
});
