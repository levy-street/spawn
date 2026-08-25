import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { HostFacts } from "@/components/hosts/host-facts";
import { hostConnectionLabel, relativeSeen } from "@/components/hosts/host-model";
import { HostSessionList } from "@/components/hosts/host-session-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Icon, type IconName } from "@/components/ui/icon";
import { ListGroup } from "@/components/ui/list-group";
import { ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { BrowserDeviceOut } from "@/data/api/schemas/devices";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { HostPinCapacity, HostPinsOut } from "@/data/api/schemas/trust";
import { haptics } from "@/lib/haptics";
import { opacity, spacing } from "@/theme";

function DestinationRow({
  detail,
  disabled,
  icon,
  label,
  onPress,
}: {
  detail: string;
  disabled?: boolean;
  icon: IconName;
  label: string;
  onPress(): void;
}) {
  return (
    <View
      pointerEvents={disabled ? "none" : "auto"}
      style={{ opacity: disabled ? opacity.disabled : opacity.opaque }}
    >
      <ListRow
        height="tall"
        leading={<Icon color="mutedForeground" name={icon} size={spacing[5]} />}
        {...(disabled
          ? {}
          : {
              onPress: () => {
                haptics.selection();
                onPress();
              },
            })}
        shape="fullBleed"
        subtitle={detail}
        title={label}
        trailing={<Icon color="mutedForeground" name="ChevronRight" />}
      />
    </View>
  );
}

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

function HostTroubleshootingPanel({ host }: { host: HostOut }): React.JSX.Element | null {
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

export function hostPinCapacityWarning(capacity: HostPinCapacity | null): string | null {
  if (capacity === null || capacity.used < 28) return null;
  return `This host is close to its limit of approving devices (${capacity.used} of ${capacity.max}). Remove devices you no longer use under Access.`;
}

function HostApprovingDevices({
  devices,
  hostPins,
}: {
  devices: readonly BrowserDeviceOut[];
  hostPins: HostPinsOut;
}): React.JSX.Element {
  const labels = new Map(devices.map((device) => [device.id, device.label ?? "Unnamed device"]));
  const warning = hostPinCapacityWarning(hostPins.capacity);
  const title =
    hostPins.capacity === null
      ? "Approving devices"
      : `Approving devices · ${hostPins.capacity.used} of ${hostPins.capacity.max}`;

  return (
    <View style={styles.approvingDevices} testID="host-approving-devices">
      <Text variant="label">{title}</Text>
      {warning ? (
        <Card style={styles.capacityWarning} testID="host-device-capacity-warning" variant="flat">
          <Icon color="warning" name="ShieldAlert" size={spacing[5]} />
          <Text color="mutedForeground" style={styles.capacityCopy}>
            {warning}
          </Text>
        </Card>
      ) : null}
      {hostPins.pins.length === 0 ? (
        <Text color="mutedForeground">No devices are approved for this host.</Text>
      ) : (
        <ListGroup openingRule>
          {hostPins.pins.map((pin) => (
            <ListRow
              key={pin.browser_device_id}
              shape="fullBleed"
              subtitle={pin.delivered ? "Approved for this host" : "Approval needs attention"}
              title={labels.get(pin.browser_device_id) ?? "Unknown device"}
              {...(pin.delivered
                ? {}
                : { trailing: <Badge variant="warning">Not delivered</Badge> })}
            />
          ))}
        </ListGroup>
      )}
    </View>
  );
}

export interface HostDetailViewProps {
  agents: readonly AgentOut[];
  browserDevices?: readonly BrowserDeviceOut[];
  host: HostOut;
  hostPins?: HostPinsOut | null;
  sessions: readonly SessionOut[];
  onOpenAgents(): void;
  onOpenFiles(): void;
  onOpenSession(session: SessionOut): void;
}

export function HostDetailView({
  agents,
  browserDevices = [],
  host,
  hostPins = null,
  sessions,
  onOpenAgents,
  onOpenFiles,
  onOpenSession,
}: HostDetailViewProps) {
  const online = host.status === "online";
  return (
    <View style={styles.content}>
      <View style={styles.hero}>
        <View style={styles.statusRow}>
          <StatusDot
            accessibilityLabel={online ? "Online" : "Offline"}
            pulse={false}
            tone={online ? "active" : "offline"}
          />
          <Text color="mutedForeground" variant="body">
            {hostConnectionLabel(host)}
          </Text>
        </View>
        <Text color="mutedForeground" variant="body">
          {host.os ?? "unknown"} · {host.arch ?? "unknown"} · daemon {host.version ?? "unknown"}
        </Text>
      </View>
      <HostTroubleshootingPanel host={host} />
      {/* No heading over these, so the group opens with its own rule. */}
      <ListGroup openingRule testID="host-destinations">
        <DestinationRow
          detail={online ? "Browse this machine" : "Unavailable while the daemon is offline"}
          disabled={!online}
          icon="FolderTree"
          label="Files"
          onPress={onOpenFiles}
        />
        <DestinationRow
          detail={online ? "Availability, installs, updates and skills" : "Availability is offline"}
          icon="Bot"
          label="Agents & skills"
          onPress={onOpenAgents}
        />
      </ListGroup>
      <HostFacts host={host} />
      {hostPins ? <HostApprovingDevices devices={browserDevices} hostPins={hostPins} /> : null}
      <HostSessionList agents={agents} onOpen={onOpenSession} sessions={sessions} />
    </View>
  );
}

const styles = StyleSheet.create({
  approvingDevices: {
    gap: spacing[3],
  },
  capacityCopy: {
    flex: 1,
  },
  capacityWarning: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: spacing[3],
  },
  content: {
    gap: spacing[8],
    padding: spacing[4],
  },
  hero: {
    gap: spacing[2],
  },
  doctorHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  doctorPanel: {
    alignItems: "flex-start",
    gap: spacing[3],
  },
  statusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
});
