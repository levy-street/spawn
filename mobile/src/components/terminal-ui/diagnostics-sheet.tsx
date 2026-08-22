import { StyleSheet, View } from "react-native";

import { Sheet, SheetHeader } from "@/components/ui/sheet";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import type { TransportError, TransportState, WorkerDiagnostic } from "@/terminal/transport/types";
import { borderWidth, useTheme } from "@/theme";

export interface DiagnosticsSheetProps {
  visible: boolean;
  state: TransportState;
  diagnostic: WorkerDiagnostic | null;
  error: TransportError | null;
  onDismiss: () => void;
}

function DiagnosticRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.row,
        {
          borderBottomColor: theme.colors.border,
          borderBottomWidth: borderWidth.hairline,
          gap: theme.space(3),
          paddingVertical: theme.space(2.5),
        },
      ]}
    >
      <Text color="mutedForeground" style={styles.label} variant="caption">
        {label}
      </Text>
      <Text numberOfLines={2} style={styles.value} variant="mono">
        {value}
      </Text>
    </View>
  );
}

function yesNo(value: boolean): string {
  return value ? "Available" : "Unavailable";
}

export function DiagnosticsSheet({
  visible,
  state,
  diagnostic,
  error,
  onDismiss,
}: DiagnosticsSheetProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Sheet enableDynamicSizing onDismiss={onDismiss} visible={visible}>
      <SheetHeader title="Terminal diagnostics" />
      <View style={{ paddingHorizontal: theme.space(4), paddingBottom: theme.space(4) }}>
        <View style={[styles.summary, { gap: theme.space(2), paddingVertical: theme.space(2) }]}>
          <StatusDot
            pulse={state === "connecting" || state === "signalling"}
            tone={state === "ready" ? "active" : state === "failed" ? "offline" : "waiting"}
          />
          <Text variant="label">{state}</Text>
        </View>
        <DiagnosticRow
          label="Secure context"
          value={diagnostic ? yesNo(diagnostic.isSecureContext) : "Pending"}
        />
        <DiagnosticRow
          label="Peer connection"
          value={diagnostic ? yesNo(diagnostic.peerConnection) : "Pending"}
        />
        <DiagnosticRow
          label="Data channel"
          value={diagnostic ? yesNo(diagnostic.dataChannel) : "Pending"}
        />
        <DiagnosticRow
          label="Renderer"
          value={diagnostic?.renderer === null || !diagnostic ? "Pending" : diagnostic.renderer}
        />
        <DiagnosticRow
          label="Loopback"
          value={diagnostic ? yesNo(diagnostic.loopback) : "Pending"}
        />
        {diagnostic?.detail ? <DiagnosticRow label="Worker" value={diagnostic.detail} /> : null}
        {error ? <DiagnosticRow label={error.code} value={error.message} /> : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  label: {
    flexBasis: "36%",
  },
  row: {
    alignItems: "flex-start",
    flexDirection: "row",
  },
  summary: {
    alignItems: "center",
    flexDirection: "row",
  },
  value: {
    flex: 1,
    textAlign: "right",
  },
});
