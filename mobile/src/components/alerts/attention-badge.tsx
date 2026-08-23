import { StyleSheet, View } from "react-native";

import { Badge } from "@/components/ui/badge";
import type { AttentionSummary } from "@/data/queries/alerts";
import { useTheme } from "@/theme";

export type AttentionBadgeDisplay = "count" | "dot";

export interface AttentionBadgeProps {
  summary: AttentionSummary | null;
  display?: AttentionBadgeDisplay;
  testID?: string;
}

export function attentionAccessibilityLabel(summary: AttentionSummary): string {
  const parts: string[] = [];
  if (summary.dead > 0) {
    parts.push(`${summary.dead} ${summary.dead === 1 ? "session" : "sessions"} exited or killed`);
  }
  if (summary.waiting > 0) {
    parts.push(
      `${summary.waiting} ${summary.waiting === 1 ? "session" : "sessions"} awaiting input`,
    );
  }
  return parts.join(", ");
}

export function AttentionBadge({
  summary,
  display = "count",
  testID,
}: AttentionBadgeProps): React.JSX.Element | null {
  const theme = useTheme();
  if (!summary) return null;

  const accessibilityLabel = attentionAccessibilityLabel(summary);
  const tone = summary.highest === "dead" ? "destructive" : "warning";
  const dotColor = summary.highest === "dead" ? theme.colors.destructive : theme.colors.warning;

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image"
      accessible
      style={styles.wrapper}
      testID={testID}
    >
      {display === "dot" ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{
            backgroundColor: dotColor,
            borderRadius: theme.radii.pill,
            height: theme.space(2),
            width: theme.space(2),
          }}
          testID={testID ? `${testID}-dot` : undefined}
        />
      ) : (
        <Badge
          style={styles.badge}
          {...(testID ? { testID: `${testID}-count` } : {})}
          variant={tone}
        >
          {summary.total > 99 ? "99+" : summary.total}
        </Badge>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: "auto",
  },
  wrapper: {
    alignItems: "center",
    alignSelf: "flex-start",
    justifyContent: "center",
  },
});
