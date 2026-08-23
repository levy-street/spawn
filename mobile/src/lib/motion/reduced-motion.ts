import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useReducedMotion(): boolean {
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    let mounted = true;

    AccessibilityInfo.isReduceMotionEnabled().then(
      (enabled) => {
        if (mounted) {
          setReducedMotion(enabled);
        }
      },
      () => undefined,
    );

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

/**
 * Selects a non-spatial fallback. The optional flag keeps the common two-value API while letting
 * hooks pass their live accessibility value without relying on global mutable state.
 */
export function motionSafe<T>(animatedValue: T, fallback: T, reducedMotion = false): T {
  "worklet";
  return reducedMotion ? fallback : animatedValue;
}
