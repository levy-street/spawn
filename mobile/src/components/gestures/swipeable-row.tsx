import { forwardRef, type ReactNode, useCallback, useImperativeHandle, useMemo } from "react";
import {
  type LayoutChangeEvent,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { haptics } from "@/lib/haptics";
import { durations } from "@/lib/motion/durations";
import { easings } from "@/lib/motion/easings";
import { useReducedMotion } from "@/lib/motion/reduced-motion";
import { chrome, opacity, useTheme } from "@/theme";

import { restingOffset, shouldCommitDrag } from "./drag-threshold";

const RUBBER_BAND_RESISTANCE = 0.2;
const REVEAL_THRESHOLD = 0.5;

export type SwipeActionTone = "default" | "destructive";

export interface SwipeAction {
  key: string;
  label: string;
  icon: ReactNode | ((color: string) => ReactNode);
  tone?: SwipeActionTone;
  accessibilityLabel?: string;
  onPress: () => void;
}

export interface SwipeableRowHandle {
  close(): void;
}

export interface SwipeableRowProps {
  children: ReactNode;
  leadingActions?: readonly SwipeAction[];
  trailingActions?: readonly SwipeAction[];
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

type SwipeDirection = "leading" | "trailing";

function fireRevealHaptic(): void {
  haptics.impact("light");
}

function fireCommitHaptic(): void {
  haptics.warning();
}

function rubberBand(value: number, minimum: number, maximum: number): number {
  "worklet";
  if (value > maximum) {
    return maximum + (value - maximum) * RUBBER_BAND_RESISTANCE;
  }
  if (value < minimum) {
    return minimum + (value - minimum) * RUBBER_BAND_RESISTANCE;
  }
  return value;
}

function renderActionIcon(action: SwipeAction, color: string): ReactNode {
  return typeof action.icon === "function" ? action.icon(color) : action.icon;
}

export const SwipeableRow = forwardRef<SwipeableRowHandle, SwipeableRowProps>(function SwipeableRow(
  {
    children,
    leadingActions = [],
    trailingActions = [],
    style,
    contentStyle,
    testID = "swipeable-row",
  },
  ref,
) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const actionWidth = theme.space(20);
  const leadingWidth = leadingActions.length * actionWidth;
  const trailingWidth = trailingActions.length * actionWidth;
  const translateX = useSharedValue(0);
  const gestureStartX = useSharedValue(0);
  const rowWidth = useSharedValue(0);
  const revealHapticFired = useSharedValue(false);
  const commitHapticFired = useSharedValue(false);
  const leadingCanCommit = leadingActions.some((action) => action.tone === "destructive");
  const trailingCanCommit = trailingActions.some((action) => action.tone === "destructive");

  const animateClosed = useCallback(() => {
    if (reducedMotion) {
      translateX.value = 0;
      return;
    }
    translateX.value = withTiming(0, {
      duration: durations.press,
      easing: easings.settle,
    });
  }, [reducedMotion, translateX]);

  useImperativeHandle(ref, () => ({ close: animateClosed }), [animateClosed]);

  const commitPrimaryAction = useCallback(
    (direction: SwipeDirection) => {
      const actions = direction === "leading" ? leadingActions : trailingActions;
      actions.find((action) => action.tone === "destructive")?.onPress();
    },
    [leadingActions, trailingActions],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-theme.space(3), theme.space(3)])
        .failOffsetY([-theme.space(2), theme.space(2)])
        .onStart(() => {
          gestureStartX.value = translateX.value;
          revealHapticFired.value = false;
          commitHapticFired.value = false;
        })
        .onUpdate((event) => {
          const proposed = gestureStartX.value + event.translationX;
          const projectedOffset = restingOffset(
            { translation: proposed, velocity: event.velocityX, size: 1 },
            true,
          );
          const direction: SwipeDirection = projectedOffset >= 0 ? "leading" : "trailing";
          const availableWidth = direction === "leading" ? leadingWidth : trailingWidth;
          const canCommit = direction === "leading" ? leadingCanCommit : trailingCanCommit;
          translateX.value = rubberBand(proposed, -trailingWidth, leadingWidth);

          const revealCrossed =
            availableWidth > 0 && Math.abs(proposed) >= availableWidth * REVEAL_THRESHOLD;
          if (revealCrossed && !revealHapticFired.value) {
            revealHapticFired.value = true;
            scheduleOnRN(fireRevealHaptic);
          }

          const commitCrossed =
            canCommit &&
            shouldCommitDrag({
              translation: proposed,
              velocity: event.velocityX,
              size: rowWidth.value,
            });
          if (commitCrossed && !commitHapticFired.value) {
            commitHapticFired.value = true;
            scheduleOnRN(fireCommitHaptic);
          } else if (!commitCrossed) {
            commitHapticFired.value = false;
          }
        })
        .onEnd((event) => {
          const translation = gestureStartX.value + event.translationX;
          const projectedOffset = restingOffset(
            { translation, velocity: event.velocityX, size: 1 },
            true,
          );
          const direction: SwipeDirection = projectedOffset >= 0 ? "leading" : "trailing";
          const availableWidth = direction === "leading" ? leadingWidth : trailingWidth;
          const canCommit = direction === "leading" ? leadingCanCommit : trailingCanCommit;
          const commitInput = {
            translation,
            velocity: event.velocityX,
            size: rowWidth.value,
          };
          const committed = canCommit && shouldCommitDrag(commitInput);

          if (committed) {
            if (!commitHapticFired.value) {
              scheduleOnRN(fireCommitHaptic);
            }
            scheduleOnRN(commitPrimaryAction, direction);
            if (reducedMotion) {
              translateX.value = 0;
            } else {
              translateX.value = withTiming(
                restingOffset(commitInput, true),
                { duration: durations.press, easing: easings.settle },
                (finished) => {
                  if (finished) {
                    translateX.value = 0;
                  }
                },
              );
            }
            return;
          }

          const revealInput = {
            translation,
            velocity: event.velocityX,
            size: availableWidth,
            threshold: REVEAL_THRESHOLD,
          };
          const shouldReveal = availableWidth > 0 && shouldCommitDrag(revealInput);
          const target = restingOffset(revealInput, shouldReveal);
          translateX.value = reducedMotion
            ? target
            : withTiming(target, { duration: durations.press, easing: easings.settle });
        }),
    [
      commitHapticFired,
      commitPrimaryAction,
      gestureStartX,
      leadingCanCommit,
      leadingWidth,
      reducedMotion,
      revealHapticFired,
      rowWidth,
      theme,
      trailingCanCommit,
      trailingWidth,
      translateX,
    ],
  );

  const animatedContentStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      rowWidth.value = event.nativeEvent.layout.width;
    },
    [rowWidth],
  );

  const handleActionPress = useCallback(
    (action: SwipeAction) => {
      if (action.tone === "destructive") {
        haptics.warning();
      } else {
        haptics.impact("light");
      }
      animateClosed();
      action.onPress();
    },
    [animateClosed],
  );

  const renderActions = (actions: readonly SwipeAction[], direction: SwipeDirection) => (
    <View
      style={[
        styles.actions,
        direction === "leading" ? styles.leadingActions : styles.trailingActions,
        { width: actions.length * actionWidth },
      ]}
      testID={`${testID}-${direction}-actions`}
    >
      {actions.map((action) => {
        const destructive = action.tone === "destructive";
        const backgroundColor = destructive ? theme.colors.destructive : theme.colors.muted;
        const foregroundColor = destructive
          ? theme.colors.destructiveForeground
          : theme.colors.foreground;
        return (
          <Pressable
            key={action.key}
            accessibilityLabel={action.accessibilityLabel ?? action.label}
            accessibilityRole="button"
            onPress={() => handleActionPress(action)}
            style={({ pressed }) => [
              styles.action,
              {
                backgroundColor,
                gap: theme.space(1),
                opacity: pressed ? opacity.hoverButton : opacity.opaque,
                width: actionWidth,
              },
            ]}
            testID={`${testID}-${direction}-action-${action.key}`}
          >
            {renderActionIcon(action, foregroundColor)}
            <Text
              numberOfLines={1}
              style={{
                color: foregroundColor,
                fontFamily: theme.type.fontFamily.sans,
                fontSize: theme.type.fontSize.xs,
                fontWeight: theme.type.fontWeight.medium,
                lineHeight: theme.type.lineHeight.micro,
              }}
            >
              {action.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View onLayout={handleLayout} style={[styles.container, style]} testID={testID}>
      {leadingActions.length > 0 ? renderActions(leadingActions, "leading") : null}
      {trailingActions.length > 0 ? renderActions(trailingActions, "trailing") : null}
      <GestureDetector gesture={pan}>
        <Animated.View
          style={[
            styles.content,
            { backgroundColor: theme.colors.background },
            contentStyle,
            animatedContentStyle,
          ]}
          testID={`${testID}-content`}
        >
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
  },
  content: {
    minHeight: chrome.touchTarget,
    zIndex: 1,
  },
  actions: {
    bottom: 0,
    flexDirection: "row",
    position: "absolute",
    top: 0,
  },
  leadingActions: {
    left: 0,
  },
  trailingActions: {
    right: 0,
  },
  action: {
    alignItems: "center",
    height: "100%",
    justifyContent: "center",
    minHeight: chrome.touchTarget,
  },
});
