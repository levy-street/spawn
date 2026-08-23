import type { PropsWithChildren } from "react";
import { useCallback, useMemo } from "react";
import { StyleSheet, useWindowDimensions } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { restingOffset, shouldCommitDrag } from "@/components/gestures/drag-threshold";
import {
  advanceDismissHaptic,
  horizontalDismissIntent,
  rubberBandHorizontalDismiss,
} from "@/components/terminal-ui/horizontal-dismiss";
import { haptics } from "@/lib/haptics";
import { useReducedMotion } from "@/lib/motion/reduced-motion";
import { useTheme } from "@/theme";

const DISMISS_THRESHOLD_RATIO = 0.22;
const SPRING_CONFIG = { damping: 26, stiffness: 280 } as const;

export interface FullSurfaceDismissProps extends PropsWithChildren {
  onDismiss: () => void;
}

export function FullSurfaceDismiss({
  children,
  onDismiss,
}: FullSurfaceDismissProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const { width } = useWindowDimensions();
  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const thresholdHapticFired = useSharedValue(false);
  const activationDistance = theme.motion.gesture.drawerAxisLock;
  const crossAxisFailureDistance = theme.space(6);
  const projectionMs = theme.motion.duration.medium;

  const dismissImmediately = useCallback(() => {
    onDismiss();
  }, [onDismiss]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .maxPointers(1)
        .cancelsTouchesInView(false)
        .shouldCancelWhenOutside(false)
        .onTouchesDown((event) => {
          const touch = event.allTouches[0];
          if (!touch) return;
          cancelAnimation(translateX);
          translateX.value = 0;
          startX.value = touch.absoluteX;
          startY.value = touch.absoluteY;
          thresholdHapticFired.value = false;
        })
        .onTouchesMove((event, manager) => {
          const touch = event.allTouches[0];
          if (!touch) return;
          const intent = horizontalDismissIntent({
            deltaX: touch.absoluteX - startX.value,
            deltaY: touch.absoluteY - startY.value,
            activationDistance,
            crossAxisFailureDistance,
          });
          if (intent === "fail") manager.fail();
          else if (intent === "activate") manager.activate();
        })
        .onUpdate((event) => {
          const translation = Math.max(0, event.translationX);
          translateX.value = rubberBandHorizontalDismiss(translation, width);
          const gate = advanceDismissHaptic(
            shouldCommitDrag({
              translation,
              velocity: event.velocityX,
              size: width,
              threshold: DISMISS_THRESHOLD_RATIO,
              projectionMs,
            }),
            thresholdHapticFired.value,
          );
          thresholdHapticFired.value = gate.fired;
          if (gate.shouldFire) scheduleOnRN(haptics.overlayDismiss);
        })
        .onEnd((event) => {
          const input = {
            translation: Math.max(0, event.translationX),
            velocity: event.velocityX,
            size: width,
            threshold: DISMISS_THRESHOLD_RATIO,
            projectionMs,
          };
          const committed = input.translation > 0 && shouldCommitDrag(input);
          if (committed && reducedMotion) {
            translateX.value = 0;
            scheduleOnRN(dismissImmediately);
            return;
          }
          translateX.value = withSpring(
            restingOffset(input, committed),
            SPRING_CONFIG,
            (finished) => {
              if (finished && committed) scheduleOnRN(dismissImmediately);
            },
          );
        })
        .onFinalize((_event, success) => {
          if (!success && translateX.value !== 0) {
            translateX.value = withSpring(0, SPRING_CONFIG);
          }
        }),
    [
      activationDistance,
      crossAxisFailureDistance,
      dismissImmediately,
      projectionMs,
      reducedMotion,
      startX,
      startY,
      thresholdHapticFired,
      translateX,
      width,
    ],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.root, animatedStyle]} testID="terminal-full-surface-dismiss">
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
