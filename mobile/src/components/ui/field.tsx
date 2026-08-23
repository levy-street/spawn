import { Children, cloneElement, isValidElement, type ReactElement, useId } from "react";
import { type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/ui/text";
import { pressroomColors, useTheme } from "@/theme";
import { spacing } from "@/theme/spacing";
import { lineHeight, typeStyles } from "@/theme/typography";

interface FieldControlAccessibilityProps {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  accessibilityLabelledBy?: string | string[];
  error?: boolean;
}

export interface FieldProps {
  label: string;
  children: ReactElement<FieldControlAccessibilityProps>;
  required?: boolean;
  hint?: string;
  error?: string | null;
  nativeID?: string;
  showRequiredIndicator?: boolean;
  style?: StyleProp<ViewStyle>;
  variant?: "default" | "auth";
}

export function Field({
  label,
  children,
  required = false,
  hint,
  error,
  nativeID,
  showRequiredIndicator = false,
  style,
  variant = "default",
}: FieldProps) {
  const theme = useTheme();
  const generatedId = useId().replaceAll(":", "");
  const labelId = `${nativeID ?? `field-${generatedId}`}-label`;
  const helperCopy = error ?? hint;
  const hasError = typeof error === "string" && error.length > 0;
  const hasHelperCopy = typeof helperCopy === "string" && helperCopy.length > 0;
  const child = Children.only(children);
  const transition = LinearTransition.duration(theme.motion.duration.base)
    .easing(theme.motion.easing.inOut)
    .reduceMotion(ReduceMotion.System);
  const enter = FadeIn.duration(theme.motion.duration.base)
    .easing(theme.motion.easing.inOut)
    .reduceMotion(ReduceMotion.System);
  const exit = FadeOut.duration(theme.motion.duration.fast)
    .easing(theme.motion.easing.inOut)
    .reduceMotion(ReduceMotion.System);

  const control = isValidElement<FieldControlAccessibilityProps>(child)
    ? cloneElement(child, {
        accessibilityLabel: child.props.accessibilityLabel ?? label,
        accessibilityLabelledBy: child.props.accessibilityLabelledBy ?? labelId,
        ...(child.props.accessibilityHint !== undefined
          ? { accessibilityHint: child.props.accessibilityHint }
          : !hasHelperCopy
            ? {}
            : { accessibilityHint: helperCopy }),
        ...(hasError ? { error: true } : {}),
      })
    : child;

  return (
    <Animated.View
      layout={transition}
      style={[styles.field, variant === "auth" && styles.authField, style]}
    >
      <Label
        nativeID={labelId}
        required={required}
        showRequiredIndicator={showRequiredIndicator}
        variant={variant}
      >
        {label}
      </Label>
      {control}
      {hasHelperCopy ? (
        <Animated.View
          entering={enter}
          exiting={exit}
          layout={transition}
          testID="field-helper-slot"
        >
          <Text
            accessibilityLiveRegion={hasError ? "assertive" : "none"}
            accessibilityRole={hasError ? "alert" : "text"}
            color={hasError ? "destructive" : "mutedForeground"}
            style={[
              styles.helper,
              variant === "auth" && styles.authHelper,
              variant === "auth" && {
                color: hasError ? pressroomColors.ember : pressroomColors.ash,
              },
            ]}
          >
            {helperCopy}
          </Text>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: spacing[1.5],
    width: "100%",
  },
  authField: {
    gap: spacing[2],
  },
  helper: {
    ...typeStyles.uiXs,
  },
  authHelper: {
    lineHeight: lineHeight.sm,
  },
});
