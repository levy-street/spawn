import { forwardRef, useEffect, useState } from "react";
import {
  type NativeSyntheticEvent,
  type StyleProp,
  StyleSheet,
  TextInput,
  type TextInputContentSizeChangeEventData,
  type TextInputProps,
  type TextStyle,
} from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { getInputPurposeConfig, type InputPurpose } from "@/components/ui/input";
import { useTheme } from "@/theme";
import { opacity } from "@/theme/effects";
import { borderWidth, radii, space, spacing } from "@/theme/spacing";
import { typeStyles } from "@/theme/typography";

export interface TextareaProps extends Omit<TextInputProps, "multiline" | "style"> {
  purpose?: InputPurpose;
  error?: boolean;
  minHeight?: number;
  maxHeight?: number;
  style?: StyleProp<TextStyle>;
}

export const Textarea = forwardRef<TextInput, TextareaProps>(function Textarea(
  {
    purpose = "plain",
    error = false,
    minHeight = space(15),
    maxHeight = spacing[32],
    style,
    editable = true,
    autoCapitalize,
    autoCorrect,
    spellCheck,
    keyboardType,
    textContentType,
    autoComplete,
    smartInsertDelete,
    secureTextEntry,
    scrollEnabled,
    onContentSizeChange,
    onFocus,
    onBlur,
    accessibilityState,
    testID,
    ...props
  },
  ref,
) {
  const theme = useTheme();
  const config = getInputPurposeConfig(purpose);
  const focusProgress = useSharedValue(0);
  const [measuredHeight, setMeasuredHeight] = useState(minHeight);
  const [contentExceedsMaximum, setContentExceedsMaximum] = useState(false);

  useEffect(() => {
    setMeasuredHeight((height) => Math.max(minHeight, Math.min(maxHeight, height)));
  }, [maxHeight, minHeight]);

  const animatedHaloStyle = useAnimatedStyle(
    () => ({
      borderColor: error ? theme.colors.destructive : theme.colors.ring,
      opacity: focusProgress.value,
    }),
    [error, theme.colors.destructive, theme.colors.ring],
  );

  const animateFocus = (focused: boolean) => {
    focusProgress.value = withTiming(focused ? 1 : 0, {
      duration: theme.motion.duration.base,
      easing: theme.motion.easing.inOut,
      reduceMotion: ReduceMotion.System,
    });
  };

  const handleContentSizeChange = (
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) => {
    const contentHeight = event.nativeEvent.contentSize.height;
    setMeasuredHeight(Math.max(minHeight, Math.min(maxHeight, contentHeight)));
    setContentExceedsMaximum(contentHeight > maxHeight);
    onContentSizeChange?.(event);
  };

  return (
    <Animated.View
      style={[
        styles.container,
        { borderColor: error ? theme.colors.destructive : theme.colors.input },
        !editable && styles.disabled,
        { height: measuredHeight, minHeight, maxHeight },
      ]}
    >
      <Animated.View
        pointerEvents="none"
        style={[styles.focusHalo, animatedHaloStyle]}
        testID={testID === undefined ? undefined : `${testID}-focus-halo`}
      />
      <TextInput
        {...props}
        ref={ref}
        testID={testID}
        multiline
        editable={editable}
        autoCapitalize={autoCapitalize ?? config.autoCapitalize}
        autoCorrect={autoCorrect ?? config.autoCorrect}
        spellCheck={spellCheck ?? config.spellCheck}
        keyboardType={keyboardType ?? config.keyboardType}
        textContentType={textContentType ?? config.textContentType}
        autoComplete={autoComplete ?? config.autoComplete}
        smartInsertDelete={smartInsertDelete ?? config.smartInsertDelete}
        secureTextEntry={secureTextEntry ?? config.secureTextEntry}
        scrollEnabled={scrollEnabled ?? contentExceedsMaximum}
        onContentSizeChange={handleContentSizeChange}
        onFocus={(event) => {
          animateFocus(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          animateFocus(false);
          onBlur?.(event);
        }}
        accessibilityState={{ ...accessibilityState, disabled: !editable }}
        aria-invalid={error || undefined}
        placeholderTextColor={props.placeholderTextColor ?? theme.colors.mutedForeground}
        selectionColor={props.selectionColor ?? theme.colors.brandAccent}
        style={[styles.input, { color: theme.colors.foreground }, style]}
      />
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  container: {
    borderRadius: radii.md,
    borderWidth: borderWidth.hairline,
    position: "relative",
    width: "100%",
  },
  focusHalo: {
    borderRadius: radii.md,
    borderWidth: borderWidth.hairline,
    bottom: -borderWidth.hairline,
    left: -borderWidth.hairline,
    position: "absolute",
    right: -borderWidth.hairline,
    top: -borderWidth.hairline,
  },
  disabled: {
    opacity: opacity.disabled,
  },
  input: {
    ...typeStyles.uiSm,
    flex: 1,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    textAlignVertical: "top",
  },
});
