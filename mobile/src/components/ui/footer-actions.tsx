import { Children, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import Animated, { Extrapolation, interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "@/lib/motion/reduced-motion";
import { borderWidth, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface FooterKeyboardAnimation {
  /** Negative keyboard height, continuously driven by the keyboard controller. */
  height: SharedValue<number>;
  /** Continuous closed-to-open keyboard progress. */
  progress: SharedValue<number>;
  /** Destination progress reported at the start of the current keyboard transition. */
  targetProgress: SharedValue<number>;
}

export interface FooterActionsProps {
  children: ReactNode;
  keyboardAnimation: FooterKeyboardAnimation;
}

export function FooterActions({
  children,
  keyboardAnimation,
}: FooterActionsProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const closedBottomPadding = Math.max(sizing.footer.minimumBottomPadding, insets.bottom);
  const { height, progress, targetProgress } = keyboardAnimation;

  const animatedStyle = useAnimatedStyle(() => {
    const insetProgress = reducedMotion ? targetProgress.value : progress.value;

    return {
      paddingBottom: interpolate(
        insetProgress,
        [0, 1],
        [closedBottomPadding, sizing.footer.minimumBottomPadding],
        Extrapolation.CLAMP,
      ),
      transform: [{ translateY: height.value }],
    };
  }, [closedBottomPadding, height, progress, reducedMotion, targetProgress]);

  return (
    <Animated.View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.background,
          borderTopColor: theme.colors.border,
        },
        animatedStyle,
      ]}
      testID="footer-actions"
    >
      {Children.map(children, (action) => (
        <View style={styles.action}>{action}</View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  action: {
    flexBasis: 0,
    flexGrow: 1,
    minHeight: sizing.footer.actionHeight,
  },
  container: {
    alignItems: "stretch",
    borderTopWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: sizing.footer.actionGap,
    paddingHorizontal: sizing.footer.horizontalPadding,
    paddingTop: sizing.footer.topPadding,
    width: "100%",
  },
});
