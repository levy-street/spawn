import type { ReactNode } from "react";
import { StyleSheet, type TextProps } from "react-native";
import { Text } from "@/components/ui/text";
import { fontSize, fontWeight, lineHeight } from "@/theme/typography";

export interface LabelProps extends Omit<TextProps, "children"> {
  children: ReactNode;
  required?: boolean;
}

export function Label({ children, required = false, style, ...props }: LabelProps) {
  return (
    <Text {...props} color="foreground" style={[styles.label, style]}>
      {children}
      {required ? (
        <Text accessibilityElementsHidden color="destructive" style={styles.required}>
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
});
