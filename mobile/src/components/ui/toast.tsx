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
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { Icon } from "@/components/ui/icon";
import { useReducedMotionPreference } from "@/components/ui/swipe-dismiss-overlay";
import { Text } from "@/components/ui/text";
import { haptics } from "@/lib/haptics";
import { alpha, borderWidth, chrome, layer, shadow, spacing, useTheme } from "@/theme";

const MAX_VISIBLE_TOASTS = 5;
const TOAST_SWIPE_THRESHOLD_RATIO = 0.3;
const TOAST_VELOCITY_PROJECTION_SECONDS = 0.15;

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

function rgbaFromHex(hex: string, opacity: number): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return hex;
  return `rgba(${Number.parseInt(match[1] ?? "0", 16)},${Number.parseInt(
    match[2] ?? "0",
    16,
  )},${Number.parseInt(match[3] ?? "0", 16)},${opacity})`;
}

export interface ToastProps {
  toast: ToastRecord;
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: ToastProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotionPreference();
  const translateX = useSharedValue(reducedMotion ? 0 : theme.motion.transform.toastSlide);
  const opacity = useSharedValue(0);
  const width = useSharedValue(theme.space(80));

  useEffect(() => {
    const transition = toast.leaving
      ? theme.motion.transition.toastExit
      : theme.motion.transition.toastEnter;
    const duration = reducedMotion ? theme.motion.duration.reduced : transition.duration;
    opacity.value = withTiming(toast.leaving ? 0 : 1, { duration, easing: transition.easing });
    translateX.value = withTiming(
      reducedMotion ? 0 : toast.leaving ? theme.motion.transform.toastSlide : 0,
      { duration, easing: transition.easing },
    );
  }, [opacity, reducedMotion, theme.motion, toast.leaving, translateX]);

  const dismiss = useCallback(() => onDismiss(toast.id), [onDismiss, toast.id]);

  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-theme.space(3), theme.space(3)])
        .failOffsetY([-theme.space(2), theme.space(2)])
        .onUpdate((event) => {
          translateX.value = event.translationX;
          opacity.value = interpolate(
            Math.abs(event.translationX),
            [0, Math.max(1, width.value)],
            [1, 0],
          );
        })
        .onEnd((event) => {
          const projected =
            event.translationX + event.velocityX * TOAST_VELOCITY_PROJECTION_SECONDS;
          const shouldDismiss = Math.abs(projected) >= width.value * TOAST_SWIPE_THRESHOLD_RATIO;
          if (shouldDismiss) {
            const destination = projected < 0 ? -width.value : width.value;
            translateX.value = withTiming(
              reducedMotion ? 0 : destination,
              theme.motion.transition.toastExit,
              (finished) => {
                if (finished) scheduleOnRN(dismiss);
              },
            );
            opacity.value = withTiming(0, theme.motion.transition.toastExit);
          } else {
            translateX.value = withTiming(0, theme.motion.transition.toastEnter);
            opacity.value = withTiming(1, theme.motion.transition.toastEnter);
          }
        }),
    [dismiss, opacity, reducedMotion, theme.motion, theme.space, translateX, width],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: reducedMotion ? [] : [{ translateX: translateX.value }],
  }));

  const borderColor =
    toast.variant === "error"
      ? rgbaFromHex(theme.colors.destructive, alpha.a40)
      : theme.colors.border;

  const message = (
    <View style={styles.messageColumn}>
      <Text variant="body">{toast.message}</Text>
      {toast.detail ? (
        <Text color="mutedForeground" style={{ marginTop: theme.space(0.5) }} variant="caption">
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
        }}
        style={[
          styles.toast,
          {
            backgroundColor: theme.colors.popover,
            borderColor,
            borderRadius: theme.radii.lg,
            boxShadow: shadow.lg,
            gap: theme.space(2.5),
            paddingHorizontal: theme.space(3),
            paddingVertical: theme.space(2.5),
          },
          animatedStyle,
        ]}
        testID={`toast-${toast.id}`}
      >
        <View style={{ marginTop: theme.space(0.5) }}>
          {toast.icon ??
            (toast.variant === "error" ? (
              <Icon color="destructive" name="AlertCircle" size={theme.space(4)} />
            ) : (
              <Icon color="success" name="CheckCircle2" size={theme.space(4)} />
            ))}
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
          hitSlop={theme.space(3)}
          onPress={dismiss}
          style={({ pressed }) => [
            styles.dismiss,
            {
              backgroundColor: pressed ? theme.colors.accent : "transparent",
              borderRadius: theme.radii.sm,
            },
          ]}
        >
          <Icon color="mutedForeground" name="X" size={theme.space(3.5)} />
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

export function ToastProvider({ children }: PropsWithChildren): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const viewport = useWindowDimensions();
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

  const hostWidth = Math.min(theme.space(80), viewport.width - theme.space(8));

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
            right: theme.space(4),
            top: insets.top + chrome.sidebarRailWidth,
            width: hostWidth,
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
  dismiss: {
    alignItems: "center",
    height: spacing[5],
    justifyContent: "center",
    width: spacing[5],
  },
  host: {
    position: "absolute",
  },
  messageColumn: {
    flex: 1,
    minWidth: 0,
  },
  toast: {
    alignItems: "flex-start",
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
  },
});
