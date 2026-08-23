import {
  Children,
  Fragment,
  isValidElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Modal,
  type StyleProp,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { KeyboardContext } from "react-native-keyboard-controller/src/context";
import Animated, {
  Easing,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";

import { useBottomChromeOwnsInset } from "@/components/layout/bottom-chrome";
import { registerNavigationOverlayDismiss } from "@/components/nav/overlay-dismiss";
import { FooterActions } from "@/components/ui/footer-actions";
import { IconButton } from "@/components/ui/icon-button";
import {
  enterOverlay,
  leaveOverlay,
  markOverlayClosing,
  type OverlayEntry,
  resolveOverlayClose,
  restoreOverlay,
} from "@/components/ui/overlay-stack";
import { useReducedMotionPreference } from "@/components/ui/swipe-dismiss-overlay";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { layer, spacing, useTheme } from "@/theme";
import { bottomNavHeight, sizing } from "@/theme/sizing";

export type DialogSize = "sm" | "md" | "lg" | "full-mobile" | "viewer";

/** Long enough to read as an arrival, short enough not to delay the first tap. */
const DIALOG_RISE_MS = 300;
/** Carrying the surface off the side once a swipe has committed to it. */
const DIALOG_SLIDE_MS = 220;
/** Rightward travel before the surface starts following the finger. */
const SWIPE_ACTIVATION = 16;
/** Vertical slack that hands the touch back to whatever scrolls underneath. */
const SWIPE_AXIS_SLOP = 12;
/** Fraction of the width past which a release lets the dialog go. */
const SWIPE_DISMISS_RATIO = 0.25;
/** How far ahead of the finger a release is read, so a flick commits early. */
const SWIPE_PROJECTION_SECONDS = 0.15;
/** Settling back after a drag that did not go far enough to dismiss. */
const SETTLE_SPRING = { damping: 26, mass: 0.7, stiffness: 260 } as const;

export interface DialogProps {
  visible: boolean;
  onDismiss: () => void;
  /**
   * Called when this dialog comes back because something raised over it was
   * dismissed. See `overlay-stack.ts` — the return itself needs no help.
   */
  onReturn?: () => void;
  title?: string;
  description?: ReactNode;
  size?: DialogSize;
  /** The header's X. The way out of a dialog; its actions are the caller's own. */
  showCloseButton?: boolean;
  closeAccessibilityLabel?: string;
  /** The pinned action row. A dialog states its own answers — there is no default. */
  footer?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  children?: ReactNode;
  testID?: string;
}

function flattenFooterActions(node: ReactNode): ReactNode[] {
  return Children.toArray(node).flatMap((child) => {
    if (isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment) {
      return flattenFooterActions(child.props.children);
    }
    return [child];
  });
}

function DialogFooter({
  children,
  reservedBottomChrome,
}: {
  children: ReactNode;
  reservedBottomChrome: number;
}): React.JSX.Element {
  // Read the provider's context directly so importing Dialog does not eagerly load native
  // bindings in provider-light routes and tests.
  const keyboard = useContext(KeyboardContext);
  const { height, progress } = keyboard.reanimated;
  const targetProgress = useSharedValue(progress.value);

  useLayoutEffect(
    () =>
      keyboard.setKeyboardHandlers({
        onStart: (event) => {
          "worklet";
          targetProgress.value = event.progress;
        },
        onEnd: (event) => {
          "worklet";
          targetProgress.value = event.progress;
        },
      }),
    [keyboard, targetProgress],
  );

  return (
    <FooterActions
      keyboardAnimation={{ height, progress, targetProgress }}
      reservedBottomChrome={reservedBottomChrome}
    >
      {children}
    </FooterActions>
  );
}

export function Dialog({
  visible,
  onDismiss,
  onReturn,
  title,
  description,
  showCloseButton = true,
  closeAccessibilityLabel = "Close dialog",
  footer,
  contentStyle,
  children,
  testID,
}: DialogProps): React.JSX.Element | null {
  const theme = useTheme();
  const reducedMotion = useReducedMotionPreference();
  const { width: windowWidth } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  /** 0 while the dialog is away, 1 once it has arrived. Drives the rise and the fade. */
  const presence = useSharedValue(0);
  /** How far a swipe has carried the surface sideways, in points. */
  const slide = useSharedValue(0);
  const closingRef = useRef(false);
  /** Whether this dialog is closing itself, in which case it still owes onDismiss. */
  const closedItselfRef = useRef(false);
  /** True while this dialog waits under something raised from inside it. */
  const [suspended, setSuspended] = useState(false);
  const entryRef = useRef<OverlayEntry | null>(null);
  const restoreRef = useRef<() => void>(() => undefined);
  const teardownRef = useRef<() => void>(() => undefined);
  const insets = useSafeAreaInsets();
  const childInsets = useMemo(() => ({ ...insets, top: spacing[0] }), [insets]);
  // The nav bar is portalled to window level, which puts it *over* this modal
  // rather than behind it. Nothing else holds its footprint open here, so a
  // dialog's own foot has to, or the bar sits on top of the actions.
  const reservedBottomChrome = useBottomChromeOwnsInset() ? bottomNavHeight(insets.bottom) : 0;

  const enterDuration = reducedMotion ? theme.motion.duration.reduced : DIALOG_RISE_MS;

  const restore = useCallback(() => {
    setSuspended(false);
    presence.value = withTiming(1, { duration: enterDuration, easing: Easing.out(Easing.cubic) });
    onReturn?.();
  }, [enterDuration, onReturn, presence]);

  const teardown = useCallback(() => {
    closingRef.current = false;
    closedItselfRef.current = false;
    setSuspended(false);
    slide.value = 0;
    setMounted(false);
    onDismiss();
  }, [onDismiss, slide]);

  restoreRef.current = restore;
  teardownRef.current = teardown;

  const finishDismiss = useCallback(() => {
    closingRef.current = false;
    slide.value = 0;
    // Backed out of by the person, or closed by whatever owns it: the drawer it
    // was raised from only comes back for the first (`overlay-stack.ts`).
    const closedItself = closedItselfRef.current;
    const entry = entryRef.current;
    if (entry && resolveOverlayClose(entry, closedItself ? "user" : "owner") === "suspend") {
      setSuspended(true);
      return;
    }
    setMounted(false);
    // A parent that closed the dialog itself has already run its own teardown;
    // only a dialog that closed itself still owes that call.
    if (closedItself) {
      closedItselfRef.current = false;
      onDismiss();
    }
  }, [onDismiss, slide]);

  const close = useCallback(
    (manner: "rise" | "slide") => {
      if (closingRef.current) return;
      closingRef.current = true;
      if (entryRef.current) markOverlayClosing(entryRef.current);
      const settled = (finished?: boolean) => {
        "worklet";
        if (finished) runOnJS(finishDismiss)();
      };
      if (manner === "slide" && !reducedMotion) {
        slide.value = withTiming(
          windowWidth,
          { duration: DIALOG_SLIDE_MS, easing: Easing.out(Easing.cubic) },
          settled,
        );
        return;
      }
      // It leaves the way it arrived: back down the short distance it rose, fading out.
      presence.value = withTiming(
        0,
        { duration: enterDuration, easing: Easing.in(Easing.cubic) },
        settled,
      );
    },
    [enterDuration, finishDismiss, presence, reducedMotion, slide, windowWidth],
  );

  const requestClose = useCallback(
    (manner: "rise" | "slide") => {
      closedItselfRef.current = true;
      haptics.overlayDismiss();
      close(manner);
    },
    [close],
  );

  useEffect(() => {
    if (visible) {
      closingRef.current = false;
      setMounted(true);
      return;
    }
    if (mounted && !suspended) close("rise");
  }, [close, mounted, suspended, visible]);

  // Raised again through its owner while it was waiting: the same return, with
  // the owner's state back in step.
  useEffect(() => {
    if (visible && suspended && entryRef.current) restoreOverlay(entryRef.current);
  }, [suspended, visible]);

  // Registered for as long as it is mounted, waiting included: a dialog
  // underneath is still on screen as far as the stack is concerned.
  useEffect(() => {
    if (!mounted) return;
    const entry: OverlayEntry = {
      suspended: false,
      closing: false,
      restore: () => restoreRef.current(),
      teardown: () => teardownRef.current(),
    };
    entryRef.current = entry;
    enterOverlay(entry);
    return () => {
      leaveOverlay(entry);
      entryRef.current = null;
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted || !visible) return;
    presence.value = 0;
    slide.value = 0;
    presence.value = withTiming(1, { duration: enterDuration, easing: Easing.out(Easing.cubic) });
    haptics.overlayOpen();
  }, [enterDuration, mounted, presence, slide, visible]);

  // A dialog is state-driven rather than a route, so a nav tap had nothing to pop
  // and left the form standing over the destination. It leaves at once there —
  // playing an exit would hold a modal window over the destination tab.
  useEffect(() => {
    if (!visible) return;
    return registerNavigationOverlayDismiss(onDismiss);
  }, [onDismiss, visible]);

  const swipe = useMemo(
    () =>
      Gesture.Pan()
        // Rightward only, and only once a vertical intent has been ruled out, so a
        // scrolling form and a text cursor keep their own touches.
        .activeOffsetX(SWIPE_ACTIVATION)
        .failOffsetY([-SWIPE_AXIS_SLOP, SWIPE_AXIS_SLOP])
        .onUpdate((event) => {
          "worklet";
          // Leftward has nowhere to go, so it is resisted rather than followed.
          slide.value = event.translationX > 0 ? event.translationX : event.translationX / 4;
        })
        .onEnd((event) => {
          "worklet";
          const projected = event.translationX + event.velocityX * SWIPE_PROJECTION_SECONDS;
          if (projected > windowWidth * SWIPE_DISMISS_RATIO) {
            runOnJS(requestClose)("slide");
            return;
          }
          slide.value = withSpring(0, { ...SETTLE_SPRING, velocity: event.velocityX });
        }),
    [requestClose, slide, windowWidth],
  );

  const surfaceStyle = useAnimatedStyle(() => ({
    opacity: presence.value,
    transform: [
      {
        translateY: reducedMotion
          ? 0
          : interpolate(presence.value, [0, 1], [sizing.dialog.riseDistance, 0]),
      },
      { translateX: slide.value },
    ],
  }));

  if (!mounted) return null;

  const hasHeader = title !== undefined || description !== undefined;
  const footerActions = footer === undefined ? [] : flattenFooterActions(footer);
  const ChildInsetsProvider = SafeAreaInsetsContext?.Provider;

  return (
    <Modal
      animationType="none"
      onRequestClose={() => requestClose("rise")}
      presentationStyle="fullScreen"
      statusBarTranslucent
      // A dialog waiting under something raised from inside it is still mounted,
      // holding its form, but must not stand over what is on top of it.
      visible={!suspended}
    >
      <GestureDetector gesture={swipe}>
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.surface,
            {
              paddingBottom:
                footer === undefined ? Math.max(insets.bottom, reservedBottomChrome) : spacing[0],
            },
            contentStyle,
            { backgroundColor: theme.colors.background, zIndex: layer.modal },
            surfaceStyle,
          ]}
          testID={testID ?? "dialog-content"}
        >
          {hasHeader ? (
            <View
              style={[
                styles.header,
                {
                  gap: theme.space(1),
                  paddingBottom: theme.space(4),
                  paddingHorizontal: theme.space(4),
                  // The title row stands as tall as its close control now, which
                  // carries part of the clearance the padding used to owe on its own.
                  paddingTop: insets.top + theme.space(3),
                },
              ]}
              testID="dialog-header"
            >
              {/* The close control shares a row with the title alone, so it centres
                on that line rather than on a copy block a description may extend. */}
              <View style={[styles.titleRow, { gap: theme.space(3) }]}>
                <View style={styles.titleCopy}>
                  {title !== undefined ? (
                    <Text accessibilityRole="header" variant="uiLg" weight="semibold">
                      {title}
                    </Text>
                  ) : null}
                </View>
                {showCloseButton ? (
                  // The same way out as the headerless X and the swipe: through
                  // the dialog's own close, so it reads as backed out of rather
                  // than closed from outside — which is what decides whether the
                  // drawer it was raised from comes back.
                  <IconButton
                    accessibilityLabel={closeAccessibilityLabel}
                    icon="X"
                    onPress={() => requestClose("rise")}
                    size="lg"
                  />
                ) : null}
              </View>
              {description !== undefined ? (
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

          {ChildInsetsProvider === undefined ? (
            <View style={styles.body} testID="dialog-body">
              {children}
            </View>
          ) : (
            <ChildInsetsProvider value={childInsets}>
              <View style={styles.body} testID="dialog-body">
                {children}
              </View>
            </ChildInsetsProvider>
          )}

          {footerActions.length > 0 ? (
            <DialogFooter reservedBottomChrome={reservedBottomChrome}>{footerActions}</DialogFooter>
          ) : null}

          {!hasHeader && showCloseButton ? (
            <View
              pointerEvents="box-none"
              style={[styles.close, { right: theme.space(3), top: insets.top + theme.space(2) }]}
            >
              <IconButton
                accessibilityLabel={closeAccessibilityLabel}
                icon="X"
                onPress={() => requestClose("rise")}
                size="sm"
              />
            </View>
          ) : null}
        </Animated.View>
      </GestureDetector>
    </Modal>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  close: {
    position: "absolute",
  },
  header: {
    alignItems: "stretch",
  },
  titleCopy: {
    flex: 1,
    justifyContent: "center",
    minWidth: 0,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
  },
  surface: {
    flex: 1,
    width: "100%",
  },
});
