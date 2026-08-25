import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SetupClaimStatus } from "@/data/api/schemas/setup";
import { spacing } from "@/theme";

export const SETUP_WAIT_ELAPSED_HINT_MS = 30_000;
export const SETUP_WAIT_STALLED_MS = 60_000;
const ELAPSED_TICK_MS = 1_000;

export const SETUP_CHECKLIST_LABELS = [
  "Command copied",
  "Machine registered",
  "Approved",
  "Online",
] as const;

export const SETUP_STALLED_HINTS = [
  "Having trouble? Re-run the install command — it's safe to repeat.",
  "The machine is waiting for your approval below.",
  "Approved. Waiting for the machine to come online — this usually takes a few seconds.",
] as const;

export interface SetupChecklistState {
  completed: readonly [boolean, boolean, boolean, boolean];
  waitingIndex: number | null;
}

export function setupChecklistState(input: {
  commandCopied: boolean;
  claim: SetupClaimStatus | null;
  hosts: readonly HostOut[];
}): SetupChecklistState {
  const registered = input.claim?.status === "ready" || input.claim?.status === "approved";
  const approved = input.claim?.status === "approved";
  const hostId = input.claim?.host_id ?? null;
  const online =
    approved &&
    hostId !== null &&
    input.hosts.some((host) => host.id === hostId && host.status === "online");
  const completed = [input.commandCopied, registered, approved, online] as const;
  const next = completed.findIndex((value) => !value);
  return { completed, waitingIndex: next < 0 ? null : next };
}

function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function stalledHint(waitingIndex: number): string {
  if (waitingIndex <= 1) return SETUP_STALLED_HINTS[0];
  if (waitingIndex === 2) return SETUP_STALLED_HINTS[1];
  return SETUP_STALLED_HINTS[2];
}

export function SetupChecklist({
  claim,
  commandCopied,
  hosts,
  onEnterCode,
  onExit,
}: {
  claim: SetupClaimStatus | null;
  commandCopied: boolean;
  hosts: readonly HostOut[];
  onEnterCode(): void;
  onExit?: () => void;
}): React.JSX.Element {
  const state = setupChecklistState({ claim, commandCopied, hosts });
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    setElapsedMs(0);
    if (state.waitingIndex === null) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [state.waitingIndex]);

  return (
    <Card style={styles.card} testID="setup-checklist" variant="flat">
      <Text variant="label">Setup progress</Text>
      <View style={styles.steps}>
        {SETUP_CHECKLIST_LABELS.map((label, index) => {
          const complete = state.completed[index] ?? false;
          return (
            <View key={label} style={styles.step} testID={`setup-step-${index}`}>
              <Icon
                color={complete ? "success" : "mutedForeground"}
                name={complete ? "CheckCircle2" : "Circle"}
                size={spacing[5]}
              />
              <Text color={complete ? "foreground" : "mutedForeground"}>{label}</Text>
            </View>
          );
        })}
      </View>
      {state.waitingIndex !== null && elapsedMs >= SETUP_WAIT_ELAPSED_HINT_MS ? (
        <Text color="mutedForeground" testID="setup-elapsed" variant="caption">
          Elapsed {formatElapsed(elapsedMs)}
        </Text>
      ) : null}
      {state.waitingIndex !== null && elapsedMs >= SETUP_WAIT_STALLED_MS ? (
        <View style={styles.stalled}>
          <Text color="mutedForeground" testID="setup-stalled" variant="caption">
            {stalledHint(state.waitingIndex)}
          </Text>
          {state.waitingIndex < 3 ? (
            <Button onPress={onEnterCode} size="sm" variant="outline">
              Enter pairing code
            </Button>
          ) : onExit !== undefined ? (
            <Button onPress={onExit} size="sm" variant="outline">
              Finish later
            </Button>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing[4],
  },
  stalled: {
    alignItems: "flex-start",
    gap: spacing[3],
  },
  step: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  steps: {
    gap: spacing[3],
  },
});
