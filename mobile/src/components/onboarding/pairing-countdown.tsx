import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "@/components/ui/text";
import { spacing } from "@/theme";

export const PAIRING_CEREMONY_TTL_MS = 30 * 60 * 1000;

export function pairingSecondsRemaining(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

export function formatPairingCountdown(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  return `${minutes}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

export interface PairingCountdownProps {
  deadlineMs: number;
  onExpired: () => void;
}

export function PairingCountdown({ deadlineMs, onExpired }: PairingCountdownProps) {
  const [seconds, setSeconds] = useState(() => pairingSecondsRemaining(deadlineMs, Date.now()));
  const expiredRef = useRef(false);

  useEffect(() => {
    expiredRef.current = false;
    const update = () => {
      const remaining = pairingSecondsRemaining(deadlineMs, Date.now());
      setSeconds(remaining);
      if (remaining === 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpired();
      }
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [deadlineMs, onExpired]);

  return (
    <View accessibilityRole="timer" style={styles.row} testID="pairing-countdown">
      <Text color="mutedForeground" variant="caption">
        Pairing window
      </Text>
      <Text accessibilityLiveRegion="polite" variant="mono">
        {formatPairingCountdown(seconds)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
    justifyContent: "space-between",
  },
});
