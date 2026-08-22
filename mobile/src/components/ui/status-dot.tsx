import { useEffect, useState } from "react";
import { AccessibilityInfo, type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { borderWidth, opacity, spacing, useTheme } from "@/theme";

export type StatusTone = "active" | "waiting" | "idle" | "offline";

export interface StatusDotProps {
  accessibilityLabel?: string;
  bordered?: boolean;
  pulse?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  tone: StatusTone;
}

const TONE_COLOR = {
  active: "toneActive",
  waiting: "toneWaiting",
  idle: "toneIdle",
  offline: "toneOffline",
} as const;

export function useReducedMotionPreference(): boolean {
  const reducedAtRender = useReducedMotion();
  const [reduceMotion, setReduceMotion] = useState(reducedAtRender);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => {
        if (active) {
          setReduceMotion(enabled);
        }
      },
      () => undefined,
    );
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

export function StatusDot({
  accessibilityLabel,
  bordered = false,
  pulse,
  style,
  testID,
  tone,
}: StatusDotProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotionPreference();
  const shouldPulse = pulse ?? tone === "active";
  const pulseScale = useSharedValue<number>(1);
  const pulseOpacity = useSharedValue<number>(opacity.pulse);
  const toneColor = theme.colors[TONE_COLOR[tone]];

  useEffect(() => {
    cancelAnimation(pulseScale);
    cancelAnimation(pulseOpacity);
    pulseScale.value = 1;
    pulseOpacity.value = opacity.pulse;

    if (shouldPulse && !reduceMotion) {
      pulseScale.value = withRepeat(
        withTiming(theme.motion.transform.statusPingScale, theme.motion.repeat.statusPing),
        -1,
        false,
      );
      pulseOpacity.value = withRepeat(
        withTiming(opacity.hidden, theme.motion.repeat.statusPing),
        -1,
        false,
      );
    }

    return () => {
      cancelAnimation(pulseScale);
      cancelAnimation(pulseOpacity);
    };
  }, [
    pulseOpacity,
    pulseScale,
    reduceMotion,
    shouldPulse,
    theme.motion.repeat.statusPing,
    theme.motion.transform.statusPingScale,
  ]);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: pulseOpacity.value,
    transform: [{ scale: pulseScale.value }],
  }));

  return (
    <View
      accessibilityElementsHidden={accessibilityLabel === undefined}
      accessibilityRole={accessibilityLabel === undefined ? undefined : "image"}
      accessible={accessibilityLabel !== undefined}
      style={[
        styles.dot,
        {
          backgroundColor: toneColor,
          borderColor: theme.colors.card,
          borderRadius: theme.radii.pill,
          borderWidth: bordered ? borderWidth.hairline : borderWidth.none,
        },
        style,
      ]}
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
      {...(testID === undefined ? {} : { testID })}
    >
      {shouldPulse && !reduceMotion && (
        <Animated.View
          accessible={false}
          style={[
            styles.pulse,
            { backgroundColor: toneColor, borderRadius: theme.radii.pill },
            pulseStyle,
          ]}
          {...(testID === undefined ? {} : { testID: `${testID}-pulse` })}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    flexShrink: 0,
    height: spacing[2],
    position: "relative",
    width: spacing[2],
  },
  pulse: {
    ...StyleSheet.absoluteFillObject,
  },
});
