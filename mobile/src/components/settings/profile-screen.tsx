import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { type LayoutChangeEvent, StyleSheet, View } from "react-native";
import {
  formatProfileDuration,
  formatProfileMemory,
  profileStatsLine,
} from "@/components/settings/profile-format";
import { SettingsBlock } from "@/components/settings/settings-block";
import { SettingsInfoRow } from "@/components/settings/settings-row";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { SettingsSection } from "@/components/settings/settings-section";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon, type IconName } from "@/components/ui/icon";
import { Monogram } from "@/components/ui/monogram";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { Text } from "@/components/ui/text";
import { useToast } from "@/components/ui/toast";
import type { LegionDayOut } from "@/data/api/schemas/legion";
import { useProfileSettingsQuery } from "@/data/queries/settings";
import { haptics } from "@/lib/haptics";
import {
  alpha,
  borderWidth,
  displayLineHeightRatio,
  fontFamily,
  fontSize,
  opacity,
  spacing,
  useTheme,
} from "@/theme";

/** How many days a week has, which is also how many rows the heatmap draws. */
const WEEK = 7;
/** A day's cell never grows past this, however few weeks there are to draw. */
const MAX_CELL = spacing[4];
const DAY_MS = 24 * 60 * 60 * 1000;

function isoDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Every day of the window, quiet ones included. The server only sends days
 * that had sessions, and a heatmap built from those alone was two cells wide
 * on a new account — and, sized to fill the width, two enormous squares.
 */
export function heatmapWindow(
  days: readonly LegionDayOut[],
  today: string,
  historyDays: number,
): LegionDayOut[] {
  const byDay = new Map(days.map((day) => [day.day, day]));
  const end = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(end) || historyDays <= 0) return [...days];
  const window: LegionDayOut[] = [];
  for (let offset = historyDays - 1; offset >= 0; offset -= 1) {
    const day = isoDay(end - offset * DAY_MS);
    window.push(
      byDay.get(day) ?? {
        day,
        sessions_started: 0,
        session_seconds: 0,
        peak_sessions: 0,
        peak_hosts_online: 0,
      },
    );
  }
  return window;
}

/** A day's place in a Monday-first week: 0 for Monday, 6 for Sunday. */
export function weekdayIndex(day: string): number {
  return (new Date(`${day}T00:00:00Z`).getUTCDay() + WEEK - 1) % WEEK;
}

/**
 * The days laid out as the calendar has them — one column per week, Monday at
 * the top — with empty cells before the first day so it lands on its weekday.
 */
export function heatmapColumns(days: readonly LegionDayOut[]): (LegionDayOut | null)[][] {
  const first = days[0];
  if (!first) return [];
  const offset = weekdayIndex(first.day);
  const columns: (LegionDayOut | null)[][] = [];
  for (let index = 0; index < offset + days.length; index += 1) {
    const column = Math.floor(index / WEEK);
    columns[column] ??= [];
    columns[column].push(index < offset ? null : (days[index - offset] ?? null));
  }
  const last = columns.at(-1);
  while (last && last.length < WEEK) last.push(null);
  return columns;
}

function Tile({
  icon,
  label,
  value,
}: {
  icon: IconName;
  label: string;
  value: string | number;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.tile,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
        },
      ]}
    >
      <Icon color="mutedForeground" name={icon} size={spacing[4]} />
      <Text numberOfLines={1} variant="uiXl" weight="semibold">
        {value}
      </Text>
      <Text color="mutedForeground" numberOfLines={1} variant="caption">
        {label}
      </Text>
    </View>
  );
}

function Heatmap({ days }: { days: readonly LegionDayOut[] }): React.JSX.Element | null {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const columns = heatmapColumns(days);
  if (columns.length === 0) return null;
  const max = Math.max(1, ...days.map((day) => day.sessions_started));
  const gap = spacing[1];
  const cell =
    width > 0
      ? Math.min(
          MAX_CELL,
          Math.max(spacing[1], Math.floor((width - gap * (columns.length - 1)) / columns.length)),
        )
      : spacing[3];

  const shade = (day: LegionDayOut) => {
    const ratio = day.sessions_started / max;
    if (day.sessions_started === 0) return { backgroundColor: theme.colors.muted };
    if (ratio <= 1 / 3) return { backgroundColor: theme.colors.brandAccentSoft };
    if (ratio <= 2 / 3) return { backgroundColor: theme.colors.brandAccent, opacity: alpha.a60 };
    return { backgroundColor: theme.colors.brandAccent };
  };

  return (
    <View
      accessibilityLabel={`Sessions started per day over the last ${days.length} days`}
      accessibilityRole="image"
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.heatmap, { gap }]}
      testID="profile-heatmap"
    >
      {columns.map((column, columnIndex) => (
        <View key={column.find((day) => day !== null)?.day ?? columnIndex} style={{ gap }}>
          {column.map((day, row) => (
            <View
              accessibilityLabel={
                day ? `${day.day}: ${day.sessions_started} sessions started` : undefined
              }
              key={day?.day ?? `pad-${row}`}
              style={[
                styles.day,
                { borderRadius: theme.radii.sm, height: cell, width: cell },
                day ? shade(day) : styles.pad,
              ]}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

export function ProfileScreen(): React.JSX.Element {
  const theme = useTheme();
  const toast = useToast();
  const profile = useProfileSettingsQuery();

  if (profile.isPending) {
    return (
      <SettingsScreen title="Profile">
        <Skeleton style={styles.loading} />
      </SettingsScreen>
    );
  }
  if (!profile.data) {
    return (
      <SettingsScreen title="Profile">
        <EmptyState
          description={profile.error?.message}
          icon="AlertCircle"
          title="Profile unavailable"
        />
      </SettingsScreen>
    );
  }

  const data = profile.data;
  const totals = data.totals;
  const maxAgentCount = Math.max(1, ...data.agents.map((agent) => agent.count));
  const since = new Date(data.created_at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const heroLine = fontSize.hero * displayLineHeightRatio.r108;

  return (
    <SettingsScreen
      actions={[
        {
          accessibilityLabel: "Copy stats",
          icon: "Copy",
          onPress: () => {
            void Clipboard.setStringAsync(profileStatsLine(data)).then(() => {
              haptics.success();
              toast.success("Stats copied");
            });
          },
          testID: "profile-copy-stats",
        },
      ]}
      testID="profile-screen"
      title="Profile"
    >
      <View style={styles.identity}>
        <Monogram seed={data.email} size={spacing[20]} />
        <View style={styles.identityCopy}>
          <Text numberOfLines={1} variant="uiLg" weight="semibold">
            {data.email}
          </Text>
          <Text color="mutedForeground" variant="caption">
            Possessing machines since {since}
          </Text>
          {totals.current_streak > 0 ? (
            <Badge testID="profile-streak" variant="warning">
              {`🔥 ${totals.current_streak} day streak`}
            </Badge>
          ) : null}
        </View>
      </View>

      {/* The one figure that is the point of the page, set as a poster line. */}
      <View
        style={[
          styles.headline,
          {
            backgroundColor: theme.colors.brandAccentSoft,
            borderColor: theme.colors.brandAccent,
            borderRadius: theme.radii.xl,
          },
        ]}
        testID="profile-headline"
      >
        <View style={styles.headlineRow}>
          <Text
            style={[
              styles.headlineFigure,
              { color: theme.colors.brandAccent, lineHeight: heroLine },
            ]}
          >
            {totals.sessions_started}
          </Text>
          <Icon color="brandAccent" name="Zap" size={spacing[6]} />
        </View>
        <Text variant="label">sessions summoned</Text>
        <Text color="mutedForeground" variant="caption">
          {formatProfileDuration(totals.session_seconds)} at the keyboard · {totals.active_days}{" "}
          active {totals.active_days === 1 ? "day" : "days"}
        </Text>
      </View>

      <View style={styles.grid}>
        <View style={styles.gridRow}>
          <Tile
            icon="Server"
            label="hosts online"
            value={`${totals.hosts_online}/${totals.hosts}`}
          />
          <Tile icon="Activity" label="live now" value={totals.sessions_live} />
        </View>
        <View style={styles.gridRow}>
          <Tile icon="Cpu" label="cores" value={totals.cores} />
          <Tile
            icon="MemoryStick"
            label="memory"
            value={formatProfileMemory(totals.memory_bytes)}
          />
        </View>
      </View>

      <SettingsSection title={`Last ${data.history_days} days`}>
        <SettingsBlock>
          <Heatmap days={heatmapWindow(data.days, data.today, data.history_days)} />
          <View style={styles.legend}>
            <Text color="mutedForeground" variant="micro">
              Quiet
            </Text>
            <View style={[styles.swatch, { backgroundColor: theme.colors.muted }]} />
            <View style={[styles.swatch, { backgroundColor: theme.colors.brandAccentSoft }]} />
            <View
              style={[
                styles.swatch,
                { backgroundColor: theme.colors.brandAccent, opacity: alpha.a60 },
              ]}
            />
            <View style={[styles.swatch, { backgroundColor: theme.colors.brandAccent }]} />
            <Text color="mutedForeground" variant="micro">
              Possessed
            </Text>
          </View>
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection title="Records">
        <View style={styles.grid}>
          <View style={styles.gridRow}>
            <Tile
              icon="Flame"
              label="longest streak"
              value={`${totals.longest_streak} ${totals.longest_streak === 1 ? "day" : "days"}`}
            />
            <Tile
              icon="Timer"
              label="session time"
              value={formatProfileDuration(totals.session_seconds)}
            />
          </View>
          <View style={styles.gridRow}>
            <Tile icon="Trophy" label="most hosts at once" value={totals.peak_hosts_online} />
            <Tile icon="Trophy" label="most sessions at once" value={totals.peak_sessions} />
          </View>
        </View>
      </SettingsSection>

      <SettingsSection title="Machines">
        {data.hosts.length === 0 ? (
          <EmptyState icon="Server" title="No hosts possessed yet." />
        ) : (
          data.hosts.map((host) => {
            const specification = [
              host.cpu_cores ? `${host.cpu_cores} cores` : null,
              host.memory_bytes ? formatProfileMemory(host.memory_bytes) : null,
              host.gpu,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <SettingsInfoRow
                hint={`${specification ? `${specification} · ` : ""}${host.session_count} ${
                  host.session_count === 1 ? "session" : "sessions"
                }`}
                icon="Server"
                key={host.id}
                label={host.name}
                trailing={
                  <StatusDot
                    accessibilityLabel={host.status}
                    tone={host.status === "online" ? "active" : "offline"}
                  />
                }
              />
            );
          })
        )}
      </SettingsSection>

      {data.agents.length > 0 ? (
        <SettingsSection
          description="Command names only. No paths, repositories, or hostnames."
          title="Agents summoned"
        >
          <SettingsBlock>
            {data.agents.map((agent) => (
              <View key={agent.command} style={styles.agent}>
                <View style={styles.agentLabels}>
                  <Text variant="mono">{agent.command}</Text>
                  <Text color="mutedForeground" variant="caption">
                    {agent.count}
                  </Text>
                </View>
                <View
                  style={[
                    styles.agentTrack,
                    { backgroundColor: theme.colors.muted, borderRadius: theme.radii.pill },
                  ]}
                >
                  <View
                    style={[
                      styles.agentBar,
                      {
                        backgroundColor: theme.colors.brandAccent,
                        borderRadius: theme.radii.pill,
                        width: `${(agent.count / maxAgentCount) * 100}%`,
                      },
                    ]}
                  />
                </View>
              </View>
            ))}
          </SettingsBlock>
        </SettingsSection>
      ) : null}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  agent: {
    gap: spacing[1],
  },
  agentBar: {
    height: "100%",
  },
  agentLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  agentTrack: {
    height: spacing[1.5],
    overflow: "hidden",
  },
  day: {
    opacity: opacity.opaque,
  },
  grid: {
    gap: spacing[2],
  },
  gridRow: {
    flexDirection: "row",
    gap: spacing[2],
  },
  headline: {
    borderWidth: borderWidth.hairline,
    gap: spacing[1],
    padding: spacing[4],
  },
  headlineFigure: {
    fontFamily: fontFamily.posterLight,
    fontSize: fontSize.hero,
  },
  headlineRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[3],
  },
  heatmap: {
    flexDirection: "row",
    width: "100%",
  },
  identity: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[4],
  },
  identityCopy: {
    flex: 1,
    gap: spacing[1],
    minWidth: 0,
  },
  legend: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[1.5],
    justifyContent: "flex-end",
  },
  loading: {
    height: spacing[32],
  },
  pad: {
    opacity: opacity.hidden,
  },
  swatch: {
    borderRadius: spacing[0.5],
    height: spacing[2.5],
    width: spacing[2.5],
  },
  tile: {
    borderWidth: borderWidth.hairline,
    flex: 1,
    gap: spacing[1],
    padding: spacing[3],
  },
});
