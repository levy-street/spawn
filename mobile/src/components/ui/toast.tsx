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
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
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

/** A button on the notice itself, for a notice that asks rather than tells. */
export interface ToastAction {
  label: string;
  onPress: () => void;
  /** `primary` is the one the notice is recommending. */
  variant?: "primary" | "secondary";
}

/**
 * How far along, when a notice reports work rather than an event.
 *
 * `"indeterminate"` is a bar that moves without claiming a position, and is
 * the honest answer here: the daemon reports update *state* and never byte
 * counts, and `expo-updates` exposes no progress at all. A number is only
 * passed where something real is counted.
 */
export type ToastProgress = "indeterminate" | number;

export interface ToastShowOptions {
  detail?: string;
  variant?: ToastVariant;
  icon?: ReactNode;
  durationMs?: number;
  onPress?: () => void;
  actionLabel?: string;
  /**
   * Stays until something dismisses it. For a notice about a *condition*
   * rather than an event — an update waiting to be taken is still waiting
   * five seconds later, and a notice that expires on its own has told the
   * person nothing they could act on.
   */
  persistent?: boolean;
  /** Buttons on the notice, under the text. */
  actions?: readonly ToastAction[];
  /** Draws a progress bar under the text. */
  progress?: ToastProgress;
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
  persistent?: boolean;
  actions?: readonly ToastAction[];
  progress?: ToastProgress;
  leaving: boolean;
}

export type ToastQueueAction =
  | { type: "enqueue"; toast: ToastRecord }
  | { type: "update"; id: string; patch: Partial<ToastRecord> }
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
                ...(action.toast.persistent === undefined
                  ? {}
                  : { persistent: action.toast.persistent }),
                ...(action.toast.actions === undefined ? {} : { actions: action.toast.actions }),
                ...(action.toast.progress === undefined ? {} : { progress: action.toast.progress }),
                leaving: false,
              }
            : item,
        );
      }
      const leaving = state.filter((item) => item.leaving);
      // Persistent notices are held back from eviction first. One of them is a
      // condition someone still has to answer — an update waiting to be taken
      // — and losing it to a burst of transient notices would drop the only
      // notice on screen that was asking a question.
      const candidates = [...state.filter((item) => !item.leaving), action.toast];
      const sticky = candidates.filter((item) => item.persistent);
      const transient = candidates.filter((item) => !item.persistent);
      const room = Math.max(0, MAX_VISIBLE_TOASTS - sticky.length);
      return [...leaving, ...sticky, ...transient.slice(-room)];
    }
    case "update":
      // Unknown ids are ignored: the notice may have been dismissed by hand
      // while the work that owns it was still running.
      return state.map((item) =>
        item.id === action.id && !item.leaving ? { ...item, ...action.patch } : item,
      );
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
  /**
   * Change a notice already on screen, in place. A notice reporting work has
   * to move — "update available" becomes "updating…" with a bar — and showing
   * again would animate a second row in beside the first.
   */
  update: (id: string, patch: Partial<Omit<ToastShowOptions, "durationMs" | "variant">>) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * The bar under a notice that is reporting work.
 *
 * Indeterminate is a stripe travelling the track: it says "still going"
 * without claiming a position, which is all we honestly know for a daemon
 * update — the daemon reports state, never byte counts — or a mobile OTA,
 * where `expo-updates` gives nothing to count. A number is only passed where
 * something real is counted, and is clamped so a bad total cannot paint
 * outside the track.
 *
 * Reduced motion holds a still, part-filled track rather than freezing the
 * stripe mid-flight, which would read as stalled.
 */
export function ToastProgressBar({ progress }: { progress: ToastProgress }): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotionPreference();
  const travel = useSharedValue(0);
  const determinate = typeof progress === "number";
  const percent = determinate ? Math.max(0, Math.min(100, Math.round(progress))) : 0;

  useEffect(() => {
    if (determinate || reducedMotion) return;
    travel.value = 0;
    travel.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.ease) }),
      -1,
      false,
    );
  }, [determinate, reducedMotion, travel]);

  const stripeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(travel.value, [0, 1], [-40, 120]) }],
  }));

  const track = (
    <View
      style={[
        styles.progressTrack,
        {
          backgroundColor: theme.colors.muted,
          borderRadius: theme.radii.pill,
          height: theme.space(1),
          marginTop: theme.space(2),
        },
      ]}
    >
      {determinate ? (
        <View
          style={{
            backgroundColor: theme.colors.primary,
            borderRadius: theme.radii.pill,
            height: "100%",
            width: `${percent}%`,
          }}
        />
      ) : (
        <Animated.View
          style={[
            {
              backgroundColor: theme.colors.primary,
              borderRadius: theme.radii.pill,
              height: "100%",
              width: reducedMotion ? "50%" : "35%",
            },
            reducedMotion ? undefined : stripeStyle,
          ]}
        />
      )}
    </View>
  );

  if (!determinate) return track;
  return (
    <View style={styles.progressRow}>
      <View style={styles.progressFill}>{track}</View>
      <Text color="mutedForeground" style={{ marginTop: theme.space(2) }} variant="caption">
        {percent}%
      </Text>
    </View>
  );
}

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
    // A persistent notice is not spending anything: it waits for an answer,
    // and a hairline draining to nothing would say it was about to go.
    if (toast.persistent) {
      remaining.value = 0;
      return;
    }
    // Read from the deadline rather than the duration, so a notice that was
    // refreshed by a repeat, or remounted, shows the time it actually has.
    const timeLeft = Math.max(0, toast.expiresAt - Date.now());
    remaining.value = Math.min(1, timeLeft / Math.max(1, toast.durationMs));
    remaining.value = withTiming(0, {
      duration: timeLeft,
      easing: theme.motion.easing.linear,
    });
  }, [
    reducedMotion,
    remaining,
    theme.motion,
    toast.durationMs,
    toast.expiresAt,
    toast.leaving,
    toast.persistent,
  ]);

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
      {toast.progress === undefined ? null : <ToastProgressBar progress={toast.progress} />}
      {toast.actions?.length ? (
        <View style={[styles.actions, { gap: theme.space(1.5), marginTop: theme.space(2) }]}>
          {toast.actions.map((action) => (
            <Pressable
              accessibilityLabel={action.label}
              accessibilityRole="button"
              key={action.label}
              onPress={action.onPress}
              style={[
                styles.action,
                {
                  backgroundColor:
                    action.variant === "primary" ? theme.colors.primary : "transparent",
                  borderColor:
                    action.variant === "primary" ? theme.colors.primary : theme.colors.border,
                  borderRadius: theme.radii.lg,
                  borderWidth: borderWidth.hairline,
                  paddingHorizontal: theme.space(2.5),
                  paddingVertical: theme.space(1),
                },
              ]}
            >
              <Text
                color={action.variant === "primary" ? "primaryForeground" : "mutedForeground"}
                variant="caption"
                weight="medium"
              >
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
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
      // A persistent notice carries no deadline; the sweeper below skips it.
      const expiresAt = options.persistent ? Number.POSITIVE_INFINITY : now + durationMs;
      dispatch({
        type: "enqueue",
        toast: {
          id,
          message: trimmed,
          ...(options.detail === undefined ? {} : { detail: options.detail }),
          variant,
          ...(options.icon === undefined ? {} : { icon: options.icon }),
          durationMs,
          expiresAt,
          ...(options.onPress === undefined ? {} : { onPress: options.onPress }),
          ...(options.actionLabel === undefined ? {} : { actionLabel: options.actionLabel }),
          ...(options.persistent === undefined ? {} : { persistent: options.persistent }),
          ...(options.actions === undefined ? {} : { actions: options.actions }),
          ...(options.progress === undefined ? {} : { progress: options.progress }),
          leaving: false,
        },
      });
      if (variant === "success") haptics.success();
      if (variant === "error") haptics.error();
      return id;
    },
    [theme.motion.duration.toastError, theme.motion.duration.toastInfo],
  );

  const update = useCallback(
    (id: string, patch: Partial<Omit<ToastShowOptions, "durationMs" | "variant">>) => {
      dispatch({ type: "update", id, patch });
    },
    [],
  );

  const clear = useCallback(() => {
    for (const timer of removalTimers.current.values()) clearTimeout(timer);
    removalTimers.current.clear();
    dispatch({ type: "clear" });
  }, []);

  useEffect(() => {
    const live = queue.filter(
      (item) => !item.leaving && item.expiresAt !== Number.POSITIVE_INFINITY,
    );
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
      update,
      success: (message, options) => show(message, { ...options, variant: "success" }),
      error: (message, options) => show(message, { ...options, variant: "error" }),
      dismiss,
      clear,
    }),
    [clear, dismiss, show, update],
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
  action: {
    alignItems: "center",
    justifyContent: "center",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  messageColumn: {
    flex: 1,
    minWidth: 0,
  },
  progressFill: {
    flex: 1,
    minWidth: 0,
  },
  progressRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  progressTrack: {
    overflow: "hidden",
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
