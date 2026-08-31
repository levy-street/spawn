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
  Keyboard,
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
import { OverlaySurfaceContext } from "@/components/ui/overlay-surface";
import { useReducedMotionPreference } from "@/components/ui/swipe-dismiss-overlay";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { alpha, layer, spacing, useTheme } from "@/theme";
import { bottomNavHeight, sizing } from "@/theme/sizing";

export type DialogSize = "sm" | "md" | "lg" | "full-mobile" | "viewer";

/** Long enough to read as an arrival, short enough not to delay the first tap. */
const DIALOG_RISE_MS = 260;
/**
 * Leaving is quick: the decision has been made, and a surface that lingers on
 * its way out holds the page underneath hostage for no reason.
 */
const DIALOG_LEAVE_MS = 150;
/** Carrying the surface off the side once a swipe has committed to it. */
const DIALOG_SLIDE_MS = 180;
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

/**
 * The keyboard goes down the moment the surface starts to leave — carried off
 * by a swipe, or backed out of — rather than vanishing when the window does.
 * A keyboard still standing over a form that is sliding away reads as the
 * form having left it behind.
 */
function dismissKeyboard(): void {
  Keyboard.dismiss();
}

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
  /** What the owner asked for last time the close effect ran. */
  const wasVisibleRef = useRef(false);
  const insets = useSafeAreaInsets();
  const childInsets = useMemo(() => ({ ...insets, top: spacing[0] }), [insets]);
  // The nav bar is portalled to window level, which puts it *over* this modal
  // rather than behind it. Nothing else holds its footprint open here, so a
  // dialog's own foot has to, or the bar sits on top of the actions.
  const reservedBottomChrome = useBottomChromeOwnsInset() ? bottomNavHeight(insets.bottom) : 0;

  const enterDuration = reducedMotion ? theme.motion.duration.reduced : DIALOG_RISE_MS;
  const leaveDuration = reducedMotion ? theme.motion.duration.reduced : DIALOG_LEAVE_MS;

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
      dismissKeyboard();
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
        { duration: leaveDuration, easing: Easing.in(Easing.cubic) },
        settled,
      );
    },
    [finishDismiss, leaveDuration, presence, reducedMotion, slide, windowWidth],
  );

  const requestClose = useCallback(
    (manner: "rise" | "slide") => {
      closedItselfRef.current = true;
      haptics.overlayDismiss();
      close(manner);
    },
    [close],
  );

  /**
   * Gone at once, exit and all. A dialog is state-driven rather than a route,
   * so a nav tap had nothing to pop and left the form standing over the
   * destination; playing an exit there would hold a modal window over the
   * destination tab for as long as the exit took.
   */
  const teardownNow = useCallback(() => {
    closingRef.current = false;
    closedItselfRef.current = false;
    const entry = entryRef.current;
    if (entry) resolveOverlayClose(entry, "owner");
    setSuspended(false);
    slide.value = 0;
    setMounted(false);
    onDismiss();
  }, [onDismiss, slide]);
  const teardownNowRef = useRef(teardownNow);
  teardownNowRef.current = teardownNow;

  // The owner's `visible` is read as an edge, not a level: a dialog the stack
  // brought back is on screen while its owner still says `visible={false}`.
  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (visible) {
      closingRef.current = false;
      setMounted(true);
      return;
    }
    if (wasVisible && mounted && !suspended) close("rise");
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

  // For the whole time it is mounted, waiting included: a dialog parked under a
  // drawer is still a window that would otherwise survive the nav tap.
  useEffect(() => {
    if (!mounted) return;
    return registerNavigationOverlayDismiss(() => teardownNowRef.current());
  }, [mounted]);

  const swipe = useMemo(
    () =>
      Gesture.Pan()
        // Rightward only, and only once a vertical intent has been ruled out, so a
        // scrolling form and a text cursor keep their own touches.
        .activeOffsetX(SWIPE_ACTIVATION)
        .failOffsetY([-SWIPE_AXIS_SLOP, SWIPE_AXIS_SLOP])
        .onStart(() => {
          "worklet";
          // The keyboard follows the surface out from the first committed
          // movement, so a swipe that lets go of the form lets go of it whole.
          runOnJS(dismissKeyboard)();
        })
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

  // The surface itself only fades in and out; a swipe carries the whole of it
  // aside. It is what sits on the surface that rises on the way in and sinks
  // on the way out, so the page reads as lighting up with the form arriving
  // on it rather than as a sheet being lifted into place.
  const surfaceStyle = useAnimatedStyle(() => ({
    opacity: presence.value,
    transform: [{ translateX: slide.value }],
  }));
  const riseStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: reducedMotion
          ? 0
          : interpolate(presence.value, [0, 1], [sizing.dialog.riseDistance, 0]),
      },
    ],
  }));
  // The page underneath dims as the surface arrives, and a swipe that carries
  // the surface aside lets it back through in step.
  const scrimStyle = useAnimatedStyle(() => ({
    opacity:
      presence.value *
      alpha.a50 *
      (1 - Math.min(1, Math.max(0, slide.value / Math.max(1, windowWidth)))),
  }));

  if (!mounted) return null;

  const hasHeader = title !== undefined || description !== undefined;
  const footerActions = footer === undefined ? [] : flattenFooterActions(footer);
  const ChildInsetsProvider = SafeAreaInsetsContext?.Provider;

  return (
    // Transparent on purpose: the window behind a full-screen modal is the
    // system's own, and it is white. Every rise and every exit used to fade
    // through that, which in dark mode was a white flash on both ends.
    <Modal
      animationType="none"
      onRequestClose={() => requestClose("rise")}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      // A dialog waiting under something raised from inside it is still mounted,
      // holding its form, but must not stand over what is on top of it.
      visible={!suspended}
    >
      <View style={styles.window} testID="dialog-window">
        <Animated.View
          pointerEvents="none"
          style={[styles.scrim, { backgroundColor: theme.colors.scrim }, scrimStyle]}
        />
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
            <Animated.View style={[styles.rise, riseStyle]} testID="dialog-rise">
              <OverlaySurfaceContext.Provider value="background">
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
                  <DialogFooter reservedBottomChrome={reservedBottomChrome}>
                    {footerActions}
                  </DialogFooter>
                ) : null}

                {!hasHeader && showCloseButton ? (
                  <View
                    pointerEvents="box-none"
                    style={[
                      styles.close,
                      { right: theme.space(3), top: insets.top + theme.space(2) },
                    ]}
                  >
                    <IconButton
                      accessibilityLabel={closeAccessibilityLabel}
                      icon="X"
                      onPress={() => requestClose("rise")}
                      size="sm"
                    />
                  </View>
                ) : null}
              </OverlaySurfaceContext.Provider>
            </Animated.View>
          </Animated.View>
        </GestureDetector>
      </View>
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
  rise: {
    flex: 1,
  },
  scrim: {
    ...StyleSheet.absoluteFillObject,
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
  window: {
    flex: 1,
  },
});
