import type { ReactNode } from "react";
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { markSettingsRow, useSettingsGrouped } from "@/components/settings/settings-grouped";
import { Icon, type IconName } from "@/components/ui/icon";
import { Switch } from "@/components/ui/switch";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, chrome, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

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
  const grouped = useSettingsGrouped();
  const theme = useTheme();
  return (
    <>
      {icon ? (
        grouped ? (
          // A grouped row shows the bare glyph a drawer's rows show; the muted
          // plate belongs to a card, and in a list of nine it reads as noise.
          <View style={styles.glyph}>
            <Icon color="mutedForeground" name={icon} size={sizing.actionSheet.icon} />
          </View>
        ) : (
          <View style={[styles.icon, { backgroundColor: theme.colors.muted }]}>
            <Icon color="mutedForeground" name={icon} size={spacing[4]} />
          </View>
        )
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

interface RowSurface {
  style: StyleProp<ViewStyle>;
  pressedBackground: string;
  restBackground: string;
}

/** The card a standalone row wears, dropped when a grouped list draws it instead. */
function useRowSurface(): RowSurface {
  const grouped = useSettingsGrouped();
  const theme = useTheme();
  return grouped
    ? {
        style: styles.groupedRow,
        pressedBackground: theme.colors.accent,
        restBackground: "transparent",
      }
    : {
        style: [styles.cardRow, { borderColor: theme.colors.border }],
        pressedBackground: theme.colors.accent,
        restBackground: theme.colors.card,
      };
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
  const surface = useRowSurface();
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={() => {
        haptics.selection();
        onPress();
      }}
      style={({ pressed }) => [
        styles.row,
        surface.style,
        { backgroundColor: pressed ? surface.pressedBackground : surface.restBackground },
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
  const surface = useRowSurface();
  return (
    <View
      style={[styles.row, surface.style, { backgroundColor: surface.restBackground }]}
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
  const surface = useRowSurface();
  return (
    <View
      style={[styles.row, surface.style, { backgroundColor: surface.restBackground }]}
      testID={testID}
    >
      <RowContent hint={hint} icon={icon} label={label} trailing={trailing} />
    </View>
  );
}

const styles = StyleSheet.create({
  cardRow: {
    borderRadius: spacing[2.5],
    borderWidth: borderWidth.hairline,
    gap: spacing[3],
    minHeight: chrome.touchTarget,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
  },
  copy: {
    flex: 1,
    gap: spacing[0.5],
    minWidth: 0,
  },
  glyph: {
    alignItems: "center",
    height: sizing.actionSheet.iconSlot,
    justifyContent: "center",
    width: sizing.actionSheet.iconSlot,
  },
  groupedRow: {
    gap: sizing.listRow.contentGap,
    minHeight: sizing.actionSheet.rowMinHeight,
    // The page gutter, re-applied here because the group cancelled it: labels
    // line up with the padded content above and below the list.
    paddingHorizontal: sizing.screen.gutter,
    paddingVertical: sizing.actionSheet.verticalPadding,
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
    flexDirection: "row",
    width: "100%",
  },
});

// A section groups these three and draws the hairlines between them.
markSettingsRow(SettingsLinkRow);
markSettingsRow(SettingsToggleRow);
markSettingsRow(SettingsInfoRow);
