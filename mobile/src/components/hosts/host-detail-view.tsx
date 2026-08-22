import { Pressable, StyleSheet, View } from "react-native";
import { HostFacts } from "@/components/hosts/host-facts";
import { hostConnectionLabel } from "@/components/hosts/host-model";
import { HostSessionList } from "@/components/hosts/host-session-list";
import { Icon, type IconName } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { borderWidth, chrome, opacity, spacing, useTheme } from "@/theme";

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
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.destination,
        {
          backgroundColor: pressed ? theme.colors.accent : "transparent",
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          minHeight: chrome.touchTarget + spacing[3],
          opacity: disabled ? opacity.disabled : opacity.opaque,
        },
      ]}
    >
      <Icon color="mutedForeground" name={icon} size={spacing[5]} />
      <View style={styles.destinationCopy}>
        <Text variant="label">{label}</Text>
        <Text color="mutedForeground" variant="caption">
          {detail}
        </Text>
      </View>
      <Icon color="mutedForeground" name="ChevronRight" />
    </Pressable>
  );
}

export interface HostDetailViewProps {
  agents: readonly AgentOut[];
  host: HostOut;
  sessions: readonly SessionOut[];
  onOpenAgents(): void;
  onOpenFiles(): void;
  onOpenSession(session: SessionOut): void;
}

export function HostDetailView({
  agents,
  host,
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
      <View style={styles.destinations}>
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
      </View>
      <HostFacts host={host} />
      <HostSessionList agents={agents} onOpen={onOpenSession} sessions={sessions} />
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[8],
    padding: spacing[4],
  },
  destination: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    flexDirection: "row",
    gap: spacing[3],
    padding: spacing[3],
  },
  destinationCopy: {
    flex: 1,
    gap: spacing[1],
  },
  destinations: {
    gap: spacing[2],
  },
  hero: {
    gap: spacing[2],
  },
  statusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
});
