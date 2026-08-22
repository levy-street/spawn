import { Pressable, StyleSheet, View } from "react-native";

import { Icon, type IconName } from "@/components/ui/icon";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { borderWidth, chrome, opacity, spacing, useTheme } from "@/theme";

export interface ChoiceRowProps {
  accessibilityLabel: string;
  detail: string;
  disabled?: boolean;
  icon: IconName;
  onPress(): void;
  selected: boolean;
  statusTone?: StatusTone;
  title: string;
}

export function ChoiceRow({
  accessibilityLabel,
  detail,
  disabled = false,
  icon,
  onPress,
  selected,
  statusTone,
  title,
}: ChoiceRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: selected
            ? theme.colors.accent
            : pressed
              ? theme.colors.muted
              : theme.colors.card,
          borderColor: selected ? theme.colors.ring : theme.colors.border,
          borderRadius: theme.radii.lg,
          opacity: disabled ? opacity.disabled : opacity.opaque,
        },
      ]}
    >
      <View
        style={[
          styles.iconPlate,
          { backgroundColor: theme.colors.muted, borderRadius: theme.radii.md },
        ]}
      >
        <Icon color="foreground" name={icon} size={spacing[5]} />
      </View>
      <View style={styles.copy}>
        <View style={styles.titleRow}>
          {statusTone ? <StatusDot pulse={false} tone={statusTone} /> : null}
          <Text numberOfLines={1} style={styles.title} variant="label">
            {title}
          </Text>
        </View>
        <Text color="mutedForeground" numberOfLines={2} variant="caption">
          {detail}
        </Text>
      </View>
      {selected ? <Icon color="foreground" name="Check" size={spacing[4]} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    minHeight: chrome.touchTarget,
    padding: spacing[3],
  },
  iconPlate: {
    alignItems: "center",
    height: spacing[10],
    justifyContent: "center",
    width: spacing[10],
  },
  copy: { flex: 1, gap: spacing[0.5] },
  titleRow: { alignItems: "center", flexDirection: "row", gap: spacing[2] },
  title: { flex: 1 },
});
