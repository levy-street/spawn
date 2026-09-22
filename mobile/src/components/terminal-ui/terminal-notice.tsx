import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { layer, useTheme } from "@/theme";

export interface TerminalNoticeAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/**
 * A remark over the terminal. Most retire themselves; one that asks for
 * something — "the agent updated itself, restart it" — carries the button that
 * does it, so the answer is a tap and not a trip through a menu.
 */
export function TerminalNotice({
  message,
  action,
}: {
  message: string | null;
  action?: TerminalNoticeAction | null;
}): React.JSX.Element | null {
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
          gap: theme.space(2),
          paddingHorizontal: theme.space(3),
          paddingVertical: theme.space(2),
          zIndex: layer.floatingChrome,
        },
      ]}
    >
      <Text numberOfLines={2} style={styles.message} variant="caption">
        {message}
      </Text>
      {action ? (
        <Button
          disabled={action.disabled ?? false}
          onPress={action.onPress}
          size="sm"
          testID="terminal-notice-action"
        >
          {action.label}
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  message: {
    flexShrink: 1,
  },
  notice: {
    alignItems: "center",
    alignSelf: "center",
    flexDirection: "row",
    maxWidth: "90%",
    position: "absolute",
  },
});
