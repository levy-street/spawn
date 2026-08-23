import { easing, easingCurve } from "@/theme";

/** Curves remain inspectable so parity tests can catch drift in the theme transcription. */
export const easingCurves = {
  standard: easingCurve.inOut,
  shell: easingCurve.swift,
} as const;

/** Reanimated bezier functions created by the authoritative theme module. */
export const easings = {
  standard: easing.inOut,
  shell: easing.swift,
  settle: easing.out,
} as const;
