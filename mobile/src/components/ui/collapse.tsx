import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import {
  type LayoutChangeEvent,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { useReducedMotionPreference } from "@/components/ui/swipe-dismiss-overlay";
import { useTheme } from "@/theme";

export interface CollapseProps {
  open: boolean;
  children: ReactNode;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Collapse({
  open,
  children,
  accessibilityLabel,
  style,
  testID,
}: CollapseProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotionPreference();
  const measuredHeight = useSharedValue(0);
  const height = useSharedValue(0);
  const armed = useRef(false);
  const hasMeasured = useRef(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      armed.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const transition = theme.motion.transition.collapse;
    const config = {
      duration: reducedMotion ? theme.motion.duration.reduced : transition.duration,
      easing: transition.easing,
    };
    const nextHeight = open ? measuredHeight.value : 0;
    height.value = armed.current ? withTiming(nextHeight, config) : nextHeight;
  }, [height, measuredHeight, open, reducedMotion, theme.motion]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: height.value,
  }));

  const handleLayout = (event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    if (nextHeight === measuredHeight.value) return;
    measuredHeight.value = nextHeight;
    if (open) {
      const transition = theme.motion.transition.collapse;
      const config = {
        duration: reducedMotion ? theme.motion.duration.reduced : transition.duration,
        easing: transition.easing,
      };
      height.value =
        armed.current && hasMeasured.current ? withTiming(nextHeight, config) : nextHeight;
    }
    hasMeasured.current = true;
  };

  return (
    <Animated.View
      accessibilityElementsHidden={!open}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={open ? "auto" : "no-hide-descendants"}
      style={[styles.clipped, animatedStyle, style]}
      testID={testID}
    >
      <View onLayout={handleLayout}>{children}</View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clipped: {
    overflow: "hidden",
  },
});
