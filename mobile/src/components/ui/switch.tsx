import { useEffect } from "react";
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  type ViewStyle,
} from "react-native";
import Animated, {
  interpolateColor,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/theme";
import { opacity, shadow } from "@/theme/effects";
import { borderWidth, chrome, radii, spacing } from "@/theme/spacing";

export interface SwitchProps
  extends Omit<PressableProps, "accessibilityRole" | "children" | "onPress" | "style"> {
  value: boolean;
  onValueChange: (value: boolean) => void;
  style?: StyleProp<ViewStyle>;
}

export function Switch({
  value,
  onValueChange,
  disabled = false,
  style,
  accessibilityLabel,
  accessibilityState,
  onFocus,
  onBlur,
  ...props
}: SwitchProps) {
  const theme = useTheme();
  const isDisabled = disabled === true;
  const selectedProgress = useSharedValue(value ? 1 : 0);
  const thumbPosition = useSharedValue(
    value ? theme.motion.transform.switchThumbOnX : theme.motion.transform.switchThumbOffX,
  );
  const focusProgress = useSharedValue(0);

  useEffect(() => {
    const timing = {
      duration: theme.motion.duration.base,
      easing: theme.motion.easing.inOut,
      reduceMotion: ReduceMotion.System,
    } as const;
    selectedProgress.value = withTiming(value ? 1 : 0, timing);
    thumbPosition.value = withTiming(
      value ? theme.motion.transform.switchThumbOnX : theme.motion.transform.switchThumbOffX,
      timing,
    );
  }, [
    selectedProgress,
    theme.motion.duration.base,
    theme.motion.easing.inOut,
    theme.motion.transform.switchThumbOffX,
    theme.motion.transform.switchThumbOnX,
    thumbPosition,
    value,
  ]);

  const focusStyle = useAnimatedStyle(() => ({ opacity: focusProgress.value }), []);

  const trackStyle = useAnimatedStyle(
    () => ({
      backgroundColor: interpolateColor(
        selectedProgress.value,
        [0, 1],
        [theme.colors.muted, theme.colors.primary],
      ),
      borderColor: interpolateColor(
        selectedProgress.value,
        [0, 1],
        [theme.colors.border, theme.colors.primary],
      ),
    }),
    [theme.colors.border, theme.colors.muted, theme.colors.primary],
  );

  const thumbStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: thumbPosition.value }] }),
    [],
  );

  const animateFocus = (focused: boolean) => {
    focusProgress.value = withTiming(focused ? 1 : 0, {
      duration: theme.motion.duration.base,
      easing: theme.motion.easing.inOut,
      reduceMotion: ReduceMotion.System,
    });
  };

  return (
    <Pressable
      {...props}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ ...accessibilityState, checked: value, disabled: isDisabled }}
      disabled={isDisabled}
      onFocus={(event) => {
        animateFocus(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        animateFocus(false);
        onBlur?.(event);
      }}
      onPress={() => {
        haptics.selection();
        onValueChange(!value);
      }}
      style={[styles.touchTarget, isDisabled && styles.disabled, style]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.focusRing,
          { backgroundColor: theme.colors.background, borderColor: theme.colors.ring },
          focusStyle,
        ]}
      />
      <Animated.View style={[styles.track, trackStyle]}>
        <Animated.View
          style={[styles.thumb, { backgroundColor: theme.colors.background }, thumbStyle]}
        />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  touchTarget: {
    alignItems: "center",
    height: chrome.touchTarget,
    justifyContent: "center",
    position: "relative",
    width: spacing[12],
  },
  disabled: {
    opacity: opacity.disabled,
  },
  focusRing: {
    borderRadius: radii.pill,
    borderWidth: borderWidth.emphasis,
    height: spacing[7] + borderWidth.emphasis,
    position: "absolute",
    width: chrome.touchTarget + borderWidth.emphasis,
  },
  track: {
    borderRadius: radii.pill,
    borderWidth: borderWidth.hairline,
    height: spacing[6],
    justifyContent: "center",
    overflow: "hidden",
    width: spacing[10],
  },
  thumb: {
    borderRadius: radii.pill,
    boxShadow: shadow.sm,
    height: spacing[4],
    position: "absolute",
    width: spacing[4],
  },
});
