import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useReducer, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";

import { useReducedMotionPreference } from "@/components/ui/status-dot";
import {
  paintedUploadRatio,
  reduceUploadBar,
  UPLOAD_PROGRESS_FADE_MS,
  type UploadBarState,
} from "@/terminal/transport/upload";
import { alpha, borderWidth, layer, opacity, spacing, useTheme, withAlpha } from "@/theme";

export interface UploadProgressBarProps {
  ratio: number | null;
}

const INITIAL_STATE: UploadBarState = { phase: "hidden" };

/** How wide the light at the head of the bar is. */
const LEADING_EDGE_WIDTH = spacing[16];
/** How far the head dims between breaths. */
const LEADING_EDGE_DIM = alpha.a45;

/**
 * The upload indicator: a hairline across the top edge of the terminal, which
 * reads as a second border under the session header — the same shape the
 * browser draws, and the same reason. It replaced a floating "Uploading
 * photo.jpg…" card that covered the output and outstayed the upload.
 *
 * It is absolutely positioned and takes no touches: the surface underneath
 * keeps its full height, so nothing here disturbs the grid or the scrollback.
 */
export function UploadProgressBar({ ratio }: UploadProgressBarProps): React.JSX.Element | null {
  const theme = useTheme();
  const reduceMotion = useReducedMotionPreference();
  const [state, dispatch] = useReducer(reduceUploadBar, INITIAL_STATE);
  const width = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const head = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    dispatch({ type: "ratio", ratio, now: Date.now() });
  }, [ratio]);

  useEffect(() => {
    if (state.phase === "holding") {
      const timer = setTimeout(
        () => dispatch({ type: "tick", now: Date.now() }),
        Math.max(0, state.fadeAt - Date.now()),
      );
      return () => clearTimeout(timer);
    }
    if (state.phase === "fading") {
      const timer = setTimeout(
        () => dispatch({ type: "tick", now: Date.now() }),
        Math.max(0, state.fadeEndsAt - Date.now()),
      );
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [state]);

  useEffect(() => {
    const target =
      state.phase === "active" ? paintedUploadRatio(state.ratio) : state.phase === "hidden" ? 0 : 1;
    Animated.timing(width, {
      toValue: target,
      duration: theme.motion.duration.overlay,
      easing: undefined,
      useNativeDriver: false,
    }).start();
    Animated.timing(fade, {
      toValue: state.phase === "fading" || state.phase === "hidden" ? 0 : 1,
      duration: state.phase === "fading" ? UPLOAD_PROGRESS_FADE_MS : theme.motion.duration.instant,
      useNativeDriver: false,
    }).start();
  }, [fade, state, theme.motion.duration.instant, theme.motion.duration.overlay, width]);

  // Bytes are still moving: breathe the head of the bar, so a large file on a
  // slow uplink reads as working rather than stalled at 12%. A settled bar
  // holds its light steady while it waits to fade.
  useEffect(() => {
    if (reduceMotion || state.phase !== "active") {
      head.setValue(1);
      return undefined;
    }
    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(head, {
          toValue: LEADING_EDGE_DIM,
          duration: theme.motion.duration.uploadSheen / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(head, {
          toValue: 1,
          duration: theme.motion.duration.uploadSheen / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    breathe.start();
    return () => breathe.stop();
  }, [head, reduceMotion, state.phase, theme.motion.duration.uploadSheen]);

  if (state.phase === "hidden") return null;
  const percentage = width.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });
  // The bar is painted in the foreground colour so it holds up over a light
  // terminal and a dark one alike, dim at the tail and bright at the head.
  const body = [
    withAlpha(theme.colors.foreground, alpha.a15),
    withAlpha(theme.colors.foreground, alpha.a45),
  ] as const;
  const headStops = [
    withAlpha(theme.colors.foreground, opacity.hidden),
    withAlpha(theme.colors.foreground, alpha.a95),
  ] as const;

  return (
    <View
      pointerEvents="none"
      style={[styles.track, { zIndex: layer.floatingChrome }]}
      testID="terminal-upload-progress"
    >
      <Animated.View style={[styles.fill, { opacity: fade, width: percentage }]}>
        <LinearGradient
          colors={body}
          end={GRADIENT_END}
          start={GRADIENT_START}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View style={[styles.head, { opacity: head }]}>
          <LinearGradient
            colors={headStops}
            end={GRADIENT_END}
            start={GRADIENT_START}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const GRADIENT_START = { x: 0, y: 0 } as const;
const GRADIENT_END = { x: 1, y: 0 } as const;

const styles = StyleSheet.create({
  fill: {
    height: "100%",
    overflow: "hidden",
  },
  head: {
    bottom: 0,
    position: "absolute",
    right: 0,
    top: 0,
    width: LEADING_EDGE_WIDTH,
  },
  track: {
    height: borderWidth.emphasis,
    left: 0,
    overflow: "hidden",
    position: "absolute",
    right: 0,
    top: 0,
  },
});
