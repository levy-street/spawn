import type { ReactNode } from "react";
import { useEffect } from "react";
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
  const opacity = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    const config = {
      duration: reducedMotion ? theme.motion.duration.reduced : theme.motion.duration.base,
      easing: theme.motion.easing.swift,
    };
    height.value = withTiming(open ? measuredHeight.value : 0, config);
    opacity.value = withTiming(open ? 1 : 0, config);
  }, [height, measuredHeight, open, opacity, reducedMotion, theme.motion]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: height.value,
    opacity: opacity.value,
  }));

  const handleLayout = (event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    if (nextHeight === measuredHeight.value) return;
    measuredHeight.value = nextHeight;
    if (open) {
      height.value = withTiming(nextHeight, {
        duration: reducedMotion ? theme.motion.duration.reduced : theme.motion.duration.base,
        easing: theme.motion.easing.swift,
      });
    }
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
