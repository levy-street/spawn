import { Children, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { SharedValue } from "react-native-reanimated";
import Animated, { Extrapolation, interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOverlaySurface } from "@/components/ui/overlay-surface";
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
  /**
   * Omit inside a container that already owns the bottom inset and is not
   * keyboard-aware — a bottom sheet, say. The footer then simply sits at the
   * foot of its parent instead of tracking the keyboard itself.
   */
  keyboardAnimation?: FooterKeyboardAnimation;
  /**
   * Height of persistent chrome drawn *over* this footer's container — the
   * window-level nav bar above a full-page dialog. Held open while the keyboard
   * is down; a raised keyboard covers that chrome, so the reservation goes with it.
   */
  reservedBottomChrome?: number;
}

export function FooterActions({
  children,
  keyboardAnimation,
  reservedBottomChrome = 0,
}: FooterActionsProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  // The foot takes the colour of whatever it is pinned to. Painting the page
  // colour under a drawer's panel is what put a black band under a grey sheet.
  const surface = useOverlaySurface();
  const tracksKeyboard = keyboardAnimation !== undefined;
  // Reserved chrome already covers the device inset it stands on, so it replaces
  // that inset rather than stacking on top of it.
  const closedBottomPadding =
    reservedBottomChrome > 0
      ? reservedBottomChrome + sizing.footer.minimumBottomPadding
      : tracksKeyboard
        ? Math.max(sizing.footer.minimumBottomPadding, insets.bottom)
        : sizing.footer.minimumBottomPadding;
  const height = keyboardAnimation?.height;
  const progress = keyboardAnimation?.progress;
  const targetProgress = keyboardAnimation?.targetProgress;

  const animatedStyle = useAnimatedStyle(() => {
    if (progress === undefined || targetProgress === undefined || height === undefined) {
      return { paddingBottom: closedBottomPadding, transform: [{ translateY: 0 }] };
    }
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
        surface === "popover"
          ? {
              backgroundColor: theme.colors.popover,
              borderTopColor: theme.colors.popoverBorder,
            }
          : {
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
