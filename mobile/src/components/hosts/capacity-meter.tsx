import { StyleSheet, View } from "react-native";
import type { CapacityPresentation } from "@/components/hosts/host-model";
import { capacityLabel, formatBytes, formatDuration } from "@/components/hosts/host-model";
import { Text } from "@/components/ui/text";
import { borderWidth, opacity, spacing, useTheme } from "@/theme";

const CAPACITY_SEGMENTS = ["one", "two", "three", "four", "five"] as const;

function SegmentedMeter({
  compact = false,
  label,
  segments,
}: {
  compact?: boolean;
  label: string;
  segments: number;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.meterRow, compact && styles.compactMeterRow]}>
      <Text color="mutedForeground" style={styles.meterLabel} variant="micro">
        {label}
      </Text>
      <View accessibilityLabel={`${label} ${capacityLabel(segments)}`} style={styles.segments}>
        {CAPACITY_SEGMENTS.map((segment, index) => (
          <View
            key={`${label}-${segment}`}
            style={[
              styles.segment,
              {
                backgroundColor: index < segments ? theme.colors.foreground : theme.colors.muted,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.sm,
              },
            ]}
          />
        ))}
      </View>
      {compact ? null : (
        <Text color="mutedForeground" style={styles.value} variant="caption">
          {capacityLabel(segments)}
        </Text>
      )}
    </View>
  );
}

function ExactMeter({ label, percent }: { label: string; percent: number }) {
  const theme = useTheme();
  const rounded = Math.round(percent);
  return (
    <View style={styles.meterRow}>
      <Text style={styles.meterLabel} variant="micro">
        {label}
      </Text>
      <View
        accessibilityLabel={`${label} ${rounded}%`}
        style={[
          styles.exactTrack,
          { backgroundColor: theme.colors.muted, borderRadius: theme.radii.pill },
        ]}
      >
        <View
          style={[
            styles.exactFill,
            {
              backgroundColor: theme.colors.foreground,
              borderRadius: theme.radii.pill,
              width: `${rounded}%`,
            },
          ]}
        />
      </View>
      <Text style={styles.value} variant="caption">
        {rounded}%
      </Text>
    </View>
  );
}

export interface CapacityMeterProps {
  capacity: CapacityPresentation;
  /**
   * Both coarse meters on one line, without their word labels — the shape a
   * list row has room for. The words are still spoken: each meter names its
   * reading for assistive tech either way.
   */
  compact?: boolean;
}

export function CapacityMeter({ capacity, compact = false }: CapacityMeterProps) {
  if (capacity.source === "unavailable") {
    return (
      <Text color="mutedForeground" variant="caption">
        Capacity unavailable
      </Text>
    );
  }
  if (capacity.source === "bucketed") {
    return (
      <View style={compact ? styles.compactPair : styles.stack} testID="bucketed-capacity">
        <SegmentedMeter compact={compact} label="CPU" segments={capacity.cpuSegments} />
        <SegmentedMeter compact={compact} label="MEM" segments={capacity.memorySegments} />
      </View>
    );
  }
  return (
    <View style={styles.stack} testID="exact-capacity">
      <ExactMeter label="CPU" percent={capacity.cpuPercent} />
      <ExactMeter label="MEM" percent={capacity.memoryPercent} />
      <Text color="mutedForeground" variant="caption">
        {formatBytes(capacity.memoryUsedBytes)} of {formatBytes(capacity.memoryTotalBytes)}
        {capacity.loadOne === null ? "" : ` · load ${capacity.loadOne.toFixed(2)}`} · uptime{" "}
        {formatDuration(capacity.uptimeSeconds)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  compactMeterRow: {
    flex: 1,
  },
  compactPair: {
    flexDirection: "row",
    gap: spacing[4],
  },
  exactFill: {
    height: "100%",
    minWidth: spacing.px,
  },
  exactTrack: {
    flex: 1,
    height: spacing[1.5],
    overflow: "hidden",
  },
  meterLabel: {
    width: spacing[9],
  },
  meterRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing[2],
  },
  segment: {
    borderWidth: borderWidth.hairline,
    flex: 1,
    height: spacing[1.5],
    opacity: opacity.opaque,
  },
  segments: {
    flex: 1,
    flexDirection: "row",
    gap: spacing[1],
  },
  stack: {
    gap: spacing[2],
  },
  value: {
    minWidth: spacing[14],
    textAlign: "right",
  },
});
