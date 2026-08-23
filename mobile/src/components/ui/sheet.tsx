import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  Modal,
  Platform,
  ScrollView,
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { alpha, borderWidth, chrome, opacity, shadow, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/** Travel past which releasing closes the sheet rather than settling it back. */
const CLOSE_DISTANCE = 96;
/**
 * How far ahead of the finger the release is read, in seconds. The decision is
 * made on where the sheet *would* come to rest, not on how far it has travelled:
 * a flick closes it from barely any travel, and a drag that is pulled back up
 * before release settles home however far down it went first.
 */
const CLOSE_PROJECTION_SECONDS = 0.15;
/** Travel past which a touch on the scrim is a drag rather than a tap. */
const TAP_SLOP = 6;
const OPEN_MS = 260;
const CLOSE_MS = 200;
/** Settling back after a drag that did not go far enough to close. */
const SETTLE_SPRING = { damping: 26, mass: 0.7, stiffness: 260 } as const;

/**
 * "content" hugs whatever the sheet holds — the shape every menu and confirm
 * wants. "tall" claims the whole available height instead, for content that
 * scrolls or steps: a hugging panel gives its children no height to flex into,
 * so a scroller inside one collapses to nothing.
 */
export type SheetSize = "content" | "tall";

export interface SheetProps {
  visible: boolean;
  onDismiss: () => void;
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  size?: SheetSize;
  testID?: string;
}

export interface SheetHeaderProps {
  title: string;
  action?: ReactNode;
}

/**
 * Route-backed sheet defaults for Expo Router Stack.Screen options. The system owns the
 * grabber and corner radius; callers can replace the detents for their content shape.
 */
export const NATIVE_FORM_SHEET_OPTIONS = {
  presentation: "formSheet" as const,
  sheetAllowedDetents: [0.48, 0.9],
  sheetGrabberVisible: true,
  sheetInitialDetentIndex: 0,
};

/** A sheet's own scroller. Nothing special is needed: the pan yields to it. */
export const SheetScrollView = ScrollView;

/** Every sheet currently on screen, so navigation can clear them all at once. */
const openSheets = new Set<() => void>();

export function dismissAllSheets(): void {
  for (const close of [...openSheets]) close();
}

export function SheetHeader({ title, action }: SheetHeaderProps): React.JSX.Element {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.header,
        {
          gap: theme.space(2),
          paddingBottom: theme.space(1),
          paddingHorizontal: theme.space(4),
        },
      ]}
    >
      <Text numberOfLines={1} style={styles.headerTitle} variant="label">
        {title}
      </Text>
      {action}
    </View>
  );
}

/**
 * A bottom drawer that tracks the finger from anywhere on its surface.
 *
 * Deliberately hand-rolled rather than wrapping a sheet library. The library used
 * before owned its own pan, bound to the panel and its handle, and offered no way
 * to extend that to the scrim; driving its position from a scrim gesture restarted
 * its animation every frame, which is why dragging stuttered and flashed. Here one
 * shared value *is* the sheet's position, one gesture spans the whole overlay, and
 * the drag writes straight to that value. Nothing competes for it.
 *
 * The panel measures its own content, so a sheet is exactly as tall as what it
 * holds — unless `size="tall"` claims the available height for content that
 * scrolls. Either way it owns the bottom safe-area inset so its last row clears
 * the home indicator.
 */
export function Sheet({
  visible,
  onDismiss,
  children,
  contentStyle,
  size = "content",
  testID,
}: SheetProps): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const availableHeight = windowHeight - insets.top - chrome.sheetTopClearance;
  const isTall = size === "tall";
  const [mounted, setMounted] = useState(visible);
  const [panelHeight, setPanelHeight] = useState(0);
  /** Distance below its resting place, in points: 0 is open, `panelHeight` is gone. */
  const offset = useSharedValue(0);
  const closingRef = useRef(false);

  const finishDismiss = useCallback(() => {
    closingRef.current = false;
    setMounted(false);
    onDismiss();
  }, [onDismiss]);

  const closeWith = useCallback(
    (velocity: number | null) => {
      if (closingRef.current) return;
      closingRef.current = true;
      const travel = Math.max(panelHeight, chrome.touchTarget);
      const settled = (done?: boolean) => {
        "worklet";
        if (done) runOnJS(finishDismiss)();
      };
      offset.value =
        velocity === null
          ? withTiming(travel, { duration: CLOSE_MS, easing: Easing.in(Easing.cubic) }, settled)
          : withSpring(travel, { ...SETTLE_SPRING, overshootClamping: true, velocity }, settled);
    },
    [finishDismiss, offset, panelHeight],
  );

  const animateClosed = useCallback(() => closeWith(null), [closeWith]);
  const animateClosedWithVelocity = useCallback(
    (velocity: number) => closeWith(velocity),
    [closeWith],
  );

  useEffect(() => {
    if (visible) {
      closingRef.current = false;
      setMounted(true);
      return;
    }
    if (mounted) animateClosed();
  }, [animateClosed, mounted, visible]);

  useEffect(() => {
    if (!mounted) return;
    openSheets.add(animateClosed);
    return () => {
      openSheets.delete(animateClosed);
    };
  }, [animateClosed, mounted]);

  // The panel rises only once measured, so it never flashes at the wrong place.
  useEffect(() => {
    if (!mounted || panelHeight === 0) return;
    offset.value = panelHeight;
    offset.value = withTiming(0, { duration: OPEN_MS, easing: Easing.out(Easing.cubic) });
    haptics.overlayOpen();
  }, [mounted, offset, panelHeight]);

  const pan = Gesture.Pan()
    .onUpdate((event) => {
      "worklet";
      // An upward drag is resisted rather than followed: there is nothing above.
      offset.value = event.translationY > 0 ? event.translationY : event.translationY / 4;
    })
    .onEnd((event) => {
      "worklet";
      // Where the sheet would come to rest if the throw carried on, rather than
      // how far it happened to travel: a drag pulled back up before release
      // settles home however far down it went first, and a flick still closes.
      const projected = event.translationY + event.velocityY * CLOSE_PROJECTION_SECONDS;
      if (projected > CLOSE_DISTANCE) {
        // Carry the throw through the close rather than restarting from rest,
        // which is what made a fast flick stutter before it left.
        runOnJS(animateClosedWithVelocity)(event.velocityY);
        return;
      }
      offset.value = withSpring(0, { ...SETTLE_SPRING, velocity: event.velocityY });
    });

  /**
   * The scrim's own dismissal. It has to be a gesture rather than the view's
   * `onTouchEnd`: that fired on every release, so a drag begun up here closed
   * the sheet no matter where it had been pulled back to. A tap that travels
   * further than the slop is a drag, and the pan above owns it instead.
   */
  const dismissTap = Gesture.Tap()
    .maxDistance(TAP_SLOP)
    .onEnd((_event, success) => {
      "worklet";
      if (success) runOnJS(animateClosed)();
    });

  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value }],
  }));
  const scrimStyle = useAnimatedStyle(() => ({
    opacity:
      panelHeight === 0
        ? opacity.hidden
        : interpolate(offset.value, [0, panelHeight], [alpha.a50, opacity.hidden]),
  }));

  if (!mounted) return null;

  const overlay = (
    <GestureDetector gesture={pan}>
      <View style={styles.overlay}>
        <GestureDetector gesture={dismissTap}>
          <Animated.View
            accessibilityLabel="Dismiss drawer"
            accessibilityRole="button"
            onAccessibilityTap={animateClosed}
            style={[styles.scrim, { backgroundColor: theme.colors.foreground }, scrimStyle]}
            testID="sheet-scrim"
          />
        </GestureDetector>
        <Animated.View
          onLayout={(event: LayoutChangeEvent) => setPanelHeight(event.nativeEvent.layout.height)}
          style={[
            styles.panel,
            {
              backgroundColor: theme.colors.popover,
              borderColor: theme.colors.border,
              // The foot only clears the screen edge while the sheet is being
              // dragged, so it carries the display's own radius the way a pushed
              // card does — square corners there cut across the hardware curve.
              borderBottomLeftRadius: theme.radii.device,
              borderBottomRightRadius: theme.radii.device,
              borderTopLeftRadius: theme.radii.xxl,
              borderTopRightRadius: theme.radii.xxl,
              borderTopWidth: borderWidth.hairline,
              boxShadow: shadow.xxl,
              maxHeight: availableHeight,
              ...(isTall ? { height: availableHeight } : {}),
            },
            panelStyle,
          ]}
          testID="sheet-panel"
        >
          <View style={styles.handleArea}>
            <View
              style={[
                styles.handle,
                { backgroundColor: theme.colors.border, borderRadius: theme.radii.pill },
              ]}
            />
          </View>
          <View
            style={[
              isTall && styles.tallContent,
              contentStyle,
              { paddingBottom: Math.max(insets.bottom, sizing.screen.gutter) },
            ]}
            testID={testID ?? "sheet-content"}
          >
            {children}
          </View>
        </Animated.View>
      </View>
    </GestureDetector>
  );

  // The nav bar lives in a window-level overlay, which renders above any RN modal.
  // Presenting into that same layer is what puts a drawer over the bar rather
  // than behind it. Elsewhere a modal is still the right container.
  if (Platform.OS === "ios") {
    return <FullWindowOverlay>{overlay}</FullWindowOverlay>;
  }
  return (
    <Modal animationType="none" onRequestClose={animateClosed} transparent visible>
      {overlay}
    </Modal>
  );
}

const styles = StyleSheet.create({
  handle: {
    height: sizing.sheet.handleHeight,
    width: sizing.sheet.handleWidth,
  },
  handleArea: {
    alignItems: "center",
    paddingBottom: sizing.sheet.handleGap,
    paddingTop: sizing.sheet.handleTopPadding,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
  },
  headerTitle: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  panel: {
    overflow: "hidden",
    width: "100%",
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
  },
  tallContent: {
    flex: 1,
  },
});
