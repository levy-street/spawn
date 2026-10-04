import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { relativeSeen } from "@/components/hosts/host-model";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import type { HostOut } from "@/data/api/schemas/hosts";
import { haptics } from "@/lib/haptics";
import { spacing } from "@/theme";

export type HostDoctorCase =
  | "online"
  | "never-connected"
  | "auth-rejected"
  | "stale-version"
  | "plain-offline";

export interface HostDoctorPresentation {
  kind: HostDoctorCase;
  message: string;
  command: "spawnd doctor" | "spawnd login" | "spawnd update" | null;
}

export function hostDoctorPresentation(host: HostOut, now = Date.now()): HostDoctorPresentation {
  if (host.status === "online") {
    return {
      kind: "online",
      message: `Daemon ${host.version ?? "unknown"}`,
      command: null,
    };
  }
  if (host.last_seen_at === null) {
    return {
      kind: "never-connected",
      message: "SPAWN D hasn't checked in from this machine yet. On it, run: spawnd doctor",
      command: "spawnd doctor",
    };
  }
  if (host.last_disconnect?.reason === "auth_rejected") {
    return {
      kind: "auth-rejected",
      message: `${host.name} can't sign in. On that machine, run: spawnd login`,
      command: "spawnd login",
    };
  }
  if (host.update?.state === "available" || host.update?.state === "failed") {
    return {
      kind: "stale-version",
      message: `${host.name} runs ${host.version ?? "unknown"}. On it, run: spawnd update (or it will self-update when idle).`,
      command: "spawnd update",
    };
  }
  return {
    kind: "plain-offline",
    message: `Last seen ${relativeSeen(host.last_seen_at, now)} (connection dropped). If the machine is on, run spawnd doctor there.`,
    command: "spawnd doctor",
  };
}

export function HostTroubleshootingPanel({ host }: { host: HostOut }): React.JSX.Element | null {
  const [copied, setCopied] = useState(false);
  const presentation = hostDoctorPresentation(host);
  if (presentation.kind === "online" || presentation.command === null) return null;

  return (
    <Card style={styles.doctorPanel} testID={`host-doctor-${presentation.kind}`} variant="flat">
      <View style={styles.doctorHeading}>
        <Icon color="warning" name="Wrench" size={spacing[5]} />
        <Text variant="label">Something wrong?</Text>
      </View>
      <Text color="mutedForeground">{presentation.message}</Text>
      <Button
        onPress={() => {
          void Clipboard.setStringAsync(presentation.command ?? "").then(() => {
            setCopied(true);
            haptics.success();
          });
        }}
        size="sm"
        variant="outline"
      >
        <Icon color="foreground" name={copied ? "Check" : "Copy"} size={spacing[4]} />
        {copied ? "Copied" : `Copy ${presentation.command}`}
      </Button>
    </Card>
  );
}

const styles = StyleSheet.create({
  doctorHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  doctorPanel: {
    alignItems: "flex-start",
    gap: spacing[3],
  },
});
