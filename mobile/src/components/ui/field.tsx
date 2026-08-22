import { Children, cloneElement, isValidElement, type ReactElement, useId } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/ui/text";
import { spacing } from "@/theme/spacing";
import { lineHeight, typeStyles } from "@/theme/typography";

interface FieldControlAccessibilityProps {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  accessibilityLabelledBy?: string | string[];
}

export interface FieldProps {
  label: string;
  children: ReactElement<FieldControlAccessibilityProps>;
  required?: boolean;
  hint?: string;
  error?: string | null;
  nativeID?: string;
  style?: StyleProp<ViewStyle>;
}

export function Field({
  label,
  children,
  required = false,
  hint,
  error,
  nativeID,
  style,
}: FieldProps) {
  const generatedId = useId().replaceAll(":", "");
  const labelId = `${nativeID ?? `field-${generatedId}`}-label`;
  const helperCopy = error ?? hint;
  const child = Children.only(children);

  const control = isValidElement<FieldControlAccessibilityProps>(child)
    ? cloneElement(child, {
        accessibilityLabel: child.props.accessibilityLabel ?? label,
        accessibilityLabelledBy: child.props.accessibilityLabelledBy ?? labelId,
        ...(child.props.accessibilityHint !== undefined
          ? { accessibilityHint: child.props.accessibilityHint }
          : helperCopy === undefined
            ? {}
            : { accessibilityHint: helperCopy }),
      })
    : child;

  return (
    <View style={[styles.field, style]}>
      <Label nativeID={labelId} required={required}>
        {label}
      </Label>
      {control}
      <View testID="field-helper-slot" style={styles.helperSlot}>
        <Text
          accessibilityLiveRegion={error ? "assertive" : "none"}
          accessibilityRole={error ? "alert" : "text"}
          color={error ? "destructive" : "mutedForeground"}
          importantForAccessibility={helperCopy === undefined ? "no-hide-descendants" : "auto"}
          style={[styles.helper, helperCopy === undefined && styles.hiddenHelper]}
        >
          {helperCopy ?? " "}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing[2],
    width: "100%",
  },
  helperSlot: {
    minHeight: lineHeight.micro,
  },
  helper: {
    ...typeStyles.uiXs,
  },
  hiddenHelper: {
    opacity: 0,
  },
});
