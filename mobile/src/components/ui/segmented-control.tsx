import { useEffect, useState } from "react";
import {
  type LayoutChangeEvent,
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { useTheme } from "@/theme";
import { opacity, shadow } from "@/theme/effects";
import { borderWidth, chrome, radii, spacing } from "@/theme/spacing";
import { typeStyles } from "@/theme/typography";

export interface SegmentedControlOption<Value extends string = string> {
  value: Value;
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<Value extends string = string> {
  value: Value;
  options: readonly SegmentedControlOption<Value>[];
  onChange: (value: Value) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SegmentedControl<Value extends string>({
  value,
  options,
  onChange,
  disabled = false,
  accessibilityLabel,
  style,
  testID,
}: SegmentedControlProps<Value>) {
  const theme = useTheme();
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const animatedIndex = useSharedValue(selectedIndex);
  const [trackWidth, setTrackWidth] = useState(0);
  const contentWidth = Math.max(0, trackWidth - spacing[1]);
  const segmentWidth = options.length === 0 ? 0 : contentWidth / options.length;

  useEffect(() => {
    animatedIndex.value = withTiming(selectedIndex, {
      duration: theme.motion.duration.base,
      easing: theme.motion.easing.inOut,
      reduceMotion: ReduceMotion.System,
    });
  }, [animatedIndex, selectedIndex, theme.motion.duration.base, theme.motion.easing.inOut]);

  const indicatorStyle = useAnimatedStyle(
    () => ({
      transform: [{ translateX: animatedIndex.value * segmentWidth }],
      width: segmentWidth,
    }),
    [segmentWidth],
  );

  const handleLayout = (event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  };

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="radiogroup"
      onLayout={handleLayout}
      testID={testID}
      style={[
        styles.track,
        {
          backgroundColor: theme.colors.muted,
          borderColor: theme.colors.border,
        },
        disabled && styles.disabled,
        style,
      ]}
    >
      {segmentWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.indicator,
            {
              backgroundColor: theme.colors.card,
              borderColor: theme.colors.border,
            },
            indicatorStyle,
          ]}
        />
      ) : null}
      {options.map((option) => {
        const selected = option.value === value;
        const optionDisabled = disabled || option.disabled === true;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ checked: selected, disabled: optionDisabled }}
            disabled={optionDisabled}
            key={option.value}
            onPress={() => {
              if (selected) return;
              haptics.selection();
              onChange(option.value);
            }}
            style={styles.segment}
          >
            <Text
              color={selected ? "foreground" : "mutedForeground"}
              numberOfLines={1}
              style={styles.label}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    borderRadius: radii.md,
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    height: chrome.touchTarget,
    padding: spacing[0.5],
    position: "relative",
    width: "100%",
  },
  disabled: {
    opacity: opacity.disabled,
  },
  indicator: {
    borderRadius: radii.sm,
    borderWidth: borderWidth.hairline,
    bottom: spacing[0.5],
    boxShadow: shadow.sm,
    left: spacing[0.5],
    position: "absolute",
    top: spacing[0.5],
  },
  segment: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    minHeight: spacing[10],
    paddingHorizontal: spacing[2],
  },
  label: {
    ...typeStyles.uiSmMedium,
    textAlign: "center",
  },
});
