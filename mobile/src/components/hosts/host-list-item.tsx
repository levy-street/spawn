import { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { CapacityMeter } from "@/components/hosts/capacity-meter";
import {
  capacityLabel,
  capacityPresentation,
  formatBytes,
  hostConnectionLabel,
  pluralize,
} from "@/components/hosts/host-model";
import { RunningAgents } from "@/components/hosts/running-agents";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { groupRunningAgents } from "@/data/selectors/agent";
import { sessionAttention } from "@/data/selectors/session";
import { haptics } from "@/lib/haptics";
import { borderWidth, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface HostListItemProps {
  host: HostOut;
  /** Sessions on this host. Drives what the row says is running. */
  sessions?: readonly SessionOut[];
  /** Account agents, so a session's command resolves to a known agent. */
  agents?: readonly AgentOut[];
  onOpen(): void;
  onOpenActions(): void;
}

export function HostListItem({
  host,
  sessions = [],
  agents = [],
  onOpen,
  onOpenActions,
}: HostListItemProps) {
  const theme = useTheme();
  const online = host.status === "online";
  const system = `${host.os ?? "unknown"}/${host.arch ?? "unknown"} · daemon ${host.version ?? "unknown"}`;

  const liveSessions = useMemo(
    () => sessions.filter((session) => session.status !== "exited" && session.status !== "killed"),
    [sessions],
  );
  const needYou = sessions.filter((session) => sessionAttention(session) !== null).length;
  const running = useMemo(() => groupRunningAgents(liveSessions, agents), [agents, liveSessions]);

  // The heartbeat's five-level reading, which is all the server is ever given.
  // Exact per-second figures need a direct channel to the daemon, and a list
  // that scrolls is the wrong place to open one per row.
  const capacity = capacityPresentation(host, null);
  const spec = [
    host.cpu_cores === null ? null : pluralize(host.cpu_cores, "core"),
    host.memory_bytes === null ? null : formatBytes(host.memory_bytes),
    host.gpu,
  ].filter((value): value is string => Boolean(value));

  const hasBody =
    capacity.source === "bucketed" || spec.length > 0 || running.length > 0 || needYou > 0;

  return (
    <View testID={`host-row-${host.id}`}>
      <ListRow
        {...(hasBody
          ? {
              body: (
                <>
                  {spec.length > 0 ? (
                    <Text color="mutedForeground" variant="caption">
                      {spec.join(" · ")}
                    </Text>
                  ) : null}
                  {capacity.source === "bucketed" ? <CapacityMeter capacity={capacity} /> : null}
                  {running.length > 0 || needYou > 0 ? (
                    <View style={styles.activity}>
                      <RunningAgents groups={running} testID={`host-running-${host.id}`} />
                      {needYou > 0 ? (
                        <Badge testID={`host-attention-${host.id}`} variant="warning">
                          {`${needYou} need you`}
                        </Badge>
                      ) : null}
                    </View>
                  ) : null}
                </>
              ),
              bodyLabel: hostBodyLabel({
                capacity,
                liveSessions: liveSessions.length,
                needYou,
                spec,
              }),
            }
          : {})}
        height="tall"
        leading={
          <View
            style={[
              styles.machine,
              {
                backgroundColor: theme.colors.muted,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.md,
              },
            ]}
          >
            <Icon color="mutedForeground" name="Server" size={spacing[4]} />
            <StatusDot
              accessibilityLabel={online ? "Online" : "Offline"}
              bordered
              pulse={false}
              style={styles.statusDot}
              testID={`host-status-${host.id}`}
              tone={online ? "active" : "offline"}
            />
          </View>
        }
        onLongPress={() => {
          haptics.impact("medium");
          onOpenActions();
        }}
        onPress={() => {
          haptics.selection();
          onOpen();
        }}
        shape="fullBleed"
        subtitle={`${hostConnectionLabel(host)}\n${system}`}
        title={host.name}
        trailing={
          <View style={styles.trailing}>
            <Badge testID={`host-session-count-${host.id}`} variant="outline">
              {pluralize(host.session_count, "session")}
            </Badge>
            <IconButton
              accessibilityLabel={`Actions for ${host.name}`}
              icon="Ellipsis"
              onPress={onOpenActions}
              size="sm"
            />
          </View>
        }
      />
    </View>
  );
}

/**
 * The body in words, since a screen reader is handed the row as one object and
 * would otherwise be told a name and a heartbeat and nothing about the load.
 */
function hostBodyLabel({
  capacity,
  liveSessions,
  needYou,
  spec,
}: {
  capacity: ReturnType<typeof capacityPresentation>;
  liveSessions: number;
  needYou: number;
  spec: readonly string[];
}): string {
  const parts: string[] = [];
  if (spec.length > 0) parts.push(spec.join(", "));
  if (capacity.source === "bucketed") {
    parts.push(
      `CPU ${capacityLabel(capacity.cpuSegments)}`,
      `memory ${capacityLabel(capacity.memorySegments)}`,
    );
  }
  if (liveSessions > 0) parts.push(pluralize(liveSessions, "live session"));
  if (needYou > 0) parts.push(`${needYou} need you`);
  return parts.join(", ");
}

const styles = StyleSheet.create({
  activity: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing[2],
  },
  machine: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    height: sizing.listRow.leading.rich,
    justifyContent: "center",
    position: "relative",
    width: sizing.listRow.leading.rich,
  },
  statusDot: {
    bottom: -spacing[0.5],
    position: "absolute",
    right: -spacing[0.5],
  },
  trailing: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[1],
  },
});
