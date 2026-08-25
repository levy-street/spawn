import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Keyboard,
  type LayoutChangeEvent,
  Modal,
  Platform,
  ScrollView,
  type StyleProp,
  StyleSheet,
  TextInput,
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

import {
  enterOverlay,
  leaveOverlay,
  markOverlayClosing,
  type OverlayCloseReason,
  type OverlayEntry,
  resolveOverlayClose,
  restoreOverlay,
} from "@/components/ui/overlay-stack";
import { OverlaySurfaceContext } from "@/components/ui/overlay-surface";
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

type FocusedInput = ReturnType<typeof TextInput.State.currentlyFocusedInput>;

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
  /**
   * Called when this drawer comes back because the one raised over it was
   * dismissed. Only owners that mirror the drawer's visibility elsewhere need
   * it — the return itself is handled without any help (`overlay-stack.ts`).
   */
  onReturn?: () => void;
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

/**
 * Takes every drawer down at once, without an exit. Primary navigation is
 * replacing the whole scene underneath, and a panel sliding away over a page
 * that is already gone reads as a leftover rather than a dismissal.
 */
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
 *
 * A drawer also owns the keyboard while it is up: whatever field had focus when
 * it rose is put away, and gets its focus — and the keys — back when the drawer
 * leaves, so a choice made from inside a form returns you to the form.
 */
export function Sheet({
  visible,
  onDismiss,
  onReturn,
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
  /** Whether this presentation has already played its entrance. */
  const enteredRef = useRef(false);
  /** True while this drawer waits under one that was raised from inside it. */
  const [suspended, setSuspended] = useState(false);
  const closeReason = useRef<OverlayCloseReason>("owner");
  const entryRef = useRef<OverlayEntry | null>(null);
  /** The prop as last rendered, for callbacks the stack fires between renders. */
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  /** What the owner asked for last time the close effect ran. */
  const wasVisibleRef = useRef(false);
  /** The field that had the keyboard when the drawer rose, owed its focus back. */
  const focusedInputRef = useRef<FocusedInput>(null);
  /**
   * What was last rendered while this drawer was open. An owner usually clears
   * the state its rows were built from in the same breath as closing it, so a
   * drawer that waits underneath — or simply plays its exit — has to show what
   * it was, not the empty shape it has become.
   */
  const shownRef = useRef<ReactNode>(children);
  if (visible) shownRef.current = children;

  // The stack calls back into whichever render is current, so the entry holds
  // refs rather than the closures it was built with.
  const restoreRef = useRef<() => void>(() => undefined);
  const teardownRef = useRef<() => void>(() => undefined);
  const coveredRef = useRef<() => void>(() => undefined);

  const restoreFocus = useCallback(() => {
    const input = focusedInputRef.current;
    focusedInputRef.current = null;
    if (input) TextInput.State.focusTextInput(input);
  }, []);

  const restore = useCallback(() => {
    setSuspended(false);
    offset.value = withTiming(0, { duration: OPEN_MS, easing: Easing.out(Easing.cubic) });
    onReturn?.();
  }, [offset, onReturn]);

  const teardown = useCallback(() => {
    closingRef.current = false;
    setSuspended(false);
    setMounted(false);
    onDismiss();
    restoreFocus();
  }, [onDismiss, restoreFocus]);

  restoreRef.current = restore;
  teardownRef.current = teardown;

  const finishDismiss = useCallback(() => {
    closingRef.current = false;
    const entry = entryRef.current;
    if (entry && resolveOverlayClose(entry, closeReason.current) === "suspend") {
      setSuspended(true);
      return;
    }
    setMounted(false);
    onDismiss();
    restoreFocus();
  }, [onDismiss, restoreFocus]);

  const closeWith = useCallback(
    (velocity: number | null, reason: OverlayCloseReason) => {
      if (closingRef.current) return;
      closingRef.current = true;
      closeReason.current = reason;
      if (entryRef.current) markOverlayClosing(entryRef.current);
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

  /** Dismissed by the person: whatever was waiting underneath comes back. */
  const dismissBySelf = useCallback(() => closeWith(null, "user"), [closeWith]);
  const dismissBySelfWithVelocity = useCallback(
    (velocity: number) => closeWith(velocity, "user"),
    [closeWith],
  );
  /** Closed by whatever owns it, which means its work here is finished. */
  const closeByOwner = useCallback(() => closeWith(null, "owner"), [closeWith]);

  /**
   * Gone at once, exit and all: primary navigation is replacing the scene this
   * drawer stood over. Focus is not handed back — the field it belonged to is
   * on a screen that is leaving too.
   */
  const teardownNow = useCallback(() => {
    closingRef.current = false;
    focusedInputRef.current = null;
    const entry = entryRef.current;
    if (entry) resolveOverlayClose(entry, "owner");
    setSuspended(false);
    setMounted(false);
    onDismiss();
  }, [onDismiss]);
  const teardownNowRef = useRef(teardownNow);
  teardownNowRef.current = teardownNow;

  // Something opened over a drawer that had come back on its own — its owner
  // still holds it closed, so as far as the owner is concerned nothing changed.
  // Stepping aside here is what lets it return again if the new thing is
  // dismissed, and go for good if the new thing is answered.
  coveredRef.current = () => {
    if (!visibleRef.current) closeByOwner();
  };

  // The owner's `visible` is read as an edge, not a level. A drawer brought back
  // by the stack is on screen while its owner still says `visible={false}` —
  // the owner let go of it when it raised the one above — and reading that as
  // an instruction to close is what sent a returned drawer straight back down.
  useEffect(() => {
    const wasVisible = wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (visible) {
      closingRef.current = false;
      if (!wasVisible || !mounted) {
        // Whatever field had the keys gives them up while the drawer is up;
        // they come back with the field when the drawer leaves.
        const focused = TextInput.State.currentlyFocusedInput();
        if (focused) {
          focusedInputRef.current = focused;
          Keyboard.dismiss();
        }
      }
      setMounted(true);
      return;
    }
    if (wasVisible && mounted && !suspended) closeByOwner();
  }, [closeByOwner, mounted, suspended, visible]);

  // Raised again through its owner while it was waiting: the same return, with
  // the owner's own state back in step, so its rows are live rather than the
  // snapshot they were.
  useEffect(() => {
    if (visible && suspended && entryRef.current) restoreOverlay(entryRef.current);
  }, [suspended, visible]);

  // Registered for the whole time it is mounted, waiting included: a drawer
  // underneath is still on screen as far as the stack is concerned.
  useEffect(() => {
    if (!mounted) return;
    const entry: OverlayEntry = {
      suspended: false,
      closing: false,
      restore: () => restoreRef.current(),
      teardown: () => teardownRef.current(),
      covered: () => coveredRef.current(),
    };
    entryRef.current = entry;
    enterOverlay(entry);
    return () => {
      leaveOverlay(entry);
      entryRef.current = null;
    };
  }, [mounted]);

  useEffect(() => {
    if (!mounted) return;
    const close = () => teardownNowRef.current();
    openSheets.add(close);
    return () => {
      openSheets.delete(close);
    };
  }, [mounted]);

  // The panel rises only once measured, so it never flashes at the wrong place —
  // and only on the first measurement. A sheet whose content changes size while
  // it is open (a drawer stepping into a picker, a list growing) measures again,
  // and replaying the entrance from there dropped the panel off the bottom and
  // rebuilt it, haptic and all. Later measurements simply resize it in place.
  useEffect(() => {
    if (!mounted || panelHeight === 0 || enteredRef.current) return;
    enteredRef.current = true;
    offset.value = panelHeight;
    offset.value = withTiming(0, { duration: OPEN_MS, easing: Easing.out(Easing.cubic) });
    haptics.overlayOpen();
  }, [mounted, offset, panelHeight]);

  useEffect(() => {
    if (!mounted) enteredRef.current = false;
  }, [mounted]);

  // A drawer waiting underneath is parked exactly its own height below the
  // screen. If that height changes while it waits — a rotation, say — the old
  // parking distance would leave a strip of it showing.
  useEffect(() => {
    if (suspended) offset.value = Math.max(panelHeight, chrome.touchTarget);
  }, [offset, panelHeight, suspended]);

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
        runOnJS(dismissBySelfWithVelocity)(event.velocityY);
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
      if (success) runOnJS(dismissBySelf)();
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
      {/* A drawer waiting under another is off-screen but still mounted, and a
          full-screen overlay that swallowed touches would make the one above it
          unusable. */}
      <View
        pointerEvents={suspended ? "none" : "auto"}
        style={styles.overlay}
        testID="sheet-overlay"
      >
        <GestureDetector gesture={dismissTap}>
          <Animated.View
            accessibilityLabel="Dismiss drawer"
            accessibilityRole="button"
            onAccessibilityTap={dismissBySelf}
            style={[styles.scrim, { backgroundColor: theme.colors.scrim }, scrimStyle]}
            testID="sheet-scrim"
          />
        </GestureDetector>
        <Animated.View
          onLayout={(event: LayoutChangeEvent) => setPanelHeight(event.nativeEvent.layout.height)}
          style={[
            styles.panel,
            {
              backgroundColor: theme.colors.popover,
              borderColor: theme.colors.popoverBorder,
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
                { backgroundColor: theme.colors.popoverBorder, borderRadius: theme.radii.pill },
              ]}
            />
          </View>
          <OverlaySurfaceContext.Provider value="popover">
            <View
              style={[
                isTall && styles.tallContent,
                contentStyle,
                { paddingBottom: Math.max(insets.bottom, sizing.screen.gutter) },
              ]}
              testID={testID ?? "sheet-content"}
            >
              {shownRef.current}
            </View>
          </OverlaySurfaceContext.Provider>
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
    <Modal animationType="none" onRequestClose={dismissBySelf} transparent visible>
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
