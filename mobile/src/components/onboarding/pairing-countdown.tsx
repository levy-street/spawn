import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { spacing } from "@/theme";

export const PAIRING_CEREMONY_TTL_MS = 30 * 60 * 1000;
export const PAIRING_WAIT_HINT_MS = 30_000;
export const PAIRING_WAIT_ESCAPE_MS = 60_000;

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

export function PairingWaitingEscape({ onEscape }: { onEscape(): void }): React.JSX.Element {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => clearInterval(timer);
  }, []);

  if (elapsedMs < PAIRING_WAIT_HINT_MS) return <View />;

  return (
    <View style={styles.waitingHint} testID="pairing-waiting-hint">
      <Text color="mutedForeground" variant="caption">
        Elapsed {formatPairingCountdown(Math.floor(elapsedMs / 1_000))}
      </Text>
      {elapsedMs >= PAIRING_WAIT_ESCAPE_MS ? (
        <>
          <Text color="mutedForeground" variant="caption">
            Having trouble? Re-run the install command — it's safe to repeat.
          </Text>
          <Button onPress={onEscape} size="sm" variant="outline">
            Back to install instructions
          </Button>
        </>
      ) : null}
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
  waitingHint: {
    alignItems: "flex-start",
    gap: spacing[2],
  },
});
