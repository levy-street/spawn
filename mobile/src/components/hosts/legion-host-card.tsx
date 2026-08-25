import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { CapacityMeter } from "@/components/hosts/capacity-meter";
import {
  capacityPresentation,
  formatBytes,
  type HostMetrics,
  pluralize,
} from "@/components/hosts/host-model";
import { HostUpdateBadge } from "@/components/hosts/host-update-status";
import { LiveCapacityProbe } from "@/components/hosts/live-capacity-probe";
import { RunningAgents } from "@/components/hosts/running-agents";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import { groupRunningAgents } from "@/data/selectors/agent";
import { sessionAttention } from "@/data/selectors/session";
import { haptics } from "@/lib/haptics";
import type { TransportState } from "@/terminal/transport/types";
import { spacing, useTheme } from "@/theme";

export interface LegionHostCardProps {
  agents: readonly AgentOut[];
  host: HostOut;
  liveEnabled: boolean;
  sessions: readonly SessionOut[];
  onOpen(): void;
}

export function LegionHostCard({
  agents,
  host,
  liveEnabled,
  sessions,
  onOpen,
}: LegionHostCardProps) {
  const theme = useTheme();
  const [metrics, setMetrics] = useState<HostMetrics | null>(null);
  const [transportState, setTransportState] = useState<TransportState>("idle");
  const [liveError, setLiveError] = useState<string | null>(null);
  const online = host.status === "online";
  const liveSessions = sessions.filter(
    (session) => session.status !== "exited" && session.status !== "killed",
  );
  const needYou = sessions.filter((session) => sessionAttention(session) !== null).length;
  const runningAgents = useMemo(
    () => groupRunningAgents(liveSessions, agents),
    [agents, liveSessions],
  );

  useEffect(() => {
    if (liveEnabled) return;
    setMetrics(null);
    setLiveError(null);
    setTransportState("idle");
  }, [liveEnabled]);

  const capacity = capacityPresentation(host, liveEnabled ? metrics : null);
  const canProbe = liveEnabled && online && host.host_public_key !== null;
  const liveUnavailable =
    liveEnabled &&
    online &&
    (host.host_public_key === null ||
      ((transportState === "ready" || transportState === "failed") &&
        metrics === null &&
        liveError !== null));

  return (
    <Pressable
      accessibilityLabel={`Open ${host.name}`}
      accessibilityRole="button"
      onPress={() => {
        haptics.selection();
        onOpen();
      }}
      testID={`legion-host-${host.id}`}
    >
      {({ pressed }) => (
        <Card
          style={{ backgroundColor: pressed ? theme.colors.accent : theme.colors.card }}
          variant="flat"
        >
          <View style={styles.heading}>
            <StatusDot
              accessibilityLabel={online ? "Online" : "Offline"}
              pulse={false}
              tone={online ? "active" : "offline"}
            />
            <View style={styles.headingCopy}>
              <Text numberOfLines={1} variant="label">
                {host.name}
              </Text>
              <Text color="mutedForeground" variant="caption">
                {online ? (host.os ?? "unknown") : "Offline"}
              </Text>
            </View>
            {liveEnabled && metrics !== null ? <Badge variant="success">Live</Badge> : null}
            <HostUpdateBadge host={host} />
            <Icon color="mutedForeground" name="ChevronRight" />
          </View>
          {host.cpu_cores !== null || host.memory_bytes !== null || host.gpu !== null ? (
            <Text color="mutedForeground" variant="caption">
              {[
                host.cpu_cores === null ? null : pluralize(host.cpu_cores, "core"),
                host.memory_bytes === null ? null : formatBytes(host.memory_bytes),
                host.gpu,
              ]
                .filter((value): value is string => Boolean(value))
                .join(" · ")}
            </Text>
          ) : null}
          {online ? <CapacityMeter capacity={capacity} /> : null}
          {liveEnabled && online && metrics === null && !liveUnavailable ? (
            <Text color="mutedForeground" variant="caption">
              Connecting live capacity…
            </Text>
          ) : null}
          {liveUnavailable ? (
            <Text color="mutedForeground" variant="caption">
              This host does not report live capacity.
            </Text>
          ) : null}
          <View style={styles.summary}>
            <Text color="mutedForeground" variant="caption">
              {pluralize(liveSessions.length, "live session")}
            </Text>
            {needYou > 0 ? <Badge variant="warning">{`${needYou} need you`}</Badge> : null}
          </View>
          <RunningAgents groups={runningAgents} />
          <LiveCapacityProbe
            enabled={canProbe}
            hostId={host.id}
            hostIdentityPublicKey={host.host_public_key}
            onMetrics={(next) => {
              setMetrics(next);
              setLiveError(null);
            }}
            onStateChange={setTransportState}
            onUnavailable={setLiveError}
          />
        </Card>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  heading: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  headingCopy: {
    flex: 1,
    minWidth: 0,
  },
  summary: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
});
