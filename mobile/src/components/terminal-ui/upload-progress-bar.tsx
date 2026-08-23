import { useEffect, useReducer, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

import {
  paintedUploadRatio,
  reduceUploadBar,
  UPLOAD_PROGRESS_FADE_MS,
  type UploadBarState,
} from "@/terminal/transport/upload";
import { borderWidth, layer, useTheme } from "@/theme";

export interface UploadProgressBarProps {
  ratio: number | null;
}

const INITIAL_STATE: UploadBarState = { phase: "hidden" };

export function UploadProgressBar({ ratio }: UploadProgressBarProps): React.JSX.Element | null {
  const theme = useTheme();
  const [state, dispatch] = useReducer(reduceUploadBar, INITIAL_STATE);
  const width = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

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
    Animated.timing(opacity, {
      toValue: state.phase === "fading" || state.phase === "hidden" ? 0 : 1,
      duration: state.phase === "fading" ? UPLOAD_PROGRESS_FADE_MS : theme.motion.duration.instant,
      useNativeDriver: false,
    }).start();
  }, [opacity, state, theme.motion.duration.instant, theme.motion.duration.overlay, width]);

  if (state.phase === "hidden") return null;
  const percentage = width.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] });

  return (
    <View
      pointerEvents="none"
      style={[styles.track, { zIndex: layer.floatingChrome }]}
      testID="terminal-upload-progress"
    >
      <Animated.View
        style={[
          styles.fill,
          {
            backgroundColor: theme.colors.success,
            opacity,
            width: percentage,
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    height: "100%",
  },
  track: {
    height: borderWidth.emphasis,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
});
