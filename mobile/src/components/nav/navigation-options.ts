/**
 * Common native-card behavior for every retained destination stack.
 *
 * `simple_push` is react-native-screens' shared animator for its edge and full-screen
 * recognizers. Matching the gesture to that animator removes the UIKit/custom split that
 * previously gave the same card two different edge treatments.
 */
export const ROUNDED_CARD_GESTURE_OPTIONS = {
  animation: "simple_push",
  animationMatchesGesture: true,
  fullScreenGestureEnabled: true,
  fullScreenGestureShadowEnabled: true,
  gestureDirection: "horizontal",
  gestureEnabled: true,
  presentation: "card",
} as const;
