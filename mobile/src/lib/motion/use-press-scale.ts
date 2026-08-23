import { useCallback, useEffect } from "react";
import { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { motion } from "@/theme";

import { durations } from "./durations";
import { easings } from "./easings";
import { motionSafe, useReducedMotion } from "./reduced-motion";

export interface UsePressScaleOptions {
  disabled?: boolean;
  pressedScale?: number;
}

export function usePressScale(options: UsePressScaleOptions = {}) {
  const { disabled = false, pressedScale = motion.transform.launcherPressScale } = options;
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);

  const animateTo = useCallback(
    (nextScale: number) => {
      const safeScale = motionSafe(nextScale, 1, reducedMotion);
      scale.value = reducedMotion
        ? safeScale
        : withTiming(safeScale, {
            duration: durations.press,
            easing: easings.standard,
          });
    },
    [reducedMotion, scale],
  );

  useEffect(() => {
    if (disabled) {
      animateTo(1);
    }
  }, [animateTo, disabled]);

  const onPressIn = useCallback(() => {
    if (!disabled) {
      animateTo(pressedScale);
    }
  }, [animateTo, disabled, pressedScale]);

  const onPressOut = useCallback(() => {
    animateTo(1);
  }, [animateTo]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return { animatedStyle, onPressIn, onPressOut };
}
