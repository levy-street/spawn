import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { Icon, type IconName } from "@/components/ui/icon";
import type { TransportState } from "@/terminal/transport/types";
import { alpha, borderWidth, opacity, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

/** How one half of the channel reads right now. */
type LineState = "flowing" | "waiting" | "solid";

export interface ConnectionChannelView {
  icon: IconName;
  /** Tone key for the plate glyph, its ring, and the lines either side. */
  tone: "muted" | "warning" | "success" | "destructive";
  /** The near half (phone to server) then the far half (server to host). */
  lines: readonly [LineState, LineState];
}

/**
 * What the terminal draws while it has nothing to draw: the connection itself —
 * two endpoints, the padlock that has to close between them, and dashes drifting
 * inward for as long as a half is still being negotiated. It mirrors the web
 * app's ConnectingOverlay so the same moment reads the same on both clients, and
 * it replaces a bare spinner that said only "something is happening".
 */
export function connectionChannelView(state: TransportState): ConnectionChannelView {
  switch (state) {
    case "idle":
      return { icon: "Unplug", tone: "muted", lines: ["waiting", "waiting"] };
    case "signalling":
      return { icon: "LockOpen", tone: "muted", lines: ["flowing", "waiting"] };
    case "connecting":
      return { icon: "LockOpen", tone: "muted", lines: ["flowing", "flowing"] };
    case "ready":
      return { icon: "Lock", tone: "success", lines: ["solid", "solid"] };
    case "reconnecting":
      return { icon: "PlugZap", tone: "warning", lines: ["flowing", "waiting"] };
    case "closed":
      return { icon: "Unplug", tone: "muted", lines: ["waiting", "waiting"] };
    case "failed":
      return { icon: "ShieldAlert", tone: "destructive", lines: ["waiting", "waiting"] };
  }
}

function Endpoint(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.endpoint,
        {
          backgroundColor: theme.colors.mutedForeground,
          borderRadius: theme.radii.pill,
          opacity: alpha.a60,
        },
      ]}
    />
  );
}

/**
 * One half of the channel. A flowing half animates a highlight along its length
 * toward the padlock — the RN stand-in for the web's drifting dashes, since a
 * dashed 1px rule cannot be animated in place here. `reverse` sends the far half
 * inward too, so both halves travel toward the lock rather than in parallel.
 */
function ChannelLine({
  color,
  reverse = false,
  state,
}: {
  color: string;
  reverse?: boolean;
  state: LineState;
}): React.JSX.Element {
  const progress = useSharedValue(0);

  useEffect(() => {
    if (state !== "flowing") {
      cancelAnimation(progress);
      progress.value = 0;
      return;
    }
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(1, {
        duration: CHANNEL_FLOW_MS,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      false,
    );
    return () => cancelAnimation(progress);
  }, [progress, state]);

  const travel = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          progress.value,
          [0, 1],
          reverse
            ? [sizing.connectionChannel.lineWidth, -sizing.connectionChannel.pulseWidth]
            : [-sizing.connectionChannel.pulseWidth, sizing.connectionChannel.lineWidth],
        ),
      },
    ],
  }));

  return (
    <View
      style={[
        styles.line,
        {
          backgroundColor: color,
          borderRadius: sizing.connectionChannel.lineHeight,
          opacity: state === "solid" ? alpha.a70 : alpha.a25,
        },
      ]}
    >
      {state === "flowing" ? (
        <Animated.View
          style={[styles.pulse, { backgroundColor: color, opacity: opacity.opaque }, travel]}
        />
      ) : null}
    </View>
  );
}

/** One full pass of the highlight along a flowing half. */
const CHANNEL_FLOW_MS = 1400;

export function ConnectionChannel({ state }: { state: TransportState }): React.JSX.Element {
  const theme = useTheme();
  const view = connectionChannelView(state);
  const tone = {
    muted: theme.colors.mutedForeground,
    warning: theme.colors.warning,
    success: theme.colors.success,
    destructive: theme.colors.destructive,
  }[view.tone];

  return (
    <View accessibilityElementsHidden style={styles.channel} testID="connection-channel">
      <Endpoint />
      <ChannelLine color={tone} state={view.lines[0]} />
      <View
        style={[
          styles.plate,
          {
            backgroundColor: theme.colors.card,
            borderColor: tone,
            borderRadius: theme.radii.lg,
          },
        ]}
      >
        <Icon color={view.tone === "muted" ? "mutedForeground" : view.tone} name={view.icon} />
      </View>
      <ChannelLine color={tone} reverse state={view.lines[1]} />
      <Endpoint />
    </View>
  );
}

const styles = StyleSheet.create({
  channel: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.connectionChannel.gap,
  },
  endpoint: {
    flexShrink: 0,
    height: sizing.connectionChannel.endpoint,
    width: sizing.connectionChannel.endpoint,
  },
  line: {
    flexShrink: 0,
    height: sizing.connectionChannel.lineHeight,
    overflow: "hidden",
    width: sizing.connectionChannel.lineWidth,
  },
  plate: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    flexShrink: 0,
    height: sizing.connectionChannel.plate,
    justifyContent: "center",
    width: sizing.connectionChannel.plate,
  },
  pulse: {
    height: "100%",
    position: "absolute",
    width: sizing.connectionChannel.pulseWidth,
  },
});
