import type { PropsWithChildren } from "react";
import { type StyleProp, StyleSheet, View, type ViewProps, type ViewStyle } from "react-native";

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

const styles = StyleSheet.create({
  base: {
    borderWidth: borderWidth.hairline,
  },
  elevated: {
    boxShadow: shadow.sm,
  },
  padded: {
    padding: spacing[4],
  },
});
