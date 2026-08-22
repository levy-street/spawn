import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type LayoutChangeEvent,
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
import { useReducedMotionPreference } from "@/components/ui/swipe-dismiss-overlay";
import { alpha, borderWidth, chrome, layer, shadow, useTheme } from "@/theme";

function shadowWithAlpha(value: string, channelAlpha: number): string {
  return value.replace(/rgba\((\d+,\d+,\d+),[\d.]+\)/g, `rgba($1,${channelAlpha})`);
}

const OVERLAY_XL_SHADOW = shadowWithAlpha(shadow.xl, alpha.a50);

export type PopoverAlign = "start" | "center" | "end";
export type PopoverSide = "top" | "bottom" | "left" | "right";

export interface PopoverAnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PopoverInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PopoverPositionInput {
  anchor: PopoverAnchorRect;
  popoverWidth: number;
  popoverHeight: number;
  align: PopoverAlign;
  side?: PopoverSide;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  offset?: number;
  insets?: Partial<PopoverInsets>;
}

export interface PopoverPosition {
  left: number;
  top: number;
  maxHeight: number;
  maxWidth: number;
  side: PopoverSide;
  originX: "left" | "center" | "right";
  originY: "top" | "center" | "bottom";
}

export function pointPopoverAnchor(x: number, y: number): PopoverAnchorRect {
  return { top: y, bottom: y, left: x, right: x };
}

function clamp(value: number, min: number, max: number): number {
  "worklet";
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

function resolveMainAxis(
  size: number,
  roomPositive: number,
  roomNegative: number,
  preferPositive: boolean,
): { positive: boolean; room: number } {
  const fitsPreferred = size <= (preferPositive ? roomPositive : roomNegative);
  const fitsOther = size <= (preferPositive ? roomNegative : roomPositive);
  const positive = fitsPreferred
    ? preferPositive
    : fitsOther
      ? !preferPositive
      : roomPositive >= roomNegative;
  return { positive, room: Math.max(0, positive ? roomPositive : roomNegative) };
}

/** Native port of the web menu-position flip, cross-edge shift, clamp, and size-cap contract. */
export function positionPopover({
  anchor,
  popoverWidth,
  popoverHeight,
  align,
  side = "bottom",
  viewportWidth,
  viewportHeight,
  margin = chrome.menuViewportMargin,
  offset = chrome.menuAnchorOffset,
  insets = {},
}: PopoverPositionInput): PopoverPosition {
  const bounds = {
    top: (insets.top ?? 0) + margin,
    right: viewportWidth - (insets.right ?? 0) - margin,
    bottom: viewportHeight - (insets.bottom ?? 0) - margin,
    left: (insets.left ?? 0) + margin,
  };

  if (side === "left" || side === "right") {
    const roomRight = bounds.right - (anchor.right + offset);
    const roomLeft = anchor.left - offset - bounds.left;
    const { positive: toRight, room: maxWidth } = resolveMainAxis(
      popoverWidth,
      roomRight,
      roomLeft,
      side === "right",
    );
    const width = Math.min(popoverWidth, maxWidth);
    const left = toRight ? anchor.right + offset : anchor.left - offset - width;
    const maxHeight = Math.max(0, bounds.bottom - bounds.top);
    const height = Math.min(popoverHeight, maxHeight);
    const desiredTop =
      align === "end"
        ? anchor.bottom - height
        : align === "center"
          ? (anchor.top + anchor.bottom - height) / 2
          : anchor.top;

    return {
      left: clamp(left, bounds.left, bounds.right - width),
      top: clamp(desiredTop, bounds.top, bounds.bottom - height),
      maxHeight,
      maxWidth,
      side: toRight ? "right" : "left",
      originX: toRight ? "left" : "right",
      originY: align === "start" ? "top" : align === "end" ? "bottom" : "center",
    };
  }

  const roomBelow = bounds.bottom - (anchor.bottom + offset);
  const roomAbove = anchor.top - offset - bounds.top;
  const { positive: below, room: maxHeight } = resolveMainAxis(
    popoverHeight,
    roomBelow,
    roomAbove,
    side !== "top",
  );
  const height = Math.min(popoverHeight, maxHeight);
  const top = below ? anchor.bottom + offset : anchor.top - offset - height;
  const maxWidth = Math.max(0, bounds.right - bounds.left);
  const width = Math.min(popoverWidth, maxWidth);
  const fromStart = align !== "end";
  const preferred =
    align === "center"
      ? (anchor.left + anchor.right - width) / 2
      : fromStart
        ? anchor.left
        : anchor.right - width;
  const flipped = fromStart ? anchor.right - width : anchor.left;
  const fits = (value: number) => value >= bounds.left && value + width <= bounds.right;
  const usePreferred = align === "center" || fits(preferred) || !fits(flipped);
  const desiredLeft = usePreferred ? preferred : flipped;

  return {
    left: clamp(desiredLeft, bounds.left, bounds.right - width),
    top: clamp(top, bounds.top, bounds.bottom - height),
    maxHeight,
    maxWidth,
    side: below ? "bottom" : "top",
    originX: align === "center" ? "center" : usePreferred === fromStart ? "left" : "right",
    originY: below ? "top" : "bottom",
  };
}

export interface PopoverProps {
  visible: boolean;
  onDismiss: () => void;
  anchorRef?: RefObject<View | null>;
  anchorRect?: PopoverAnchorRect;
  side?: PopoverSide;
  align?: PopoverAlign;
  interactive?: boolean;
  width?: number;
  maxWidth?: number;
  fallbackWidth?: number;
  accessibilityLabel?: string;
  contentStyle?: StyleProp<ViewStyle>;
  overlayLayer?: number;
  margin?: number;
  offset?: number;
  animateScale?: boolean;
  children: ReactNode;
}

export function Popover({
  visible,
  onDismiss,
  anchorRef,
  anchorRect,
  side = "right",
  align = "start",
  interactive = false,
  width,
  maxWidth,
  fallbackWidth,
  accessibilityLabel,
  contentStyle,
  overlayLayer = layer.previewPopover,
  margin,
  offset,
  animateScale = true,
  children,
}: PopoverProps): React.JSX.Element | null {
  const theme = useTheme();
  const reducedMotion = useReducedMotionPreference();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
  const [measuredAnchor, setMeasuredAnchor] = useState<PopoverAnchorRect | null>(
    anchorRect ?? null,
  );
  const [contentSize, setContentSize] = useState({
    width: width ?? fallbackWidth ?? theme.space(136),
    height: 0,
  });
  const progress = useSharedValue(0);

  const measureAnchor = useCallback(() => {
    if (anchorRect) {
      setMeasuredAnchor(anchorRect);
      return;
    }
    anchorRef?.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => {
      setMeasuredAnchor({
        top: y,
        bottom: y + measuredHeight,
        left: x,
        right: x + measuredWidth,
      });
    });
  }, [anchorRect, anchorRef]);

  useEffect(() => {
    if (!visible || viewport.width <= 0 || viewport.height <= 0) return;
    measureAnchor();
  }, [measureAnchor, viewport.height, viewport.width, visible]);

  useEffect(() => {
    if (!visible) return;
    progress.value = 0;
    progress.value = withTiming(1, {
      duration: reducedMotion ? theme.motion.duration.reduced : theme.motion.duration.fast,
      easing: theme.motion.easing.cssEase,
    });
  }, [progress, reducedMotion, theme.motion, visible]);

  const placement = useMemo(
    () =>
      measuredAnchor
        ? positionPopover({
            anchor: measuredAnchor,
            popoverWidth: contentSize.width,
            popoverHeight: contentSize.height,
            align,
            side,
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
            insets,
            ...(margin === undefined ? {} : { margin }),
            ...(offset === undefined ? {} : { offset }),
          })
        : null,
    [
      align,
      contentSize,
      insets,
      margin,
      measuredAnchor,
      offset,
      side,
      viewport.height,
      viewport.width,
    ],
  );

  const animatedStyle = useAnimatedStyle(() => {
    const scale =
      reducedMotion || !animateScale
        ? 1
        : theme.motion.transform.enterScale +
          (1 - theme.motion.transform.enterScale) * progress.value;
    const measuredWidth = contentSize.width;
    const measuredHeight = contentSize.height;
    const originX =
      placement?.originX === "right"
        ? measuredWidth
        : placement?.originX === "center"
          ? measuredWidth / 2
          : 0;
    const originY =
      placement?.originY === "bottom"
        ? measuredHeight
        : placement?.originY === "center"
          ? measuredHeight / 2
          : 0;
    return {
      opacity: progress.value,
      transform:
        reducedMotion || !animateScale
          ? []
          : [
              { translateX: originX - measuredWidth / 2 },
              { translateY: originY - measuredHeight / 2 },
              { scale },
              { translateX: -(originX - measuredWidth / 2) },
              { translateY: -(originY - measuredHeight / 2) },
            ],
    };
  });

  const handleLayout = (event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout;
    if (next.width !== contentSize.width || next.height !== contentSize.height) {
      setContentSize({ width: next.width, height: next.height });
    }
  };

  if (!visible || !measuredAnchor || !placement) return null;

  return (
    <Modal
      animationType="none"
      onRequestClose={onDismiss}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <View style={[styles.root, { zIndex: overlayLayer }]}>
        <Pressable
          accessibilityLabel="Dismiss popover"
          accessibilityRole="button"
          onPress={onDismiss}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          accessibilityLabel={accessibilityLabel}
          accessibilityRole={interactive ? "menu" : "text"}
          onLayout={handleLayout}
          pointerEvents={interactive ? "auto" : "none"}
          style={[
            styles.surface,
            {
              backgroundColor: theme.colors.popover,
              borderColor: theme.colors.popoverBorder,
              borderRadius: theme.radii.lg,
              boxShadow: OVERLAY_XL_SHADOW,
              left: placement.left,
              maxHeight: placement.maxHeight,
              maxWidth: Math.min(maxWidth ?? placement.maxWidth, placement.maxWidth),
              top: placement.top,
              width,
            },
            contentStyle,
            animatedStyle,
          ]}
          testID="popover-content"
        >
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
  },
  surface: {
    borderWidth: borderWidth.hairline,
    overflow: "hidden",
    position: "absolute",
  },
});
