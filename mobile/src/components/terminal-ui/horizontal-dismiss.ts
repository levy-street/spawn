export type HorizontalDismissIntent = "pending" | "activate" | "fail";

export interface HorizontalDismissIntentInput {
  deltaX: number;
  deltaY: number;
  activationDistance: number;
  crossAxisFailureDistance: number;
}

/** Locks rightward intent to dismissal while leaving vertical and leftward movement to children. */
export function horizontalDismissIntent({
  deltaX,
  deltaY,
  activationDistance,
  crossAxisFailureDistance,
}: HorizontalDismissIntentInput): HorizontalDismissIntent {
  "worklet";
  if (deltaX < -activationDistance || Math.abs(deltaY) > crossAxisFailureDistance) {
    return "fail";
  }
  if (deltaX > activationDistance && Math.abs(deltaX) > Math.abs(deltaY)) {
    return "activate";
  }
  return "pending";
}

export interface DismissHapticGate {
  fired: boolean;
  shouldFire: boolean;
}

/** Keeps threshold feedback to one acknowledgement for the lifetime of a gesture. */
export function advanceDismissHaptic(committed: boolean, alreadyFired: boolean): DismissHapticGate {
  "worklet";
  return {
    fired: alreadyFired || committed,
    shouldFire: committed && !alreadyFired,
  };
}

export function rubberBandHorizontalDismiss(translation: number, width: number): number {
  "worklet";
  if (translation <= 0 || width <= 0) return 0;
  const band = width * 0.55;
  return translation / (1 + translation / band);
}
