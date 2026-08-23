import { useEffect } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useReducedMotionPreference } from "@/components/ui/status-dot";
import { opacity, useTheme } from "@/theme";

export interface SkeletonProps {
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const AnimatedView = Animated.createAnimatedComponent(View);

export function Skeleton({ style, testID }: SkeletonProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotionPreference();
  const animatedOpacity = useSharedValue<number>(opacity.skeleton);

  useEffect(() => {
    cancelAnimation(animatedOpacity);
    animatedOpacity.value = opacity.skeleton;
    if (!reduceMotion) {
      const halfDuration = theme.motion.repeat.skeleton.duration / 2;
      const timing = {
        duration: halfDuration,
        easing: theme.motion.repeat.skeleton.easing,
      };
      animatedOpacity.value = withRepeat(
        withSequence(
          withTiming(opacity.skeleton * opacity.disabled, timing),
          withTiming(opacity.skeleton, timing),
        ),
        -1,
        false,
      );
    }
    return () => cancelAnimation(animatedOpacity);
  }, [animatedOpacity, reduceMotion, theme.motion.repeat.skeleton]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: animatedOpacity.value }));

  return (
    <AnimatedView
      accessibilityElementsHidden
      style={[
        styles.base,
        { backgroundColor: theme.colors.muted, borderRadius: theme.radii.md },
        animatedStyle,
        style,
      ]}
      {...(testID === undefined ? {} : { testID })}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    overflow: "hidden",
  },
});
