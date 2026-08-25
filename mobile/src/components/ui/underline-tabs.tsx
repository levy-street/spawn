import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type LayoutChangeEvent,
  Pressable,
  type StyleProp,
  StyleSheet,
  type TextStyle,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolateColor,
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { haptics } from "@/lib/haptics";
import { useReducedMotion } from "@/lib/motion/reduced-motion";
import { borderWidth, chrome, useTheme } from "@/theme";

export interface UnderlineTabOption<Value extends string = string> {
  value: Value;
  label: string;
  accessibilityLabel?: string;
}

/**
 * A swipe happening somewhere else — across the page the tabs head — that the
 * indicator follows and then finishes. `drift` is the finger's travel in tabs
 * (0.5 is halfway to the next); `velocity` is set at release, in tabs per
 * second, and is what the indicator settles with once the tab has changed.
 */
export interface TabSwipe {
  drift: SharedValue<number>;
  velocity: SharedValue<number>;
}

export function useTabSwipe(): TabSwipe {
  const drift = useSharedValue(0);
  const velocity = useSharedValue(0);
  return useMemo(() => ({ drift, velocity }), [drift, velocity]);
}

export interface UnderlineTabsProps<Value extends string = string> {
  value: Value;
  options: readonly UnderlineTabOption<Value>[];
  onChange: (value: Value) => void;
  /** A swipe across the page the tabs head, for the indicator to follow. */
  swipe?: TabSwipe;
  accessibilityLabel?: string;
  testID?: string;
}

/** Settling onto a tab after a drag or a tap. */
const SETTLE_SPRING = { damping: 24, mass: 0.6, stiffness: 260 } as const;
/** How far ahead of the finger a release is read, so a flick changes tab. */
const PROJECTION_SECONDS = 0.12;
/** Sideways travel before the strip starts following the finger. */
const ACTIVATION = 6;
/** Vertical slack that hands the touch back to whatever scrolls underneath. */
const AXIS_SLOP = 12;

function clamp(value: number, min: number, max: number): number {
  "worklet";
  return Math.min(max, Math.max(min, value));
}

function TabLabel({
  index,
  inkColor,
  label,
  position,
  quietColor,
  style,
  swipe,
}: {
  index: number;
  inkColor: string;
  label: string;
  position: SharedValue<number>;
  quietColor: string;
  style: StyleProp<TextStyle>;
  swipe: TabSwipe | undefined;
}): React.JSX.Element {
  // The ink follows the indicator: a label is red exactly as far as the
  // indicator is under it, so a drag hands the colour across as it goes.
  const animated = useAnimatedStyle(() => ({
    color: interpolateColor(
      clamp(Math.abs(position.value + (swipe?.drift.value ?? 0) - index), 0, 1),
      [0, 1],
      [inkColor, quietColor],
    ),
  }));
  return (
    <Animated.Text numberOfLines={1} style={[style, animated]}>
      {label}
    </Animated.Text>
  );
}

/**
 * A row of tabs with a rule under it and a red line under the one chosen.
 *
 * No plate, no pill: the strip is the full width of whatever it heads, and the
 * only marks on it are the labels, a hairline, and the indicator. The indicator
 * is dragged as much as tapped — it follows the finger across the strip and
 * settles on the nearest tab when let go, a flick carrying it over.
 *
 * A change of tab settles the indicator exactly once, from wherever it is —
 * the finger's travel on the page included — at the speed it was let go with.
 * The change goes through the owner and comes back a render later; springing
 * at release *and* on return is what made the indicator stutter.
 */
export function UnderlineTabs<Value extends string>({
  value,
  options,
  onChange,
  swipe,
  accessibilityLabel,
  testID,
}: UnderlineTabsProps<Value>): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const count = Math.max(1, options.length);
  const tabWidth = width / count;
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  /** Where the indicator is, in tabs: 0 is under the first, 1 under the second. */
  const position = useSharedValue(selectedIndex);
  const dragStart = useSharedValue(0);
  /** The chosen tab, readable from the strip's own gesture. */
  const selected = useSharedValue(selectedIndex);
  /** The speed a drag on the strip let go with, kept for the settle that follows. */
  const releaseVelocity = useSharedValue(0);

  useEffect(() => {
    selected.value = selectedIndex;
    const carried = swipe?.drift.value ?? 0;
    const velocity = (swipe?.velocity.value ?? 0) + releaseVelocity.value;
    if (swipe) {
      swipe.drift.value = 0;
      swipe.velocity.value = 0;
    }
    releaseVelocity.value = 0;
    if (reducedMotion) {
      position.value = selectedIndex;
      return;
    }
    // The drift is folded into the position in the same tick it is zeroed, so
    // the indicator does not move until the settle begins.
    position.value = position.value + carried;
    position.value = withSpring(selectedIndex, { ...SETTLE_SPRING, velocity });
  }, [position, reducedMotion, releaseVelocity, selected, selectedIndex, swipe]);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (option === undefined || option.value === value) return;
      haptics.selection();
      onChange(option.value);
    },
    [onChange, options, value],
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-ACTIVATION, ACTIVATION])
        .failOffsetY([-AXIS_SLOP, AXIS_SLOP])
        .onStart(() => {
          "worklet";
          dragStart.value = position.value;
        })
        .onUpdate((event) => {
          "worklet";
          if (tabWidth <= 0) return;
          position.value = clamp(dragStart.value + event.translationX / tabWidth, 0, count - 1);
        })
        .onEnd((event) => {
          "worklet";
          if (tabWidth <= 0) return;
          const projected = position.value + (event.velocityX * PROJECTION_SECONDS) / tabWidth;
          const target = Math.round(clamp(projected, 0, count - 1));
          const velocity = event.velocityX / tabWidth;
          if (target === selected.value) {
            // Nothing changes hands: settle back here and now.
            position.value = withSpring(target, { ...SETTLE_SPRING, velocity });
            return;
          }
          // The settle is played once the owner has answered, with this speed.
          releaseVelocity.value = velocity;
          runOnJS(commit)(target);
        }),
    [commit, count, dragStart, position, releaseVelocity, selected, tabWidth],
  );

  const indicatorStyle = useAnimatedStyle(
    () => ({
      transform: [
        {
          translateX: clamp(position.value + (swipe?.drift.value ?? 0), 0, count - 1) * tabWidth,
        },
      ],
    }),
    [count, swipe, tabWidth],
  );

  return (
    <GestureDetector gesture={pan}>
      <View
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="tablist"
        onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
        style={styles.root}
        testID={testID}
      >
        <View style={styles.row}>
          {options.map((option, index) => (
            <Pressable
              accessibilityLabel={option.accessibilityLabel ?? option.label}
              accessibilityRole="tab"
              accessibilityState={{ selected: index === selectedIndex }}
              key={option.value}
              onPress={() => commit(index)}
              style={styles.tab}
              {...(testID === undefined ? {} : { testID: `${testID}-${option.value}` })}
            >
              <TabLabel
                index={index}
                inkColor={theme.colors.brandAccent}
                label={option.label}
                position={position}
                quietColor={theme.colors.mutedForeground}
                style={theme.type.typeStyles.sigilLabel}
                swipe={swipe}
              />
            </Pressable>
          ))}
        </View>
        <View style={[styles.rule, { backgroundColor: theme.colors.border }]} />
        {tabWidth > 0 ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.indicator,
              { backgroundColor: theme.colors.brandAccent, width: tabWidth },
              indicatorStyle,
            ]}
            testID={testID === undefined ? undefined : `${testID}-indicator`}
          />
        ) : null}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  // Sits at the strip's start on its own (an absolute child with no horizontal
  // inset lands there) and is carried along by its transform.
  indicator: {
    bottom: 0,
    height: borderWidth.emphasis,
    position: "absolute",
  },
  root: {
    width: "100%",
  },
  row: {
    flexDirection: "row",
  },
  rule: {
    height: borderWidth.hairline,
    width: "100%",
  },
  tab: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: chrome.touchTarget,
  },
});
