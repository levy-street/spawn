import { Pressable, StyleSheet, View } from "react-native";

import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import type { DisplayControlState } from "@/terminal/transport/types";
import { borderWidth, opacity, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface DisplayControlBarProps {
  display: DisplayControlState | null;
  onTakeControl: () => void;
}

/** Only a follower needs telling: the owner's terminal is simply the right size. */
export function shouldShowDisplayControl(display: DisplayControlState | null): boolean {
  return display !== null && !display.owner;
}

export function displayControlSummary(display: DisplayControlState): string {
  const size =
    display.cols === null || display.rows === null
      ? "another viewer's size"
      : `${display.cols}×${display.rows}`;
  return `Another view has control · ${size}`;
}

/**
 * A session's grid belongs to one viewer at a time. While someone else holds
 * it, this phone matches their columns and shrinks its type to fit — readable,
 * but not its own. This says so, and hands the grid back on a tap.
 */
export function DisplayControlBar({
  display,
  onTakeControl,
}: DisplayControlBarProps): React.JSX.Element | null {
  const theme = useTheme();
  if (!shouldShowDisplayControl(display) || display === null) return null;

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: theme.colors.muted,
          borderBottomColor: theme.colors.border,
          borderBottomWidth: borderWidth.hairline,
          gap: theme.space(2),
          paddingHorizontal: theme.space(4),
          paddingVertical: theme.space(2),
        },
      ]}
      testID="terminal-display-control"
    >
      <Icon color="mutedForeground" name="MonitorSmartphone" size={sizing.control.icon} />
      <Text color="mutedForeground" numberOfLines={1} style={styles.summary} variant="caption">
        {displayControlSummary(display)}
      </Text>
      <Pressable
        accessibilityLabel="Take control of the terminal"
        accessibilityRole="button"
        hitSlop={theme.space(2)}
        onPress={() => {
          haptics.selection();
          onTakeControl();
        }}
        style={({ pressed }) => ({ opacity: pressed ? opacity.pressedContent : opacity.opaque })}
        testID="terminal-take-control"
      >
        <Text variant="caption" weight="semibold">
          Take control
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: "center",
    flexDirection: "row",
  },
  summary: {
    flexShrink: 1,
  },
});
