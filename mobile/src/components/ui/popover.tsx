import type { ReactNode, RefObject } from "react";
import { type StyleProp, StyleSheet, View, type ViewStyle } from "react-native";

import { Sheet } from "@/components/ui/sheet";
import { chrome } from "@/theme";

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
  interactive = false,
  accessibilityLabel,
  contentStyle,
  children,
}: PopoverProps): React.JSX.Element {
  // Anchor geometry stays in the public contract for existing callers, but every
  // popover now deliberately shares the app's bottom-drawer presentation.
  return (
    <Sheet onDismiss={onDismiss} testID="popover-content" visible={visible}>
      <View
        accessibilityLabel={accessibilityLabel}
        accessibilityRole={interactive ? "menu" : "text"}
        style={[styles.content, contentStyle]}
      >
        {children}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  content: {
    width: "100%",
  },
});
