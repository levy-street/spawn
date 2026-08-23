import type { ReactNode } from "react";
import { Pressable, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";

import { Text, type TextColor } from "@/components/ui/text";
import { borderWidth, opacity, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export type ChipVariant =
  | "default"
  | "outline"
  | "success"
  | "warning"
  | "info"
  | "destructive"
  | "success-soft"
  | "warning-soft"
  | "info-soft"
  | "destructive-soft";

export interface ChipProps {
  accessibilityLabel?: string;
  children: ReactNode;
  disabled?: boolean;
  leading?: ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: ChipVariant;
}

type ChipPalette = {
  backgroundColor?: string;
  borderColor: string;
  textColor: TextColor;
};

function canonicalVariant(variant: ChipVariant): Exclude<ChipVariant, `${string}-soft`> {
  switch (variant) {
    case "success-soft":
      return "success";
    case "warning-soft":
      return "warning";
    case "info-soft":
      return "info";
    case "destructive-soft":
      return "destructive";
    default:
      return variant;
  }
}

export function Chip({
  accessibilityLabel,
  children,
  disabled = false,
  leading,
  onPress,
  style,
  testID,
  variant = "default",
}: ChipProps): React.JSX.Element {
  const theme = useTheme();
  const palette: ChipPalette = (() => {
    switch (canonicalVariant(variant)) {
      case "default":
      case "outline":
        return { borderColor: theme.colors.border, textColor: "mutedForeground" };
      case "success":
        return {
          backgroundColor: theme.colors.successSoft,
          borderColor: theme.colors.success,
          textColor: "success",
        };
      case "warning":
        return {
          backgroundColor: theme.colors.warningSoft,
          borderColor: theme.colors.warning,
          textColor: "warning",
        };
      case "info":
        return {
          backgroundColor: theme.colors.infoSoft,
          borderColor: theme.colors.info,
          textColor: "info",
        };
      case "destructive":
        return {
          backgroundColor: theme.colors.destructiveSoft,
          borderColor: theme.colors.destructive,
          textColor: "destructive",
        };
    }
  })();
  const content = (
    <>
      {leading}
      {typeof children === "string" || typeof children === "number" ? (
        <Text color={palette.textColor} style={styles.label} variant="label">
          {children}
        </Text>
      ) : (
        children
      )}
    </>
  );
  const chipStyle: StyleProp<ViewStyle> = [
    styles.base,
    {
      backgroundColor: palette.backgroundColor,
      borderColor: palette.borderColor,
      borderRadius: theme.radii.pill,
    },
    disabled && styles.disabled,
    style,
  ];

  if (onPress) {
    return (
      <Pressable
        accessibilityLabel={
          accessibilityLabel ??
          (typeof children === "string" || typeof children === "number"
            ? String(children)
            : undefined)
        }
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [chipStyle, pressed && { backgroundColor: theme.colors.accent }]}
        testID={testID}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View style={chipStyle} testID={testID}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: sizing.chip.contentGap,
    minHeight: sizing.chip.minHeight,
    paddingHorizontal: sizing.chip.horizontalPadding,
  },
  disabled: {
    opacity: opacity.disabled,
  },
  label: {
    fontSize: sizing.type.componentLabel.fontSize,
    lineHeight: sizing.type.componentLabel.lineHeight,
  },
});
