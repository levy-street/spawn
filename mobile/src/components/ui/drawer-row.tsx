import { cloneElement, isValidElement, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "@/components/ui/text";
import { borderWidth, opacity, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface DrawerRowProps {
  label: string;
  detail?: string;
  icon?: ReactNode;
  /** A mark at the row's tail — a selection check, say. Sized like the leading icon. */
  trailing?: ReactNode;
  /** Answers a choice: reports checked state and is what a drawer marks with a tick. */
  selected?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityRole?: "button" | "menuitem" | "radio";
  onPress: () => void;
  testID?: string;
}

/**
 * One action inside a bottom drawer.
 *
 * Menus and action sheets had grown separate row implementations with different
 * heights, icon sizes and gaps, so the same list of actions looked like two
 * different components depending on which screen opened it. Both present through
 * this now, and the geometry lives in `sizing.actionSheet` rather than in either
 * of them.
 *
 * Icons arrive from call sites at their default size; the row sets the size once
 * so no caller has to know a drawer's icon is larger than an inline one.
 */
export function DrawerRow({
  label,
  detail,
  icon,
  trailing,
  selected,
  destructive = false,
  disabled = false,
  accessibilityLabel,
  accessibilityRole = "button",
  onPress,
  testID,
}: DrawerRowProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ disabled, ...(selected === undefined ? {} : { checked: selected }) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed
            ? destructive
              ? theme.colors.destructiveSoft
              : theme.colors.popoverAccent
            : "transparent",
          opacity: disabled ? opacity.disabled : opacity.opaque,
        },
      ]}
      {...(testID === undefined ? {} : { testID })}
    >
      <DrawerRowGlyph glyph={icon} />
      <View style={styles.copy}>
        <Text color={destructive ? "destructive" : "popoverForeground"} variant="uiBase">
          {label}
        </Text>
        {detail ? (
          <Text color="mutedForeground" variant="caption">
            {detail}
          </Text>
        ) : null}
      </View>
      <DrawerRowGlyph glyph={trailing} />
    </Pressable>
  );
}

function DrawerRowGlyph({ glyph }: { glyph: ReactNode }): React.JSX.Element | null {
  if (!isValidElement<{ size?: number }>(glyph)) return null;
  return (
    <View style={styles.icon}>
      {cloneElement(glyph, { size: glyph.props.size ?? sizing.actionSheet.icon })}
    </View>
  );
}

export function DrawerSeparator(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID="drawer-separator"
      style={[
        styles.separator,
        {
          backgroundColor: theme.colors.popoverBorder,
          marginHorizontal: sizing.actionSheet.horizontalPadding,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  copy: {
    flex: 1,
    minWidth: 0,
  },
  icon: {
    alignItems: "center",
    height: sizing.actionSheet.iconSlot,
    justifyContent: "center",
    width: sizing.actionSheet.iconSlot,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.actionSheet.iconGap,
    minHeight: sizing.actionSheet.rowMinHeight,
    paddingHorizontal: sizing.actionSheet.horizontalPadding,
    paddingVertical: sizing.actionSheet.verticalPadding,
    width: "100%",
  },
  separator: {
    height: borderWidth.hairline,
  },
});
