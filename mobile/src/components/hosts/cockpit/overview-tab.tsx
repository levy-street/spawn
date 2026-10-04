import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { CapacityMeter } from "@/components/hosts/capacity-meter";
import {
  hostFolders,
  isHomeFolder,
  memoryFigure,
  runningHere,
  windowBlockedReason,
} from "@/components/hosts/cockpit/cockpit-model";
import { filesBlocked } from "@/components/hosts/cockpit/files-tab";
import { HostAgentsSection } from "@/components/hosts/cockpit/host-agents-section";
import { HostOfferEntries, HostOfferPanels } from "@/components/hosts/cockpit/host-offer-slots";
import { HostMachineFacts } from "@/components/hosts/host-facts";
import {
  type CapacityPresentation,
  capacityPresentation,
  formatDuration,
  type HostMetrics,
  pluralize,
} from "@/components/hosts/host-model";
import { HostSessionRow } from "@/components/hosts/host-session-row";
import { HostTroubleshootingPanel } from "@/components/hosts/host-troubleshooting";
import { HOST_IDENTITY_BLOCKED_REASON } from "@/components/hosts/host-trust-copy";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { ListGroup } from "@/components/ui/list-group";
import { ListRow } from "@/components/ui/list-row";
import { SectionHeader } from "@/components/ui/section-header";
import { Text } from "@/components/ui/text";
import type { AgentOut } from "@/data/api/schemas/agents";
import type { HostOut } from "@/data/api/schemas/hosts";
import type { SessionOut } from "@/data/api/schemas/sessions";
import type { HostOffers } from "@/data/selectors/host-offers";
import { displayPath } from "@/data/selectors/places";
import { isLiveSession } from "@/data/selectors/session";
import { opacity, spacing, useTheme } from "@/theme";

export interface OverviewTabProps {
  host: HostOut;
  /** This host's windows. */
  sessions: readonly SessionOut[];
  /** Account agents, so a window's command resolves to a known agent. */
  agents: readonly AgentOut[];
  /** Exact figures, while they are being asked for. */
  metrics: HostMetrics | null;
  /** The host answered without figures (telemetry off, or a daemon too old). */
  metricsUnavailable: boolean;
  /** Nothing here reaches the host while its identity is in question. */
  identityConflict: boolean;
  offers: HostOffers;
  refreshing: boolean;
  onRefresh(): void;
  onOpenSession(session: SessionOut): void;
  onOpenAllSessions(): void;
  onOpenFolder(path: string): void;
  onFolderActions(path: string): void;
  onOpenUpdate(): void;
}

/**
 * The host right now: its load, the machine, what runs on it and where, and
 * which agents it has. Its live figures are asked for only while this tab is
 * the one on screen (the cockpit decides), every three seconds.
 */
export function OverviewTab({
  host,
  sessions,
  agents,
  metrics,
  metricsUnavailable,
  identityConflict,
  offers,
  refreshing,
  onRefresh,
  onOpenSession,
  onOpenAllSessions,
  onOpenFolder,
  onFolderActions,
  onOpenUpdate,
}: OverviewTabProps): React.JSX.Element {
  const theme = useTheme();
  const online = host.status === "online";
  const capacity = capacityPresentation(host, online ? metrics : null);
  const running = runningHere(sessions);
  const liveCount = sessions.filter(isLiveSession).length;
  const folders = hostFolders(sessions);
  // A folder opens in Files, which needs a live connection this device
  // trusts; its menu opens a window there, which needs the host online.
  const browsable = filesBlocked(host, identityConflict) === null;
  const windowBlocked = windowBlockedReason(host, identityConflict);

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          onRefresh={onRefresh}
          refreshing={refreshing}
          tintColor={theme.colors.mutedForeground}
        />
      }
      testID="host-overview"
    >
      <HostTroubleshootingPanel host={host} />
      <HostOfferEntries host={host} offers={offers} />

      {online ? (
        <RightNow
          capacity={capacity}
          hostName={host.name}
          metrics={metrics}
          unavailable={metricsUnavailable && metrics === null}
        />
      ) : null}

      <HostMachineFacts host={host} liveSpec={metrics?.spec ?? null} onOpenUpdate={onOpenUpdate} />

      <View style={styles.section} testID="host-running-here">
        <SectionHeader
          style={styles.sectionHeader}
          title="Running here"
          trailing={
            <Text color="mutedForeground" variant="caption">
              {liveCount}
            </Text>
          }
        />
        {running.length === 0 ? (
          <Text color="mutedForeground" variant="body">
            Nothing is running here.
          </Text>
        ) : null}
        {/* Always there: the Sessions tab lists ended windows too. */}
        <ListGroup>
          {running.map((session) => (
            <HostSessionRow
              agents={agents}
              key={session.id}
              onOpen={onOpenSession}
              session={session}
            />
          ))}
          <ListRow
            onPress={onOpenAllSessions}
            shape="fullBleed"
            title="All sessions"
            trailing={<Icon color="mutedForeground" name="ChevronRight" />}
          />
        </ListGroup>
      </View>

      <View style={styles.section} testID="host-folders">
        <SectionHeader style={styles.sectionHeader} title="Folders" />
        <ListGroup>
          {folders.map((folder) => {
            const label = displayPath(folder.path);
            const home = isHomeFolder(folder.path);
            return (
              <View
                key={folder.path}
                style={{ opacity: browsable ? opacity.opaque : opacity.disabled }}
                testID={`host-folder-${folder.path}`}
              >
                <ListRow
                  leading={
                    <Icon
                      color="mutedForeground"
                      name={home ? "Home" : "Folder"}
                      size={spacing[5]}
                    />
                  }
                  {...(browsable ? { onPress: () => onOpenFolder(folder.path) } : {})}
                  shape="fullBleed"
                  subtitle={
                    identityConflict
                      ? HOST_IDENTITY_BLOCKED_REASON
                      : folder.windows > 0
                        ? `${pluralize(folder.windows, "window")} here`
                        : "Home"
                  }
                  title={label}
                  trailing={
                    <IconButton
                      accessibilityLabel={`Actions for ${label}`}
                      disabled={windowBlocked !== null}
                      icon="Ellipsis"
                      onPress={() => onFolderActions(folder.path)}
                      size="lg"
                      {...(windowBlocked === null ? {} : { accessibilityHint: windowBlocked })}
                    />
                  }
                  trailingPlacement="action"
                />
              </View>
            );
          })}
        </ListGroup>
      </View>

      <HostAgentsSection host={host} />
      <HostOfferPanels host={host} offers={offers} />
    </ScrollView>
  );
}

/**
 * How hard the host is working: exact figures over this device's own channel
 * once they arrive, marked live, and the heartbeat's five-level reading until
 * then. With neither, it says what the figures wait on; a host that reports
 * none says so. The browser shows the same section in the same words.
 */
function RightNow({
  capacity,
  hostName,
  metrics,
  unavailable,
}: {
  capacity: CapacityPresentation;
  hostName: string;
  metrics: HostMetrics | null;
  /** The host answered without figures (telemetry off, or a daemon too old). */
  unavailable: boolean;
}): React.JSX.Element {
  const sample = metrics?.sample ?? null;
  return (
    <View style={styles.section} testID="host-right-now">
      <SectionHeader
        style={styles.sectionHeader}
        title="Right now"
        trailing={
          sample ? (
            <Text color="mutedForeground" style={styles.liveTag} variant="micro">
              live
            </Text>
          ) : undefined
        }
      />
      {capacity.source !== "unavailable" ? <CapacityMeter capacity={capacity} /> : null}
      {sample ? (
        <View style={styles.figures} testID="host-right-now-figures">
          <Figure
            label="Memory"
            value={memoryFigure(sample.memory_used_bytes, sample.memory_total_bytes) ?? "—"}
          />
          <Figure label="Load" value={sample.load_one == null ? "—" : sample.load_one.toFixed(2)} />
          <Figure
            label="Up"
            value={sample.uptime_seconds > 0 ? formatDuration(sample.uptime_seconds) : "—"}
          />
        </View>
      ) : null}
      {!sample && capacity.source === "unavailable" && !unavailable ? (
        <Text color="mutedForeground" variant="caption">
          {`Live figures appear here while SPAWN D can reach ${hostName}.`}
        </Text>
      ) : null}
      {unavailable ? (
        <Text color="mutedForeground" variant="caption">
          This host does not report live capacity.
        </Text>
      ) : null}
    </View>
  );
}

/**
 * One exact figure, read whole: in a narrow column it wraps — between the
 * amounts of "89 GiB of 125 GiB", never inside one — rather than being cut
 * short, since a phone has nowhere else to show the rest.
 */
function Figure({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={`${label} ${value.replaceAll("\u00a0", " ")}`}
      style={styles.figure}
    >
      <Text color="mutedForeground" variant="caption">
        {label}
      </Text>
      <Text testID={`host-figure-${label.toLowerCase()}`} variant="body">
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing[8],
    padding: spacing[4],
    paddingBottom: spacing[8],
  },
  figure: {
    flex: 1,
    gap: spacing[0.5],
    minWidth: 0,
  },
  figures: {
    flexDirection: "row",
    gap: spacing[4],
  },
  liveTag: {
    textTransform: "uppercase",
  },
  section: {
    gap: spacing[3],
  },
  sectionHeader: {
    paddingHorizontal: spacing[0],
  },
});
