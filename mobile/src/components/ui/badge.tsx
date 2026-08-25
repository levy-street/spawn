import { Children, type ReactNode } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { Text } from "@/components/ui/text";
import { alpha, borderWidth, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export type BadgeVariant =
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

export interface BadgeProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  variant?: BadgeVariant;
}

type CanonicalBadgeVariant = Exclude<BadgeVariant, `${string}-soft`>;

function canonicalBadgeVariant(variant: BadgeVariant): CanonicalBadgeVariant {
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

function colorWithAlpha(color: string, channelAlpha: number): string {
  if (!/^#[\dA-Fa-f]{6}$/.test(color)) {
    return color;
  }
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return `rgba(${red},${green},${blue},${channelAlpha})`;
}

/**
 * The badge's text, when its children are text. JSX like `🔥 {n} day streak`
 * arrives as several strings and numbers rather than one, and a badge that only
 * recognised a single string drew an empty pill around them.
 */
function textOf(children: ReactNode): string | null {
  const parts = Children.toArray(children);
  if (parts.length === 0) return null;
  if (!parts.every((part) => typeof part === "string" || typeof part === "number")) return null;
  return parts.map(String).join("");
}

export function Badge({ children, style, testID, variant = "default" }: BadgeProps) {
  const theme = useTheme();
  const normalizedVariant = canonicalBadgeVariant(variant);
  const text = textOf(children);
  const palette = (() => {
    switch (normalizedVariant) {
      case "default":
        return {
          backgroundColor: colorWithAlpha(theme.colors.secondary, alpha.a60),
          borderColor: theme.colors.border,
          textColor: "secondaryForeground" as const,
        };
      case "outline":
        return {
          backgroundColor: "transparent",
          borderColor: theme.colors.border,
          textColor: "mutedForeground" as const,
        };
      case "success":
        return {
          backgroundColor: theme.colors.successSoft,
          borderColor: colorWithAlpha(theme.colors.success, alpha.a25),
          textColor: "success" as const,
        };
      case "warning":
        return {
          backgroundColor: theme.colors.warningSoft,
          borderColor: colorWithAlpha(theme.colors.warning, alpha.a25),
          textColor: "warning" as const,
        };
      case "info":
        return {
          backgroundColor: theme.colors.infoSoft,
          borderColor: colorWithAlpha(theme.colors.info, alpha.a25),
          textColor: "info" as const,
        };
      case "destructive":
        return {
          backgroundColor: theme.colors.destructiveSoft,
          borderColor: colorWithAlpha(theme.colors.destructive, alpha.a25),
          textColor: "destructive" as const,
        };
    }
  })();

  return (
    <View
      style={[
        styles.base,
        {
          backgroundColor: palette.backgroundColor,
          borderColor: palette.borderColor,
          borderRadius: theme.radii.pill,
        },
        style,
      ]}
      testID={testID}
    >
      {text !== null ? (
        <Text color={palette.textColor} variant="micro">
          {text}
        </Text>
      ) : (
        children
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: sizing.badge.contentGap,
    paddingHorizontal: sizing.badge.horizontalPadding,
    paddingVertical: sizing.badge.verticalPadding,
  },
});
