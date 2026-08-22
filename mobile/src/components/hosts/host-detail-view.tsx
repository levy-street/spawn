import { StyleSheet, View } from "react-native";
import { HostFacts } from "@/components/hosts/host-facts";
import { hostConnectionLabel } from "@/components/hosts/host-model";
import { HostSessionList } from "@/components/hosts/host-session-list";
import { Card } from "@/components/ui/card";
import { Icon, type IconName } from "@/components/ui/icon";
import { ListRow, ListSeparator } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
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
      <Card padded={false} style={styles.destinations} variant="flat">
        <DestinationRow
          detail={online ? "Browse this machine" : "Unavailable while the daemon is offline"}
          disabled={!online}
          icon="FolderTree"
          label="Files"
          onPress={onOpenFiles}
        />
        <ListSeparator />
        <DestinationRow
          detail={online ? "Availability, installs, updates and skills" : "Availability is offline"}
          icon="Bot"
          label="Agents & skills"
          onPress={onOpenAgents}
        />
      </Card>
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
  destinations: {
    gap: spacing[0],
    overflow: "hidden",
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
