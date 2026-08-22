import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { borderWidth, chrome, spacing, useTheme } from "@/theme";

interface SettingsRowBaseProps {
  label: string;
  hint?: ReactNode | undefined;
  icon?: IconName | undefined;
  trailing?: ReactNode | undefined;
  testID?: string | undefined;
}

interface SettingsLinkRowProps extends SettingsRowBaseProps {
  onPress: () => void;
  accessibilityHint?: string;
}

interface SettingsToggleRowProps extends SettingsRowBaseProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
}

function RowContent({ label, hint, icon, trailing }: SettingsRowBaseProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <>
      {icon ? (
        <View style={[styles.icon, { backgroundColor: theme.colors.muted }]}>
          <Icon color="mutedForeground" name={icon} size={spacing[4]} />
        </View>
      ) : null}
      <View style={styles.copy}>
        <Text variant="label">{label}</Text>
        {hint ? (
          typeof hint === "string" ? (
            <Text color="mutedForeground" variant="caption">
              {hint}
            </Text>
          ) : (
            hint
          )
        ) : null}
      </View>
      {trailing}
    </>
  );
}

export function SettingsLinkRow({
  label,
  hint,
  icon,
  trailing,
  onPress,
  accessibilityHint,
  testID,
}: SettingsLinkRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? theme.colors.accent : theme.colors.card,
          borderColor: theme.colors.border,
        },
      ]}
      testID={testID}
    >
      <RowContent hint={hint} icon={icon} label={label} trailing={trailing} />
      <Icon color="mutedForeground" name="ChevronRight" size={spacing[4]} />
    </Pressable>
  );
}

export function SettingsToggleRow({
  label,
  hint,
  icon,
  trailing,
  value,
  onValueChange,
  disabled = false,
  testID,
}: SettingsToggleRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[styles.row, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}
      testID={testID}
    >
      <RowContent hint={hint} icon={icon} label={label} trailing={trailing} />
      <Switch
        accessibilityLabel={label}
        disabled={disabled}
        onValueChange={onValueChange}
        value={value}
      />
    </View>
  );
}

export function SettingsInfoRow({
  label,
  hint,
  icon,
  trailing,
  testID,
}: SettingsRowBaseProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[styles.row, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}
      testID={testID}
    >
      <RowContent hint={hint} icon={icon} label={label} trailing={trailing} />
    </View>
  );
}

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    gap: spacing[0.5],
  },
  icon: {
    alignItems: "center",
    borderRadius: spacing[2],
    height: spacing[8],
    justifyContent: "center",
    width: spacing[8],
  },
  row: {
    alignItems: "center",
    borderRadius: spacing[2.5],
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    minHeight: chrome.touchTarget,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
});
