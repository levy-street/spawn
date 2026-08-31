import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";

import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import { spacing } from "@/theme";

export const MACHINE_WAIT_ELAPSED_HINT_MS = 30_000;
export const MACHINE_WAIT_STALLED_MS = 60_000;
export const MACHINE_WAIT_STALLED_HINT =
  "Having trouble? Re-run the install command — it's safe to repeat.";
const ELAPSED_TICK_MS = 1_000;

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function MachineWait({ host }: { host: HostOut | null }): React.JSX.Element {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    setElapsedMs(0);
    if (host !== null) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [host]);

  return (
    <Card style={styles.card} testID="machine-wait" variant="flat">
      <Text variant="label">
        {host === null ? "Waiting for your machine…" : `${host.name} is online.`}
      </Text>
      {host === null && elapsedMs >= MACHINE_WAIT_ELAPSED_HINT_MS ? (
        <Text color="mutedForeground" testID="machine-wait-elapsed" variant="caption">
          Elapsed {formatElapsed(elapsedMs)}
        </Text>
      ) : null}
      {host === null && elapsedMs >= MACHINE_WAIT_STALLED_MS ? (
        <Text color="mutedForeground" testID="machine-wait-stalled" variant="caption">
          {MACHINE_WAIT_STALLED_HINT}
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[3],
  },
});
