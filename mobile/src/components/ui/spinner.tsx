import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { useReducedMotionPreference } from "@/components/ui/status-dot";
import { alpha, type Colors, spacing, useTheme } from "@/theme";

export interface SpinnerProps {
  color?: keyof Colors;
  label?: string;
  size?: number;
  testID?: string;
}

const AnimatedView = Animated.createAnimatedComponent(View);

export function Spinner({
  color = "mutedForeground",
  label = "Loading",
  // A page's loading mark, not an inline one: buttons and strips pass their
  // own smaller size. At the old 16pt it was a fleck in the middle of a screen.
  size = spacing[7],
  testID,
}: SpinnerProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotionPreference();
  const rotation = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(rotation);
    rotation.value = 0;
    if (!reduceMotion) {
      rotation.value = withRepeat(withTiming(1, theme.motion.repeat.spinner), -1, false);
    }
    return () => cancelAnimation(rotation);
  }, [reduceMotion, rotation, theme.motion.repeat.spinner]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 360}deg` }],
  }));

  return (
    <AnimatedView
      accessibilityLabel={label}
      accessibilityRole="progressbar"
      style={[styles.container, { height: size, width: size }, animatedStyle]}
      {...(testID === undefined ? {} : { testID })}
    >
      <Svg fill="none" height={size} viewBox="0 0 24 24" width={size}>
        <Circle
          cx="12"
          cy="12"
          r="9"
          stroke={theme.colors[color]}
          strokeOpacity={alpha.a25}
          strokeWidth="3"
        />
        <Path
          d="M12 3a9 9 0 0 1 9 9"
          stroke={theme.colors[color]}
          strokeLinecap="round"
          strokeWidth="3"
        />
      </Svg>
    </AnimatedView>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
});
