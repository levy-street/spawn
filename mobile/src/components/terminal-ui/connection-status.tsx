import { StyleSheet, View } from "react-native";
import { ConnectionChannel } from "@/components/terminal-ui/connection-channel";
import type { BadgeVariant } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { DEVICE_NOT_TRUSTED_CODE } from "@/data/trust/device-trust";
import type { TransportError, TransportState } from "@/terminal/transport/types";
import { borderWidth, layer, useTheme } from "@/theme";

interface ConnectionCopy {
  title: string;
  detail: string;
  variant: BadgeVariant;
  busy: boolean;
}

export function connectionCopy(state: TransportState): ConnectionCopy {
  switch (state) {
    case "idle":
      return {
        title: "Waiting to connect",
        detail: "The terminal connection has not started yet.",
        variant: "outline",
        busy: false,
      };
    case "signalling":
      return {
        title: "Securing connection",
        detail: "Verifying the host and negotiating a private session.",
        variant: "info-soft",
        busy: true,
      };
    case "connecting":
      return {
        title: "Connecting to terminal",
        detail: "Opening the terminal and control channels.",
        variant: "info-soft",
        busy: true,
      };
    case "ready":
      return {
        title: "Connected",
        detail: "The terminal is ready for input.",
        variant: "success-soft",
        busy: false,
      };
    case "reconnecting":
      return {
        title: "Reconnecting",
        detail: "Restoring the connection and replaying recent output.",
        variant: "warning-soft",
        busy: true,
      };
    case "closed":
      return {
        title: "Connection closed",
        detail: "This terminal is no longer connected.",
        variant: "outline",
        busy: false,
      };
    case "failed":
      return {
        title: "Connection failed",
        detail: "The terminal could not establish a secure connection.",
        variant: "destructive-soft",
        busy: false,
      };
  }
}

function CompactStateGlyph({
  busy,
  state,
}: {
  busy: boolean;
  state: TransportState;
}): React.JSX.Element {
  const theme = useTheme();
  if (busy) return <Spinner color={state === "reconnecting" ? "warning" : "info"} />;
  return (
    <Icon
      color={state === "failed" ? "destructive" : "mutedForeground"}
      name={state === "failed" ? "AlertCircle" : "Unplug"}
      size={theme.space(5)}
    />
  );
}

export interface ConnectionStateOverlayProps {
  state: TransportState;
  error?: TransportError | null;
  hasEverBeenReady: boolean;
  onRetry: () => void;
  /** Offered only for a trust failure, where retrying cannot help on its own. */
  onDeviceTrust?: () => void;
  /**
   * An approval this device is still waiting on, latched by the caller.
   *
   * The refusal's code does not survive: a transport that has already failed
   * throws plainly on the next open ("transport is in a failed state"), and
   * that message arrives as a fresh, uncoded error. Reading only the newest one
   * dropped the ceremony button and left "Connection failed" in front of
   * someone whose only problem was an approval in flight.
   */
  awaitingApproval?: boolean;
}

export function ConnectionStateOverlay({
  state,
  error,
  hasEverBeenReady,
  onRetry,
  onDeviceTrust,
  awaitingApproval = false,
}: ConnectionStateOverlayProps): React.JSX.Element | null {
  const theme = useTheme();
  if (state === "ready") return null;
  const copy = connectionCopy(state);
  const untrusted = error?.code === DEVICE_NOT_TRUSTED_CODE || awaitingApproval;
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
          // The compact form spans the foot of the terminal rather than
          // floating over it, so it is a bar and not a card: square corners,
          // and a single rule along the top where it meets the output.
          borderTopWidth: compact ? borderWidth.hairline : borderWidth.none,
          gap: theme.space(compact ? 2 : 3),
          padding: theme.space(compact ? 3 : 6),
          zIndex: layer.connecting,
        },
      ]}
      testID={`connection-state-${state}`}
    >
      {compact ? null : <ConnectionChannel state={state} />}
      <View
        style={[
          styles.copyRow,
          { gap: theme.space(3), justifyContent: compact ? "flex-start" : "center" },
        ]}
      >
        {compact ? <CompactStateGlyph busy={copy.busy} state={state} /> : null}
        <View style={[styles.copy, { alignItems: compact ? "flex-start" : "center" }]}>
          <Text variant="label">{awaitingApproval ? "Waiting for approval" : copy.title}</Text>
          <Text
            color="mutedForeground"
            style={compact ? undefined : styles.centeredCopy}
            variant="caption"
          >
            {awaitingApproval
              ? "This host has not approved this device yet. It reconnects on its own the moment it does."
              : (error?.message ?? copy.detail)}
          </Text>
        </View>
      </View>
      <View style={[styles.actions, { gap: theme.space(2) }]}>
        {untrusted && onDeviceTrust ? (
          <Button onPress={onDeviceTrust} size="sm">
            Approve this device
          </Button>
        ) : null}
        {retryable ? (
          <Button onPress={onRetry} size="sm" variant="outline">
            Retry
          </Button>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  actions: {
    alignItems: "center",
    flexDirection: "row",
  },
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
  headerChip: {
    // Badge defaults to flex-start for body copy; header accessories sit on the title baseline.
    alignSelf: "center",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
});
