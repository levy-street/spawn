import type { PropsWithChildren } from "react";
import { type StyleProp, StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";

import { Text, type TextProps } from "@/components/ui/text";
import { borderWidth, shadow, spacing, useTheme } from "@/theme";

export type CardVariant = "elevated" | "flat";

export interface CardProps extends PropsWithChildren<Omit<ViewProps, "style">> {
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  variant?: CardVariant;
}

export function Card({
  children,
  padded = true,
  style,
  variant = "elevated",
  ...props
}: CardProps) {
  const theme = useTheme();

  return (
    <View
      {...props}
      style={[
        styles.base,
        padded && styles.padded,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
        },
        variant === "elevated" && styles.elevated,
        style,
      ]}
    >
      {children}
    </View>
  );
}

export interface CardSectionProps extends Omit<ViewProps, "style"> {
  style?: StyleProp<ViewStyle>;
}

export function CardHeader({ style, ...props }: CardSectionProps): React.JSX.Element {
  return <View {...props} style={[styles.header, style]} />;
}

export type CardTitleProps = Omit<TextProps, "variant">;

export function CardTitle({ color = "cardForeground", ...props }: CardTitleProps) {
  return <Text {...props} color={color} variant="title" />;
}

export type CardDescriptionProps = Omit<TextProps, "variant">;

export function CardDescription({ color = "mutedForeground", ...props }: CardDescriptionProps) {
  return <Text {...props} color={color} variant="body" />;
}

export function CardContent({ style, ...props }: CardSectionProps): React.JSX.Element {
  return <View {...props} style={[styles.content, style]} />;
}

export function CardFooter({ style, ...props }: CardSectionProps): React.JSX.Element {
  return <View {...props} style={[styles.footer, style]} />;
}

const styles = StyleSheet.create({
  base: {
    borderWidth: borderWidth.hairline,
  },
  elevated: {
    boxShadow: shadow.sm,
  },
  header: {
    gap: spacing[1],
    padding: spacing[4],
  },
  content: {
    padding: spacing[4],
    paddingTop: spacing[0],
  },
  footer: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    padding: spacing[4],
    paddingTop: spacing[0],
  },
  padded: {
    padding: spacing[4],
  },
});
