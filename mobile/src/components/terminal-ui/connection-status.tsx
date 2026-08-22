import { StyleSheet, View } from "react-native";

import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import type { TransportError, TransportState } from "@/terminal/transport/types";
import { borderWidth, layer, useTheme } from "@/theme";

interface ConnectionCopy {
  chip: string;
  title: string;
  detail: string;
  variant: BadgeVariant;
  busy: boolean;
}

export function connectionCopy(state: TransportState): ConnectionCopy {
  switch (state) {
    case "idle":
      return {
        chip: "Waiting",
        title: "Waiting to connect",
        detail: "The terminal connection has not started yet.",
        variant: "outline",
        busy: false,
      };
    case "signalling":
      return {
        chip: "Securing",
        title: "Securing connection",
        detail: "Verifying the host and negotiating a private session.",
        variant: "info-soft",
        busy: true,
      };
    case "connecting":
      return {
        chip: "Connecting",
        title: "Connecting to terminal",
        detail: "Opening the terminal and control channels.",
        variant: "info-soft",
        busy: true,
      };
    case "ready":
      return {
        chip: "Connected",
        title: "Connected",
        detail: "The terminal is ready for input.",
        variant: "success-soft",
        busy: false,
      };
    case "reconnecting":
      return {
        chip: "Reconnecting",
        title: "Reconnecting",
        detail: "Restoring the connection and replaying recent output.",
        variant: "warning-soft",
        busy: true,
      };
    case "closed":
      return {
        chip: "Closed",
        title: "Connection closed",
        detail: "This terminal is no longer connected.",
        variant: "outline",
        busy: false,
      };
    case "failed":
      return {
        chip: "Failed",
        title: "Connection failed",
        detail: "The terminal could not establish a secure connection.",
        variant: "destructive-soft",
        busy: false,
      };
  }
}

export function ConnectionChip({ state }: { state: TransportState }): React.JSX.Element {
  const copy = connectionCopy(state);
  return (
    <Badge testID="terminal-connection-chip" variant={copy.variant}>
      {copy.chip}
    </Badge>
  );
}

export interface ConnectionStateOverlayProps {
  state: TransportState;
  error?: TransportError | null;
  hasEverBeenReady: boolean;
  onRetry: () => void;
}

export function ConnectionStateOverlay({
  state,
  error,
  hasEverBeenReady,
  onRetry,
}: ConnectionStateOverlayProps): React.JSX.Element | null {
  const theme = useTheme();
  if (state === "ready") return null;
  const copy = connectionCopy(state);
  const retryable = state === "failed" || state === "closed" || error?.retryable === true;
  const compact = hasEverBeenReady;

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole={state === "failed" ? "alert" : "summary"}
      style={[
        compact ? styles.banner : styles.overlay,
        {
          backgroundColor: compact ? theme.colors.popover : theme.colors.terminalBg,
          borderColor: theme.colors.border,
          borderRadius: compact ? theme.radii.lg : 0,
          borderWidth: compact ? borderWidth.hairline : borderWidth.none,
          gap: theme.space(compact ? 2 : 3),
          padding: theme.space(compact ? 3 : 6),
          zIndex: layer.connecting,
        },
      ]}
      testID={`connection-state-${state}`}
    >
      <View
        style={[
          styles.copyRow,
          { gap: theme.space(3), justifyContent: compact ? "flex-start" : "center" },
        ]}
      >
        {copy.busy ? (
          <Spinner color={state === "reconnecting" ? "warning" : "info"} />
        ) : (
          <Icon
            color={state === "failed" ? "destructive" : "mutedForeground"}
            name={state === "failed" ? "AlertCircle" : "Unplug"}
            size={theme.space(5)}
          />
        )}
        <View style={[styles.copy, { alignItems: compact ? "flex-start" : "center" }]}>
          <Text variant="label">{copy.title}</Text>
          <Text
            color="mutedForeground"
            style={compact ? undefined : styles.centeredCopy}
            variant="caption"
          >
            {error?.message ?? copy.detail}
          </Text>
        </View>
      </View>
      {retryable ? (
        <Button onPress={onRetry} size="sm" variant="outline">
          Retry
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: "center",
    bottom: 0,
    flexDirection: "row",
    justifyContent: "space-between",
    left: 0,
    position: "absolute",
    right: 0,
  },
  centeredCopy: {
    textAlign: "center",
  },
  copy: {
    flex: 1,
  },
  copyRow: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
});
