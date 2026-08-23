import { Children, type ReactNode, useEffect, useState } from "react";
import {
  type GestureResponderEvent,
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import Animated, {
  cancelAnimation,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Spinner } from "@/components/ui/spinner";
import { useReducedMotionPreference } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, type Colors, opacity, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive" | "link";
export type ButtonSize = "default" | "sm" | "lg" | "icon";

export interface ButtonProps
  extends Omit<
    PressableProps,
    "accessibilityRole" | "children" | "disabled" | "hitSlop" | "style"
  > {
  children: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  size?: ButtonSize;
  style?: StyleProp<ViewStyle>;
  variant?: ButtonVariant;
}

interface ButtonPalette {
  backgroundColor: string;
  borderColor: string;
  contentColor: keyof Colors;
  pressedBackgroundColor: string;
  pressedOpacity: number;
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function buttonContentColor(variant: ButtonVariant): keyof Colors {
  switch (variant) {
    case "default":
      return "primaryForeground";
    case "secondary":
      return "secondaryForeground";
    case "outline":
    case "ghost":
      return "foreground";
    case "destructive":
      return "destructiveForeground";
    case "link":
      return "primary";
  }
}

function extractAccessibilityLabel(children: ReactNode): string | undefined {
  const parts = Children.toArray(children)
    .filter(
      (child): child is string | number => typeof child === "string" || typeof child === "number",
    )
    .map(String);
  const label = parts.join(" ").trim();
  return label.length === 0 ? undefined : label;
}

function ButtonContent({
  children,
  color,
  linkPressed,
}: {
  children: ReactNode;
  color: keyof Colors;
  linkPressed: boolean;
}) {
  return Children.map(children, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      return (
        <Text color={color} style={linkPressed ? styles.linkPressed : undefined} variant="label">
          {child}
        </Text>
      );
    }
    return child;
  });
}

export function Button({
  accessibilityLabel,
  accessibilityState,
  children,
  disabled = false,
  loading = false,
  onPress,
  onPressIn,
  onPressOut,
  size = "default",
  style,
  testID,
  variant = "default",
  ...props
}: ButtonProps) {
  const theme = useTheme();
  const reduceMotion = useReducedMotionPreference();
  const pressProgress = useSharedValue(0);
  const [linkPressed, setLinkPressed] = useState(false);
  const inactive = disabled || loading;
  const contentColor = buttonContentColor(variant);
  const palette: ButtonPalette = (() => {
    switch (variant) {
      case "default":
        return {
          backgroundColor: theme.colors.primary,
          borderColor: "transparent",
          contentColor,
          pressedBackgroundColor: theme.colors.primary,
          pressedOpacity: opacity.hoverButton,
        };
      case "secondary":
        return {
          backgroundColor: theme.colors.secondary,
          borderColor: "transparent",
          contentColor,
          pressedBackgroundColor: theme.colors.accent,
          pressedOpacity: opacity.opaque,
        };
      case "outline":
        return {
          backgroundColor: "transparent",
          borderColor: theme.colors.border,
          contentColor,
          pressedBackgroundColor: theme.colors.accent,
          pressedOpacity: opacity.opaque,
        };
      case "ghost":
        // Ghost carries the app's icon buttons. A tinted plate appearing under a
        // bare glyph on press reads as a stray box, so the press dims the content
        // instead and the ground stays transparent throughout.
        return {
          backgroundColor: "transparent",
          borderColor: "transparent",
          contentColor,
          pressedBackgroundColor: "transparent",
          pressedOpacity: opacity.pressedContent,
        };
      case "destructive":
        return {
          backgroundColor: theme.colors.destructive,
          borderColor: "transparent",
          contentColor,
          pressedBackgroundColor: theme.colors.destructive,
          pressedOpacity: opacity.hoverButton,
        };
      case "link":
        return {
          backgroundColor: "transparent",
          borderColor: "transparent",
          contentColor,
          pressedBackgroundColor: "transparent",
          pressedOpacity: opacity.opaque,
        };
    }
  })();

  const animatedStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      pressProgress.value,
      [0, 1],
      [palette.backgroundColor, palette.pressedBackgroundColor],
    ),
    opacity: inactive
      ? opacity.disabled
      : interpolate(pressProgress.value, [0, 1], [opacity.opaque, palette.pressedOpacity]),
  }));

  useEffect(
    () => () => {
      cancelAnimation(pressProgress);
    },
    [pressProgress],
  );

  const animatePress = (next: number) => {
    pressProgress.value = withTiming(next, {
      duration: reduceMotion ? theme.motion.duration.instant : theme.motion.duration.base,
      easing: theme.motion.easing.inOut,
    });
  };

  const handlePressIn = (event: GestureResponderEvent) => {
    setLinkPressed(variant === "link");
    animatePress(1);
    onPressIn?.(event);
  };

  const handlePressOut = (event: GestureResponderEvent) => {
    setLinkPressed(false);
    animatePress(0);
    onPressOut?.(event);
  };

  const handlePress = (event: GestureResponderEvent) => {
    if (variant === "destructive") {
      haptics.warning();
    } else {
      haptics.impact("light");
    }
    onPress?.(event);
  };

  const resolvedAccessibilityLabel = accessibilityLabel ?? extractAccessibilityLabel(children);
  const hitSlop = (sizing.control.comfortableTouchTarget - sizing.control.button[size]) / 2;

  return (
    <AnimatedPressable
      {...props}
      accessibilityRole="button"
      accessibilityState={{ ...accessibilityState, busy: loading, disabled: inactive }}
      disabled={inactive}
      hitSlop={hitSlop}
      onPress={handlePress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[
        styles.base,
        styles[size],
        {
          borderColor: palette.borderColor,
          borderRadius: theme.radii.md,
          borderWidth: variant === "outline" ? borderWidth.hairline : borderWidth.none,
        },
        animatedStyle,
        style,
      ]}
      {...(testID === undefined ? {} : { testID })}
      {...(resolvedAccessibilityLabel === undefined
        ? {}
        : { accessibilityLabel: resolvedAccessibilityLabel })}
    >
      <View style={styles.contentFrame}>
        <View style={[styles.content, loading && styles.loadingContent]}>
          <ButtonContent color={palette.contentColor} linkPressed={linkPressed}>
            {children}
          </ButtonContent>
        </View>
        {loading && (
          <View pointerEvents="none" style={styles.loadingOverlay}>
            <Spinner
              color={palette.contentColor}
              size={sizing.control.spinner}
              {...(testID === undefined ? {} : { testID: `${testID}-spinner` })}
            />
          </View>
        )}
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.space.peer,
    justifyContent: "center",
  },
  content: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.space.peer,
    justifyContent: "center",
  },
  contentFrame: {
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  default: {
    minHeight: sizing.control.button.default,
    paddingHorizontal: sizing.space.block,
  },
  icon: {
    height: sizing.control.button.icon,
    paddingHorizontal: 0,
    width: sizing.control.button.icon,
  },
  lg: {
    minHeight: sizing.control.button.lg,
    paddingHorizontal: sizing.space.section,
  },
  linkPressed: {
    textDecorationLine: "underline",
  },
  loadingContent: {
    opacity: opacity.hidden,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  sm: {
    minHeight: sizing.control.button.sm,
    paddingHorizontal: sizing.space.cluster,
  },
});
