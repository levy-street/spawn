import type { PropsWithChildren } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, Modal, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { registerNavigationOverlayDismiss } from "@/components/nav/overlay-dismiss";
import { haptics } from "@/lib/haptics";
import { alpha, chrome, pressroomColors, useTheme } from "@/theme";

const DEFAULT_DISMISS_RATIO = 0.22;
const VELOCITY_PROJECTION_SECONDS = 0.2;
const BACKGROUND_SCALE_DELTA = 0.015;
const DOWNWARD_RUBBER_BAND_RATIO = 0.55;
const UPWARD_RUBBER_BAND_RATIO = 0.12;
const SPRING_CONFIG = { damping: 26, stiffness: 280 } as const;

export type DragHandleRegion = "full" | "header";

export interface DismissalDecisionInput {
  translationY: number;
  velocityY: number;
  threshold: number;
  projectionSeconds?: number;
}

/** Projects the finger's endpoint so a deliberate flick can commit before distance alone would. */
export function projectedDismissalEndpoint({
  translationY,
  velocityY,
  projectionSeconds = VELOCITY_PROJECTION_SECONDS,
}: Omit<DismissalDecisionInput, "threshold">): number {
  "worklet";
  return Math.max(0, translationY + velocityY * projectionSeconds);
}

export function shouldDismissOverlay(input: DismissalDecisionInput): boolean {
  "worklet";
  if (input.threshold <= 0) return true;
  return projectedDismissalEndpoint(input) >= input.threshold;
}

/** Resists movement on both sides of the top bound without introducing a hard clamp. */
export function rubberBandTranslation(translationY: number, height: number): number {
  "worklet";
  if (height <= 0 || translationY === 0) return 0;
  const ratio = translationY < 0 ? UPWARD_RUBBER_BAND_RATIO : DOWNWARD_RUBBER_BAND_RATIO;
  const band = height * ratio;
  return translationY / (1 + Math.abs(translationY) / band);
}

export function useReducedMotionPreference(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReducedMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reducedMotion;
}

export interface SwipeDismissOverlayProps extends PropsWithChildren {
  visible: boolean;
  onDismiss: () => void;
  dragHandleRegion?: DragHandleRegion;
  dismissThreshold?: number;
  backdropOpacity?: number;
}

export function SwipeDismissOverlay({
  visible,
  onDismiss,
  dragHandleRegion = "full",
  dismissThreshold,
  backdropOpacity = alpha.a50,
  children,
}: SwipeDismissOverlayProps): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reducedMotion = useReducedMotionPreference();
  const translateY = useSharedValue(height);
  const entrance = useSharedValue(0);
  const gestureOffset = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startEligible = useSharedValue(false);
  const thresholdHapticFired = useSharedValue(false);
  const threshold = dismissThreshold ?? height * DEFAULT_DISMISS_RATIO;
  const activationDistance = theme.motion.gesture.drawerAxisLock;
  const horizontalFailureDistance = theme.space(6);

  useEffect(() => {
    if (!visible) return;
    const timing = reducedMotion
      ? { duration: theme.motion.duration.reduced }
      : theme.motion.transition.shellGeometry;
    translateY.value = reducedMotion ? 0 : height;
    entrance.value = 0;
    translateY.value = withTiming(0, timing);
    entrance.value = withTiming(1, timing);
    haptics.overlayOpen();
  }, [entrance, height, reducedMotion, theme.motion, translateY, visible]);

  const dismissWithAnimation = useCallback(() => {
    "worklet";
    const timing = reducedMotion
      ? { duration: theme.motion.duration.reduced }
      : theme.motion.transition.shellGeometry;
    entrance.value = withTiming(0, timing);
    translateY.value = withTiming(reducedMotion ? 0 : height, timing, (finished) => {
      if (finished) scheduleOnRN(onDismiss);
    });
  }, [entrance, height, onDismiss, reducedMotion, theme.motion, translateY]);

  useEffect(() => {
    if (!visible) return;
    // Primary navigation is already replacing the active scene, so waiting for the exit
    // animation would leave a modal window intercepting the destination tab.
    return registerNavigationOverlayDismiss(onDismiss);
  }, [onDismiss, visible]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .onTouchesDown((event) => {
          const touch = event.allTouches[0];
          if (!touch) return;
          cancelAnimation(translateY);
          cancelAnimation(entrance);
          startX.value = touch.absoluteX;
          startY.value = touch.absoluteY;
          startEligible.value =
            dragHandleRegion === "full" || touch.absoluteY <= insets.top + chrome.touchTarget;
          thresholdHapticFired.value = false;
        })
        .onTouchesMove((event, manager) => {
          const touch = event.allTouches[0];
          if (!touch || !startEligible.value) {
            manager.fail();
            return;
          }
          const dx = touch.absoluteX - startX.value;
          const dy = touch.absoluteY - startY.value;
          if (Math.abs(dx) > horizontalFailureDistance || dy < -activationDistance) {
            manager.fail();
          } else if (dy > activationDistance && Math.abs(dy) > Math.abs(dx)) {
            manager.activate();
          }
        })
        .onStart(() => {
          gestureOffset.value = translateY.value;
          entrance.value = 1;
        })
        .onUpdate((event) => {
          const rawTranslation = gestureOffset.value + event.translationY;
          translateY.value = rubberBandTranslation(rawTranslation, height);
          const committed = shouldDismissOverlay({
            translationY: rawTranslation,
            velocityY: event.velocityY,
            threshold,
          });
          if (committed && !thresholdHapticFired.value) {
            thresholdHapticFired.value = true;
            scheduleOnRN(haptics.overlayDismiss);
          }
        })
        .onEnd((event) => {
          const rawTranslation = gestureOffset.value + event.translationY;
          if (
            shouldDismissOverlay({
              translationY: rawTranslation,
              velocityY: event.velocityY,
              threshold,
            })
          ) {
            dismissWithAnimation();
            return;
          }
          translateY.value = withSpring(0, SPRING_CONFIG);
          entrance.value = withTiming(1, theme.motion.transition.shellGeometry);
        }),
    [
      activationDistance,
      dismissWithAnimation,
      dragHandleRegion,
      entrance,
      gestureOffset,
      height,
      horizontalFailureDistance,
      insets.top,
      startEligible,
      startX,
      startY,
      theme.motion,
      threshold,
      thresholdHapticFired,
      translateY,
    ],
  );

  const backdropStyle = useAnimatedStyle(() => {
    const dragProgress = 1 - Math.min(1, Math.max(0, translateY.value / Math.max(1, height)));
    return { opacity: entrance.value * dragProgress * backdropOpacity };
  });

  const panelStyle = useAnimatedStyle(() => {
    const dragProgress = Math.min(1, Math.max(0, translateY.value / Math.max(1, height)));
    return {
      opacity: entrance.value,
      transform: reducedMotion
        ? []
        : [
            { translateY: translateY.value },
            { scale: interpolate(dragProgress, [0, 1], [1, 1 - BACKGROUND_SCALE_DELTA]) },
          ],
    };
  });

  if (!visible) return null;

  return (
    <Modal
      animationType="none"
      onRequestClose={onDismiss}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <View style={styles.root} testID="swipe-dismiss-overlay">
        <Animated.View pointerEvents="none" style={[styles.backdrop, backdropStyle]} />
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              styles.panel,
              {
                backgroundColor: theme.colors.background,
                borderRadius: theme.radii.xxl,
              },
              panelStyle,
            ]}
            testID="swipe-dismiss-overlay-panel"
          >
            {children}
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: pressroomColors.void,
  },
  panel: {
    flex: 1,
    overflow: "hidden",
  },
  root: {
    flex: 1,
  },
});
