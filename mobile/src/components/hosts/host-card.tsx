import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { CapacityMeter } from "@/components/hosts/capacity-meter";
import {
  capacityLabel,
  capacityPresentation,
  formatBytes,
  type HostMetrics,
  hostConnectionLabel,
  pluralize,
} from "@/components/hosts/host-model";
import { HostUpdateBadge, hostUpdateLabel } from "@/components/hosts/host-update-status";
import { LiveCapacityProbe } from "@/components/hosts/live-capacity-probe";
import { RunningAgents } from "@/components/hosts/running-agents";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ListRow } from "@/components/ui/list-row";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { groupRunningAgents } from "@/data/selectors/agent";
import { useHostLiveStatus } from "@/data/stores/host-live";
import { haptics } from "@/lib/haptics";
import type { TransportState } from "@/terminal/transport/types";
import { borderWidth, spacing, useTheme } from "@/theme";
import { sizing } from "@/theme/sizing";

export interface HostCardProps {
  host: HostOut;
  /** Sessions on this host. Drives what the card says is running. */
  sessions?: readonly SessionOut[];
  /** Account agents, so a session's command resolves to a known agent. */
  agents?: readonly AgentOut[];
  /**
   * The card is on screen in the focused Hosts tab of a foregrounded app, so
   * exact figures are worth asking the host for every three seconds. Otherwise
   * it shows the heartbeat's five-level reading and holds no channel open.
   */
  liveCapacity?: boolean;
  onOpen(): void;
  onOpenActions(): void;
}

/**
 * One host on the Hosts tab.
 *
 * A card is a glance, not a fact sheet: the name, whether this device can
 * reach it, what it has to give, and what is running on it. The OS, the
 * architecture and the daemon version belong to the host's own page — printed
 * on every card they made the list read as an inventory rather than a fleet.
 * Sessions waiting on a person are not counted here either: that is the
 * workspace's business, and a card that nagged about it read as an alert
 * rather than a host.
 */
export function HostCard({
  host,
  sessions = [],
  agents = [],
  liveCapacity = false,
  onOpen,
  onOpenActions,
}: HostCardProps) {
  const theme = useTheme();
  const online = host.status === "online";
  // This device's connection, not only the server's word: a host that is
  // reconnecting says so on its own card, with its Retry, rather than in a
  // banner over every screen.
  const live = useHostLiveStatus(host);
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [transportState, setTransportState] = useState<TransportState>("idle");
  const [liveError, setLiveError] = useState<string | null>(null);

  const liveSessions = useMemo(
    () => sessions.filter((session) => session.status !== "exited" && session.status !== "killed"),
    [sessions],
  );
  const running = useMemo(() => groupRunningAgents(liveSessions, agents), [agents, liveSessions]);

  useEffect(() => {
    if (liveCapacity) return;
    setMetrics(null);
    setLiveError(null);
    setTransportState("idle");
  }, [liveCapacity]);

  // Exact figures travel only over this device's own channel to the host; the
  // server is only ever given the heartbeat's five-level reading.
  const canProbe = liveCapacity && online && host.host_public_key !== null;
  const capacity = capacityPresentation(host, canProbe ? metrics : null);
  // Said once the host has answered without a sample (telemetry turned off, or
  // a daemon too old to offer one), or when it has no key to open a channel
  // with. A connection that failed is the reconnect line's to explain.
  const liveUnavailable =
    liveCapacity &&
    online &&
    (host.host_public_key === null ||
      (transportState === "ready" && metrics === null && liveError !== null));
  const spec = [
    host.cpu_cores === null ? null : pluralize(host.cpu_cores, "core"),
    host.memory_bytes === null ? null : formatBytes(host.memory_bytes),
  ].filter((value): value is string => Boolean(value));
  const subtitle = [hostConnectionLabel(host), ...spec].join(" · ");

  const showCapacity = online && capacity.source !== "unavailable";
  const updateLabel = hostUpdateLabel(host);
  const hasBody = showCapacity || liveUnavailable || running.length > 0 || updateLabel !== null;

  return (
    <View testID={`host-row-${host.id}`}>
      <ListRow
        {...(hasBody
          ? {
              body: (
                <>
                  <HostUpdateBadge host={host} />
                  {showCapacity ? <CapacityMeter capacity={capacity} compact /> : null}
                  {liveUnavailable ? (
                    <Text color="mutedForeground" variant="caption">
                      This host does not report live capacity.
                    </Text>
                  ) : null}
                  {running.length > 0 ? (
                    <RunningAgents groups={running} testID={`host-running-${host.id}`} />
                  ) : null}
                </>
              ),
              bodyLabel: hostBodyLabel({
                capacity: showCapacity ? capacity : { source: "unavailable" },
                liveSessions: liveSessions.length,
                sessionCount: host.session_count,
                updateLabel,
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
              accessibilityLabel={live.status.label}
              bordered
              pulse={live.status.reconnecting}
              style={styles.statusDot}
              testID={`host-status-${host.id}`}
              tone={live.status.tone}
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
        subtitle={subtitle}
        title={host.name}
        trailing={
          <IconButton
            accessibilityLabel={`Actions for ${host.name}`}
            icon="Ellipsis"
            onPress={onOpenActions}
            size="lg"
          />
        }
        trailingPlacement="action"
      />
      {live.status.reconnecting ? (
        // Beside the row, not in it: a control inside the row's press target
        // would be folded into the row for assistive tech and never reached.
        <View style={styles.reconnect} testID={`host-reconnect-${host.id}`}>
          <Text color="warning" numberOfLines={2} style={styles.reconnectLabel} variant="caption">
            {live.status.label}
          </Text>
          {live.retry ? (
            <Button
              accessibilityLabel={`Retry connection to ${host.name}`}
              onPress={() => {
                haptics.selection();
                live.retry?.();
              }}
              size="sm"
              variant="secondary"
            >
              Retry
            </Button>
          ) : null}
        </View>
      ) : null}
      <LiveCapacityProbe
        enabled={canProbe}
        hostId={host.id}
        hostIdentityPublicKey={host.host_public_key}
        onMetrics={(next) => {
          setMetrics(next);
          if (next !== null) setLiveError(null);
        }}
        onStateChange={setTransportState}
        onUnavailable={setLiveError}
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
  sessionCount,
  updateLabel,
}: {
  capacity: ReturnType<typeof capacityPresentation>;
  liveSessions: number;
  sessionCount: number;
  updateLabel: string | null;
}): string {
  const parts: string[] = [];
  if (updateLabel) parts.push(updateLabel);
  if (capacity.source === "bucketed") {
    parts.push(
      `CPU ${capacityLabel(capacity.cpuSegments)}`,
      `memory ${capacityLabel(capacity.memorySegments)}`,
    );
  } else if (capacity.source === "exact") {
    parts.push(
      `CPU ${Math.round(capacity.cpuPercent)}%`,
      `memory ${Math.round(capacity.memoryPercent)}%`,
    );
  }
  parts.push(pluralize(liveSessions > 0 ? liveSessions : sessionCount, "session"));
  return parts.join(", ");
}

const styles = StyleSheet.create({
  machine: {
    alignItems: "center",
    borderWidth: borderWidth.hairline,
    height: sizing.listRow.leading.rich,
    justifyContent: "center",
    position: "relative",
    width: sizing.listRow.leading.rich,
  },
  reconnect: {
    alignItems: "center",
    flexDirection: "row",
    gap: sizing.listRow.contentGap,
    // Drawn as the row's last line: the body's gap from the copy above, not a
    // second row's padding.
    marginTop: sizing.listRow.bodyGap - sizing.listRow.verticalPadding,
    paddingBottom: sizing.listRow.verticalPadding,
    paddingHorizontal: sizing.listRow.horizontalPadding,
  },
  reconnectLabel: {
    flex: 1,
    minWidth: 0,
  },
  statusDot: {
    bottom: -spacing[0.5],
    position: "absolute",
    right: -spacing[0.5],
  },
});
