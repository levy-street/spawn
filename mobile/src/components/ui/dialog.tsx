import { BlurView } from "expo-blur";
import type { ReactNode } from "react";
import { useEffect } from "react";
import {
  Modal,
  Pressable,
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "@/components/ui/icon";
import { useReducedMotionPreference } from "@/components/ui/swipe-dismiss-overlay";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { alpha, blurRadius, borderWidth, layer, pressroomColors, shadow, useTheme } from "@/theme";

export type DialogSize = "sm" | "md" | "lg" | "full-mobile" | "viewer";

export interface DialogProps {
  visible: boolean;
  onDismiss: () => void;
  title?: string;
  description?: ReactNode;
  size?: DialogSize;
  showCloseButton?: boolean;
  closeAccessibilityLabel?: string;
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
  testID?: string;
}

const WIDTH_UNITS: Record<Exclude<DialogSize, "full-mobile" | "viewer">, number> = {
  sm: 96,
  md: 128,
  lg: 168,
};

export function Dialog({
  visible,
  onDismiss,
  title,
  description,
  size = "md",
  showCloseButton = true,
  closeAccessibilityLabel = "Close dialog",
  footer,
  contentStyle,
  children,
  testID,
}: DialogProps): React.JSX.Element | null {
  const theme = useTheme();
  const reducedMotion = useReducedMotionPreference();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const progress = useSharedValue(0);
  const fullScreen = size === "full-mobile" || size === "viewer";

  useEffect(() => {
    if (!visible) return;
    progress.value = 0;
    progress.value = withTiming(1, {
      duration: reducedMotion ? theme.motion.duration.reduced : theme.motion.duration.base,
      easing: theme.motion.easing.cssEase,
    });
    haptics.overlayOpen();
  }, [progress, reducedMotion, theme.motion, visible]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: reducedMotion
      ? []
      : [
          {
            scale:
              theme.motion.transform.enterScale +
              (1 - theme.motion.transform.enterScale) * progress.value,
          },
        ],
  }));

  if (!visible) return null;

  const centeredWidth = fullScreen ? viewport.width : theme.space(WIDTH_UNITS[size]);
  const horizontalGutter = fullScreen ? 0 : theme.space(4);

  return (
    <Modal
      animationType="none"
      onRequestClose={onDismiss}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <View style={[styles.root, { zIndex: layer.modal }]}>
        <BlurView
          intensity={blurRadius.modal}
          style={StyleSheet.absoluteFill}
          tint={theme.isDark ? "dark" : "light"}
        />
        <Pressable
          accessibilityLabel="Dismiss dialog"
          accessibilityRole="button"
          onPress={onDismiss}
          style={[styles.scrim, { backgroundColor: pressroomColors.void, opacity: alpha.a60 }]}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.content,
            {
              backgroundColor: theme.colors.background,
              borderColor: theme.colors.border,
              borderRadius: fullScreen ? 0 : theme.radii.xl,
              borderWidth: fullScreen ? 0 : borderWidth.hairline,
              boxShadow: fullScreen
                ? undefined
                : theme.isDark
                  ? shadow.dialogDark
                  : shadow.dialogLight,
              height: fullScreen ? viewport.height : undefined,
              maxHeight: fullScreen
                ? viewport.height
                : viewport.height - insets.top - insets.bottom - theme.space(8),
              maxWidth: viewport.width - horizontalGutter * 2,
              paddingBottom: fullScreen ? insets.bottom : 0,
              paddingTop: fullScreen ? insets.top : 0,
              width: centeredWidth,
            },
            contentStyle,
            animatedStyle,
          ]}
          testID={testID ?? "dialog-content"}
        >
          {title || description ? (
            <View
              style={[
                styles.header,
                {
                  gap: theme.space(1),
                  paddingBottom: theme.space(2),
                  paddingHorizontal: theme.space(4),
                  paddingRight: showCloseButton ? theme.space(12) : theme.space(4),
                  paddingTop: theme.space(4),
                },
              ]}
            >
              {title ? (
                <Text accessibilityRole="header" variant="label" weight="semibold">
                  {title}
                </Text>
              ) : null}
              {description ? (
                typeof description === "string" ? (
                  <Text color="mutedForeground" variant="body">
                    {description}
                  </Text>
                ) : (
                  description
                )
              ) : null}
            </View>
          ) : null}
          {children}
          {footer ? (
            <View
              style={[
                styles.footer,
                {
                  gap: theme.space(2),
                  padding: theme.space(4),
                  paddingTop: theme.space(2),
                },
              ]}
            >
              {footer}
            </View>
          ) : null}
          {showCloseButton ? (
            <Pressable
              accessibilityLabel={closeAccessibilityLabel}
              accessibilityRole="button"
              hitSlop={theme.space(2)}
              onPress={onDismiss}
              style={({ pressed }) => [
                styles.close,
                {
                  backgroundColor: pressed ? theme.colors.accent : "transparent",
                  borderRadius: theme.radii.md,
                  padding: theme.space(1.5),
                  right: theme.space(3),
                  top: (fullScreen ? insets.top : 0) + theme.space(3),
                },
              ]}
            >
              <Icon color="mutedForeground" name="X" size={theme.space(4)} />
            </Pressable>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  close: {
    alignItems: "center",
    justifyContent: "center",
    position: "absolute",
  },
  content: {
    overflow: "hidden",
  },
  footer: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  header: {
    flexDirection: "column",
  },
  root: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
  },
});
