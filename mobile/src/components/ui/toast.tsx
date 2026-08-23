import type { PropsWithChildren, ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { Icon, type IconName } from "@/components/ui/icon";
import { useReducedMotionPreference } from "@/components/ui/swipe-dismiss-overlay";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { borderWidth, layer, opacity as opacityToken, shadow, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

const MAX_VISIBLE_TOASTS = 5;
const TOAST_SWIPE_THRESHOLD_RATIO = 0.3;
const TOAST_VELOCITY_PROJECTION_SECONDS = 0.15;
/** How far a downward drag actually travels: the notice is pinned to the top. */
const TOAST_DOWNWARD_RESISTANCE = 0.2;

/** What each notice leads with: an outcome, a fault, or a plain remark. */
const GLYPH = {
  success: "Check",
  error: "AlertTriangle",
  default: "Bell",
} as const satisfies Record<ToastVariant, IconName>;

export type ToastVariant = "default" | "success" | "error";

export interface ToastShowOptions {
  detail?: string;
  variant?: ToastVariant;
  icon?: ReactNode;
  durationMs?: number;
  onPress?: () => void;
  actionLabel?: string;
}

export interface ToastRecord {
  id: string;
  message: string;
  detail?: string;
  variant: ToastVariant;
  icon?: ReactNode;
  durationMs: number;
  expiresAt: number;
  onPress?: () => void;
  actionLabel?: string;
  leaving: boolean;
}

export type ToastQueueAction =
  | { type: "enqueue"; toast: ToastRecord }
  | { type: "dismiss"; id: string }
  | { type: "remove"; id: string }
  | { type: "clear" };

function sameToast(left: ToastRecord, right: ToastRecord): boolean {
  return (
    !left.leaving &&
    left.variant === right.variant &&
    left.message === right.message &&
    left.detail === right.detail
  );
}

/** Keeps five live notices, refreshes exact duplicates, and preserves exit rows until removal. */
export function toastQueueReducer(
  state: readonly ToastRecord[],
  action: ToastQueueAction,
): ToastRecord[] {
  switch (action.type) {
    case "enqueue": {
      const duplicate = state.find((item) => sameToast(item, action.toast));
      if (duplicate) {
        return state.map((item) =>
          item.id === duplicate.id
            ? {
                id: item.id,
                message: item.message,
                ...(item.detail === undefined ? {} : { detail: item.detail }),
                variant: item.variant,
                ...(action.toast.icon === undefined ? {} : { icon: action.toast.icon }),
                durationMs: action.toast.durationMs,
                expiresAt: action.toast.expiresAt,
                ...(action.toast.onPress === undefined ? {} : { onPress: action.toast.onPress }),
                ...(action.toast.actionLabel === undefined
                  ? {}
                  : { actionLabel: action.toast.actionLabel }),
                leaving: false,
              }
            : item,
        );
      }
      const leaving = state.filter((item) => item.leaving);
      const live = [...state.filter((item) => !item.leaving), action.toast].slice(
        -MAX_VISIBLE_TOASTS,
      );
      return [...leaving, ...live];
    }
    case "dismiss":
      return state.map((item) => (item.id === action.id ? { ...item, leaving: true } : item));
    case "remove":
      return state.filter((item) => item.id !== action.id);
    case "clear":
      return [];
  }
}

export interface ToastApi {
  show: (message: string, options?: ToastShowOptions) => string;
  success: (message: string, options?: Omit<ToastShowOptions, "variant">) => string;
  error: (message: string, options?: Omit<ToastShowOptions, "variant">) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export interface ToastProps {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: ToastProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotionPreference();
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(reducedMotion ? 0 : -theme.motion.transform.toastDrop);
  const opacity = useSharedValue(0);
  const width = useSharedValue(theme.space(80));
  const height = useSharedValue(theme.space(16));
  const remaining = useSharedValue(1);

  useEffect(() => {
    const transition = toast.leaving
      ? theme.motion.transition.toastExit
      : theme.motion.transition.toastEnter;
    const duration = reducedMotion ? theme.motion.duration.reduced : transition.duration;
    opacity.value = withTiming(toast.leaving ? 0 : 1, { duration, easing: transition.easing });
    // A notice arrives from above the screen and leaves the same way, because
    // that is the edge it is pinned to.
    translateY.value = withTiming(
      reducedMotion ? 0 : toast.leaving ? -theme.motion.transform.toastDrop : 0,
      { duration, easing: transition.easing },
    );
  }, [opacity, reducedMotion, theme.motion, toast.leaving, translateY]);

  // The hairline along the foot spends the notice's life: you can see how long
  // is left rather than guessing whether it is about to go.
  useEffect(() => {
    if (reducedMotion || toast.leaving) return;
    // Read from the deadline rather than the duration, so a notice that was
    // refreshed by a repeat, or remounted, shows the time it actually has.
    const timeLeft = Math.max(0, toast.expiresAt - Date.now());
    remaining.value = Math.min(1, timeLeft / Math.max(1, toast.durationMs));
    remaining.value = withTiming(0, {
      duration: timeLeft,
      easing: theme.motion.easing.linear,
    });
  }, [reducedMotion, remaining, theme.motion, toast.durationMs, toast.expiresAt, toast.leaving]);

  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);

  // Read on this thread and handed to the gesture as plain numbers and configs.
  // A pan callback is a worklet: calling `theme.space` from inside one reaches
  // for a function that does not exist on the UI thread, and that throws where
  // nothing can catch it — the swipe took the app down with it.
  const enterTransition = theme.motion.transition.toastEnter;
  const exitTransition = theme.motion.transition.toastExit;
  const exitClearance = theme.space(4);

  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate((event) => {
          "worklet";
          translateX.value = event.translationX;
          // Up clears it; down is the direction it came from, so it only gives
          // a little and springs back.
          translateY.value =
            event.translationY < 0
              ? event.translationY
              : event.translationY * TOAST_DOWNWARD_RESISTANCE;
          const sideways = Math.abs(event.translationX) / Math.max(1, width.value);
          const upward = Math.max(0, -event.translationY) / Math.max(1, height.value);
          opacity.value = interpolate(Math.max(sideways, upward), [0, 1], [1, 0]);
        })
        .onEnd((event) => {
          "worklet";
          const projectedX =
            event.translationX + event.velocityX * TOAST_VELOCITY_PROJECTION_SECONDS;
          const projectedY =
            event.translationY + event.velocityY * TOAST_VELOCITY_PROJECTION_SECONDS;
          const swipedAside = Math.abs(projectedX) >= width.value * TOAST_SWIPE_THRESHOLD_RATIO;
          const swipedUp = -projectedY >= height.value * TOAST_SWIPE_THRESHOLD_RATIO;
          if (swipedAside || swipedUp) {
            if (swipedUp && !swipedAside) {
              translateY.value = withTiming(
                reducedMotion ? 0 : -(height.value + exitClearance),
                exitTransition,
                (finished) => {
                  if (finished) scheduleOnRN(dismiss);
                },
              );
            } else {
              translateX.value = withTiming(
                reducedMotion ? 0 : projectedX < 0 ? -width.value : width.value,
                exitTransition,
                (finished) => {
                  if (finished) scheduleOnRN(dismiss);
                },
              );
            }
            opacity.value = withTiming(0, exitTransition);
          } else {
            translateX.value = withTiming(0, enterTransition);
            translateY.value = withTiming(0, enterTransition);
            opacity.value = withTiming(1, enterTransition);
          }
        }),
    [
      dismiss,
      enterTransition,
      exitClearance,
      exitTransition,
      height,
      opacity,
      reducedMotion,
      translateX,
      translateY,
      width,
    ],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: reducedMotion
      ? []
      : [{ translateX: translateX.value }, { translateY: translateY.value }],
  }));

  // Scaled from the left rather than resized: a width animation would relayout
  // the notice sixty times a second for a two-pixel rule.
  const countdownStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: -(width.value * (1 - remaining.value)) / 2 },
      { scaleX: remaining.value },
    ],
  }));

  const tone =
    toast.variant === "error"
      ? "destructive"
      : toast.variant === "success"
        ? "success"
        : "mutedForeground";
  const plateBackground =
    toast.variant === "error"
      ? theme.colors.destructiveSoft
      : toast.variant === "success"
        ? theme.colors.successSoft
        : theme.colors.muted;

  const message = (
    <View style={styles.messageColumn}>
      <Text numberOfLines={2} variant="uiBase" weight="medium">
        {toast.message}
      </Text>
      {toast.detail ? (
        <Text
          color="mutedForeground"
          numberOfLines={2}
          style={{ marginTop: theme.space(0.5) }}
          variant="caption"
        >
          {toast.detail}
        </Text>
      ) : null}
    </View>
  );

  return (
    <GestureDetector gesture={swipe}>
      <Animated.View
        accessibilityLiveRegion="polite"
        accessibilityRole={toast.variant === "error" ? "alert" : "summary"}
        onLayout={(event) => {
          width.value = event.nativeEvent.layout.width;
          height.value = event.nativeEvent.layout.height;
        }}
        style={[
          styles.toast,
          {
            backgroundColor: theme.colors.popover,
            borderColor: theme.colors.popoverBorder,
            borderRadius: theme.radii.xxl,
            boxShadow: shadow.lg,
          },
          animatedStyle,
        ]}
        testID={`toast-${toast.id}`}
      >
        <View style={[styles.clip, { borderRadius: theme.radii.xxl - borderWidth.hairline }]}>
          <View style={[styles.row, { gap: theme.space(3), padding: theme.space(3) }]}>
            <View style={[styles.plate, { backgroundColor: plateBackground }]}>
              {toast.icon ?? (
                <Icon color={tone} name={GLYPH[toast.variant]} size={theme.space(4)} />
              )}
            </View>
            {toast.onPress ? (
              <Pressable
                accessibilityLabel={toast.actionLabel ?? toast.message}
                accessibilityRole="button"
                onPress={() => {
                  toast.onPress?.();
                  dismiss();
                }}
                style={styles.messageColumn}
              >
                {message}
              </Pressable>
            ) : (
              message
            )}
            <Pressable
              accessibilityLabel="Dismiss notification"
              accessibilityRole="button"
              hitSlop={theme.space(2)}
              onPress={dismiss}
              style={({ pressed }) => [
                styles.dismiss,
                {
                  backgroundColor: pressed ? theme.colors.accent : "transparent",
                  borderRadius: theme.radii.pill,
                },
              ]}
            >
              <Icon color="mutedForeground" name="X" size={theme.space(3.5)} />
            </Pressable>
          </View>
          {reducedMotion ? null : (
            <Animated.View
              accessibilityElementsHidden
              importantForAccessibility="no"
              pointerEvents="none"
              style={[
                styles.countdown,
                { backgroundColor: theme.colors[tone], opacity: opacityToken.countdown },
                countdownStyle,
              ]}
            />
          )}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

export function ToastProvider({ children }: PropsWithChildren): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [queue, dispatch] = useReducer(toastQueueReducer, []);
  const queueRef = useRef<readonly ToastRecord[]>(queue);
  const nextId = useRef(1);
  const removalTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  queueRef.current = queue;

  const dismiss = useCallback(
    (id: string) => {
      const target = queueRef.current.find((item) => item.id === id);
      if (!target || target.leaving) return;
      dispatch({ type: "dismiss", id });
      const priorTimer = removalTimers.current.get(id);
      if (priorTimer) clearTimeout(priorTimer);
      const timer = setTimeout(() => {
        dispatch({ type: "remove", id });
        removalTimers.current.delete(id);
      }, theme.motion.duration.toastExitRemoval);
      removalTimers.current.set(id, timer);
    },
    [theme.motion.duration.toastExitRemoval],
  );

  const show = useCallback(
    (message: string, options: ToastShowOptions = {}): string => {
      const trimmed = message.trim();
      if (!trimmed) return "";
      const variant = options.variant ?? "default";
      const durationMs =
        options.durationMs ??
        (variant === "error" ? theme.motion.duration.toastError : theme.motion.duration.toastInfo);
      const duplicate = queueRef.current.find(
        (item) =>
          !item.leaving &&
          item.variant === variant &&
          item.message === trimmed &&
          item.detail === options.detail,
      );
      const id = duplicate?.id ?? `toast-${nextId.current++}`;
      const now = Date.now();
      dispatch({
        type: "enqueue",
        toast: {
          id,
          message: trimmed,
          ...(options.detail === undefined ? {} : { detail: options.detail }),
          variant,
          ...(options.icon === undefined ? {} : { icon: options.icon }),
          durationMs,
          expiresAt: now + durationMs,
          ...(options.onPress === undefined ? {} : { onPress: options.onPress }),
          ...(options.actionLabel === undefined ? {} : { actionLabel: options.actionLabel }),
          leaving: false,
        },
      });
      if (variant === "success") haptics.success();
      if (variant === "error") haptics.error();
      return id;
    },
    [theme.motion.duration.toastError, theme.motion.duration.toastInfo],
  );

  const clear = useCallback(() => {
    for (const timer of removalTimers.current.values()) clearTimeout(timer);
    removalTimers.current.clear();
    dispatch({ type: "clear" });
  }, []);

  useEffect(() => {
    const live = queue.filter((item) => !item.leaving);
    if (live.length === 0) return;
    const soonest = Math.min(...live.map((item) => item.expiresAt));
    const timer = setTimeout(
      () => {
        const now = Date.now();
        for (const item of queueRef.current) {
          if (!item.leaving && item.expiresAt <= now) dismiss(item.id);
        }
      },
      Math.max(0, soonest - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [dismiss, queue]);

  useEffect(
    () => () => {
      for (const timer of removalTimers.current.values()) clearTimeout(timer);
    },
    [],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message, options) => show(message, { ...options, variant: "success" }),
      error: (message, options) => show(message, { ...options, variant: "error" }),
      dismiss,
      clear,
    }),
    [clear, dismiss, show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <View
        accessibilityLiveRegion="polite"
        pointerEvents="box-none"
        style={[
          styles.host,
          {
            gap: theme.space(2),
            // Pinned to the top: a notice drops in from off-screen and spans the
            // page's own measure, the screen less one gutter either side.
            left: insets.left + sizing.screen.gutter,
            paddingTop: insets.top + spacing[2],
            right: insets.right + sizing.screen.gutter,
            top: spacing[0],
            zIndex: layer.toast,
          },
        ]}
        testID="toast-host"
      >
        {[...queue].reverse().map((item) => (
          <Toast key={item.id} onDismiss={dismiss} toast={item} />
        ))}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}

const styles = StyleSheet.create({
  countdown: {
    bottom: spacing[0],
    height: spacing[0.5],
    left: spacing[0],
    position: "absolute",
    right: spacing[0],
  },
  clip: {
    overflow: "hidden",
    width: "100%",
  },
  dismiss: {
    alignItems: "center",
    height: spacing[7],
    justifyContent: "center",
    width: spacing[7],
  },
  host: {
    position: "absolute",
  },
  messageColumn: {
    flex: 1,
    minWidth: 0,
  },
  plate: {
    alignItems: "center",
    borderRadius: spacing[2],
    height: spacing[8],
    justifyContent: "center",
    width: spacing[8],
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    width: "100%",
  },
  toast: {
    borderWidth: borderWidth.hairline,
    width: "100%",
  },
});
