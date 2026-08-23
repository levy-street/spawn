import type { ReactNode } from "react";
import { StyleSheet, type TextProps } from "react-native";
import { Text } from "@/components/ui/text";
import { pressroomColors } from "@/theme/colors";
import { fontSize, fontWeight, lineHeight, typeStyles } from "@/theme/typography";

export interface LabelProps extends Omit<TextProps, "children"> {
  children: ReactNode;
  required?: boolean;
  showRequiredIndicator?: boolean;
  variant?: "default" | "auth";
}

export function Label({
  children,
  required = false,
  showRequiredIndicator = false,
  style,
  variant = "default",
  ...props
}: LabelProps) {
  const isAuth = variant === "auth";
  return (
    <Text {...props} color="foreground" style={[styles.label, isAuth && styles.authLabel, style]}>
      {children}
      {required && showRequiredIndicator ? (
        <Text
          accessibilityElementsHidden
          color="destructive"
          style={[styles.required, isAuth && styles.authRequired]}
        >
          {" *"}
        </Text>
      ) : null}
    </Text>
  );
}

const styles = StyleSheet.create({
  label: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.compact,
  },
  required: {
    fontSize: fontSize.sm,
    fontWeight: fontWeight.medium,
    lineHeight: lineHeight.compact,
  },
  authLabel: {
    ...typeStyles.sigilLabel,
    color: pressroomColors.ash,
  },
  authRequired: {
    ...typeStyles.sigilLabel,
    color: pressroomColors.ember,
  },
});
